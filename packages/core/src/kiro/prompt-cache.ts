/**
 * Local prompt-cache accounting.
 *
 * The upstream reports neither cache reads nor cache writes; it reports the context size
 * (prompt + this turn's billed output) and bills credits. Two ways to split the prompt:
 *
 * - Exact (models in `kiro/prompt-tokens.ts`): the prompt is counted exactly, so the output is
 *   `context - prompt`, and with both known the credits fix the cached part:
 *   `credits = writePrice * (prompt - read) + readPrice * read + outputPrice * output`.
 *   Probes on claude-opus-5.5 (2026-11-09) gave read = 0.0 on cold prompts and prompt - read =
 *   13.3 tokens on identical resends; see PITFALLS「上游 prompt 缓存与本地记账」.
 * - Tracker (every other model, or no credits): the gateway keeps its own model of the upstream
 *   cache and takes the matched share of the prompt as read.
 *
 * Tracker model, from probes on claude-opus-5.5 (2026-11-03/04):
 * - the cache belongs to the account and is keyed on content; for Claude conversationId does
 *   not matter, GPT only hits inside the same conversationId (PITFALLS「GPT credit 锚定」);
 * - a later request hits the longest cached prefix that ends on a message boundary
 *   (tools, then each history message, then the current message);
 * - an entry lives ~5 minutes and is refreshed when it is read;
 * - everything not read is written (miss and write cost the same credits).
 *
 * Tracker token figures are only used as proportions of one prompt; the absolute prompt size
 * comes from the exact count or the upstream's context usage (see {@link localPromptSplit}).
 */

import { createHash } from 'node:crypto';
import type { UsageFinishEvent } from '@kiro2claude/plugin-api';
import { isGptModelId } from '../claude/converter.js';
import { getRequestContext } from '../shared/request-context.js';
import { countUpstreamTokens } from '../token.js';
import { countKiroPrompt, noteReasoningTokens, visibleOutputTokens } from './prompt-tokens.js';

export const PROMPT_CACHE_TTL_MS = 5 * 60_000;

/** Rough upstream cost of one image; images carry no text to count. */
const IMAGE_TOKENS = 1500;

/** Prompt split into cache boundaries: `hashes[i]` covers segments 0..i, `tokens[i]` is segment i alone. */
export interface PromptShape {
  model: string;
  /** Set for models whose cache is per conversation (GPT). */
  conversation?: string;
  hashes: string[];
  tokens: number[];
}

/** Estimated share of one prompt served from cache: `read` of `total` (same units). */
export interface PromptCacheHit {
  read: number;
  total: number;
}

const segmentTokenMemo = new Map<string, number>();
const SEGMENT_MEMO_MAX = 50_000;

function tokensOf(value: unknown): number {
  let total = 0;
  const walk = (v: unknown, key?: string): void => {
    // `i` = a user segment's images, see segmentOf.
    if (key === 'i' && Array.isArray(v)) {
      total += v.length * IMAGE_TOKENS;
    } else if (typeof v === 'string') {
      if (key === 'bytes') total += IMAGE_TOKENS;
      else if (key !== 'signature') total += countUpstreamTokens(v);
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item);
    } else if (v && typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) walk(item, k);
    }
  };
  walk(value);
  return total;
}

/**
 * What a message contributes to the prompt, independent of where it sits: the current user
 * message and the same message replayed as history next turn must hash alike (the wire
 * forms differ in `modelId` / `origin` / `tools`).
 */
function segmentOf(message: Record<string, unknown>): unknown {
  const user = message.userInputMessage as Record<string, unknown> | undefined;
  if (user) {
    const context = user.userInputMessageContext as Record<string, unknown> | undefined;
    return { u: user.content ?? '', r: context?.toolResults ?? [], i: user.images ?? [] };
  }
  const assistant = message.assistantResponseMessage as Record<string, unknown> | undefined;
  if (assistant) {
    return {
      a: assistant.content ?? '',
      t: assistant.toolUses ?? [],
      r: assistant.reasoningContent ?? null,
    };
  }
  return message;
}

