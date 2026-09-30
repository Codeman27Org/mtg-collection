// Pure geometry for the scanner: where the on-screen guide lands in the camera frame, and card regions.

export const CARD_ASPECT = 63 / 88;

/** Card regions as fractions of the card: [x0, y0, x1, y1]. */
export const REGIONS = {
  title: [0.05, 0.035, 0.8, 0.115],
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
