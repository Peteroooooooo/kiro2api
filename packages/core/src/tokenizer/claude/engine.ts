/**
 * The min-cost tiling of the marked stream over the v4.7 vocabulary (used by the v4.8 family).
 *
 * Port of ctok/engine.py (`ReverseTrie`, `min_vocab_tile`, `ByteFloor`, `char_cost`,
 * `frame_tail`, `tile`) and the vocabulary loading in ctok/main.py (`TokenizerModel`) from
 * https://github.com/sanderland/ctok (MIT, Copyright (c) 2026 Sander Land; see ./LICENSE),
 * commit 8c43ffd3c7be467622a540f025516e49ef78d8b1.
 *
 * Only the count is computed: every tile costs one token, so the DP needs no back-pointers and
 * the tie order ctok uses to pick token boundaries does not change the total.
 */

import { isMarkerGlyph, unescapeMarkerLiteral } from './unicode.js';
import { VOCAB_V4_7_JSON } from './vocab-v4-7.js';

interface VocabDocument {
  meta: { family: string; messageOverhead: number };
  pieces: string[];
  contractions: string[];
  markers: string[];
  bytesFallback: string[];
}

/**
 * The vocabulary stored backwards: the DP ends a tile at each position and walks candidate
 * starts right to left. Children live in one open-addressing hash table keyed by
 * (node, codepoint); the root's BMP children are a direct table.
 */
class ReverseTrie {
  private readonly rootBmp: Int32Array;
  private readonly rootAstral = new Map<number, number>();
  private keyNode: Int32Array;
  private keyCp: Int32Array;
  private child: Int32Array;
  private mask: number;
  private edges = 0;
  terminal: Uint8Array;
  private nodes = 1; // node 0 = root

  constructor(pieces: Iterable<string>) {
    this.rootBmp = new Int32Array(0x10000).fill(-1);
    const cap = 1 << 17;
    this.keyNode = new Int32Array(cap).fill(-1);
    this.keyCp = new Int32Array(cap);
    this.child = new Int32Array(cap);
    this.mask = cap - 1;
    let term = new Uint8Array(1024);
    for (const piece of pieces) {
      const cps = Array.from(piece, (c) => c.codePointAt(0) as number);
      let node = 0;
      for (let k = cps.length - 1; k >= 0; k--) {
        const cp = cps[k] as number;
        let next = this.next(node, cp);
        if (next < 0) {
          next = this.nodes++;
          this.insert(node, cp, next);
        }
        node = next;
      }
      if (node >= term.length) {
        const t = new Uint8Array(Math.max(term.length * 2, node + 1));
        t.set(term);
        term = t;
      }
      term[node] = 1;
    }
    const t = new Uint8Array(this.nodes);
    t.set(term.subarray(0, this.nodes));
    this.terminal = t;
  }

  private static slot(node: number, cp: number, mask: number): number {
    return ((Math.imul(node, 0x9e3779b1) ^ Math.imul(cp, 0x85ebca6b)) >>> 0) & mask;
  }

  private insert(node: number, cp: number, next: number): void {
    if (node === 0) {
      if (cp < 0x10000) this.rootBmp[cp] = next;
      else this.rootAstral.set(cp, next);
      return;
    }
    if ((this.edges + 1) * 2 > this.mask) this.rehash();
    let h = ReverseTrie.slot(node, cp, this.mask);
    while (this.keyNode[h] !== -1) h = (h + 1) & this.mask;
    this.keyNode[h] = node;
    this.keyCp[h] = cp;
    this.child[h] = next;
    this.edges++;
  }

  private rehash(): void {
    const oldNode = this.keyNode;
    const oldCp = this.keyCp;
    const oldChild = this.child;
    const cap = (this.mask + 1) * 2;
    this.keyNode = new Int32Array(cap).fill(-1);
    this.keyCp = new Int32Array(cap);
    this.child = new Int32Array(cap);
    this.mask = cap - 1;
    for (let i = 0; i < oldNode.length; i++) {
      const node = oldNode[i] as number;
      if (node === -1) continue;
      let h = ReverseTrie.slot(node, oldCp[i] as number, this.mask);
      while (this.keyNode[h] !== -1) h = (h + 1) & this.mask;
      this.keyNode[h] = node;
      this.keyCp[h] = oldCp[i] as number;
      this.child[h] = oldChild[i] as number;
    }
  }

  /** The child of `node` along `cp`, or -1. */
  next(node: number, cp: number): number {
    if (node === 0)
      return cp < 0x10000 ? (this.rootBmp[cp] as number) : (this.rootAstral.get(cp) ?? -1);
    const mask = this.mask;
    const keyNode = this.keyNode;
    let h = ReverseTrie.slot(node, cp, mask);
    for (;;) {
      const k = keyNode[h] as number;
      if (k === -1) return -1;
      if (k === node && this.keyCp[h] === cp) return this.child[h] as number;
      h = (h + 1) & mask;
    }
  }
}

/** What a codepoint costs when no piece covers it: its UTF-8 bytes over the byte prefixes. */
class ByteFloor {
  private readonly tokens: Set<string>;
  private readonly maxLen: number;

