/**
 * Offline Claude token counts for the Opus 4.8 / Sonnet 5 / Fable 5 tokenizer family ("v4.8":
 * the v4.7 vocabulary under a six-token frame with no ⟨bow⟩ at its head).
 *
 * TypeScript port of ctok (https://github.com/sanderland/ctok, MIT,
 * Copyright (c) 2026 Sander Land; see ./LICENSE), commit 8c43ffd3c7be467622a540f025516e49ef78d8b1,
 * ctok 1.3.0. `claudeTokenCount(text)` equals Python `ctok.token_count(text, "4.8")`.
 *
 * Pipeline: unicode.ts (character tables) → stream.ts (normalize + marked stream) → engine.ts
 * (reverse-trie min-cost tiling). Pure and synchronous; the vocabulary is parsed and the trie
 * built on the first call (tens of milliseconds), then reused.
 */

import { getModel } from './engine.js';
import { markedStream } from './stream.js';

/** Tokens the v4.8 single-message frame adds around the content. */
export const CLAUDE_MESSAGE_FRAME_TOKENS = 6;

/** Token count of `text` sent as a single user message, frame included (ctok `token_count`). */
export function claudeTokenCount(text: string): number {
  return CLAUDE_MESSAGE_FRAME_TOKENS + claudeContentTokens(text);
}

/** `claudeTokenCount(text)` minus the 6-token message frame. */
export function claudeContentTokens(text: string): number {
  if (typeof text !== 'string') throw new TypeError(`text must be a string, not ${typeof text}`);
  const model = getModel();
  const { cps, length, tailNewlines } = markedStream(text);
  return model.tileCost(cps, length) + model.frameTail(tailNewlines);
}
