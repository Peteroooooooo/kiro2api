import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveContextUsage } from '../../src/claude/converter.js';
import {
  localPromptSplit,
  notePromptServed,
  resolveOutputTokens,
} from '../../src/kiro/prompt-cache.js';
import {
  countKiroPrompt,
  imagePatches,
  imageSize,
  visibleOutputTokens,
} from '../../src/kiro/prompt-tokens.js';
import { UsageFinishEventImpl } from '../../src/plugin-host/index.js';
import { getLogger } from '../../src/shared/logger.js';
import { type RequestContext, requestContextStorage } from '../../src/shared/request-context.js';

/**
 * Real claude-opus-5.5 requests and what the upstream reported for them (2026-11-09):
 * `contextTokens` = round(contextUsagePercentage × 10 000), `credits` from the metering frame.
 */
interface Probe {
  name: string;
  contextTokens: number;
  credits: number;
  visibleText: string;
  signature: string | null;
  wire: unknown;
}

const probes: Probe[] = JSON.parse(
  readFileSync(
    new URL('../fixtures/kiro-prompt-tokens/opus-5.5-probes.json', import.meta.url),
    'utf8',
  ),
);
const probe = (name: string): Probe => {
  const p = probes.find((x) => x.name === name);
  if (!p) throw new Error(`no probe ${name}`);
  return p;
};
const prompt = (p: Probe) => countKiroPrompt(JSON.stringify(p.wire));

function inContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContextStorage.run(ctx, fn);
}

describe('countKiroPrompt', () => {
  const plain = probes.filter((p) => !p.signature && !p.name.startsWith('rp_'));

  it.each(
    plain.map((p) => [p.name, p] as const),
  )('%s: prompt + visible output = upstream context', (_name, p) => {
    const count = prompt(p);
    expect(count?.estimated).toBe(false);
    expect((count?.tokens ?? 0) + visibleOutputTokens(p.visibleText, [])).toBe(p.contextTokens);
  });

  it('counts replayed reasoning with the tokens recorded when it was issued', () => {
    const issued = probe('g4');
    const ctx: RequestContext = { reqId: 'r', startTime: 0 };
    const output = inContext(ctx, () => {
      notePromptServed('prompt-tokens-test', JSON.stringify(issued.wire));
      return resolveOutputTokens({
        contextTokens: issued.contextTokens,
        fromUpstream: true,
        estimate: 0,
        text: issued.visibleText,
        toolUses: [],
        signatures: [issued.signature ?? ''],
      });
    });
    expect(output).toBe(issued.contextTokens - (ctx.promptTokens?.tokens ?? 0));

    for (const name of ['rp_g4', 'rp_g4_old']) {
      const replay = probe(name);
      const count = prompt(replay);
      expect(count?.estimated).toBe(false);
      expect((count?.tokens ?? 0) + visibleOutputTokens(replay.visibleText, [])).toBe(
        replay.contextTokens,
      );
    }
  });

  it('estimates an unknown signature and says so', () => {
    type Wire = {
      conversationState: { history: { assistantResponseMessage?: Record<string, unknown> }[] };
    };
    const withSignature = (signature: string | undefined) => {
      const wire = structuredClone(probe('rp_g4').wire) as Wire;
      const assistant = wire.conversationState.history.find((m) => m.assistantResponseMessage)
        ?.assistantResponseMessage as Record<string, unknown>;
      if (signature) assistant.reasoningContent = { reasoningText: { text: '', signature } };
      else assistant.reasoningContent = undefined;
      return countKiroPrompt(JSON.stringify(wire));
    };
    const none = withSignature(undefined);
    const unknown = withSignature('Q'.repeat(1300));
    expect(none?.estimated).toBe(false);
    expect(unknown?.estimated).toBe(true);
    expect(unknown?.tokens).toBe((none?.tokens ?? 0) + 200 + 2);
  });

  it('leaves unmeasured models and non-conversation bodies alone', () => {
    const gpt = structuredClone(probe('base').wire) as {
      conversationState: { currentMessage: { userInputMessage: { modelId: string } } };
    };
    gpt.conversationState.currentMessage.userInputMessage.modelId = 'gpt-5.6-sol';
    expect(countKiroPrompt(JSON.stringify(gpt))).toBeUndefined();
    expect(countKiroPrompt('not json')).toBeUndefined();
    expect(countKiroPrompt('{"profileArn":"x"}')).toBeUndefined();
  });
});

