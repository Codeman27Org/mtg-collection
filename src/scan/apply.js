// Saving a scan session: the only place scans change the collection or a deck.
import * as collection from '../collection.js';
import * as decks from '../decks.js';
import * as locations from '../locations.js';
import { getCards } from '../scryfall.js';
import { isBasicLand } from '../card-utils.js';
import { deckLocation } from '../location-logic.js';
import { planRecount } from './session-logic.js';
import { planDeckScan } from './deck-scan.js';

const scannedOf = (session) => session.items.map((i) => ({ scryfallId: i.scryfallId, finish: i.finish, qty: i.qty }));

/** What saving a collection scan would do: { rows, mode, added, removed }. */
export async function planCollectionSave(session) {
  const scanned = scannedOf(session);
  if (!session.recount) {
    return {
      mode: 'merge',
      rows: scanned.map((s) => ({ ...s, condition: 'NM', language: 'en', location: session.location })),
      added: scanned,
      removed: [],
    };
  }
  const existing = (await collection.entries()).filter((e) => (e.location ?? '') === session.location);
  const cards = await getCards(existing.map((e) => e.scryfallId));
  const plan = planRecount(session.location, existing, scanned, (e) => isBasicLand(cards.get(e.scryfallId)));
  return { mode: 'replace', ...plan };
}

export async function saveCollectionScan(plan) {
  if (plan.mode === 'replace' && !plan.rows.length) throw new Error('Nothing was scanned, so there’s nothing to recount.');
  return collection.importRows(plan.rows, plan.mode);
}

/** What saving a deck scan would do; see planDeckScan. */
export async function planDeckSave(session) {
  const deck = session.newDeck
    ? { id: `new-${session.createdAt}`, name: session.newDeck.name, format: session.newDeck.format, lines: {}, isNew: true }
    : await decks.get(session.deckId);
  if (!deck) throw new Error('That deck no longer exists.');
  const entries = await collection.entries();
  const ids = [...decks.activeIds(deck), ...entries.map((e) => e.scryfallId), ...session.items.map((i) => i.scryfallId)];
  const cards = await getCards(ids);
  return { deck, cards, ...planDeckScan(deck, cards, entries, scannedOf(session)) };
}

/**
 * Applies a deck plan. skip: Set of change ids left unchecked; asNew: Set of move ids (copies in other decks)
 * to record as new copies instead of taking them from that deck. Returns the deck (created now if it's new).
 */
export async function saveDeckScan(plan, { skip, asNew }) {
  const deck = plan.deck.isNew ? await decks.create({ name: plan.deck.name, format: plan.deck.format }) : plan.deck;
  const lines = plan.lines.filter((l) => !skip.has(l.id)).map((l) => ({ scryfallId: l.scryfallId, section: l.section, qty: l.to }));
  if (lines.length) await decks.setLines(deck.id, lines);

  const returns = plan.returns.filter((r) => !skip.has(r.id));
  if (returns.length) await locations.sendBack(returns);

  const moves = plan.moves.filter((m) => !skip.has(m.id) && !asNew.has(m.id));
  if (moves.length) await locations.pullIntoDeck(deck.id, moves);

  const here = deckLocation(deck.id);
  const rows = [
    ...plan.adds.filter((a) => !skip.has(a.id)).map((a) => ({ scryfallId: a.scryfallId, finish: a.finish, qty: a.qty })),
    ...plan.moves.filter((m) => !skip.has(m.id) && asNew.has(m.id)).map((m) => ({ ...m.unit, qty: m.qty })),
  ].map((r) => ({ ...r, condition: 'NM', language: 'en', location: here }));
  if (rows.length) await collection.importRows(rows, 'merge');
  return deck;
}
