/**
 * Per-codepoint tables and predicates for the Claude tokenizer port (ctok v4.8 family).
 *
 * Port of the character-level parts of ctok/constants.py and ctok/normalize.py from
 * https://github.com/sanderland/ctok (MIT, Copyright (c) 2026 Sander Land; see ./LICENSE),
 * commit 8c43ffd3c7be467622a540f025516e49ef78d8b1.
 *
 * Unicode data source. ctok reads Python's `unicodedata` (category, combining class, case
 * flags, lower()) and the `regex` module (\p{M}, \p{Alphabetic}); this port reads ICU through
 * `\p{...}` regex properties, `toLowerCase()` and `normalize()`. The two can disagree on
 * codepoints assigned or re-cased between their Unicode versions. Every result here is cached per
 * codepoint, so each property is computed once per distinct character.
 */

// ---- marker glyphs (constants.py) ------------------------------------------------------------

export const BOW = 0xfdd0;
export const EOW = 0xfdd1;
export const SHIFT = 0xfdd3;
export const CAPS = 0xfdd4;
// U+FDD2 is ⟨pad⟩: a frame token with no in-stream role.

/** BOW / EOW / SHIFT / CAPS (not PAD): a marker no piece absorbed tiles as itself. */
export function isMarkerGlyph(cp: number): boolean {
  return cp === BOW || cp === EOW || cp === SHIFT || cp === CAPS;
}

/**
 * Literal U+FDD0..U+FDD4 in the text are escaped to U+E000..U+E004 after NFC (BMP private use is
 * stripped by then, so the escapes cannot collide with text). Maps an escape back to the literal.
 */
export function unescapeMarkerLiteral(cp: number): number {
  return cp >= 0xe000 && cp <= 0xe004 ? cp - 0xe000 + 0xfdd0 : cp;
}

// ---- stream classes ----------------------------------------------------------------------------

export const WORDY = 1;
export const HARD = 2;
export const DIGIT = 3;
export const PUNCT = 4;
export const SPACE = 5;
/** ctok `_STRAY_MARK`: a run of combining marks with no base in front of them. Runs only. */
export const STRAY = 6;

// ---- general category ----------------------------------------------------------------------------

const CATEGORIES = [
  'Lu',
  'Ll',
  'Lt',
  'Lm',
  'Lo',
  'Mn',
  'Mc',
  'Me',
  'Nd',
  'Nl',
  'No',
  'Pc',
  'Pd',
  'Ps',
  'Pe',
  'Pi',
  'Pf',
  'Po',
  'Sm',
  'Sc',
  'Sk',
  'So',
  'Zs',
  'Zl',
  'Zp',
  'Cc',
  'Cf',
  'Cs',
  'Co',
  'Cn',
] as const;
type Category = (typeof CATEGORIES)[number];
const CATEGORY_RE = new RegExp(`^(?:${CATEGORIES.map((c) => `(\\p{gc=${c}})`).join('|')})$`, 'u');

const bmpCategory = new Uint8Array(0x10000); // index + 1; 0 = not computed yet
const astralCategory = new Map<number, number>();

function categoryIndex(cp: number): number {
  const cached = cp < 0x10000 ? bmpCategory[cp] : (astralCategory.get(cp) ?? 0);
  if (cached !== 0) return cached - 1;
  const m = CATEGORY_RE.exec(String.fromCodePoint(cp));
  let idx = CATEGORIES.length - 1; // Cn
  if (m) {
    for (let g = 1; g < m.length; g++) {
      if (m[g] !== undefined) {
        idx = g - 1;
        break;
      }
    }
  }
  if (cp < 0x10000) bmpCategory[cp] = idx + 1;
  else astralCategory.set(cp, idx + 1);
  return idx;
}

/** `unicodedata.category`, from ICU. */
export function category(cp: number): Category {
  return CATEGORIES[categoryIndex(cp)] as Category;
}

const MARK_RE = /^\p{M}$/u;
const ALPHABETIC_RE = /^\p{Alphabetic}$/u;
const UPPERCASE_RE = /^\p{Uppercase}$/u;

function isMark(cp: number): boolean {
  return MARK_RE.test(String.fromCodePoint(cp));
}

function isAlphabetic(cp: number): boolean {
  return ALPHABETIC_RE.test(String.fromCodePoint(cp));
}

/**
 * `unicodedata.combining(c) != 0`. JS exposes no combining class, so ask NFD's canonical
 * reordering: U+0345 has class 240, the highest any codepoint has, so NFD moves a following
 * codepoint in front of it exactly when that codepoint's class is in 1..239. A precomposed
 * character decomposes to a class-0 starter and stays put, which is its own class (0). The only
 * class-0 characters whose decomposition starts with a non-starter (U+0F73, U+0F75, U+0F81) and
 * the class-230 U+0344 are composition exclusions, so NFC has replaced them before this is asked.
 */
