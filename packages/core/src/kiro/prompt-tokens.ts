/**
 * Exact upstream token count of a Kiro request's prompt, and of the visible part of its output.
 *
 * Kiro reports no token counts, only `contextUsagePercentage` (prompt + this turn's whole billed
 * output, hidden reasoning included) and credits. With the prompt counted exactly here, the
 * output is `context − prompt` and the cache read/write split follows from the credits (see
 * `kiro/prompt-cache.ts`).
 *
 * The count tokenizes what the upstream renders from the wire body: message texts, the tool
 * list, tool calls and results, images, plus the framing constants below. All constants were
 * measured against the real upstream on claude-opus-5.5 (2026-11-09, PITFALLS「上游 prompt 缓存与本地记账」);
 * on every probe without reasoning the upstream total equalled prompt + visible output exactly.
 * Other models are not counted (`undefined`), because their framing or tokenizer is unmeasured.
 */

import { createHash } from 'node:crypto';
import { claudeContentTokens } from '../tokenizer/claude/index.js';

/** Upstream model ids whose framing below was measured. */
const EXACT_PROMPT_MODELS: ReadonlySet<string> = new Set(['claude-opus-5.5']);

/** Measured framing, in tokens. */
const FRAME = {
  /** Kiro's own system prompt and frame around a single user message. */
  base: 1889,
  /** Each message before the current one. */
  historyMessage: 2,
  /** Wrapper around the rendered tool list, beyond its text. */
  toolList: 277,
  /** An assistant message that has both text and tool calls. */
  textBeforeCalls: 1,
  /** An assistant message with two or more tool calls (flat, not per call). */
  parallelCalls: 26,
  /** A user message carrying tool results (net of the call/result renderings' surplus). */
  resultsMessage: -51,
  /** Such a message that also has text. */
  resultsWithText: 4,
  /** Each tool result whose text is empty. */
  emptyResult: 19,
  /** An assistant message without tool calls right after a tool-results message. */
  textAfterResults: 2,
  /** Each image, beyond its patches. */
  image: 3,
  /**
   * A text-only assistant message that replays reasoning, or that has none but comes after a
   * message with reasoning and not directly after tool results. Tool-call messages cost only
   * their reasoning tokens.
   */
  reasoning: 2,
  /** End of every response. */
  outputEnd: 2,
  /** A response's tool calls, beyond their rendering. */
  outputCalls: -18,
} as const;

/** Image limits of the Claude 4.7+ vision tier: 28 px patches. */
const IMAGE_PATCH_PX = 28;
const IMAGE_MAX_EDGE_PX = 2576;
const IMAGE_MAX_PATCHES = 4784;
/** Stand-in for an image whose size could not be read. */
const UNKNOWN_IMAGE_TOKENS = 1600;

export interface KiroPromptCount {
  tokens: number;
  /** Part of the count is an estimate (unknown replayed reasoning or unreadable image). */
  estimated: boolean;
  /**
   * Replayed signatures the gateway had no record of, with the estimate used for each and the
   * context they were replayed in.
   */
  unknownReasoning: { signature: string; tokens: number; context: string }[];
  /** Hash of the whole prompt: the context a response to it is issued in. */
  context: string;
}

// ---------------------------------------------------------------------------
// Prompt segments
// ---------------------------------------------------------------------------

/**
 * What a message contributes to the prompt, independent of where it sits: the current user
 * message and the same message replayed as history next turn must hash alike (the wire forms
 * differ in `modelId` / `origin` / `tools`).
 */
export function promptSegment(message: Record<string, unknown>): unknown {
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

/**
 * Hashes of a prompt's segments (the tool list, then each message): `segments[i]` hashes segment
 * i alone, `prefixes[i]` segments 0..i.
 */
export function segmentHashes(segments: readonly unknown[]): {
  segments: string[];
  prefixes: string[];
} {
  const single: string[] = [];
  const prefixes: string[] = [];
  const running = createHash('sha1');
  for (const segment of segments) {
    const hash = createHash('sha1').update(JSON.stringify(segment)).digest('base64');
    single.push(hash);
    running.update(hash);
    prefixes.push(running.copy().digest('base64'));
  }
  return { segments: single, prefixes };
}

function contentTokens(text: string): number {
  return text ? claudeContentTokens(text) : 0;
}

/** Python `json.dumps(value, ensure_ascii=False[, sort_keys=True])`: the upstream's renderer. */
function pythonJson(value: unknown, sortKeys: boolean): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'NaN';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map((v) => pythonJson(v, sortKeys)).join(', ')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (sortKeys) keys.sort();
    const record = value as Record<string, unknown>;
    return `{${keys.map((k) => `${JSON.stringify(k)}: ${pythonJson(record[k], sortKeys)}`).join(', ')}}`;
  }
  return JSON.stringify(String(value));
}

