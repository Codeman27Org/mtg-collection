import { accountDB } from './db.js';
import * as account from './account.js';
import { markDirty, markSharesFor } from './sync.js';
import { emit, on } from './bus.js';
import { lineKey, deckTouchedAt } from './merge.js';
import { PREFIX } from './constants.js';
import { getCards } from './scryfall.js';
import { requireEdit } from './collection.js';

let cache = null;
let cacheFor = null;

on('account', () => (cache = null));
on('remote:decks', () => {
  cache = null;
  emit('decks');
});

async function load() {
  const pubkey = account.current();
  if (!cache || cacheFor !== pubkey) {
    const all = await (await accountDB(pubkey)).getAll('decks');
    cache = new Map(all.map((d) => [d.id, d]));
    cacheFor = pubkey;
  }
  return cache;
}

export async function list() {
  return [...(await load()).values()].filter((d) => !d.deleted).sort((a, b) => (b.touchedAt ?? 0) - (a.touchedAt ?? 0));
}

export async function get(id) {
  const deck = (await load()).get(id);
  return deck && !deck.deleted ? deck : null;
}

async function save(deck) {
  requireEdit();
  deck.touchedAt = deckTouchedAt(deck);
  await (await accountDB(account.current())).put('decks', deck);
  (await load()).set(deck.id, deck);
  await markDirty(`${PREFIX}deck:${deck.id}`);
  await markSharesFor({ deckId: deck.id });
  emit('decks');
  return deck;
}

async function editable(id) {
  const deck = await get(id);
  if (!deck) throw new Error('Deck not found.');
  return structuredClone(deck);
}

export async function create({ name, format, description = '' }) {
  requireEdit();
  const now = Date.now();
  return save({
    id: crypto.randomUUID(),
    name: name.trim() || 'Untitled deck',
    format,
    description,
    createdAt: now,
    fieldsUpdatedAt: now,
    deleted: false,
    lines: {},
  });
}

export async function updateFields(id, fields) {
  const deck = await editable(id);
  for (const k of ['name', 'format', 'description']) if (k in fields) deck[k] = fields[k];
  deck.fieldsUpdatedAt = Date.now();
  return save(deck);
}

function put(deck, scryfallId, section, qty, now) {
  deck.lines[lineKey(scryfallId, section)] = { scryfallId, section, qty: Math.max(0, qty), updatedAt: now };
}

export async function setLine(id, scryfallId, section, qty) {
  const deck = await editable(id);
  put(deck, scryfallId, section, qty, Date.now());
  return save(deck);
}

/** Sets several lines to exact quantities in one save. lines: [{ scryfallId, section, qty }]. */
export async function setLines(id, lines) {
  const deck = await editable(id);
  const now = Date.now();
  for (const l of lines) put(deck, l.scryfallId, l.section, l.qty, now);
  return save(deck);
}

export async function addCard(id, scryfallId, section = 'main', delta = 1) {
  const deck = await editable(id);
  const current = deck.lines[lineKey(scryfallId, section)]?.qty ?? 0;
  put(deck, scryfallId, section, current + delta, Date.now());
  return save(deck);
}

export async function moveLine(id, scryfallId, from, to) {
  if (from === to) return;
  const deck = await editable(id);
  const now = Date.now();
  const qty = deck.lines[lineKey(scryfallId, from)]?.qty ?? 0;
  const existing = deck.lines[lineKey(scryfallId, to)]?.qty ?? 0;
  put(deck, scryfallId, from, 0, now);
  put(deck, scryfallId, to, existing + qty, now);
  return save(deck);
}

/** lines: [{scryfallId, section, qty}]. replace: zero out everything not in the import. */
export async function importLines(id, lines, { replace = false } = {}) {
  const deck = await editable(id);
  const now = Date.now();
  const incoming = new Map();
  for (const l of lines) {
    const key = lineKey(l.scryfallId, l.section);
    incoming.set(key, { ...l, qty: (incoming.get(key)?.qty ?? 0) + l.qty });
  }
  if (replace) {
    for (const [key, l] of Object.entries(deck.lines)) if (!incoming.has(key) && l.qty > 0) put(deck, l.scryfallId, l.section, 0, now);
  }
  for (const [key, l] of incoming) {
    const qty = replace ? l.qty : (deck.lines[key]?.qty ?? 0) + l.qty;
    put(deck, l.scryfallId, l.section, qty, now);
  }
  return save(deck);
}

export async function remove(id) {
  const deck = await editable(id);
  deck.deleted = true;
  deck.fieldsUpdatedAt = Date.now();
  return save(deck);
}

export function activeIds(deck) {
  return Object.values(deck.lines)
    .filter((l) => l.qty > 0)
    .map((l) => l.scryfallId);
}

export async function cardsFor(deck, opts) {
  return getCards(activeIds(deck), opts);
}

/** Map oracle_id → copies used across all decks (maybeboards excluded). */
export async function usageByOracle({ excludeDeckId } = {}) {
  const others = (await list()).filter((d) => d.id !== excludeDeckId);
  const cards = await getCards(others.flatMap(activeIds));
  const out = new Map();
  for (const deck of others) {
    for (const l of Object.values(deck.lines)) {
      if (l.qty <= 0 || l.section === 'maybeboard') continue;
      const oracle = cards.get(l.scryfallId)?.oracle_id;
      if (oracle) out.set(oracle, (out.get(oracle) ?? 0) + l.qty);
    }
  }
  return out;
}

/** Decks containing a card (any printing): [{ deck, qty }]. */
export async function decksUsing(oracleId) {
  const all = await list();
  const cards = await getCards(all.flatMap(activeIds));
  return all
    .map((deck) => ({
      deck,
      qty: Object.values(deck.lines)
        .filter((l) => l.qty > 0 && cards.get(l.scryfallId)?.oracle_id === oracleId)
        .reduce((n, l) => n + l.qty, 0),
    }))
    .filter((x) => x.qty > 0);
}