/** Cache boundaries of a Kiro request body, or undefined for bodies without a conversation. */
export function promptShapeOf(body: string): PromptShape | undefined {
  let state: Record<string, unknown> | undefined;
  try {
    state = (JSON.parse(body) as { conversationState?: Record<string, unknown> }).conversationState;
  } catch {
    return undefined;
  }
  const current = (state?.currentMessage as Record<string, unknown> | undefined)
    ?.userInputMessage as Record<string, unknown> | undefined;
  if (!current) return undefined;
  const history = Array.isArray(state?.history) ? (state.history as Record<string, unknown>[]) : [];
  const tools =
    (current.userInputMessageContext as Record<string, unknown> | undefined)?.tools ?? [];

  const segments: unknown[] = [{ tools }];
  for (const message of history) segments.push(segmentOf(message));
  segments.push(segmentOf({ userInputMessage: current }));

  const hashes: string[] = [];
  const tokens: number[] = [];
  const running = createHash('sha1');
  for (const segment of segments) {
    const json = JSON.stringify(segment);
    const segmentHash = createHash('sha1').update(json).digest('base64');
    let count = segmentTokenMemo.get(segmentHash);
    if (count === undefined) {
      count = tokensOf(segment);
      if (segmentTokenMemo.size >= SEGMENT_MEMO_MAX) segmentTokenMemo.clear();
      segmentTokenMemo.set(segmentHash, count);
    }
    running.update(segmentHash);
    hashes.push(running.copy().digest('base64'));
    tokens.push(count);
  }
  const model = typeof current.modelId === 'string' ? current.modelId : '';
  const conversation =
    isGptModelId(model) && typeof state?.conversationId === 'string'
      ? state.conversationId
      : undefined;
  return { model, conversation, hashes, tokens };
}

/** Which prompt prefixes each account's upstream cache still holds. */
export class PromptCacheTracker {
  readonly #entries = new Map<string, Map<string, number>>();
  readonly #ttlMs: number;

  constructor(ttlMs = PROMPT_CACHE_TTL_MS) {
    this.#ttlMs = ttlMs;
  }

  /** Records that `account` was just sent `shape`; returns what of it the cache already held. */
  serve(account: string, shape: PromptShape, now = Date.now()): PromptCacheHit {
    const key = `${account}\u0000${shape.model}\u0000${shape.conversation ?? ''}`;
    let entries = this.#entries.get(key);
    if (!entries) {
      entries = new Map();
      this.#entries.set(key, entries);
    }

    let matched = -1;
    for (let i = shape.hashes.length - 1; i >= 0; i--) {
      const expiry = entries.get(shape.hashes[i] as string);
      if (expiry !== undefined && expiry > now) {
        matched = i;
        break;
      }
    }

    let read = 0;
    let total = 0;
    for (let i = 0; i < shape.tokens.length; i++) {
      const t = shape.tokens[i] as number;
      total += t;
      if (i <= matched) read += t;
    }

    if (entries.size > 4 * shape.hashes.length + 1000) {
      for (const [hash, expiry] of entries) if (expiry <= now) entries.delete(hash);
    }
    const expiry = now + this.#ttlMs;
    for (const hash of shape.hashes) entries.set(hash, expiry);

    return { read, total };
  }

  /** Accounts are keyed by id; a renamed or deleted account simply starts cold. */
  clear(): void {
    this.#entries.clear();
  }
}

export const promptCacheTracker = new PromptCacheTracker();

/** Single-credential mode has no account id; its one cache is keyed under this. */
const SINGLE_ACCOUNT = '\u0000single';

/**
 * Called once the upstream accepted a request: notes the hit on the request context (read
 * by {@link localPromptSplit}) and marks the prompt as cached for the account.
 */
export function notePromptServed(accountId: string | undefined, body: string): void {
  const ctx = getRequestContext();
  if (!ctx) return;
  const shape = promptShapeOf(body);
  if (!shape) return;
  ctx.promptCache = promptCacheTracker.serve(accountId ?? SINGLE_ACCOUNT, shape);
  ctx.promptTokens = countKiroPrompt(body);
}

/**
 * The response's billed output tokens: `context - exact prompt` when both are known, else the
 * caller's estimate. Also files the reasoning tokens behind the response's signatures (output
 * minus its visible part) for when the client replays them.
 */
export function resolveOutputTokens(args: {
  contextTokens: number;
  fromUpstream: boolean;
  estimate: number;
  text: string;
  toolUses: readonly { name: string; input: unknown }[];
  signatures: readonly string[];
}): number {
  const prompt = getRequestContext()?.promptTokens;
  if (!prompt || !args.fromUpstream) return args.estimate;
  const output = args.contextTokens - prompt.tokens;
  if (output < 0) return args.estimate;
  if (args.signatures.length > 0 && !prompt.estimated) {
    const hidden = output - visibleOutputTokens(args.text, args.toolUses);
    noteReasoningTokens(args.signatures, Math.max(hidden, 0));
  }
  return output;
}