const YPOGEGRAMMENI = String.fromCharCode(0x0345);

function hasCombiningClass(cp: number): boolean {
  if (cp === 0x0345) return true;
  if (cp === 0x0f73 || cp === 0x0f75 || cp === 0x0f81) return false;
  return !(YPOGEGRAMMENI + String.fromCodePoint(cp)).normalize('NFD').startsWith(YPOGEGRAMMENI);
}

// ---- case (normalize.py _lower / _is_upper) ------------------------------------------------------

/** Python 3.13 ships Unicode 15.1; ctok adds these Unicode 16.0 case pairs by hand. */
const NEW_CASE_PAIRS = new Map<number, number>([
  [0x1c89, 0x1c8a],
  [0xa7cb, 0x0264],
]);
const NEW_CASED = new Set<number>([0x1c89, 0x1c8a, 0xa7cb, 0x0264]);
/** ϴ: category Lu, measured caseless. */
const UNCASED = 0x03f4;

const bmpLower: (string | undefined)[] = new Array(0x10000);

/** ctok `_lower` of one codepoint: Python's per-character full lowercase mapping. */
export function lowerOf(cp: number): string {
  if (cp >= 0x41 && cp <= 0x5a) return String.fromCharCode(cp + 32);
  if (cp < 0x10000) {
    const hit = bmpLower[cp];
    if (hit !== undefined) return hit;
  }
  const c = String.fromCodePoint(cp);
  let lowered: string;
  if (cp === UNCASED) lowered = c;
  else {
    const pair = NEW_CASE_PAIRS.get(cp);
    lowered = pair !== undefined ? String.fromCodePoint(pair) : c.toLowerCase();
  }
  if (cp < 0x10000) bmpLower[cp] = lowered;
  return lowered;
}

/** `lowerOf(cp)` is `cp` itself. */
export function lowersToItself(cp: number): boolean {
  const l = lowerOf(cp);
  return l.length === (cp < 0x10000 ? 1 : 2) && l.codePointAt(0) === cp;
}

// ---- per-codepoint flags -------------------------------------------------------------------------

const F_CLASS = 0x7; // WORDY..SPACE
const F_STRAY = 0x8; // _stray_mark (asked only of WORDY codepoints)
const F_PUNCT_LIKE = 0x10; // _marks_like_punct
const F_DIGIT_BORDER = 0x20; // _digit_border
const F_SELECTOR = 0x40; // U+FE00..U+FE0F
const F_UPPER = 0x80; // _is_upper
const F_DIGIT_CAT_SHIFT = 8; // 0 = other, 1 = Nd, 2 = No (for _digit_run)
const F_DONE = 0x8000;

const bmpFlags = new Uint16Array(0x10000);
const astralFlags = new Map<number, number>();

// constants.py PUNCT_SYMS: enumerated, no categorical rule reproduces it.
const PUNCT_SYMS = new Set(
  Array.from('—»«•°„–−£§€…√→（№†└│།·─═█', (c) => c.codePointAt(0) as number),
);
// constants.py IDEOGRAPHIC_SYMBOLS.
const IDEOGRAPHIC_SYMBOLS = new Set([
  0x3004, 0x3012, 0x3013, 0x3020, 0x3036, 0x3037, 0x303e, 0x303f,
]);
// constants.py SYMBOL_LETTERS.
const SYMBOL_LETTERS: readonly (readonly [number, number])[] = [
  [0x16ee, 0x16f0],
  [0x2160, 0x2188],
  [0x24b6, 0x24e9],
  [0xa6e6, 0xa6ef],
];
// normalize.py is_hard_cp: the ideographic iteration and closing marks.
const HARD_MARKS = new Set([
  0x3005, 0x3006, 0x3031, 0x3032, 0x3033, 0x3034, 0x3035, 0x303b, 0x303c,
]);

function isSelector(cp: number): boolean {
  return cp >= 0xfe00 && cp <= 0xfe0f;
}

function isHardCp(o: number): boolean {
  return (
    o >= 0x10000 ||
    (o >= 0x4e00 && o <= 0x9fff) ||
    (o >= 0x3400 && o <= 0x4dbf) ||
    (o >= 0xf900 && o <= 0xfaff) ||
    (o >= 0xac00 && o <= 0xd7a3) ||
    HARD_MARKS.has(o)
  );
}

/** normalize.py is_separator: a non-Alphabetic BMP mark (not a variation selector). */
function isSeparator(cp: number): boolean {
  return cp < 0x10000 && isMark(cp) && !isSelector(cp) && !isAlphabetic(cp);
}

