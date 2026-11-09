/**
 * Text → the marked stream the tiler tiles (ctok v4.8 family: no case-caps marker, no quote
 * folding, no ⟨bow⟩ at the frame head).
 *
 * Port of ctok/normalize.py (`nfc`, `_runs`, `mark_case`, `stream_norm`) from
 * https://github.com/sanderland/ctok (MIT, Copyright (c) 2026 Sander Land; see ./LICENSE),
 * commit 8c43ffd3c7be467622a540f025516e49ef78d8b1. Only the v4.8 branches are kept: the
 * `frame_bow`, `allcaps_min` and `fold_quotes` switches are fixed at False / None / False.
 *
 * The stream is built as an Int32Array of codepoints instead of a string, so the tiler never
 * re-decodes it and the hot loops allocate nothing per character.
 */

import {
  BOW,
  CAPS,
  classOf,
  DIGIT,
  digitBorderOf,
  digitCatOf,
  EOW,
  flagsOf,
  HARD,
  lowerOf,
  lowersToItself,
  PUNCT,
  punctLikeOf,
  SHIFT,
  SPACE,
  STRAY,
  selectorOf,
  strayOf,
  upperOf,
  WORDY,
} from './unicode.js';

// ---- nfc (normalize.py nfc, constants.py) --------------------------------------------------------

function charClass(ranges: readonly (readonly [number, number])[]): RegExp {
  const hex = (cp: number) => `\\u${cp.toString(16).padStart(4, '0')}`;
  const body = ranges.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join('');
  return new RegExp(`[${body}]`, 'g');
}