interface WireToolUse {
  name?: unknown;
  input?: unknown;
}

function renderToolList(tools: unknown[]): string {
  const items = tools.map((tool) => {
    const spec = ((tool as { toolSpecification?: unknown }).toolSpecification ?? {}) as {
      name?: unknown;
      description?: unknown;
      inputSchema?: { json?: unknown };
    };
    const fn = {
      description: spec.description ?? '',
      name: spec.name ?? '',
      parameters: spec.inputSchema?.json ?? {},
    };
    return `<function>${pythonJson(fn, true)}</function>`;
  });
  return `<functions>\n${items.join('\n')}\n</functions>`;
}

const NS = 'antml:';

function renderToolCalls(toolUses: readonly WireToolUse[]): string {
  const invokes = toolUses.map((use) => {
    const input =
      use.input && typeof use.input === 'object' && !Array.isArray(use.input)
        ? (use.input as Record<string, unknown>)
        : {};
    const params = Object.entries(input)
      .map(([k, v]) => {
        const rendered = typeof v === 'string' ? v : pythonJson(v, false);
        return `<${NS}parameter name="${k}">${rendered}</${NS}parameter>\n`;
      })
      .join('');
    return `<${NS}invoke name="${String(use.name ?? '')}">\n${params}</${NS}invoke>`;
  });
  return `<${NS}function_calls>\n${invokes.join('\n')}\n</${NS}function_calls>`;
}

function resultText(result: { content?: unknown }): string {
  if (!Array.isArray(result.content)) return '';
  return result.content
    .map((part) => {
      const text = (part as { text?: unknown })?.text;
      return typeof text === 'string' ? text : '';
    })
    .join('\n');
}

/**
 * A replayed call's tool name is billed once at its real length and once at a fixed cost: with
 * the name counted in both the call and its result, Read came out 1 token short and an MCP tool
 * 9 over (probes 2026-11-09). The framing constants were fitted on Bash calls, so results render
 * with that name.
 */
const RESULT_NAME = 'Bash';

function renderToolResults(results: readonly { content?: unknown }[]): string {
  const items = results.map(
    (r) => `<result>\n<name>${RESULT_NAME}</name>\n<output>${resultText(r)}</output>\n</result>`,
  );
  return `<function_results>\n${items.join('\n')}\n</function_results>`;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** Width and height from a PNG / JPEG / GIF / WebP header, or undefined. */
export function imageSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && bytes.toString('latin1', 0, 3) === 'GIF') {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (
    bytes.length >= 30 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    const chunk = bytes.toString('latin1', 12, 16);
    if (chunk === 'VP8X') {
      return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    }
    if (chunk === 'VP8 ') {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      const b = bytes.readUInt32LE(21);
      return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
    }
    return undefined;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = bytes[o + 1] as number;
      if (marker === 0xff) {
        o++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        o += 2;
        continue;
      }
      const length = bytes.readUInt16BE(o + 2);
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { width: bytes.readUInt16BE(o + 7), height: bytes.readUInt16BE(o + 5) };
      o += 2 + length;
    }
  }
  return undefined;
}

