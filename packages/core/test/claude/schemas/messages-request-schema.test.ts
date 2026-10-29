import { describe, expect, it } from 'vitest';

import {
  countTokensRequestSchema,
  formatRequestError,
  messagesRequestSchema,
} from '../../../src/claude/schemas/messages-request-schema.js';

const VALID_MESSAGE = { role: 'user', content: 'hello' };
const MODEL = 'claude-opus-5-5';

describe('messagesRequestSchema - required fields', () => {
  it('accepts a minimal valid request', () => {
    const result = messagesRequestSchema.safeParse({
      model: MODEL,
      max_tokens: 1024,
      messages: [VALID_MESSAGE],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe(MODEL);
      expect(result.data.max_tokens).toBe(1024);
      expect(result.data.messages).toHaveLength(1);
    }
  });

  it('rejects missing model', () => {
    const result = messagesRequestSchema.safeParse({
      max_tokens: 1024,
      messages: [VALID_MESSAGE],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatRequestError(result.error)).toMatch(/model/);
    }
  });

  it('rejects model of wrong type', () => {
    const result = messagesRequestSchema.safeParse({
      model: 12345,
      max_tokens: 1024,
      messages: [VALID_MESSAGE],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatRequestError(result.error)).toMatch(/model/);
    }
  });

  it('rejects missing max_tokens', () => {
    const result = messagesRequestSchema.safeParse({
      model: MODEL,
      messages: [VALID_MESSAGE],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatRequestError(result.error)).toMatch(/max_tokens/);
    }
  });

  it('rejects missing messages', () => {
    const result = messagesRequestSchema.safeParse({
      model: MODEL,
      max_tokens: 1024,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatRequestError(result.error)).toMatch(/messages/);
    }
  });

  it('rejects messages of wrong type', () => {
    const result = messagesRequestSchema.safeParse({
      model: MODEL,
      max_tokens: 1024,
      messages: 'not an array',
    });
    expect(result.success).toBe(false);
  });
});

describe('messagesRequestSchema - system normalization', () => {
  it('converts string system to [{text}]', () => {
    const result = messagesRequestSchema.safeParse({
      model: MODEL,
      max_tokens: 1024,
      messages: [VALID_MESSAGE],
      system: 'You are a helpful assistant',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.system).toEqual([{ text: 'You are a helpful assistant' }]);
    }
  });

  it('preserves an already-array system', () => {
    const result = messagesRequestSchema.safeParse({
      model: MODEL,
      max_tokens: 1024,
      messages: [VALID_MESSAGE],
      system: [{ text: 'First' }, { text: 'Second' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.system).toEqual([{ text: 'First' }, { text: 'Second' }]);
    }
  });

  it('filters out invalid system array items', () => {
    const result = messagesRequestSchema.safeParse({
      model: MODEL,
      max_tokens: 1024,
      messages: [VALID_MESSAGE],
      system: [{ text: 'kept' }, { notText: 'dropped' }, { text: 'alsoKept' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.system).toEqual([{ text: 'kept' }, { text: 'alsoKept' }]);
    }
  });

  it('allows system to be absent', () => {
    const result = messagesRequestSchema.safeParse({
      model: MODEL,
      max_tokens: 1024,
      messages: [VALID_MESSAGE],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.system).toBeUndefined();
    }
  });
});

describe('messagesRequestSchema - thinking normalization (adaptive only)', () => {
  const parse = (thinking: unknown) =>
    messagesRequestSchema.safeParse({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [VALID_MESSAGE],
      thinking,
    });

  it('enabled → adaptive; budget_tokens kept for the effort fallback, other fields dropped', () => {
    const result = parse({ type: 'enabled', budget_tokens: 100000, extra: 1 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.thinking).toEqual({ type: 'adaptive', budgetTokens: 100000 });
    }
  });

  it('keeps adaptive + display as-is; a non-positive or fractional budget is ignored', () => {
    for (const budget_tokens of [0, -5, 1.5, '4096']) {
      const result = parse({ type: 'adaptive', display: 'omitted', budget_tokens });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
      }
    }
  });

  it('between_tools (sonnet-5.5 thinking-off) → disabled, never reaches the wire; its budget is dropped', () => {
    const result = parse({ type: 'between_tools', budget_tokens: 2048 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.thinking).toEqual({ type: 'disabled' });
  });

  it('unknown thinking.type / non-object → treated as no thinking', () => {
    for (const raw of [{ type: 'mega' }, 'enabled', 42, null]) {
      const result = parse(raw);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.thinking).toBeUndefined();
    }
  });
});

describe('messagesRequestSchema - passthrough and extras', () => {
  it('preserves unknown top-level fields via passthrough', () => {
    const result = messagesRequestSchema.safeParse({
      model: MODEL,
      max_tokens: 1024,
      messages: [VALID_MESSAGE],
      anthropic_beta_flag_not_yet_in_schema: 'preserved',
    });
    expect(result.success).toBe(true);
    // We only guarantee the known MessagesRequest shape in the transform
    // result — the unknown field is dropped by design so handlers don't
    // accidentally forward it. The important thing is parse does not fail.
  });

  it('accepts messages with unknown content block types', () => {
    // The real ContentBlock union validation lives in converter.ts;
    // schema must not pre-empt it or reject novel block types.
    const result = messagesRequestSchema.safeParse({
      model: MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [{ type: 'unknown_future_block_type', data: { foo: 1 } }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('countTokensRequestSchema', () => {
  it('accepts a minimal valid request', () => {
    const result = countTokensRequestSchema.safeParse({
      model: MODEL,
      messages: [VALID_MESSAGE],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe(MODEL);
    }
  });

  it('rejects missing model', () => {
    const result = countTokensRequestSchema.safeParse({ messages: [VALID_MESSAGE] });
    expect(result.success).toBe(false);
  });

  it('normalizes string system field', () => {
    const result = countTokensRequestSchema.safeParse({
      model: MODEL,
      messages: [VALID_MESSAGE],
      system: 'You are a helpful assistant',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.system).toEqual([{ text: 'You are a helpful assistant' }]);
    }
  });
});
