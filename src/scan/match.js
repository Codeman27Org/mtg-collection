// Pure card-identification helpers: fuzzy name matching, collector-line parsing, printing choice, and art hashes.

/** Lowercase ASCII-ish form of a name for comparison. */
export function normalizeName(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/æ/gi, 'ae')
    .replace(/[’‘`]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Only the front face is printed in the title bar ("Bonecrusher Giant // Stomp" reads "Bonecrusher Giant"). */
export const frontFace = (name) => String(name).split(' // ')[0];

/** names: every card name. Returns entries sorted by key length for fast length prefiltering. */
export function buildNameIndex(names) {
  const seen = new Set();
  const out = [];
  for (const name of names) {
    const key = normalizeName(frontFace(name));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ name, key, n: letters(key), pairs: pairsOf(key) });
  }
  return out;
}

/** Letter pairs as numbers (characters are ASCII after normalizeName). */
function pairsOf(s) {
  const out = new Uint16Array(Math.max(0, s.length - 1));
  for (let i = 0; i < out.length; i++) out[i] = ((s.charCodeAt(i) & 127) << 7) | (s.charCodeAt(i + 1) & 127);
  return out;
}

export function levenshtein(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Similarity 0–1, or 0 when it would be under min (which lets the edit distance stop early). */
const similarity = (a, b, min = 0.5) => prefixSimilarity(a, a.length, b, b.length, min);

let rowA = new Int32Array(256);
let rowB = new Int32Array(256);

/** Edit distance between a[0, al) and b[0, bl), or max + 1 once it must exceed max. Reuses its rows. */
function prefixDistance(a, al, b, bl, max) {
  if (Math.abs(al - bl) > max) return max + 1;
  if (bl >= rowA.length) {
    rowA = new Int32Array(bl + 1);
    rowB = new Int32Array(bl + 1);
  }
  let prev = rowA;
  let cur = rowB;
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j++) {
      let v = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      if (prev[j] + 1 < v) v = prev[j] + 1;
      if (cur[j - 1] + 1 < v) v = cur[j - 1] + 1;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[bl];
}

/** similarity() of a[0, al) and b[0, bl) without slicing. */
function prefixSimilarity(a, al, b, bl, min) {
  const len = al > bl ? al : bl;
  if (!len) return 0;
  const max = Math.floor((1 - min) * len);
  if (Math.abs(al - bl) > max) return 0;
  const d = prefixDistance(a, al, b, bl, max);
  return d > max ? 0 : 1 - d / len;
}

const letters = (s) => s.replace(/[^a-z0-9]/g, '').length;
const isLetter = (c) => c !== 32 && c !== 39;

/** Letters (not spaces or apostrophes) in a normalized string from index i on. */
function lettersFrom(s, i) {
  let n = 0;
  for (; i < s.length; i++) if (isLetter(s.charCodeAt(i))) n++;
  return n;
}

/**
 * Best name guesses for OCR text: [{ name, score }] (score 0–1), best first.
 * OCR often picks up stray marks from the mana cost or frame at the end, so a name that matches the start of the
 * text scores well, but less so the more is left over ("Fell" must not win over "Fell the Mighty"). A long name
 * whose end was cut off scores well the same way.
 */
export function matchName(index, text, limit = 3) {
  const full = normalizeName(text);
  if (full.length < 2) return [];
  // Frame edges often read as a stray letter or two before the name ("a bonecrusher giant"); try without them.
  const variants = [{ q: full, weight: 1 }];
  const words = full.split(' ');
  for (let drop = 1; drop <= 2 && words[drop - 1]?.length <= 2 && words.length > drop; drop++) {
    const rest = words.slice(drop).join(' ');
    if (letters(rest) >= 5) variants.push({ q: rest, weight: 0.98 });
  }
  for (const v of variants) {
    // tail[k]: letters in q from k on, for the "left over after the name" penalty.
    v.tail = new Uint16Array(v.q.length + 1);
    for (let k = v.q.length - 1; k >= 0; k--) v.tail[k] = v.tail[k + 1] + (isLetter(v.q.charCodeAt(k)) ? 1 : 0);
  }
  const total = letters(full);
  const readPairs = new Uint8Array(1 << 14);
  for (const { q } of variants) for (const p of pairsOf(q)) readPairs[p] = 1;
  const best = [];
  const tryEntry = ({ name, key, n }) => {
    // Only work out scores that could make the list.
    const floor = best.length < limit ? 0.4 : best[best.length - 1].score;
    // A name that accounts for little of what was read ("Dead" from "dead ncix") is a weak guess.
    const short = n < total * 0.6 ? 0.85 : 1;
    const kl = key.length;
    let score = 0;
    for (const { q, weight, tail } of variants) {
      const ql = q.length;
      if (kl > ql * 1.6 + 3 && ql < 6) continue;
      const m = weight * short;
      let bar = floor > score ? floor : score;
      if (m <= bar) continue;
      if (Math.abs(kl - ql) <= Math.max(3, ql * 0.4)) {
        const s = prefixSimilarity(key, kl, q, ql, bar / m) * m;
        if (s > score) score = s;
        bar = floor > score ? floor : score;
      }
      if (ql > kl + 1) {
        const mult = m * Math.max(0.5, 0.97 - 0.015 * tail[kl]);
        if (mult > bar) score = Math.max(score, prefixSimilarity(key, kl, q, kl, bar / mult) * mult);
      } else if (kl > ql + 1 && ql >= 6 && m * 0.97 > bar) {
        const mult = m * Math.max(0.5, 0.97 - 0.015 * lettersFrom(key, ql));
        if (mult > bar) score = Math.max(score, prefixSimilarity(key, ql, q, ql, bar / mult) * mult);
      }
    }
    if (score < 0.4 || (best.length >= limit && score <= floor)) return;
    best.push({ name, score });
    best.sort((a, b) => b.score - a.score);
    if (best.length > limit) best.pop();
  };
  // Names sharing most letter pairs with the reading go first, so the cutoff rises early and the rest are cheap.
  const later = [];
  for (const entry of index) {
    let shared = 0;
    for (const p of entry.pairs) shared += readPairs[p];
    if (shared * 2 >= entry.pairs.length) tryEntry(entry);
    else later.push(entry);
  }
  for (const entry of later) tryEntry(entry);
  return best;
}

/** How sure we are of the name: the best score, discounted when the runner-up is nearly as good. */
export function nameConfidence(matches) {
  const [a, b] = matches;
  if (!a) return 0;
  if (!b || a.score >= 0.97) return a.score;
  const margin = a.score - b.score;
  return margin >= 0.1 ? a.score : a.score * (0.85 + margin * 1.5);
}

const LANGS = 'EN|ES|FR|DE|IT|PT|JA|JP|KO|RU|ZHS|ZHT|CS|CT|PH';
const SET_LANG = new RegExp(`\\b([A-Z0-9]{3,5})\\s*[^\\sA-Z0-9]{0,2}\\s*(?:${LANGS})\\b`);
// OCR reads these letters and digits interchangeably in the small collector font.
const DIGITISH = { O: '0', Q: '0', D: '0', I: '1', L: '1', l: '1', '|': '1', S: '5', B: '8', Z: '2', G: '6' };

/**
 * Reads the bottom-left collector text: "123/264 R" or "R 0123" over "M20 • EN ✎ Artist".
 * Returns { set, number } with either possibly null. A bare number only counts next to a set code, since older
 * frames have none and OCR turns the artist line into stray digits.
 */
export function parseCollector(text) {
  const t = String(text ?? '').toUpperCase().replace(/[‘’`]/g, "'");
  const set = t.match(SET_LANG)?.[1] ?? null;
  let number = null;
  for (const line of t.split(/\n/)) {
    if (set && line.includes(set)) continue;
    const m = line.match(/(?:^|[^A-Z0-9])([0-9OQDILSBZG|]{1,4})\s*\/\s*[0-9OQDILSBZG|]{2,4}\b/) ?? (set ? line.match(/(?:^|\s)[CURMSLTP]?\s*([0-9]{1,4})(?:\s|$)/) : null);
    if (m) {
      const digits = [...m[1]].map((c) => DIGITISH[c] ?? c).join('');
      if (/^\d+$/.test(digits)) {
        number = String(parseInt(digits, 10));
        break;
      }
    }
  }
  return { set: set?.toLowerCase() ?? null, number };
}