  constructor(bytePrefixes: readonly string[], unitChars: Iterable<number>) {
    this.tokens = new Set(bytePrefixes);
    for (const cp of unitChars) this.tokens.add(hexOf(utf8Of(cp)));
    let maxLen = 1;
    for (const k of this.tokens) maxLen = Math.max(maxLen, k.length >> 1);
    this.maxLen = maxLen;
  }

  /** engine.min_tile over the bytes: every single byte costs 1, so does every listed prefix. */
  costCodepoint(cp: number): number {
    const bs = utf8Of(cp);
    const n = bs.length;
    const best = [0];
    for (let i = 1; i <= n; i++) {
      let b = Number.POSITIVE_INFINITY;
      for (let j = Math.max(0, i - this.maxLen); j < i; j++) {
        if (i - j === 1 || this.tokens.has(hexOf(bs.slice(j, i)))) {
          b = Math.min(b, (best[j] as number) + 1);
        }
      }
      best.push(b);
    }
    return best[n] as number;
  }
}

function utf8Of(cp: number): number[] {
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
  if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
  return [
    0xf0 | (cp >> 18),
    0x80 | ((cp >> 12) & 0x3f),
    0x80 | ((cp >> 6) & 0x3f),
    0x80 | (cp & 0x3f),
  ];
}

function hexOf(bytes: readonly number[]): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export class TokenizerModel {
  private readonly trie: ReverseTrie;
  private readonly unitPieces: Set<number>;
  private readonly bytes: ByteFloor;
  private readonly bmpCharCost = new Int8Array(0x10000); // 0 = not computed
  private readonly astralCharCost = new Map<number, number>();
  private readonly tailCache = new Map<number, number>();

  constructor(doc: VocabDocument) {
    if (doc.meta.family !== 'v4.7')
      throw new Error(`unexpected vocabulary family ${doc.meta.family}`);
    const parsed = [...doc.pieces, ...doc.contractions, ...doc.markers];
    this.unitPieces = new Set<number>();
    for (const p of parsed) {
      const cp = p.codePointAt(0) as number;
      if (p.length === (cp > 0xffff ? 2 : 1) && !isMarkerGlyph(cp)) this.unitPieces.add(cp);
    }
    this.bytes = new ByteFloor(doc.bytesFallback, this.unitPieces);
    // engine.build_vocab: the parsed pieces plus each contraction glued to its ⟨eow⟩.
    const vocab = new Set(parsed);
    for (const c of doc.contractions) vocab.add(`${c}${String.fromCharCode(0xfdd1)}`);
    this.trie = new ReverseTrie(vocab);
  }

  /** engine.char_cost (+ the marker branch of tile's unit_floor). */
  private unitFloor(cp: number): number {
    if (isMarkerGlyph(cp)) return 1;
    const ch = unescapeMarkerLiteral(cp);
    if (ch < 0x10000) {
      const hit = this.bmpCharCost[ch] as number;
      if (hit !== 0) return hit;
    } else {
      const hit = this.astralCharCost.get(ch);
      if (hit !== undefined) return hit;
    }
    const cost = this.unitPieces.has(ch) ? 1 : this.bytes.costCodepoint(ch);
    if (ch < 0x10000) this.bmpCharCost[ch] = cost;
    else this.astralCharCost.set(ch, cost);
    return cost;
  }

  /** engine.min_vocab_tile, returning the total cost only. */
  tileCost(s: Int32Array, n: number, unitCostOne = false): number {
    const trie = this.trie;
    const terminal = trie.terminal;
    const best = new Int32Array(n + 1);
    for (let end = 1; end <= n; end++) {
      const start = end - 1;
      let node = trie.next(0, s[start] as number);
      let b =
        (best[start] as number) +
        (node >= 0 && terminal[node] === 1
          ? 1
          : unitCostOne
            ? 1
            : this.unitFloor(s[start] as number));
      if (node >= 0) {
        for (let st = end - 2; st >= 0; st--) {
          node = trie.next(node, s[st] as number);
          if (node < 0) break;
          if (terminal[node] === 1) {
            const cand = (best[st] as number) + 1;
            if (cand < b) b = cand;
          }
        }
      }
      best[end] = b;
    }
    return best[n] as number;
  }

  /**
   * engine.frame_tail: a content-final run of `n` LFs is tiled as `n + 2` (the frame appends two)
   * and the frame already pays for the last of those tokens.
   */
  frameTail(n: number): number {
    if (n === 0) return 0;
    const hit = this.tailCache.get(n);
    if (hit !== undefined) return hit;
    const run = new Int32Array(n + 2).fill(0x0a);
    const cost = this.tileCost(run, n + 2, true) - 1;
    if (n <= 4096) this.tailCache.set(n, cost);
    return cost;
  }
}

let model: TokenizerModel | undefined;

/** The v4.8 model, built from the bundled vocabulary on first use. */
export function getModel(): TokenizerModel {
  model ??= new TokenizerModel(JSON.parse(VOCAB_V4_7_JSON) as VocabDocument);
  return model;
}
