// Identifies a card from an image: title OCR → name, then collector line or artwork → printing.
import { readText, readLines } from './ocr.js';
import { REGIONS, region, findCardEdges } from './geometry.js';
import {
  buildNameIndex,
  matchName,
  nameConfidence,
  parseCollector,
  printingFromCollector,
  dHash,
  hamming,
  artConfidence,
  preferPrinting,
  groupByArt,
  COLLECTOR_LINE_SINCE,
} from './match.js';
import * as scryfall from '../scryfall.js';
import { cardImage, isBasicLand } from '../card-utils.js';

let indexPromise = null;

/** The name catalog, downloaded once a week (about 240 KB). */
export function nameIndex() {
  indexPromise ??= scryfall.cardNames().then(buildNameIndex);
  indexPromise.catch(() => (indexPromise = null));
  return indexPromise;
}

/**
 * Crops a rect and scales it so its height is targetH. Tesseract binarizes on its own and does worse on
 * pre-stretched contrast, so the only other processing is an optional invert for light-on-dark titles.
 */
function prepare(source, rect, targetH, invert = false) {
  const scale = targetH / rect.h;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.w * scale));
  canvas.height = Math.max(1, Math.round(rect.h * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: invert });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
  if (invert) {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = 255 - img.data[i];
      img.data[i + 1] = 255 - img.data[i + 1];
      img.data[i + 2] = 255 - img.data[i + 2];
    }
    ctx.putImageData(img, 0, 0);
  }
  return canvas;
}

/** The top of the card where the title can be when the card isn't lined up with the guide. */
const TITLE_AREA = [0.03, -0.02, 0.85, 0.2];

const sizeOf = (source) => ({ w: source.videoWidth || source.naturalWidth || source.width, h: source.videoHeight || source.naturalHeight || source.height });

/**
 * Finds the card's actual outline near where it should be (rect), from the straight edges of its border.
 * Returns a rect in source pixels, or null when no card-shaped outline stands out.
 */
export function locateCard(source, rect) {
  const size = sizeOf(source);
  const pad = 0.15;
  const x0 = Math.max(0, rect.x - rect.w * pad);
  const y0 = Math.max(0, rect.y - rect.h * pad);
  const area = { x: x0, y: y0, w: Math.min(size.w, rect.x + rect.w * (1 + pad)) - x0, h: Math.min(size.h, rect.y + rect.h * (1 + pad)) - y0 };
  if (area.w <= 0 || area.h <= 0) return null;
  const H = 320;
  const scale = H / area.h;
  const W = Math.max(1, Math.round(area.w * scale));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, area.x, area.y, area.w, area.h, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const g = new Float32Array(W * H);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  // Measure along the middle half of each side, away from corners and whatever sits beside the card.
  const rows = new Float32Array(H);
  for (let y = 1; y < H - 1; y++) {
    let s = 0;
    for (let x = Math.floor(W * 0.25); x < W * 0.75; x++) s += Math.abs(g[(y + 1) * W + x] - g[(y - 1) * W + x]);
    rows[y] = s;
  }
  const cols = new Float32Array(W);
  for (let x = 1; x < W - 1; x++) {
    let s = 0;
    for (let y = Math.floor(H * 0.25); y < H * 0.75; y++) s += Math.abs(g[y * W + x + 1] - g[y * W + x - 1]);
    cols[x] = s;
  }
  const found = findCardEdges(rows, cols, H * 0.55);
  return found && { x: area.x + found.x / scale, y: area.y + found.y / scale, w: found.w / scale, h: found.h / scale };
}

const sameRect = (a, b) => Math.abs(a.x - b.x) < b.w * 0.015 && Math.abs(a.y - b.y) < b.h * 0.015 && Math.abs(a.h - b.h) < b.h * 0.02;

/**
 * Reads the title from each candidate card rect (best guess first) until one is convincing. Each rect is first
 * corrected to the card's real outline when one can be found, since a card is rarely exactly on the guide.
 * Per rect: the title bar where it should be; then the lines of text near the top; then a smaller and an
 * inverted read. Returns { text, matches: [{ name, score }], confidence, rect }.
 */
export async function readName(source, rects) {
  const index = await nameIndex();
  let best = null;
  const tries = rects.flatMap((r) => {
    const found = locateCard(source, r);
    return found && !sameRect(found, r) ? [found, r] : [r];
  });
  for (const rect of tries) {
    const consider = (text) => {
      const matches = matchName(index, text, 3);
      const confidence = nameConfidence(matches);
      if (!best || confidence > best.confidence) best = { text, matches, confidence, rect };
      return confidence >= 0.9;
    };
    const title = region(rect, REGIONS.title);
    if (consider((await readText(prepare(source, title, 64), 'line')).text)) return best;
    const area = region(rect, TITLE_AREA);
    const lines = await readLines(prepare(source, area, (64 * area.h) / title.h));
    for (const line of lines.sort((a, b) => a.bbox.y0 - b.bbox.y0).slice(0, 3)) if (consider(line.text)) return best;
    if (consider((await readText(prepare(source, title, 48), 'line')).text)) return best;
    if (consider((await readText(prepare(source, title, 64, true), 'line')).text)) return best;
  }
  return best;
}

const printsByName = new Map();