const plainNumber = (n) => String(n ?? '').replace(/^0+(?=\d)/, '').toLowerCase();

/**
 * Narrows printings using the collector line.
 * Returns { card, confidence } for an exact hit, or { candidates } (possibly all printings) to compare art on.
 */
export function printingFromCollector(printings, { set, number }) {
  const inSet = set ? printings.filter((p) => p.set === set) : [];
  if (set && number) {
    const exact = inSet.find((p) => plainNumber(p.collector_number) === number);
    if (exact) return { card: exact, confidence: 0.95 };
  }
  if (number) {
    const byNumber = printings.filter((p) => plainNumber(p.collector_number) === number);
    // One OCR slip in the set code is common; a unique number plus a near-miss code is still a strong hit.
    const close = set ? byNumber.filter((p) => levenshtein(p.set, set, 1) <= 1) : [];
    if (close.length === 1) return { card: close[0], confidence: 0.9 };
    if (byNumber.length > 1) return { candidates: byNumber };
  }
  if (inSet.length === 1) return { card: inSet[0], confidence: 0.85 };
  if (inSet.length > 1) return { candidates: inSet };
  return { candidates: printings };
}

/**
 * Difference hash: 64 bits comparing neighboring brightness on a 9×8 grid.
 * gray: luminance values (row-major) of a w×h image. Returns a Uint8Array of 0/1.
 */
