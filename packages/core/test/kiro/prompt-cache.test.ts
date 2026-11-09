import { describe, expect, it } from 'vitest';
import { StreamContext } from '../../src/claude/stream.js';
import {
  estimatedPromptSplit,
  localPromptSplit,
  notePromptServed,
  PromptCacheTracker,
  promptShapeOf,
} from '../../src/kiro/prompt-cache.js';
import { HookBus, UsageFinishEventImpl } from '../../src/plugin-host/index.js';
import { getLogger } from '../../src/shared/logger.js';
import { type RequestContext, requestContextStorage } from '../../src/shared/request-context.js';
import { countUpstreamTokens, estimateOutputTokens, TokenTally } from '../../src/token.js';

const TOOL = { toolSpecification: { name: 'Read', description: 'read a file', inputSchema: {} } };

function body(history: unknown[], content: string, model = 'claude-opus-5.5'): string {
  return JSON.stringify({
    conversationState: {
      conversationId: 'c1',
      history,
      currentMessage: {
        userInputMessage: {
          content,
          modelId: model,
          origin: 'KIRO_CLI',
          images: [],
          userInputMessageContext: { tools: [TOOL], toolResults: [] },
        },
      },
    },
  });
}

/** Turn 1 sends `hi`; turn 2 replays it as history (wire form differs) and adds a reply. */
const TURN1 = body([], 'hi there');
const TURN2 = body(
  [
    {
      userInputMessage: {
        content: 'hi there',
        modelId: 'claude-opus-5.5',
        origin: 'KIRO_CLI',
        images: [],
        userInputMessageContext: { toolResults: [], tools: [] },
      },
    },
    { assistantResponseMessage: { content: 'hello, how can I help?' } },
  ],
  'read the file',
);

describe('TokenTally', () => {
  it('counts the same however the text is chunked', () => {
    const text = 'const fooBar = 42;\n// 中文注释 and words\n\tif (x) { return y; }';
    const tally = new TokenTally();
    for (const piece of text.match(/.{1,3}/gsu) ?? []) tally.add(piece);
    expect(tally.tokens).toBe(countUpstreamTokens(text));
  });

  it('weights words, case steps, digits, newlines and CJK', () => {
    expect(countUpstreamTokens('')).toBe(0);
    expect(countUpstreamTokens(' ')).toBe(1);
    expect(countUpstreamTokens('hello world')).toBe(4);
    expect(countUpstreamTokens('fooBar')).toBe(5);
    expect(countUpstreamTokens('中文')).toBe(2);
    expect(countUpstreamTokens('1234')).toBe(2);
  });

  it('estimateOutputTokens counts text, thinking and tool input', () => {
    const text = estimateOutputTokens([{ type: 'text', text: 'hello world' }]);
    const all = estimateOutputTokens([
      { type: 'thinking', thinking: 'hello world' },
      { type: 'text', text: 'hello world' },
      { type: 'tool_use', name: 'Read', input: { path: 'a.ts' } },
    ]);
    expect(text).toBe(4);
    expect(all).toBeGreaterThan(2 * text);
    expect(estimateOutputTokens([])).toBe(1);
  });

  it('estimateOutputTokens adds the reasoning hidden behind a thinking signature', () => {
    const plain = estimateOutputTokens([{ type: 'thinking', thinking: 'hello world' }]);
    const signed = estimateOutputTokens([
      { type: 'thinking', thinking: 'hello world', signature: 'A'.repeat(1000) },
    ]);
    expect(signed).toBe(plain + 240);
    expect(estimateOutputTokens([{ type: 'redacted_thinking', data: 'A'.repeat(1000) }])).toBe(1);
  });
});

describe('promptShapeOf', () => {
  it('returns undefined for bodies without a conversation', () => {
    expect(promptShapeOf('not json')).toBeUndefined();
    expect(promptShapeOf('{"profileArn":"x"}')).toBeUndefined();
  });

  it('hashes a current message and its later history replay alike', () => {
    const one = promptShapeOf(TURN1);
    const two = promptShapeOf(TURN2);
    expect(one?.hashes).toHaveLength(2);
    expect(two?.hashes).toHaveLength(4);
    expect(two?.hashes.slice(0, 2)).toEqual(one?.hashes);
    expect(two?.model).toBe('claude-opus-5.5');
  });

  it('counts an image without reading its bytes as text', () => {
    const withImage = JSON.parse(TURN1);
    withImage.conversationState.currentMessage.userInputMessage.images = [
      { format: 'png', source: { bytes: 'A'.repeat(100_000) } },
    ];
    const plain = promptShapeOf(TURN1)?.tokens.at(-1) ?? 0;
    expect(promptShapeOf(JSON.stringify(withImage))?.tokens.at(-1)).toBe(plain + 1500);
  });
});

