// Pure helpers for where physical copies are. No DB access, so they can be unit tested.
import { isBasicLand } from './card-utils.js';

export const UNSORTED = '';
/** Filter/URL token for Unsorted, since '' means "any location" there. */
export const UNSORTED_TOKEN = 'unsorted';
export const DECK_LOCATION_PREFIX = 'deck:';

export const deckLocation = (deckId) => `${DECK_LOCATION_PREFIX}${deckId}`;
export const isDeckLocation = (id) => typeof id === 'string' && id.startsWith(DECK_LOCATION_PREFIX);
export const deckIdOf = (id) => (isDeckLocation(id) ? id.slice(DECK_LOCATION_PREFIX.length) : null);
export const locationToken = (id) => id || UNSORTED_TOKEN;

/** Where a copy should go when it leaves a deck: its origin if that still exists, else Unsorted. */
export function returnTarget(entry, exists) {
  const from = entry.from ?? '';
  return from && exists(from) ? from : UNSORTED;
}

/** Location a copy records as its origin when moved to `to`. Only deck locations keep an origin. */
export function originFor(entry, to) {
  if (!isDeckLocation(to)) return '';
  return isDeckLocation(entry.location) ? (entry.from ?? '') : (entry.location ?? '');
}

const PLAYED_SECTIONS = new Set(['commander', 'companion', 'main', 'sideboard']);

/**
 * What it takes to physically assemble a deck.
 * entries: all owned stacks; cards: Map scryfallId → card (deck lines and entries).
 * Returns {
 *   byOracle: Map oracle_id → { card, need, inDeck, pulls: [{ entry, qty }], inOtherDecks: [{ location, qty }], missing },
 *   pulls: [{ entry, qty }], pullCount, extras: [{ entry, qty }], extraCount, inDeck, need, missing
 * }
 * Pulls prefer the printing on the deck line, then nonfoil, then the biggest stack.
 * Copies in other decks are never pulled automatically; they're only reported.
 */
export function deckPlan(deck, cards, entries) {
  const here = deckLocation(deck.id);
  const need = new Map();
  for (const l of Object.values(deck.lines)) {
    if (l.qty <= 0 || !PLAYED_SECTIONS.has(l.section)) continue;
    const card = cards.get(l.scryfallId);
    if (!card) continue;
    const n = need.get(card.oracle_id) ?? { card, qty: 0, printings: new Set() };
    n.qty += l.qty;
    n.printings.add(l.scryfallId);
    need.set(card.oracle_id, n);
  }

  const stacks = new Map();
  for (const e of entries) {
    if (e.qty <= 0) continue;
    const oracle = cards.get(e.scryfallId)?.oracle_id;
    if (!oracle) continue;
    if (!stacks.has(oracle)) stacks.set(oracle, []);
    stacks.get(oracle).push(e);
  }

  const byOracle = new Map();
  const pulls = [];
  const extras = [];
  const totals = { inDeck: 0, need: 0, missing: 0 };

  for (const [oracle, n] of need) {
    const all = stacks.get(oracle) ?? [];
    // Basic lands are generic unless you own the exact printing on the line (a full-art foil, say): only those copies are tracked.
    const basic = isBasicLand(n.card);
    const own = basic ? all.filter((e) => n.printings.has(e.scryfallId)) : all;
    if (basic) {
      const trackable = own.filter((e) => e.location === here || !isDeckLocation(e.location)).reduce((s, e) => s + e.qty, 0);
      n.untracked = n.qty - Math.min(n.qty, trackable);
      n.qty -= n.untracked;
    }
    const inDeck = own.filter((e) => e.location === here).reduce((s, e) => s + e.qty, 0);
    let remaining = Math.max(0, n.qty - inDeck);
    const rank = (e) => [n.printings.has(e.scryfallId) ? 0 : 1, e.finish === 'nonfoil' ? 0 : 1, -e.qty];
    const candidates = own
      .filter((e) => !isDeckLocation(e.location))
      .sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
      });
    const rowPulls = [];
    for (const e of candidates) {
      if (!remaining) break;
      const qty = Math.min(remaining, e.qty);
      rowPulls.push({ entry: e, qty });
      remaining -= qty;
    }
    const inOtherDecks = own.filter((e) => isDeckLocation(e.location) && e.location !== here).map((e) => ({ location: e.location, qty: e.qty }));
    byOracle.set(oracle, {
      card: n.card,
      need: n.qty,
      inDeck: Math.min(inDeck, n.qty),
      pulls: rowPulls,
      inOtherDecks,
      missing: remaining,
      basic,
      untracked: n.untracked ?? 0,
    });
    pulls.push(...rowPulls);
    totals.need += n.qty;
    totals.inDeck += Math.min(inDeck, n.qty);
    totals.missing += remaining;
  }

  // Copies in this deck's location beyond what the list needs (cut cards, or the deck shrank).
  for (const [oracle, own] of stacks) {
    const here_ = own.filter((e) => e.location === here);
    let surplus = here_.reduce((s, e) => s + e.qty, 0) - (need.get(oracle)?.qty ?? 0);
    const printings = need.get(oracle)?.printings ?? new Set();
    for (const e of [...here_].sort((a, b) => Number(printings.has(a.scryfallId)) - Number(printings.has(b.scryfallId)))) {
      if (surplus <= 0) break;
      const qty = Math.min(surplus, e.qty);
      extras.push({ entry: e, qty });
      surplus -= qty;
    }
  }

  return {
    byOracle,
    pulls,
    pullCount: pulls.reduce((s, p) => s + p.qty, 0),
    extras,
    extraCount: extras.reduce((s, x) => s + x.qty, 0),
    ...totals,
  };
}