/** Paper printings of a card by exact name, newest first. Cached for the page's life. */
export async function printingsOf(name) {
  if (!printsByName.has(name)) {
    const p = (async () => {
      let list = [];
      if (!name.includes('"')) list = (await scryfall.search(`!"${name}" game:paper`, { order: 'released', dir: 'desc', unique: 'prints', priority: 1 })).cards;
      if (!list.length) {
        const card = await scryfall.namedExact(name);
        if (!card) throw new Error(`Couldn’t find “${name}” on Scryfall.`);
        list = await scryfall.paperPrints(card.oracle_id);
        if (!list.length) list = [card];
      }
      return list.sort((a, b) => String(b.released_at ?? '').localeCompare(String(a.released_at ?? '')));
    })();
    printsByName.set(name, p);
    p.catch(() => printsByName.delete(name));
  }
  return printsByName.get(name);
}

// ---- artwork hashes

/** 64-bit fingerprint of a region; also used to tell when the camera view is steady or has changed. */
export function regionHash(source, rect) {
  const w = 36;
  const h = 32;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return dHash(gray, w, h);
}

const imageHashes = new Map();

function imageHash(url) {
  if (!imageHashes.has(url)) {
    const p = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(regionHash(img, region({ x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight }, REGIONS.art)));
      img.onerror = () => reject(new Error('image failed'));
      img.src = url;
    });
    imageHashes.set(url, p);
    p.catch(() => imageHashes.delete(url));
  }
  return imageHashes.get(url);
}

/**
 * Reads the set code and number. first: a read already under way, if any. When no set code turns up, the strip is
 * read again a little higher and lower, since the card is rarely exactly on the guide.
 */
async function readCollector(source, rect, first) {
  const strip = region(rect, REGIONS.collector);
  const read = (dy) => readText(prepare(source, { ...strip, y: strip.y + rect.h * dy }, 90), 'block').catch(() => ({ text: '' }));
  let parsed = parseCollector((await (first ?? read(0))).text);
  for (const dy of [-0.025, 0.025]) {
    if (parsed.set) break;
    const again = parseCollector((await read(dy)).text);
    if (again.set || (!parsed.number && again.number)) parsed = again;
  }
  return parsed;
}

/** Small shifts and size changes ([dx, dy, scale] as card fractions) to compare artwork at, for an off-guide card. */
const ART_OFFSETS = [
  [0, 0, 1],
  [0, -0.035, 1],
  [0, 0.035, 1],
  [-0.03, 0, 1],
  [0.03, 0, 1],
  [0, 0, 0.92],
  [0, 0, 1.08],
];

/**
 * Picks the printing. owned: Set of scryfallIds you own (preferred among identical artwork).
 * Returns { card, confidence, printings, basic, candidates, sameArt } (sameArt: printings sharing the matched artwork).
 */
export async function identifyPrinting(source, rect, name, owned) {
  // For a card not looked up yet, read the collector line while Scryfall answers.
  const cached = printsByName.has(name);
  const collector = cached ? null : readText(prepare(source, region(rect, REGIONS.collector), 90), 'block').catch(() => ({ text: '' }));
  const printings = await printingsOf(name);
  const basic = isBasicLand(printings[0]);
  if (basic) return { card: printings[0], confidence: 1, printings, basic, candidates: printings };
  if (printings.length === 1) return { card: printings[0], confidence: 0.99, printings, basic, candidates: printings };

  const parsed = await readCollector(source, rect, collector);
  const hit = printingFromCollector(printings, parsed);
  if (hit.card) return { card: hit.card, confidence: hit.confidence, printings, basic, candidates: [hit.card] };
  // No set code at the bottom usually means a pre-2014 frame, which tells reprints of the same art apart.
  const prefer = { before: parsed.set ? null : COLLECTOR_LINE_SINCE };

  const groups = [...groupByArt(hit.candidates).values()];
  // Same artwork everywhere: nothing to compare. Prefer a copy you own, else by frame age; it can be changed in review.
  if (groups.length === 1) return { card: preferPrinting(groups[0], owned, prefer), confidence: 0.85, printings, basic, candidates: hit.candidates, sameArt: groups[0].length };

  const cams = ART_OFFSETS.map(([dx, dy, s]) => {
    const art = region(rect, REGIONS.art);
    const w = art.w * s;
    const h = art.h * s;
    return regionHash(source, { x: art.x + (art.w - w) / 2 + rect.w * dx, y: art.y + (art.h - h) / 2 + rect.h * dy, w, h });
  });
  const scored = (
    await Promise.all(
      groups.map(async (ps) => {
        const url = cardImage(ps[0], 'small');
        const d = url ? await imageHash(url).then((hash) => Math.min(...cams.map((cam) => hamming(cam, hash))), () => 64) : 64;
        return { ps, d };
      }),
    )
  ).sort((a, b) => a.d - b.d);
  const [best, next] = scored;
  const confidence = artConfidence(best.d, next?.d);
  return {
    card: preferPrinting(best.ps, owned, prefer),
    // The artwork can be right while the reprint is a guess; say so without asking.
    confidence: best.ps.length > 1 ? Math.min(confidence, 0.85) : confidence,
    printings,
    basic,
    candidates: scored.flatMap((s) => s.ps),
    sameArt: best.ps.length,
  };
}
