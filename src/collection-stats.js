// Pure summaries of the collection for the home dashboard.
import { cardPrice, colorsOf, primaryType, TYPE_ORDER } from './card-utils.js';

// max values line up with the collection's inclusive price filter.
export const PRICE_TIERS = [
  { label: 'Under $1', min: 0, max: 0.99 },
  { label: '$1–5', min: 1, max: 4.99 },
  { label: '$5–20', min: 5, max: 19.99 },
  { label: '$20–50', min: 20, max: 49.99 },
  { label: '$50+', min: 50, max: null },
];

export const COLOR_KEYS = ['W', 'U', 'B', 'R', 'G', 'M', 'C'];
const RARITY_KEYS = ['common', 'uncommon', 'rare', 'mythic'];
const ERA_START = 1993;
const ERA_SPAN = 5;

export function eraLabel(year) {
  const start = ERA_START + Math.floor((year - ERA_START) / ERA_SPAN) * ERA_SPAN;
  return `${start}–${String(start + ERA_SPAN - 1).slice(2)}`;
}

/**
 * entries: owned stacks; cards: Map scryfallId → card; usedOracles: oracle_ids used in any deck.
 * Every count is by copies (qty), except `names`.
 */
export function summarize(entries, cards, usedOracles = new Set()) {
  const s = {
    total: 0,
    value: 0,
    printings: entries.length,
    names: 0,
    foils: 0,
    foilValue: 0,
    unpriced: 0,
    tiers: PRICE_TIERS.map((t) => ({ ...t, qty: 0, value: 0 })),
    colors: Object.fromEntries(COLOR_KEYS.map((k) => [k, 0])),
    types: Object.fromEntries(TYPE_ORDER.map((k) => [k, 0])),
    rarities: Object.fromEntries(RARITY_KEYS.map((k) => [k, 0])),
    sets: [],
    eras: [],
    curve: Array.from({ length: 8 }, () => ({})),
    top: [],
    topShare: 0,
    oldest: null,
    inDecks: { names: 0, value: 0 },
    free: { names: 0, value: 0 },
    locations: [],
  };
  const names = new Map();
  const sets = new Map();
  const eras = new Map();
  const stacks = new Map();
  const locations = new Map();

  for (const e of entries) {
    if (e.qty <= 0) continue;
    s.total += e.qty;
    const card = cards.get(e.scryfallId);
    if (!card) continue;
    const unit = cardPrice(card, e.finish);
    const price = unit ?? 0;
    const value = price * e.qty;
    s.value += value;
    if (unit == null) s.unpriced += e.qty;
    if (e.finish !== 'nonfoil') {
      s.foils += e.qty;
      s.foilValue += value;
    }

    const tier = s.tiers.find((t) => price >= t.min && (t.max == null || price <= t.max)) ?? s.tiers[0];
    tier.qty += e.qty;
    tier.value += value;

    const loc = locations.get(e.location ?? '') ?? { id: e.location ?? '', qty: 0, value: 0 };
    loc.qty += e.qty;
    loc.value += value;
    locations.set(loc.id, loc);

    const type = primaryType(card);
    s.types[type] += e.qty;
    if (type !== 'Land') {
      const colors = colorsOf(card);
      s.colors[colors.length === 0 ? 'C' : colors.length > 1 ? 'M' : colors[0]] += e.qty;
      const bucket = s.curve[Math.min(7, Math.floor(card.cmc ?? 0))];
      bucket[type] = (bucket[type] ?? 0) + e.qty;
    }
    if (card.rarity in s.rarities) s.rarities[card.rarity] += e.qty;

    const set = sets.get(card.set) ?? { code: card.set, name: card.set_name, qty: 0, value: 0 };
    set.qty += e.qty;
    set.value += value;
    sets.set(card.set, set);

    const year = Number(card.released_at?.slice(0, 4));
    if (year >= ERA_START) {
      const label = eraLabel(year);
      eras.set(label, (eras.get(label) ?? 0) + e.qty);
      if (!s.oldest || card.released_at < s.oldest.card.released_at) s.oldest = { card, entry: e };
    }

    const n = names.get(card.oracle_id) ?? { value: 0 };
    n.value += value;
    names.set(card.oracle_id, n);

    // Same printing and finish in different conditions counts as one "top card".
    const key = `${e.scryfallId}:${e.finish}`;
    const stack = stacks.get(key) ?? { card, finish: e.finish, price, qty: 0 };
    stack.qty += e.qty;
    stacks.set(key, stack);
  }

  s.names = names.size;
  for (const [oracle, n] of names) {
    const bucket = usedOracles.has(oracle) ? s.inDecks : s.free;
    bucket.names += 1;
    bucket.value += n.value;
  }
  s.sets = [...sets.values()].sort((a, b) => b.qty - a.qty || b.value - a.value);
  s.locations = [...locations.values()].sort((a, b) => b.value - a.value);
  s.eras = [...eras.entries()].sort(([a], [b]) => a.localeCompare(b));
  const byPrice = [...stacks.values()].sort((a, b) => b.price - a.price);
  s.top = byPrice.slice(0, 8);
  const top10 = byPrice.slice(0, 10).reduce((sum, x) => sum + x.price * x.qty, 0);
  s.topShare = s.value ? top10 / s.value : 0;
  return s;
}