/** Patches the upstream bills for a `width × height` image after its own downscaling. */
export function imagePatches(width: number, height: number): number {
  let w = width;
  let h = height;
  const longEdge = Math.max(w, h);
  if (longEdge > IMAGE_MAX_EDGE_PX) {
    const s = IMAGE_MAX_EDGE_PX / longEdge;
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  let pw = Math.ceil(w / IMAGE_PATCH_PX);
  let ph = Math.ceil(h / IMAGE_PATCH_PX);
  if (pw * ph > IMAGE_MAX_PATCHES) {
    const s = Math.sqrt((IMAGE_MAX_PATCHES * IMAGE_PATCH_PX * IMAGE_PATCH_PX) / (w * h));
    pw = Math.floor(Math.floor(w * s) / IMAGE_PATCH_PX);
    ph = Math.floor(Math.floor(h * s) / IMAGE_PATCH_PX);
  }
  return pw * ph;
}

function imageTokens(image: unknown): { tokens: number; known: boolean } {
  const b64 = (image as { source?: { bytes?: unknown } })?.source?.bytes;
  if (typeof b64 !== 'string') return { tokens: UNKNOWN_IMAGE_TOKENS, known: false };
  const size = imageSize(Buffer.from(b64, 'base64'));
  if (!size || size.width <= 0 || size.height <= 0) {
    return { tokens: UNKNOWN_IMAGE_TOKENS, known: false };
  }
  return { tokens: imagePatches(size.width, size.height) + FRAME.image, known: true };
}

// ---------------------------------------------------------------------------
// Replayed reasoning
// ---------------------------------------------------------------------------

/**
 * Reasoning tokens a response billed behind its signature, and the context it was issued in
 * (`KiroPromptCount.context` of that request). Undefined context: issued before contexts were
 * recorded.
 */
export interface ReasoningRecord {
  tokens: number;
  context?: string;
}

/**
 * Persistent backing for reasoning records (the request-log database), so replays after a
 * restart still count exactly. Optional: without it only the in-memory map is used.
 */
export interface ReasoningTokenStore {
  get(key: string): ReasoningRecord | undefined;
  put(key: string, record: ReasoningRecord): void;
}

let reasoningStore: ReasoningTokenStore | undefined;
const reasoningMemo = new Map<string, ReasoningRecord>();
const REASONING_MEMO_MAX = 20_000;

export function setReasoningTokenStore(store: ReasoningTokenStore | undefined): void {
  reasoningStore = store;
}

function reasoningKey(signature: string): string {
  return createHash('sha256').update(signature).digest('base64url').slice(0, 22);
}

function rememberReasoning(key: string, record: ReasoningRecord): void {
  if (reasoningMemo.size >= REASONING_MEMO_MAX) {
    const oldest = reasoningMemo.keys().next().value;
    if (oldest !== undefined) reasoningMemo.delete(oldest);
  }
  reasoningMemo.set(key, record);
}

/**
 * Records the reasoning tokens a response billed behind its signatures, for when the client
 * replays them. Signatures arrive one per reasoning block; all of a response's reasoning is
 * filed under each, since the converter replays at most one block per assistant message.
 *
 * The count is `context - prompt - visible output`, unclamped and filed even when the prompt
 * held estimated (pinned) signatures: it then carries their error with the opposite sign, so a
 * later prompt replaying all of them sums to the upstream's figure again. It can be negative.
 */
export function noteReasoningTokens(
  signatures: readonly string[],
  tokens: number,
  context?: string,
): void {
  for (const signature of signatures) {
    if (!signature) continue;
    const key = reasoningKey(signature);
    const record: ReasoningRecord = context === undefined ? { tokens } : { tokens, context };
    rememberReasoning(key, record);
    try {
      reasoningStore?.put(key, record);
    } catch {
      // The count stays in memory; persistence is best effort.
    }
  }
}

/**
 * Fixes each unknown replayed signature at the estimate this request used, in the context it
 * was replayed in, so every later request counts it the same way (see `noteReasoningTokens`).
 */
export function pinUnknownReasoning(
  unknown: readonly { signature: string; tokens: number; context: string }[],
): void {
  for (const { signature, tokens, context } of unknown) {
    noteReasoningTokens([signature], tokens, context);
  }
}

function reasoningRecord(signature: string): ReasoningRecord | undefined {
  const key = reasoningKey(signature);
  let record = reasoningMemo.get(key);
  if (record === undefined) {
    try {
      record = reasoningStore?.get(key);
    } catch {
      record = undefined;
    }
    if (record !== undefined) rememberReasoning(key, record);
  }
  return record;
}

/** Estimate for a signature without a record. */
function estimatedReasoningTokens(signature: string): number {
  // Measured 2026-11-09: signatures of 680 / 856 / 1724 / 130496 characters carried
  // 19 / 96 / 350 / 37951 reasoning tokens.
  return Math.max(0, Math.round((signature.length - 620) / 3.4));
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/** Content tokens of one message (texts, renderings, images), keyed by its JSON and context. */
const messageMemo = new Map<string, { tokens: number; known: boolean }>();
const MESSAGE_MEMO_MAX = 50_000;

function memoized(
  key: unknown,
  compute: () => { tokens: number; known: boolean },
): { tokens: number; known: boolean } {
  const hash = createHash('sha1').update(JSON.stringify(key)).digest('base64');
  let value = messageMemo.get(hash);
  if (value === undefined) {
    value = compute();
    if (messageMemo.size >= MESSAGE_MEMO_MAX) messageMemo.clear();
    messageMemo.set(hash, value);
  }
  return value;
}

type Json = Record<string, unknown>;

/**
 * Exact prompt tokens of a serialized Kiro request, or undefined when the model's framing is
 * unmeasured or the body is not a conversation.
 */
export function countKiroPrompt(body: string): KiroPromptCount | undefined {
  let state: Json | undefined;
  try {
    state = (JSON.parse(body) as { conversationState?: Json }).conversationState;
  } catch {
    return undefined;
  }
  const current = (state?.currentMessage as Json | undefined)?.userInputMessage as Json | undefined;
  if (!current || !EXACT_PROMPT_MODELS.has(String(current.modelId ?? ''))) return undefined;
  const history = Array.isArray(state?.history) ? (state.history as Json[]) : [];
  const messages: Json[] = [...history, { userInputMessage: current }];
  const currentContext = (current.userInputMessageContext ?? {}) as Json;
  // Message i's context (the tool list and every message before it) is prefixes[i].
  const { prefixes } = segmentHashes([
    { tools: currentContext.tools ?? [] },
    ...messages.map(promptSegment),
  ]);

  let tokens = FRAME.base + FRAME.historyMessage * history.length;
  let estimated = false;
  const unknownReasoning: KiroPromptCount['unknownReasoning'] = [];
  let previousHadResults = false;
  let reasoningSeen = false;

  messages.forEach((message, index) => {
    const assistant = message.assistantResponseMessage as Json | undefined;
    if (assistant) {
      const text = typeof assistant.content === 'string' ? assistant.content : '';
      const toolUses = Array.isArray(assistant.toolUses) ? (assistant.toolUses as Json[]) : [];
      const part = memoized({ a: text, t: toolUses }, () => ({
        tokens:
          contentTokens(text) + (toolUses.length ? contentTokens(renderToolCalls(toolUses)) : 0),
        known: true,
      }));
      tokens += part.tokens;
      if (toolUses.length) {
        if (text) tokens += FRAME.textBeforeCalls;
        if (toolUses.length > 1) tokens += FRAME.parallelCalls;
      } else if (previousHadResults) {
        tokens += FRAME.textAfterResults;
      }
      const reasoning = assistant.reasoningContent as
        | { reasoningText?: { signature?: unknown } }
        | undefined;
      const signature = reasoning?.reasoningText?.signature;
      const messageContext = prefixes[index] as string;
      let replayed = false;
      let dropped = false;
      if (typeof signature === 'string' && signature) {
        const record = reasoningRecord(signature);
        if (record === undefined) {
          const guess = estimatedReasoningTokens(signature);
          tokens += guess;
          replayed = true;
          estimated = true;
          unknownReasoning.push({ signature, tokens: guess, context: messageContext });
        } else if (record.context !== undefined && record.context !== messageContext) {
          // A signature replayed in another context than it was issued in (an earlier message
          // or the tool list changed) is ignored upstream: no reasoning, no framing.
          dropped = true;
        } else {
          tokens += record.tokens;
          replayed = true;
        }
      }
      if (!toolUses.length && !dropped && (replayed || (reasoningSeen && !previousHadResults))) {
        tokens += FRAME.reasoning;
      }
      if (replayed) reasoningSeen = true;
      previousHadResults = false;
      return;
    }

    const user = message.userInputMessage as Json | undefined;
    if (!user) return;
    const text = typeof user.content === 'string' ? user.content : '';
    const context = (user.userInputMessageContext ?? {}) as Json;
    const results = Array.isArray(context.toolResults) ? (context.toolResults as Json[]) : [];
    const images = Array.isArray(user.images) ? user.images : [];
    const part = memoized({ u: text, r: results, i: images }, () => {
      let t = contentTokens(text);
      let known = true;
      if (results.length) t += contentTokens(renderToolResults(results));
      for (const image of images) {
        const img = imageTokens(image);
        t += img.tokens;
        if (!img.known) known = false;
      }
      return { tokens: t, known };
    });
    tokens += part.tokens;
    if (!part.known) estimated = true;
    if (results.length) {
      tokens += FRAME.resultsMessage;
      if (text) tokens += FRAME.resultsWithText;
      tokens += FRAME.emptyResult * results.filter((r) => resultText(r) === '').length;
    }
    if (index === messages.length - 1) {
      const tools = Array.isArray(context.tools) ? context.tools : [];
      if (tools.length) {
        tokens +=
          memoized({ tools }, () => ({ tokens: contentTokens(renderToolList(tools)), known: true }))
            .tokens + FRAME.toolList;
      }
    }
    previousHadResults = results.length > 0;
  });

  return { tokens, estimated, unknownReasoning, context: prefixes.at(-1) as string };
}

/**
 * Tokens of a response's visible output as the upstream bills it: text, tool calls (upstream
 * names, parsed inputs) and the closing frame. The rest of the billed output is reasoning.
 */
export function visibleOutputTokens(
  text: string,
  toolUses: readonly { name: string; input: unknown }[],
): number {
  let tokens = contentTokens(text) + FRAME.outputEnd;
  if (toolUses.length) {
    tokens += contentTokens(renderToolCalls(toolUses)) + FRAME.outputCalls;
    if (text) tokens += FRAME.textBeforeCalls;
  }
  return tokens;
}
