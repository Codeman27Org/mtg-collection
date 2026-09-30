import { h, frag } from './dom.js';

const SYMBOL_HOST = 'https://svgs.scryfall.io/card-symbols/';
const WORDS = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', C: 'colorless', S: 'snow', X: 'X', T: 'tap', Q: 'untap', E: 'energy' };

function label(sym) {
  if (/^\d+$/.test(sym)) return `${sym} generic mana`;
  const parts = sym.split('/');
  if (parts.length > 1) {
    const words = parts.map((p) => (p === 'P' ? 'Phyrexian' : WORDS[p] ?? p));
    return `${words.join(' or ')} mana`;
  }
  if (sym === 'T' || sym === 'Q') return WORDS[sym];
  return WORDS[sym] ? `${WORDS[sym]} mana` : sym;
}

function symbol(sym) {
  const code = sym.replace(/\//g, '').replace('½', 'HALF').replace('∞', 'INFINITY');
  return h('img', {
    class: 'mana-symbol',
    src: `${SYMBOL_HOST}${encodeURIComponent(code)}.svg`,
    alt: `{${sym}}`,
    'aria-label': label(sym),
    title: label(sym),
    width: 16,
    height: 16,
    loading: 'lazy',
  });
}

/** Renders text with inline {X} mana symbols. */
export function withSymbols(text) {
  const out = [];
  let last = 0;
  for (const m of (text ?? '').matchAll(/\{([^}]{1,6})\}/g)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(symbol(m[1]));
    last = m.index + m[0].length;
  }
  if (last < (text ?? '').length) out.push(text.slice(last));
  return frag(...out);
}

export function manaCost(cost) {
  return h('span', { class: 'mana-cost' }, withSymbols(cost ?? ''));
}

export function oracleText(text) {
  return frag(...(text ?? '').split('\n').map((line) => h('p', {}, withSymbols(line))));
}

export function colorPips(colors) {
  const list = colors?.length ? colors : ['C'];
  return h('span', { class: 'color-pips' }, list.map((c) => h('span', { class: `pip pip-${c}`, title: c, 'aria-label': c })));
}