/** normalize.py classify. */
function classify(cp: number): number {
  if (NEW_CASED.has(cp)) return WORDY;
  const cat = category(cp);
  if (cat[0] === 'Z' || cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x0c || cp === 0x0b) {
    return SPACE;
  }
  for (const [lo, hi] of SYMBOL_LETTERS) if (cp >= lo && cp <= hi) return WORDY;
  if (
    cat === 'Nd' &&
    (cp < 0x80 || (cp >= 0x0660 && cp <= 0x0669) || (cp >= 0x06f0 && cp <= 0x06f9))
  ) {
    return DIGIT;
  }
  if (cp < 0x80 && (cat[0] === 'P' || cat[0] === 'S')) return PUNCT;
  if (PUNCT_SYMS.has(cp)) return PUNCT;
  if (isSelector(cp)) return HARD;
  if (isMark(cp)) return cp < 0x10000 && isAlphabetic(cp) ? WORDY : HARD;
  if (cat[0] === 'L' && !isHardCp(cp)) return WORDY;
  return HARD;
}

/** normalize.py _syriac_vowel. */
function isSyriacVowel(cp: number): boolean {
  return cp === 0x0711 || (cp >= 0x0730 && cp <= 0x073f);
}

/** normalize.py _stray_mark. */
function isStrayMark(cp: number): boolean {
  if (isSyriacVowel(cp)) return false;
  return hasCombiningClass(cp) && !isSeparator(cp);
}

/** normalize.py _marks_like_punct (including its marker-escape lookup). */
function marksLikePunct(cp: number): boolean {
  const ch = unescapeMarkerLiteral(cp);
  if (ch >= 0x10000) return false;
  if (isSeparator(ch)) return true;
  const cat = category(ch);
  const ideographicPunct =
    ch >= 0x3001 && ch <= 0x303f && (cat[0] === 'P' || IDEOGRAPHIC_SYMBOLS.has(ch));
  return (cat[0] === 'P' || cat[0] === 'S' || cat === 'Cf' || cat === 'Cn') && !ideographicPunct;
}

/** normalize.py _digit_border. */
function isDigitBorder(cp: number): boolean {
  const cat = category(cp);
  return (cat === 'No' || (cat === 'Nd' && cp >= 0x80)) && cp < 0x10000;
}

/** normalize.py _is_upper. */
function isUpperCp(cp: number): boolean {
  if (cp === UNCASED) return false;
  if (NEW_CASE_PAIRS.has(cp)) return true;
  return UPPERCASE_RE.test(String.fromCodePoint(cp)) && !lowersToItself(cp);
}

function computeFlags(cp: number): number {
  const cls = classify(cp);
  let f = cls | F_DONE;
  if (cls === WORDY && isStrayMark(cp)) f |= F_STRAY;
  if (marksLikePunct(cp)) f |= F_PUNCT_LIKE;
  if (isDigitBorder(cp)) f |= F_DIGIT_BORDER;
  if (isSelector(cp)) f |= F_SELECTOR;
  if (isUpperCp(cp)) f |= F_UPPER;
  const cat = category(cp);
  if (cat === 'Nd') f |= 1 << F_DIGIT_CAT_SHIFT;
  else if (cat === 'No') f |= 2 << F_DIGIT_CAT_SHIFT;
  return f;
}

/** All per-codepoint flags, computed once per codepoint. */
export function flagsOf(cp: number): number {
  if (cp < 0x10000) {
    const f = bmpFlags[cp];
    if (f !== 0) return f;
    const g = computeFlags(cp);
    bmpFlags[cp] = g;
    return g;
  }
  let f = astralFlags.get(cp);
  if (f === undefined) {
    f = computeFlags(cp);
    astralFlags.set(cp, f);
  }
  return f;
}

export function classOf(f: number): number {
  return f & F_CLASS;
}
export function strayOf(f: number): boolean {
  return (f & F_STRAY) !== 0;
}
export function punctLikeOf(f: number): boolean {
  return (f & F_PUNCT_LIKE) !== 0;
}
export function digitBorderOf(f: number): boolean {
  return (f & F_DIGIT_BORDER) !== 0;
}
export function selectorOf(f: number): boolean {
  return (f & F_SELECTOR) !== 0;
}
export function upperOf(f: number): boolean {
  return (f & F_UPPER) !== 0;
}
/** 0 = neither, 1 = Nd, 2 = No. */
export function digitCatOf(f: number): number {
  return (f >> F_DIGIT_CAT_SHIFT) & 0x3;
}

/** Test hook: the raw predicates, uncached, for comparing against Python's tables. */
export const unicodeInternals = {
  category,
  classify,
  isStrayMark,
  marksLikePunct,
  isDigitBorder,
  isUpperCp,
  lowerOf,
  hasCombiningClass,
  isMark,
  isAlphabetic,
};
