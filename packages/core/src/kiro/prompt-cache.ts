/**
 * Local prompt-cache accounting.
 *
 * The upstream reports neither cache reads nor cache writes; it only bills credits. The
 * gateway therefore keeps its own model of the upstream cache and splits each request's
 * prompt into "read from cache" and "written to cache" itself, instead of inverting credits
 * (which moves ~25 cached tokens per output token of estimation error).
 *
 * Model, from probes on claude-opus-5.5 (2026-11-03/04, PITFALLS「上游 prompt 缓存与本地记账」):
 * - the cache belongs to the account and is keyed on content; for Claude conversationId does
 *   not matter, GPT only hits inside the same conversationId (PITFALLS「GPT credit 锚定」);
 * - a later request hits the longest cached prefix that ends on a message boundary
 *   (tools, then each history message, then the current message);
 * - an entry lives ~5 minutes and is refreshed when it is read;
 * - everything not read is written (miss and write cost the same credits).
 *
 * Token figures here are only used as proportions of one prompt; the absolute prompt size
 * comes from the upstream's context usage (see {@link localPromptSplit}).
 */

import { createHash } from 'node:crypto';
import type { UsageFinishEvent } from '@kiro2claude/plugin-api';
import { isGptModelId } from '../claude/converter.js';
import { getRequestContext } from '../shared/request-context.js';
import { countUpstreamTokens } from '../token.js';

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
}

/** The gateway's own count of a request's prompt, in the Anthropic usage fields. */
export interface LocalPromptSplit {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Splits the request's prompt into cache read and cache write.
 *
 * Prompt size: the upstream's context usage counts prompt plus this turn's output (measured:
 * credits fit `T − output` with a constant ratio), so the gateway's output count is taken off
 * it; without context usage the client-side estimate is the prompt. Returns undefined when
 * the request never reached a successful upstream call (no tracker result).
 */
export function localPromptSplit(event: UsageFinishEvent): LocalPromptSplit | undefined {
  const hit = getRequestContext()?.promptCache;
  if (!hit) return undefined;
  const context = event.getMeta<number>('kiro.inputTokens') ?? 0;
  const output = event.getMeta<number>('kiro.outputTokens') ?? 0;
  const prompt = Math.max(
    event.inputTokensSource === 'upstream-reported' ? context - output : context,
    0,
  );
  const read = hit.total > 0 ? Math.round((prompt * hit.read) / hit.total) : 0;
  return { inputTokens: 0, cacheReadTokens: read, cacheWriteTokens: prompt - read };
}

/**
 * The split sent in `message_start`, before the upstream has reported the prompt size: the
 * request-side estimate cut by the same cached share as {@link localPromptSplit}. Claude Code
 * ignores zero fields in the closing `message_delta` and keeps the `message_start` value, so
 * `input_tokens` must already be 0 here, and a cache field is zero here exactly when it is zero
 * in the final split. Undefined when the request has no tracker result.
 */
export function estimatedPromptSplit(estimate: number): LocalPromptSplit | undefined {
  const hit = getRequestContext()?.promptCache;
  if (!hit) return undefined;
  const read = hit.total > 0 ? Math.round((estimate * hit.read) / hit.total) : 0;
  return { inputTokens: 0, cacheReadTokens: read, cacheWriteTokens: estimate - read };
}
