import { h, s } from './dom.js';
import { TYPE_ORDER } from './card-utils.js';

const typeClass = (t) => `fill-type-${t.toLowerCase()}`;

/** curve: array of 8 buckets, each { [type]: count }. */
export function manaCurveChart(curve) {
  const W = 320;
  const H = 160;
  const pad = 20;
  const barW = (W - pad) / curve.length - 6;
  const totals = curve.map((b) => Object.values(b).reduce((a, n) => a + n, 0));
  const max = Math.max(1, ...totals);
  const bars = curve.map((bucket, i) => {
    const x = pad + i * (barW + 6);
    let y = H - pad;
    const rects = TYPE_ORDER.filter((t) => bucket[t]).map((t) => {
      const hgt = (bucket[t] / max) * (H - pad * 2);
      y -= hgt;
      return s('rect', { x, y, width: barW, height: hgt, class: typeClass(t) }, s('title', {}, `${t}: ${bucket[t]}`));
    });
    return s(
      'g',
      {},
      ...rects,
      s('text', { x: x + barW / 2, y: H - 5, 'text-anchor': 'middle', class: 'chart-label' }, i === 7 ? '7+' : String(i)),
      totals[i] ? s('text', { x: x + barW / 2, y: y - 3, 'text-anchor': 'middle', class: 'chart-value' }, String(totals[i])) : null,
    );
  });
  return s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `Mana curve: ${totals.join(', ')}` }, ...bars);
}

/** pips: { W, U, B, R, G, C, M } counts. */
export function colorDonut(pips, { unit = 'pips', names = {}, hrefFor } = {}) {
  const entries = Object.entries(pips).filter(([, n]) => n > 0);
  const total = entries.reduce((a, [, n]) => a + n, 0);
  const R = 50;
  const point = (turns) => {
    const a = turns * 2 * Math.PI - Math.PI / 2;
    return `${(70 + R * Math.cos(a)).toFixed(3)} ${(70 + R * Math.sin(a)).toFixed(3)}`;
  };
  let start = 0;
  // One arc per slice between exact angles; dash-offset slices on one circle overlap at the seam.
  const arcs = entries.map(([color, n]) => {
    const share = n / total;
    const attrs = { class: `stroke-color-${color}`, fill: 'none', 'stroke-width': 24 };
    const title = s('title', {}, `${names[color] ?? color}: ${n} ${unit}`);
    const arc =
      share >= 1
        ? s('circle', { ...attrs, cx: 70, cy: 70, r: R }, title)
        : s('path', { ...attrs, d: `M ${point(start)} A ${R} ${R} 0 ${share > 0.5 ? 1 : 0} 1 ${point(start + share)}` }, title);
    start += share;
    return arc;
  });
  const legend = h(
    'ul',
    { class: 'legend' },
    entries.map(([color, n]) => {
      const label = `${names[color] ?? color} ${Math.round((n / total) * 100)}% (${n.toLocaleString()})`;
      const href = hrefFor?.(color);
      return h('li', {}, h('span', { class: `swatch bg-color-${color}` }), href ? h('a', { href }, label) : label);
    }),
  );
  return h(
    'div',
    { class: 'donut-wrap' },
    total
      ? s('svg', { viewBox: '0 0 140 140', class: 'donut', role: 'img', 'aria-label': `Color distribution of ${unit}` }, ...arcs)
      : h('p', { class: 'muted' }, `No colored ${unit}.`),
    legend,
  );
}

/**
 * rows: [[label, value, extra?]]. format(value, extra) sets the right-hand text; hrefFor(label, extra) makes rows links;
 * tagFor(label, extra) adds a small pill after the label (e.g. a deck's format).
 * Widths are set via CSSOM, which a strict style-src CSP allows.
 */
export function hBars(rows, { classFor = typeClass, format = (n) => n.toLocaleString(), hrefFor, tagFor, wide = false } = {}) {
  const max = Math.max(1, ...rows.map(([, n]) => n));
  return h(
    'div',
    { class: `hbars${wide ? ' hbars-wide' : ''}${tagFor ? ' hbars-tagged' : ''}` },
    rows.map(([label, n, extra]) => {
      const fill = h('span', { class: `hbar-fill ${classFor(label, extra)}` });
      fill.style.width = `${Math.round((n / max) * 100)}%`;
      const href = hrefFor?.(label, extra);
      const tag = tagFor?.(label, extra);
      return h(
        href ? 'a' : 'div',
        { class: 'hbar-row', href },
        tagFor
          ? h('span', { class: 'hbar-label', title: tag ? `${label} (${tag})` : label }, h('span', { class: 'hbar-name' }, label), tag ? h('span', { class: 'pill hbar-tag' }, tag) : null)
          : h('span', { class: 'hbar-label', title: label }, label),
        h('span', { class: 'hbar-track' }, fill),
        h('span', { class: 'hbar-value' }, format(n, extra)),
      );
    }),
  );
}
