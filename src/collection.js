import { accountDB } from './db.js';
import * as account from './account.js';
import { markDirty, markSharesFor } from './sync.js';
import { emit, on } from './bus.js';
import { entryKey } from './merge.js';
import { originFor } from './location-logic.js';
import { PREFIX } from './constants.js';
import { getCards } from './scryfall.js';

let cache = null;
let cacheFor = null;

on('account', () => (cache = null));
on('remote:collection', () => {
  cache = null;
  emit('collection');
});

export function requireEdit() {
  if (!account.canEdit()) throw new Error('Unlock your account to make changes.');
}

async function load() {
  const pubkey = account.current();
  if (!cache || cacheFor !== pubkey) {
    const all = await (await accountDB(pubkey)).getAll('collection');
    cache = new Map(all.map((e) => [e.key, e]));
    cacheFor = pubkey;
  }
  return cache;
}

/** Owned stacks (qty > 0). */
export async function entries() {
  return [...(await load()).values()].filter((e) => e.qty > 0);
}

/** Card data for every owned stack, fetching anything not cached yet. */
export async function cardsFor(list, opts) {
  return getCards(
    list.map((e) => e.scryfallId),
    opts,
  );
}

async function write(records) {
  requireEdit();
  if (!records.length) return;
  const map = await load();
  const tx = (await accountDB(account.current())).transaction('collection', 'readwrite');
  for (const r of records) {
    tx.store.put(r);
    map.set(r.key, r);
  }
  await tx.done;
  await markDirty(...new Set(records.map((r) => `${PREFIX}collection:${r.scryfallId[0]}`)));
  await markSharesFor({ collection: true });
  emit('collection');
}

export async function setQty(scryfallId, finish, qty, { condition = 'NM', language = 'en', location = '', from = '' } = {}) {
  await write([
    {
      key: entryKey(scryfallId, finish, condition, language, location, from),
      scryfallId,
      finish,
      condition,
      language,
      location,
      from,
      qty: Math.max(0, qty),
      updatedAt: Date.now(),
    },
  ]);
}

export async function adjust(scryfallId, finish, delta, opts = {}) {
  const map = await load();
  const current = map.get(entryKey(scryfallId, finish, opts.condition ?? 'NM', opts.language ?? 'en', opts.location, opts.from))?.qty ?? 0;
  await setQty(scryfallId, finish, current + delta, opts);
}

/**
 * rows: [{scryfallId, finish, condition, language, qty, location?}]; mode: 'replace' | 'merge'.
 * Replace only clears the locations the rows are going into; other locations are left alone.
 */
export async function importRows(rows, mode) {
  const map = await load();
  const now = Date.now();
  const incoming = new Map();
  for (const r of rows) {
    const location = r.location ?? '';
    const key = entryKey(r.scryfallId, r.finish, r.condition, r.language, location);
    const prev = incoming.get(key);
    incoming.set(key, { ...r, location, from: '', key, qty: (prev?.qty ?? 0) + r.qty });
  }
  const records = [];
  for (const [key, r] of incoming) {
    const qty = mode === 'merge' ? (map.get(key)?.qty ?? 0) + r.qty : r.qty;
    if (map.get(key)?.qty !== qty) records.push({ ...r, qty, updatedAt: now });
  }
  if (mode === 'replace') {
    const scope = new Set([...incoming.values()].map((r) => r.location));
    for (const [key, e] of map) {
      if (!incoming.has(key) && e.qty > 0 && scope.has(e.location ?? '')) records.push({ ...e, qty: 0, updatedAt: now });
    }
  }
  await write(records);
  return records.length;
}

/**
 * moves: [{ entry, qty, to }]. Copies keep printing, finish, condition, and language.
 * Copies moved into a deck remember where they came from so they can be sent back.
 */
export async function move(moves) {
  const map = await load();
  const now = Date.now();
  const changed = new Map();
  const current = (key) => changed.get(key) ?? map.get(key);
  let moved = 0;
  for (const { entry, qty, to } of moves) {
    const src = current(entry.key);
    const n = Math.min(qty, src?.qty ?? 0);
    if (n <= 0 || (src.location ?? '') === to) continue;
    moved += n;
    changed.set(src.key, { ...src, qty: src.qty - n, updatedAt: now });
    const from = originFor(src, to);
    const key = entryKey(src.scryfallId, src.finish, src.condition, src.language, to, from);
    changed.set(key, {
      key,
      scryfallId: src.scryfallId,
      finish: src.finish,
      condition: src.condition,
      language: src.language,
      location: to,
      from,
      qty: (current(key)?.qty ?? 0) + n,
      updatedAt: now,
    });
  }
  await write([...changed.values()]);
  return moved;
}

/** Map scryfallId → { nonfoil, foil, etched, total }. */
export async function ownedById() {
  const out = new Map();
  for (const e of await entries()) {
    const o = out.get(e.scryfallId) ?? { nonfoil: 0, foil: 0, etched: 0, total: 0 };
    o[e.finish] += e.qty;
    o.total += e.qty;
    out.set(e.scryfallId, o);
  }
  return out;
}

/** Map oracle_id → owned copies across all printings. */
export async function ownedByOracle() {
  const list = await entries();
  const cards = await cardsFor(list);
  const out = new Map();
  for (const e of list) {
    const oracle = cards.get(e.scryfallId)?.oracle_id;
    if (oracle) out.set(oracle, (out.get(oracle) ?? 0) + e.qty);
  }
  return out;
}
