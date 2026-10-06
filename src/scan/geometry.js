// Pure geometry for the scanner: where the on-screen guide lands in the camera frame, and card regions.

export const CARD_ASPECT = 63 / 88;

/** Card regions as fractions of the card: [x0, y0, x1, y1]. */
export const REGIONS = {
  title: [0.05, 0.035, 0.8, 0.115],
  // Tight: Tesseract misreads the text when the strip includes the black border or the table.
  collector: [0.03, 0.905, 0.55, 0.985],
  art: [0.09, 0.12, 0.91, 0.54],
};

/**
 * Maps a rect in the displayed element (a video with object-fit: cover) back to source pixels.
 * src: { w, h } of the frame; box: { w, h } of the element; rect: { x, y, w, h } in element pixels.
 */
export function coverToSource(src, box, rect) {
  const scale = Math.max(box.w / src.w, box.h / src.h);
  const offX = (box.w - src.w * scale) / 2;
  const offY = (box.h - src.h * scale) / 2;
  return clampRect(
    { x: (rect.x - offX) / scale, y: (rect.y - offY) / scale, w: rect.w / scale, h: rect.h / scale },
    src,
  );
}

function clampRect(r, bounds) {
  const x = Math.max(0, Math.min(bounds.w, r.x));
  const y = Math.max(0, Math.min(bounds.h, r.y));
  return { x, y, w: Math.max(0, Math.min(bounds.w, r.x + r.w) - x), h: Math.max(0, Math.min(bounds.h, r.y + r.h) - y) };
}

/** The largest card-shaped rect centered in a w×h image (for photos that are mostly the card). */
export function centeredCard(w, h, fill = 1) {
  let cw = w * fill;
  let ch = cw / CARD_ASPECT;
  if (ch > h * fill) {
    ch = h * fill;
    cw = ch * CARD_ASPECT;
  }
  return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch };
}

/** A sub-rect of a card rect by region fractions. */
export function region(card, [x0, y0, x1, y1]) {
  return { x: card.x + card.w * x0, y: card.y + card.h * y0, w: card.w * (x1 - x0), h: card.h * (y1 - y0) };
}

function peaks(strength) {
  let max = 0;
  for (const v of strength) if (v > max) max = v;
  if (!max) return [];
  const out = [];
  for (let i = 2; i < strength.length - 2; i++) {
    const v = strength[i];
    if (v < max * 0.25) continue;
    if (v >= strength[i - 1] && v >= strength[i + 1] && v >= strength[i - 2] && v >= strength[i + 2]) out.push({ at: i, s: v / max });
  }
  return out.sort((a, b) => b.s - a.s).slice(0, 10);
}

/**
 * Picks a card outline from edge strength per row (rows[y]) and per column (cols[x]) of a search area: top, bottom,
 * left, and right edges that form a 63×88 card at least minH tall. A card's frame has strong lines inside it too,
 * and the outline always encloses them, so the largest reasonably strong outline wins.
 * Returns { x, y, w, h } in the same units, or null.
 */
export function findCardEdges(rows, cols, minH) {
  const pr = peaks(rows);
  const pc = peaks(cols);
  const aspect = 1 / CARD_ASPECT;
  const found = [];
  for (const t of pr) {
    for (const b of pr) {
      const h = b.at - t.at;
      if (h < minH) continue;
      for (const l of pc) {
        for (const r of pc) {
          const w = r.at - l.at;
          if (w <= 0 || Math.abs(h / w / aspect - 1) > 0.03) continue;
          const score = t.s + b.s + l.s + r.s;
          if (score >= 1.2) found.push({ x: l.at, y: t.at, w, h, score });
        }
      }
    }
  }
  if (!found.length) return null;
  const top = Math.max(...found.map((f) => f.score));
  const best = found.filter((f) => f.score >= top * 0.5).sort((a, b) => b.w * b.h - a.w * a.h)[0];
  return { x: best.x, y: best.y, w: best.w, h: best.h };
}