describe('images', () => {
  it('downscales like the upstream: long edge 2576, then at most 4784 patches', () => {
    expect(imagePatches(28, 28)).toBe(1);
    expect(imagePatches(29, 29)).toBe(4);
    expect(imagePatches(2000, 1000)).toBe(72 * 36);
    expect(imagePatches(4000, 1000)).toBe(2116);
    expect(imagePatches(1000, 3000)).toBe(2852);
    expect(imagePatches(2600, 100)).toBe(368);
    expect(imagePatches(3840, 2160)).toBe(4784);
    expect(imagePatches(3000, 2000)).toBe(84 * 56);
    expect(imagePatches(2400, 1600)).toBe(84 * 56);
    expect(imagePatches(2576, 2576)).toBe(69 * 69);
    expect(imagePatches(2000, 2000)).toBe(69 * 69);
  });

  it('reads PNG, GIF, WebP and JPEG headers', () => {
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    expect(imageSize(png)).toEqual({ width: 640, height: 480 });

    const gif = Buffer.from('GIF89a\x20\x03\x58\x02', 'latin1');
    expect(imageSize(gif)).toEqual({ width: 800, height: 600 });

    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBPVP8X', 8, 'latin1');
    webp.writeUIntLE(1023, 24, 3);
    webp.writeUIntLE(767, 27, 3);
    expect(imageSize(webp)).toEqual({ width: 1024, height: 768 });

    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0,
      0x02, 0x80, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 640, height: 480 });
    expect(imageSize(Buffer.from('nope'))).toBeUndefined();
  });
});

describe('exact accounting', () => {
  function finish(p: Probe, output: number) {
    return new UsageFinishEventImpl({
      model: 'claude-opus-5-5',
      source: 'http-direct',
      inputTokensSource: 'upstream-reported',
      meta: {
        'kiro.inputTokens': p.contextTokens,
        'kiro.outputTokens': output,
        'kiro.creditsUsed': p.credits,
        'kiro.pricedModel': 'claude-opus-5.5',
      },
      logger: getLogger(),
    });
  }
  function split(p: Probe) {
    const ctx: RequestContext = { reqId: 'r', startTime: 0 };
    return inContext(ctx, () => {
      notePromptServed(`exact-${p.name}`, JSON.stringify(p.wire));
      const output = resolveOutputTokens({
        contextTokens: p.contextTokens,
        fromUpstream: true,
        estimate: 0,
        text: p.visibleText,
        toolUses: [],
        signatures: [],
      });
      return {
        output,
        prompt: ctx.promptTokens?.tokens ?? 0,
        split: localPromptSplit(finish(p, output)),
      };
    });
  }

  it('takes the cached part from the credits: cold prompt reads nothing', () => {
    const { output, prompt: p, split: s } = split(probe('tools3'));
    expect(output).toBe(4);
    expect(s).toEqual({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: p, exact: true });
  });

  it('an identical resend reads all but the 13-token uncached tail', () => {
    const { prompt: p, split: s } = split(probe('res_text_before'));
    expect(s?.exact).toBe(true);
    expect(p - (s?.cacheReadTokens ?? 0)).toBe(13);
  });

  it('falls back to the tracker without credits', () => {
    const p = probe('tools3');
    const ctx: RequestContext = { reqId: 'r', startTime: 0 };
    const s = inContext(ctx, () => {
      notePromptServed('exact-nocredit', JSON.stringify(p.wire));
      const event = new UsageFinishEventImpl({
        model: 'claude-opus-5-5',
        source: 'http-direct',
        inputTokensSource: 'upstream-reported',
        meta: { 'kiro.inputTokens': p.contextTokens, 'kiro.outputTokens': 4 },
        logger: getLogger(),
      });
      return localPromptSplit(event);
    });
    expect(s?.exact).toBe(false);
    expect((s?.cacheReadTokens ?? 0) + (s?.cacheWriteTokens ?? 0)).toBe(p.contextTokens - 4);
  });

  it('keeps the estimate when the context is not from the upstream', () => {
    const ctx: RequestContext = {
      reqId: 'r',
      startTime: 0,
      promptTokens: { tokens: 100, estimated: false },
    };
    const out = inContext(ctx, () =>
      resolveOutputTokens({
        contextTokens: 50,
        fromUpstream: true,
        estimate: 7,
        text: '',
        toolUses: [],
        signatures: [],
      }),
    );
    expect(out).toBe(7);
  });

  it('rounds the context percentage', () => {
    expect(resolveContextUsage('claude-opus-5-5', 0.21429999).inputTokens).toBe(2143);
  });
});
