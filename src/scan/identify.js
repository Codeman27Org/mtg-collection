// Identifies a card from an image: title OCR → name, then collector line or artwork → printing.
import { readText } from './ocr.js';
import { REGIONS, region } from './geometry.js';
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

const shift = (r, dy) => ({ ...r, y: r.y + r.h * dy });

/**
 * Reads the title from each candidate card rect (best guess first) until one is convincing.
 * Each read is quick (tens of milliseconds), so a few sizes and small shifts are tried to allow for a card
 * that isn't lined up exactly. Returns { text, matches: [{ name, score }], confidence, rect }.
 */
export async function readName(source, rects) {
  const index = await nameIndex();
  let best = null;
  const attempts = [
    { h: 64, dy: 0, invert: false },
    { h: 48, dy: 0, invert: false },
    { h: 64, dy: -0.25, invert: false },
    { h: 64, dy: 0.25, invert: false },
    { h: 64, dy: 0, invert: true },
  ];
  for (const rect of rects) {
    const title = region(rect, REGIONS.title);
    for (const a of attempts) {
      const { text } = await readText(prepare(source, shift(title, a.dy), a.h, a.invert), 'line');
      const matches = matchName(index, text, 3);
      const confidence = nameConfidence(matches);
      if (!best || confidence > best.confidence) best = { text, matches, confidence, rect };
      if (confidence >= 0.9) return best;
    }
  }
  return best;
}

const printsByName = new Map();

/** Paper printings of a card by exact name, newest first. Cached for the page's life. */
export async function printingsOf(name) {
  if (!printsByName.has(name)) {
    const p = (async () => {
      let list = [];
      if (!name.includes('"')) list = (await scryfall.search(`!"${name}" game:paper`, { order: 'released', dir: 'desc', unique: 'prints' })).cards;
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
 * Picks the printing. owned: Set of scryfallIds you own (preferred among identical artwork).
 * Returns { card, confidence, printings, basic, candidates, sameArt } (sameArt: printings sharing the matched artwork).
 */
export async function identifyPrinting(source, rect, name, owned) {
  const printings = await printingsOf(name);
  const basic = isBasicLand(printings[0]);
  if (basic) return { card: printings[0], confidence: 1, printings, basic, candidates: printings };
  if (printings.length === 1) return { card: printings[0], confidence: 0.99, printings, basic, candidates: printings };

  const { text } = await readText(prepare(source, region(rect, REGIONS.collector), 90), 'block');
  const parsed = parseCollector(text);
  const hit = printingFromCollector(printings, parsed);
  if (hit.card) return { card: hit.card, confidence: hit.confidence, printings, basic, candidates: [hit.card] };
  // No set code at the bottom usually means a pre-2014 frame, which tells reprints of the same art apart.
  const prefer = { before: parsed.set ? null : COLLECTOR_LINE_SINCE };

  const groups = [...groupByArt(hit.candidates).values()];
  // Same artwork everywhere: nothing to compare. Prefer a copy you own, else by frame age; it can be changed in review.
  if (groups.length === 1) return { card: preferPrinting(groups[0], owned, prefer), confidence: 0.85, printings, basic, candidates: hit.candidates, sameArt: groups[0].length };

  const cam = regionHash(source, region(rect, REGIONS.art));
  const scored = (
    await Promise.all(
      groups.map(async (ps) => {
        const url = cardImage(ps[0], 'small');
        const d = url ? await imageHash(url).then((hash) => hamming(cam, hash), () => 64) : 64;
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