/** Kiro credits per token, measured with same-prompt resends (2026-11-09). */
const CREDIT_PRICES: ReadonlyMap<string, { write: number; read: number; output: number }> = new Map(
  [['claude-opus-5.5', { write: 1.227197e-5, read: 3.31675e-6, output: 2.210225561e-4 }]],
);

/** How far (tokens) the credit-implied read may fall outside [0, prompt] before it is distrusted. */
const CREDIT_READ_SLACK = 64;

/** Cache read implied by the credits, or undefined when they cannot be used. */
function creditImpliedRead(
  event: UsageFinishEvent,
  prompt: number,
  output: number,
): number | undefined {
  const credits = event.getMeta<number>('kiro.creditsUsed');
  const price = CREDIT_PRICES.get(event.getMeta<string>('kiro.pricedModel') ?? '');
  if (!price || typeof credits !== 'number' || !(credits > 0)) return undefined;
  if (event.getMeta<boolean>('kiro.meteringMissing') === true) return undefined;
  const read =
    (price.write * prompt + price.output * output - credits) / (price.write - price.read);
  if (!Number.isFinite(read) || read < -CREDIT_READ_SLACK || read > prompt + CREDIT_READ_SLACK) {
    return undefined;
  }
  return Math.min(Math.max(Math.round(read), 0), prompt);
}

/** The gateway's own count of a request's prompt, in the Anthropic usage fields. */
export interface LocalPromptSplit {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** True when the prompt was counted exactly and the split came from the credits. */
  exact: boolean;
}

/**
 * Splits the request's prompt into cache read and cache write.
 *
 * Prompt size: the exact count when the model's framing is measured, else the upstream's
 * context usage minus the gateway's output count (context usage includes this turn's output),
 * else the client-side estimate. The read share comes from the credits when the prompt is
 * exact, else from the tracker. Returns undefined when the request never reached a successful
 * upstream call (no tracker result).
 */
export function localPromptSplit(event: UsageFinishEvent): LocalPromptSplit | undefined {
  const ctx = getRequestContext();
  const hit = ctx?.promptCache;
  if (!hit) return undefined;
  const context = event.getMeta<number>('kiro.inputTokens') ?? 0;
  const output = event.getMeta<number>('kiro.outputTokens') ?? 0;
  const upstream = event.inputTokensSource === 'upstream-reported';
  const exact = ctx.promptTokens;
  if (exact && upstream && context - output === exact.tokens && !exact.estimated) {
    const read = creditImpliedRead(event, exact.tokens, output);
    if (read !== undefined) {
      return {
        inputTokens: 0,
        cacheReadTokens: read,
        cacheWriteTokens: exact.tokens - read,
        exact: true,
      };
    }
  }
  const prompt = Math.max(upstream ? context - output : context, 0);
  const read = hit.total > 0 ? Math.round((prompt * hit.read) / hit.total) : 0;
  return { inputTokens: 0, cacheReadTokens: read, cacheWriteTokens: prompt - read, exact: false };
}

/**
 * The split sent in `message_start`, before the credits are known: the exact prompt count (else
 * the request-side estimate) cut by the tracker's cached share. Claude Code ignores zero fields
 * in the closing `message_delta` and keeps the `message_start` value, so `input_tokens` must
 * already be 0 here. Under tracker accounting a cache field is zero here exactly when it is zero
 * in the final split; under exact accounting the final read can be 0 where the tracker expected
 * a hit (the upstream entry expired early), and Claude Code then shows this estimate for that
 * one response. Undefined when the request has no tracker result.
 */
export function estimatedPromptSplit(estimate: number): LocalPromptSplit | undefined {
  const ctx = getRequestContext();
  const hit = ctx?.promptCache;
  if (!hit) return undefined;
  const prompt = ctx.promptTokens?.tokens ?? estimate;
  const read = hit.total > 0 ? Math.round((prompt * hit.read) / hit.total) : 0;
  return { inputTokens: 0, cacheReadTokens: read, cacheWriteTokens: prompt - read, exact: false };
}