/** C0/C1 controls the API strips: every gc=Cc except TAB, LF and NUL. */
const STRIP_CONTROL = charClass([
  [0x01, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
]);
/** BMP private use. */
const STRIP_PRIVATE = charClass([[0xe000, 0xf8ff]]);
/** Space separators read as U+0020 (all Zs but U+3000, plus Zl/Zp). */
const FUNNY_SPACE = charClass([
  [0x00a0, 0x00a0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
]);
const MARKER_LITERAL = charClass([[0xfdd0, 0xfdd4]]);
const THAI_SARA_AM_DECOMPOSED = String.fromCharCode(0x0e4d, 0x0e32);
const THAI_SARA_AM = String.fromCharCode(0x0e33);

/**
 * ctok `nfc(text, fold_quotes=False)`: lone surrogates → U+FFFD, NFC, strip controls, NUL →
 * space, compose Thai SARA AM, strip BMP private use, fold the space separators.
 */
export function normalizeText(text: string): string {
  let t = text.toWellFormed().normalize('NFC');
  t = t.replace(STRIP_CONTROL, '');
  if (t.includes('\0')) t = t.replaceAll('\0', ' ');
  if (t.includes(THAI_SARA_AM_DECOMPOSED)) t = t.replaceAll(THAI_SARA_AM_DECOMPOSED, THAI_SARA_AM);
  t = t.replace(STRIP_PRIVATE, '');
  return t.replace(FUNNY_SPACE, ' ');
}

// ---- growable codepoint buffer -------------------------------------------------------------------

class CodepointBuffer {
  buf: Int32Array;
  len = 0;

  constructor(capacity: number) {
    this.buf = new Int32Array(Math.max(16, capacity));
  }

  push(cp: number): void {
    if (this.len === this.buf.length) this.grow(1);
    this.buf[this.len++] = cp;
  }

  pushRange(src: Int32Array, start: number, end: number): void {
    const n = end - start;
    if (this.len + n > this.buf.length) this.grow(n);
    this.buf.set(src.subarray(start, end), this.len);
    this.len += n;
  }

  pushString(s: string): void {
    for (let i = 0; i < s.length; i++) {
      const cp = s.codePointAt(i) as number;
      if (cp > 0xffff) i++;
      this.push(cp);
    }
  }

  private grow(extra: number): void {
    const next = new Int32Array(Math.max(this.buf.length * 2, this.len + extra));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
}

function toCodepoints(s: string): { cps: Int32Array; n: number } {
  const cps = new Int32Array(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        cps[n++] = ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000;
        i++;
        continue;
      }
    }
    cps[n++] = c;
  }
  return { cps, n };
}

// ---- runs (normalize.py _runs) -------------------------------------------------------------------

const KIND_PUNCT = 1;
const KIND_NUMBER = 2;
const KIND_LETTER = 3;

/** normalize.py _hard_kind. */
function hardKind(f: number): number {
  if (punctLikeOf(f)) return KIND_PUNCT;
  if (digitBorderOf(f)) return KIND_NUMBER;
  return KIND_LETTER;
}

interface Runs {
  cls: number[];
  start: number[];
  end: number[];
}

function splitRuns(cps: Int32Array, n: number): Runs {
  const cls: number[] = [];
  const start: number[] = [];
  const end: number[] = [];
  if (n === 0) return { cls, start, end };

  // Pass 1: maximal same-class runs, with baseless combining marks as their own runs.
  const pushRun = (c: number, s: number, e: number) => {
    if (c !== HARD || e - s === 1) {
      cls.push(c);
      start.push(s);
      end.push(e);
      return;
    }
    // Pass 2, inline: a HARD run splits where the pretoken kind changes; a variation selector
    // rides its base's sub-run.
    let subStart = s;
    let kind = hardKind(flagsOf(cps[s] as number));
    for (let k = s + 1; k < e; k++) {
      const f = flagsOf(cps[k] as number);
      if (selectorOf(f)) continue;
      const kk = hardKind(f);
      if (kk === kind) continue;
      cls.push(HARD);
      start.push(subStart);
      end.push(k);
      subStart = k;
      kind = kk;
    }
    cls.push(HARD);
    start.push(subStart);
    end.push(e);
  };

  const f0 = flagsOf(cps[0] as number);
  let curCls = classOf(f0);
  if (curCls === WORDY && strayOf(f0)) curCls = STRAY;
  let curStart = 0;
  for (let i = 1; i < n; i++) {
    const f = flagsOf(cps[i] as number);
    const c = classOf(f);
    if (curCls === STRAY && c === WORDY && strayOf(f)) continue;
    if (c === curCls) continue;
    pushRun(curCls, curStart, i);
    curStart = i;
    curCls = c === WORDY && strayOf(f) && curCls !== WORDY ? STRAY : c;
  }
  pushRun(curCls, curStart, n);
  return { cls, start, end };
}

// ---- the marked stream (normalize.py stream_norm) ------------------------------------------------

const APOSTROPHE = 0x27;
const SPACE_CP = 0x20;
const SHARP_S_CAPITAL = 0x1e9e; // ẞ
const I_DOT = 0x0130; // İ

/** CONTRACTION_SUFFIXES: s t d m ll re ve, lowercase, whole word. */
function isContractionSuffix(cps: Int32Array, s: number, e: number): boolean {
  const n = e - s;
  const a = cps[s] as number;
  if (n === 1) return a === 0x73 || a === 0x74 || a === 0x64 || a === 0x6d;
  if (n !== 2) return false;
  const b = cps[s + 1] as number;
  return (a === 0x6c && b === 0x6c) || (a === 0x72 && b === 0x65) || (a === 0x76 && b === 0x65);
}

/**
 * Build the marked stream of already-normalized text with its content-final newline run removed.
 * Returns the stream as codepoints in `out.buf[0, out.len)`.
 */
function streamNorm(norm: string): CodepointBuffer {
  const { cps, n } = toCodepoints(norm);
  const { cls, start, end } = splitRuns(cps, n);
  const nRuns = cls.length;
  const out = new CodepointBuffer(n + (n >> 1) + 16);
  if (nRuns === 0) return out;

  const first = (i: number) => cps[start[i] as number] as number;
  const last = (i: number) => cps[(end[i] as number) - 1] as number;
  const isLoneApostrophe = (i: number) =>
    (end[i] as number) - (start[i] as number) === 1 && first(i) === APOSTROPHE;

  /** _hard_bow / _hard_eow: the border character is a selector or reads as punctuation. */
  const hardBorder = (cp: number) => {
    const f = flagsOf(cp);
    return selectorOf(f) || punctLikeOf(f);
  };
  const hardBow = (i: number) => hardBorder(first(i));
  const hardEow = (i: number) => hardBorder(last(i));

  /** _digit_run: a uniform run of Nd or of No. */
  const digitRun = (i: number) => {
    const s = start[i] as number;
    const e = end[i] as number;
    const dc = digitCatOf(flagsOf(cps[s] as number));
    if (dc === 0) return false;
    for (let k = s + 1; k < e; k++) if (digitCatOf(flagsOf(cps[k] as number)) !== dc) return false;
    return true;
  };
  const digitBow = (i: number) => digitBorderOf(flagsOf(first(i))) && digitRun(i);
  const digitEow = (i: number) => digitBorderOf(flagsOf(last(i))) && digitRun(i);

  /** borders_space, with frame_bow False: the message start is not a space. */
  const bordersSpace = (i: number, side: number) => {
    const j = i + side;
    if (j < 0 || j >= nRuns || cls[j] !== SPACE) return false;
    if (side < 0) return last(j) === SPACE_CP;
    const s = start[j] as number;
    return cps[s] === SPACE_CP && !((end[j] as number) - s >= 2 && cps[s + 1] === SPACE_CP);
  };

  /** _opens_word: a lone `'` in front of a word. */
  const opensWord = (i: number) =>
    isLoneApostrophe(i) && i + 1 < nRuns && (cls[i + 1] === WORDY || cls[i + 1] === STRAY);

  /** _takes_right_border. */
  const takesRightBorder = (j: number) => {
    const c = cls[j];
    return c === PUNCT || hardEow(j) || ((c === DIGIT || c === HARD) && digitEow(j));
  };

  /** _contraction_seam. */
  const contractionSeam = (i: number) => {
    if (i === 0 || !isContractionSuffix(cps, start[i] as number, end[i] as number)) return false;
    if (cls[i - 1] !== PUNCT || !isLoneApostrophe(i - 1)) return false;
    return i < 2 || !takesRightBorder(i - 2);
  };

  for (let i = 0; i < nRuns; i++) {
    const c = cls[i] as number;
    const s = start[i] as number;
    const e = end[i] as number;
    if (c === WORDY) {
      const fused = i > 0 && cls[i - 1] === STRAY;
      const mode = fused ? CASE_LITERAL : markCase(cps, s, e);
      if (mode !== CASE_LITERAL) out.push(SHIFT);
      if (!(fused || contractionSeam(i))) out.push(BOW);
      if (mode === CASE_LITERAL) out.pushRange(cps, s, e);
      else pushLowered(out, cps, s, e, mode === CASE_SHIFT_KEEP_I_DOT);
      out.push(EOW);
    } else if (c === STRAY) {
      out.push(BOW);
      out.pushRange(cps, s, e);
      if (!(i + 1 < nRuns && cls[i + 1] === WORDY)) out.push(EOW);
    } else if (c === PUNCT || hardBow(i) || hardEow(i)) {
      const takesBow = bordersSpace(i, -1) && !opensWord(i) && (c === PUNCT || hardBow(i));
      if (takesBow) out.push(BOW);
      out.pushRange(cps, s, e);
      if (bordersSpace(i, 1) && (c === PUNCT || hardEow(i))) out.push(EOW);
    } else if ((c === DIGIT || c === HARD) && digitRun(i)) {
      if (digitBow(i) && bordersSpace(i, -1)) out.push(BOW);
      out.pushRange(cps, s, e);
      if (digitEow(i) && bordersSpace(i, 1)) out.push(EOW);
    } else {
      out.pushRange(cps, s, e);
    }
  }
  applySeam(out);
  return out;
}

const CASE_LITERAL = 0;
const CASE_SHIFT = 1;
const CASE_SHIFT_KEEP_I_DOT = 2;

/**
 * mark_case with allcaps_min=None and head_mark=False: a title-case span becomes ⟨shift⟩ +
 * lowercase, everything else stays literal. Wordy spans are BMP-only (astral letters classify
 * HARD), so `cps` here never holds an astral codepoint.
 */
function markCase(cps: Int32Array, s: number, e: number): number {
  let hasIDot = false;
  for (let k = s; k < e; k++) {
    const cp = cps[k] as number;
    if (cp === SHARP_S_CAPITAL) return CASE_LITERAL;
    if (cp === I_DOT) hasIDot = true;
  }
  const head = cps[s] as number;
  if (hasIDot) {
    if (!upperOf(flagsOf(head)) || head === I_DOT) return CASE_LITERAL;
    for (let k = s + 1; k < e; k++) {
      const cp = cps[k] as number;
      if (cp !== I_DOT && upperOf(flagsOf(cp))) return CASE_LITERAL;
    }
    return CASE_SHIFT_KEEP_I_DOT;
  }
  if (lowersToItself(head)) return CASE_LITERAL;
  if (!upperOf(flagsOf(head))) return CASE_LITERAL;
  for (let k = s + 1; k < e; k++) if (upperOf(flagsOf(cps[k] as number))) return CASE_LITERAL;
  return CASE_SHIFT;
}

/** _lower over the span, one codepoint at a time (so no Final_Sigma context). */
function pushLowered(
  out: CodepointBuffer,
  cps: Int32Array,
  s: number,
  e: number,
  keepIDotInTail: boolean,
): void {
  for (let k = s; k < e; k++) {
    const cp = cps[k] as number;
    if (keepIDotInTail && k > s && cp === I_DOT) out.push(cp);
    else if (cp >= 0x41 && cp <= 0x5a) out.push(cp + 32);
    else if (cp < 0x80) out.push(cp);
    else out.pushString(lowerOf(cp));
  }
}

/**
 * constants.py SEAM_RE: `(.)⟨eow⟩ ([⟨shift⟩⟨caps⟩]*)⟨bow⟩` → `\1⟨eow⟩\2⟨bow⟩`, i.e. the single
 * space between two marked spans is not written. Python's `.` is any codepoint but LF; matches
 * do not overlap and resume after the ⟨bow⟩. Compacts `out` in place.
 */
function applySeam(out: CodepointBuffer): void {
  const b = out.buf;
  const n = out.len;
  let w = 0;
  let p = 0;
  while (p < n) {
    const ch = b[p] as number;
    if (ch !== 0x0a && p + 2 < n && b[p + 1] === EOW && b[p + 2] === SPACE_CP) {
      let k = p + 3;
      while (k < n && (b[k] === SHIFT || b[k] === CAPS)) k++;
      if (k < n && b[k] === BOW) {
        b[w++] = ch;
        b[w++] = EOW;
        for (let m = p + 3; m <= k; m++) b[w++] = b[m] as number;
        p = k + 1;
        continue;
      }
    }
    b[w++] = ch;
    p++;
  }
  out.len = w;
}

export interface MarkedStream {
  /** The marked stream, as codepoints in `cps[0, length)`. */
  cps: Int32Array;
  length: number;
  /** Length of the content-final LF run that the frame's newline ladder prices separately. */
  tailNewlines: number;
}

/** engine.tile's front half: normalize, read the final newline run, build the stream. */
export function markedStream(text: string): MarkedStream {
  let norm = normalizeText(text);
  let tail = 0;
  while (tail < norm.length && norm.charCodeAt(norm.length - 1 - tail) === 0x0a) tail++;
  if (tail > 0) norm = norm.slice(0, norm.length - tail);
  // Literal marker codepoints become private-use escapes (NFC-stage stripping removed all real
  // private use, so the escapes cannot collide with text).
  MARKER_LITERAL.lastIndex = 0;
  if (MARKER_LITERAL.test(norm)) {
    norm = norm.replace(MARKER_LITERAL, (m) =>
      String.fromCharCode(m.charCodeAt(0) - 0xfdd0 + 0xe000),
    );
  }
  const out = streamNorm(norm);
  return { cps: out.buf, length: out.len, tailNewlines: tail };
}
