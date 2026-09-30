import { parseDeckText, parseDek } from './deck-text.js';
import { parseCardCsv, MAX_FILE_BYTES } from './csv-import.js';
import { resolveRows } from './import-resolve.js';
import { getCachedCards } from './scryfall.js';
import * as collection from './collection.js';
import * as decks from './decks.js';
import * as account from './account.js';
import { shortfall } from './analytics.js';
import { deckLocation } from './location-logic.js';
import { isBasicLand } from './card-utils.js';
import { hasCommander, canLead } from './formats.js';

/** How a deck import should touch the collection. */
export const COLLECTION_MODES = {
  none: 'Use cards from my collection (don’t add anything)',
  missing: 'Add only the cards I don’t have to my collection (no duplicates)',
  all: 'Add every card in this list to my collection',
};

const textLineToRow = (l) => ({
  scryfallId: null,
  name: l.name,
  setCode: l.set ?? '',
  setName: '',
  cn: l.cn ?? '',
  finish: l.foil ? 'foil' : 'nonfoil',
  condition: 'NM',
  language: 'en',
  qty: l.qty,
  section: l.section,
});

/** Returns { rows, errors } in the same row shape as parseCardCsv. */
export function readDeckText(text) {
  const { lines, errors } = parseDeckText(text);
  return { rows: lines.map(textLineToRow), errors };
}

export async function readDeckFile(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error('File is larger than 5 MB.');
  const text = await file.text();
  if (/\.dek$/i.test(file.name)) return { rows: parseDek(text).map(textLineToRow), errors: [] };
  if (/\.csv$/i.test(file.name)) return { rows: parseCardCsv(text).rows, errors: [] };
  return readDeckText(text);
}

/** Map oracle_id → the owned printing with the most copies. */
async function ownedPrintings() {
  if (!account.current()) return new Map();
  const entries = await collection.entries();
  const cards = await getCachedCards(entries.map((e) => e.scryfallId));
  const best = new Map();
  for (const e of entries) {
    const oracle = cards.get(e.scryfallId)?.oracle_id;
    if (!oracle) continue;
    if (!best.has(oracle) || best.get(oracle).qty < e.qty) best.set(oracle, e);
  }
  return new Map([...best].map(([oracle, e]) => [oracle, e.scryfallId]));
}

/**
 * rows (from readDeckText/readDeckFile) → { lines, resolved, unresolved, commander }.
 * Rows without a specific printing use an owned printing when there is one, except basic lands,
 * which stay generic so an owned special printing (a full-art foil, say) isn't assigned by accident.
 * For formats with a commander and no commander section in the list, a lone eligible legendary creature becomes the commander.
 */
export async function resolveDeck(rows, format, onProgress) {
  await resolveRows(rows, onProgress);
  const owned = await ownedPrintings();
  const resolved = [];
  const unresolved = [];
  for (const r of rows) {
    if (!r.card) {
      unresolved.push(r.name || r.scryfallId);
      continue;
    }
    const exact = !!(r.scryfallId || r.cn || r.setCode || r.setName);
    const lineId = (!exact && !isBasicLand(r.card) && owned.get(r.card.oracle_id)) || r.card.id;
    resolved.push({ ...r, lineId, exact });
  }

  let commander = null;
  if (hasCommander(format) && !resolved.some((r) => r.section === 'commander')) {
    const candidates = resolved.filter((r) => r.section === 'main' && r.qty === 1 && canLead(r.card, format));
    if (candidates.length === 1) {
      candidates[0].section = 'commander';
      commander = candidates[0].card.name;
    }
  }

  const lines = resolved.map((r) => ({ scryfallId: r.lineId, section: r.section, qty: r.qty }));
  return { lines, resolved, unresolved, commander };
}

/**
 * Adds a deck's cards to the collection per mode ('none' | 'missing' | 'all'). Run before importing the lines.
 * 'missing' adds only copies the collection can't cover after what other decks already use.
 * Added copies go into the deck's location, since they came with the deck.
 * Returns the number of cards added.
 */
export async function updateCollectionForDeck(resolved, mode, { replacingDeckId, deckId } = {}) {
  if (mode === 'none') return 0;
  // Generic basic lands aren't tracked; only a specific printing (set/number given) is added.
  const rows = resolved.filter((r) => r.section !== 'maybeboard' && (r.exact || !isBasicLand(r.card)));
  const location = deckId ? deckLocation(deckId) : '';
  const toAdd = (r) => ({ scryfallId: r.lineId, finish: r.finish, condition: r.condition, language: r.language, qty: r.qty, location, oracleId: r.card.oracle_id });
  let adds = rows.map(toAdd);
  if (mode === 'missing') {
    const owned = await collection.ownedByOracle();
    const used = await decks.usageByOracle({ excludeDeckId: replacingDeckId });
    adds = shortfall(adds, owned, used);
  }
  if (adds.length) await collection.importRows(adds.map(({ oracleId, ...entry }) => entry), 'merge');
  return adds.reduce((n, a) => n + a.qty, 0);
}

/** Resolve → update collection per mode → write deck lines. */
export async function importIntoDeck(deckId, rows, { format, mode, replace = false, onProgress }) {
  const { lines, resolved, unresolved, commander } = await resolveDeck(rows, format, onProgress);
  const added = await updateCollectionForDeck(resolved, mode, { replacingDeckId: replace ? deckId : undefined, deckId });
  await decks.importLines(deckId, lines, { replace });
  return { cards: lines.reduce((n, l) => n + l.qty, 0), unresolved, commander, added };
}

export function importSummary({ cards, unresolved, commander, added }, mode) {
  const parts = [`Imported ${cards} cards.`];
  if (commander) parts.push(`Set ${commander} as commander.`);
  if (mode !== 'none') parts.push(added ? `Added ${added} cards to your collection, in this deck.` : 'Your collection already had every card.');
  if (unresolved.length) parts.push(`Couldn’t find: ${unresolved.slice(0, 5).join(', ')}${unresolved.length > 5 ? '…' : ''}`);
  return parts.join(' ');
}
