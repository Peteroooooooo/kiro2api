import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_MESSAGE_FRAME_TOKENS,
  claudeContentTokens,
  claudeTokenCount,
} from '../../src/tokenizer/claude/index.js';

/**
 * Expected values come from Python ctok 1.3.0 as the oracle: `ctok.token_count(text, "4.8")`.
 * The sample holds the stress strings, random fuzz strings, random slices of ctok's fixture
 * corpora and a few whole corpus documents. Strings that contain a codepoint whose Unicode
 * properties changed between Unicode 15.1 and 16.0 (`unicodeVersionSensitive`) are left out:
 * ctok itself counts those differently on Python 3.13 and 3.14, and this port follows the
 * runtime's ICU data instead (see src/tokenizer/claude/unicode.ts).
 */
interface Sample {
  unicodeVersionSensitive: [number, number][];
  bmpSweep: { strings: number; sum: number; fnv1a: number };
  cases: { group: string; text: string; count: number }[];
}

const sample: Sample = JSON.parse(
  readFileSync(
    new URL('../fixtures/claude-tokenizer/ctok-v4.8-sample.json', import.meta.url),
    'utf8',
  ),
);

describe('claudeTokenCount (ctok v4.8 port)', () => {
  it('matches the Python oracle on every sampled string', () => {
    const mismatches = sample.cases
      .map((c) => ({ ...c, got: claudeTokenCount(c.text) }))
      .filter((c) => c.got !== c.count)
      .map((c) => `${c.group} want=${c.count} got=${c.got} ${JSON.stringify(c.text.slice(0, 80))}`);
    expect(sample.cases.length).toBeGreaterThan(1000);
    expect(mismatches).toEqual([]);
  });

  it('covers every sample group', () => {
    const groups = new Set(sample.cases.map((c) => c.group));
    expect([...groups].sort()).toEqual(['fuzz', 'rosetta', 'rosetta_holdout', 'slices', 'stress']);
  });

  it('counts the frame and small stress cases like ctok', () => {
    const cases: [string, number][] = [
      ['', 6],
      [' ', 7],
      ['  ', 7],
      ['a', 7],
      ['hello world', 9],
      ['Hello World', 10],
      ['HELLO WORLD', 14],
      ["it's", 8],
      ["I'll", 9],
      ['中文测试，你好。', 14],
      ['👨‍👩‍👧‍👦', 20],
      ['‘hello’ “world”', 15],
      ['⟨bow⟩', 14],
      [String.fromCharCode(0xfdd0), 9], // a literal marker codepoint is text, not a marker
      [String.fromCharCode(0xd800), 7], // a lone surrogate prices as U+FFFD
      [String.fromCharCode(0), 7], // NUL reads as a space
    ];
    for (const [text, want] of cases) expect([text, claudeTokenCount(text)]).toEqual([text, want]);
  });

  it('claudeContentTokens is the count without the 6-token frame', () => {
    expect(CLAUDE_MESSAGE_FRAME_TOKENS).toBe(6);
    expect(claudeContentTokens('')).toBe(0);
    for (const c of sample.cases.slice(0, 200)) {
      expect(claudeContentTokens(c.text)).toBe(c.count - 6);
    }
  });

  it('matches the oracle on a sweep of every BMP codepoint, alone and between letters', () => {
    const sensitive = (cp: number) =>
      sample.unicodeVersionSensitive.some(([lo, hi]) => cp >= lo && cp <= hi);
    let strings = 0;
    let sum = 0;
    let hash = 0x811c9dc5;
    for (let cp = 0; cp < 0x10000; cp++) {
      if ((cp >= 0xd800 && cp <= 0xdfff) || sensitive(cp)) continue;
      const c = String.fromCharCode(cp);
      for (const text of [c, `a${c}b`]) {
        const n = claudeTokenCount(text);
        sum += n;
        hash = Math.imul(hash ^ n, 0x01000193) >>> 0;
        strings++;
      }
    }
    expect({ strings, sum, fnv1a: hash }).toEqual(sample.bmpSweep);
  });

  it('rejects non-string input', () => {
    expect(() => claudeTokenCount(42 as unknown as string)).toThrow(TypeError);
  });
});
