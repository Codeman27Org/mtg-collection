import { cardPrice, colorsOf, primaryType, searchableText } from './card-utils.js';
import { locationToken } from './location-logic.js';

export const DEFAULT_FILTER = {
  text: '',
  colors: [],
  type: '',
  rarity: '',
  set: '',
  cmcMin: '',
  cmcMax: '',
  finish: '',
  priceMin: '',
  priceMax: '',
  unused: false,
  used: false,
  unpriced: false,
  location: '',
};

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

/**
 * entries: collection records ({scryfallId, finish, qty, ...}); cards: Map id → card.
 * usedOracles: Set of oracle_ids used in any deck (for the "not in any deck" filter).
 */
export function applyFilter(entries, cards, filter, usedOracles = new Set()) {
  const f = { ...DEFAULT_FILTER, ...filter };
  const text = String(f.text ?? '').trim().toLowerCase();
  const colors = Array.isArray(f.colors) ? f.colors : [];
  const cmcMin = num(f.cmcMin);
  const cmcMax = num(f.cmcMax);
  const priceMin = num(f.priceMin);
  const priceMax = num(f.priceMax);
  return entries.filter((e) => {
    if (e.qty <= 0) return false;
    if (f.location && locationToken(e.location) !== f.location) return false;
    const card = cards.get(e.scryfallId);
    if (!card) return !text && !colors.length && !f.type && !f.rarity && !f.set && !f.unpriced;
    if (text && !searchableText(card).includes(text)) return false;
    if (colors.length) {
      const cc = colorsOf(card);
      const hit = colors.some((c) => (c === 'C' ? cc.length === 0 : cc.includes(c)));
      if (!hit) return false;
    }
    if (f.type && primaryType(card) !== f.type && !card.type_line.includes(f.type)) return false;
    if (f.rarity && card.rarity !== f.rarity) return false;
    if (f.set && card.set !== f.set) return false;
    if (cmcMin != null && (card.cmc ?? 0) < cmcMin) return false;
    if (cmcMax != null && (card.cmc ?? 0) > cmcMax) return false;
    if (f.finish && e.finish !== f.finish) return false;
    if (priceMin != null || priceMax != null) {
      const p = cardPrice(card, e.finish) ?? 0;
      if (priceMin != null && p < priceMin) return false;
      if (priceMax != null && p > priceMax) return false;
    }
    if (f.unpriced && cardPrice(card, e.finish) != null) return false;
    if (f.unused && usedOracles.has(card.oracle_id)) return false;
    if (f.used && !usedOracles.has(card.oracle_id)) return false;
    return true;
  });
}

/** locationName: optional (token) → display name, for the location part. */
export function describeFilter(filter, { locationName } = {}) {
  const f = { ...DEFAULT_FILTER, ...filter };
  const parts = [];
  if (f.text) parts.push(`"${f.text}"`);
  if (f.colors?.length) parts.push(`colors ${f.colors.join('')}`);
  if (f.type) parts.push(f.type);
  if (f.rarity) parts.push(f.rarity);
  if (f.set) parts.push(`set ${f.set.toUpperCase()}`);
  if (f.cmcMin !== '' || f.cmcMax !== '') parts.push(`MV ${f.cmcMin || 0}–${f.cmcMax || '∞'}`);
  if (f.finish) parts.push(f.finish);
  if (f.priceMin !== '' || f.priceMax !== '') parts.push(`$${f.priceMin || 0}–${f.priceMax || '∞'}`);
  if (f.unused) parts.push('not in any deck');
  if (f.unpriced) parts.push('no price on Scryfall');
  if (f.used) parts.push('in a deck');
  if (f.location) parts.push(`in ${locationName?.(f.location) ?? 'one location'}`);
  return parts.length ? parts.join(', ') : 'whole collection';
}