export function dHash(gray, w, h) {
  const cells = new Float64Array(72);
  const counts = new Uint32Array(72);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(7, Math.floor((y * 8) / h));
    for (let x = 0; x < w; x++) {
      const gx = Math.min(8, Math.floor((x * 9) / w));
      cells[gy * 9 + gx] += gray[y * w + x];
      counts[gy * 9 + gx]++;
    }
  }
  const bits = new Uint8Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const a = cells[y * 9 + x] / (counts[y * 9 + x] || 1);
      const b = cells[y * 9 + x + 1] / (counts[y * 9 + x + 1] || 1);
      bits[y * 8 + x] = a > b ? 1 : 0;
    }
  }
  return bits;
}

export function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/**
 * Confidence for the closest art. best/next: Hamming distances (0–64) of the closest and runner-up distinct artwork.
 * Different artwork is usually 25+ apart; the same artwork photographed is usually under 14.
 */
export function artConfidence(best, next = null) {
  const closeness = 1 - Math.max(0, best - 10) / 30;
  if (next == null) return Math.max(0, Math.min(0.95, closeness));
  const margin = Math.min(1, 0.4 + (next - best) / 15);
  return Math.max(0, Math.min(0.95, closeness * margin));
}

/**
 * Picks one printing among copies of the same artwork: one you own, else the newest.
 * owned: Set of scryfallIds in the collection. before: an ISO date to prefer printings released earlier (when the
 * card looks like an older frame).
 */
export function preferPrinting(printings, owned, { before } = {}) {
  // Reprints numbered like "ELD-115" (The List and similar) are rarely what's in hand when the art is the same.
  const listed = (p) => (/^[A-Z0-9]+-\d/i.test(String(p.collector_number ?? '')) ? 1 : 0);
  const byNewest = [...printings].sort(
    (a, b) => listed(a) - listed(b) || String(b.released_at ?? '').localeCompare(String(a.released_at ?? '')),
  );
  return (
    byNewest.find((p) => owned?.has(p.id)) ??
    (before ? byNewest.find((p) => String(p.released_at ?? '') < before) : null) ??
    byNewest[0]
  );
}

/** First set with the set code and language in the collector line (Magic 2015). Earlier frames have neither. */
export const COLLECTOR_LINE_SINCE = '2014-07-18';

/** Printings grouped by artwork: Map illustrationId → printings. Printings without one get their own group. */
export function groupByArt(printings) {
  const groups = new Map();
  for (const p of printings) {
    const key = p.illustration_id ?? `card:${p.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return groups;
}

/** Finish for a scanned copy: the foil toggle, limited to finishes the printing actually has. */
export function finishFor(card, foil) {
  const finishes = card?.finishes?.length ? card.finishes : ['nonfoil'];
  if (foil) return finishes.find((f) => f === 'foil') ?? finishes.find((f) => f === 'etched') ?? finishes[0];
  return finishes.includes('nonfoil') ? 'nonfoil' : finishes[0];
}