describe('PromptCacheTracker', () => {
  const one = promptShapeOf(TURN1);
  const two = promptShapeOf(TURN2);
  if (!one || !two) throw new Error('shape');
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  it('reads the longest cached prefix on the same account and model', () => {
    const t = new PromptCacheTracker();
    expect(t.serve('a', one, 0)).toEqual({ read: 0, total: sum(one.tokens) });
    expect(t.serve('a', two, 1_000)).toEqual({ read: sum(one.tokens), total: sum(two.tokens) });
    expect(t.serve('a', two, 2_000).read).toBe(sum(two.tokens));
    expect(t.serve('b', two, 2_000).read).toBe(0);
    expect(t.serve('a', { ...two, model: 'other' }, 2_000).read).toBe(0);
  });

  it('scopes GPT prompts to their conversation', () => {
    const t = new PromptCacheTracker();
    const gpt = (id: string) => {
      const b = JSON.parse(body([], 'hi there', 'gpt-5.6-sol'));
      b.conversationState.conversationId = id;
      const shape = promptShapeOf(JSON.stringify(b));
      if (!shape) throw new Error('shape');
      return shape;
    };
    t.serve('a', gpt('c1'), 0);
    expect(t.serve('a', gpt('c1'), 1).read).toBeGreaterThan(0);
    expect(t.serve('a', gpt('c2'), 2).read).toBe(0);
    expect(promptShapeOf(TURN1)?.conversation).toBeUndefined();
  });

  it('expires after the TTL unless read in between', () => {
    const t = new PromptCacheTracker(300_000);
    t.serve('a', one, 0);
    expect(t.serve('a', one, 299_000).read).toBe(sum(one.tokens));
    expect(t.serve('a', one, 598_000).read).toBe(sum(one.tokens));
    expect(t.serve('a', one, 898_001).read).toBe(0);
  });
});

describe('localPromptSplit', () => {
  function event(context: number, output: number, fromUpstream: boolean) {
    return new UsageFinishEventImpl({
      model: 'claude-opus-5-5',
      source: 'http-direct',
      inputTokensSource: fromUpstream ? 'upstream-reported' : 'client-estimate',
      meta: { 'kiro.inputTokens': context, 'kiro.outputTokens': output },
      logger: getLogger(),
    });
  }
  function inContext<T>(ctx: Partial<RequestContext>, fn: () => T): T {
    return requestContextStorage.run({ reqId: 'r', startTime: 0, ...ctx }, fn);
  }

  it('splits the prompt by the cached share; upstream context includes this turn output', () => {
    const promptCache = { read: 30, total: 100 };
    expect(inContext({ promptCache }, () => localPromptSplit(event(1_100, 100, true)))).toEqual({
      inputTokens: 0,
      cacheReadTokens: 300,
      cacheWriteTokens: 700,
      exact: false,
    });
    expect(inContext({ promptCache }, () => localPromptSplit(event(1_000, 100, false)))).toEqual({
      inputTokens: 0,
      cacheReadTokens: 300,
      cacheWriteTokens: 700,
      exact: false,
    });
  });

  it('is undefined until an upstream call succeeded', () => {
    expect(inContext({}, () => localPromptSplit(event(1_000, 10, true)))).toBeUndefined();
    expect(localPromptSplit(event(1_000, 10, true))).toBeUndefined();
  });

  it('estimatedPromptSplit cuts the request estimate by the same share, input 0', () => {
    const at = (read: number, total: number) =>
      inContext({ promptCache: { read, total } }, () => estimatedPromptSplit(1_000));
    expect(at(30, 100)).toEqual({
      inputTokens: 0,
      cacheReadTokens: 300,
      cacheWriteTokens: 700,
      exact: false,
    });
    // zero in the final split ⇔ zero here (Claude Code keeps message_start values over zero deltas)
    expect(at(0, 100)).toEqual({
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1_000,
      exact: false,
    });
    expect(at(100, 100)).toEqual({
      inputTokens: 0,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 0,
      exact: false,
    });
    expect(inContext({}, () => estimatedPromptSplit(1_000))).toBeUndefined();
  });

  it('message_start carries the estimated split once the tracker has a result', () => {
    const start = (ctx: Partial<RequestContext>) =>
      inContext(ctx, () => {
        const stream = new StreamContext('claude-opus-5-5', 1_000, false, new Map(), new HookBus());
        return (stream.createMessageStartEvent().message as { usage: Record<string, number> })
          .usage;
      });
    expect(start({ promptCache: { read: 30, total: 100 } })).toEqual({
      input_tokens: 0,
      cache_creation_input_tokens: 700,
      cache_read_input_tokens: 300,
      output_tokens: 1,
    });
    expect(start({})).toEqual({ input_tokens: 1_000, output_tokens: 1 });
  });

  it('notePromptServed records the hit on the request context', () => {
    const ctx: RequestContext = { reqId: 'r', startTime: 0 };
    requestContextStorage.run(ctx, () => notePromptServed('note-test', TURN1));
    expect(ctx.promptCache?.read).toBe(0);
    requestContextStorage.run(ctx, () => notePromptServed('note-test', TURN2));
    expect(ctx.promptCache?.read).toBeGreaterThan(0);
    expect(() => notePromptServed('note-test', TURN1)).not.toThrow();
  });
});
