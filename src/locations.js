// Named places for physical cards (binders, boxes). Decks are locations automatically.
import { accountDB } from './db.js';
import * as account from './account.js';
import * as collection from './collection.js';
import * as decks from './decks.js';
import { markDirty } from './sync.js';
import { emit, on } from './bus.js';
import { PREFIX } from './constants.js';
import { UNSORTED, deckLocation, deckIdOf, isDeckLocation, returnTarget } from './location-logic.js';

let cache = null;
let cacheFor = null;

on('account', () => (cache = null));
on('remote:locations', () => {
  cache = null;
  emit('locations');
});

async function records() {
  const pubkey = account.current();
  if (!cache || cacheFor !== pubkey) {
    cache = (await (await accountDB(pubkey)).get('settings', 'locations')) ?? [];
    cacheFor = pubkey;
  }
  return cache;
}

async function save(list) {
  collection.requireEdit();
  await (await accountDB(account.current())).put('settings', list, 'locations');
  cache = list;
  await markDirty(`${PREFIX}locations`);
  emit('locations');
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/** Binders/boxes the user created, sorted by name. */
export async function list() {
  return (await records()).filter((l) => !l.deleted).sort(byName);
}

function cleanName(name) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!n) throw new Error('Give the location a name.');
  if (n.length > 100) throw new Error('Location names can be up to 100 characters.');
  return n;
}

export async function create(name) {
  const n = cleanName(name);
  const all = await records();
  if (all.some((l) => !l.deleted && l.name.toLowerCase() === n.toLowerCase())) throw new Error(`There’s already a location called “${n}”.`);
  const rec = { id: crypto.randomUUID(), name: n, updatedAt: Date.now(), deleted: false };
  await save([...all, rec]);
  return rec;
}

/** Case-insensitive match on an existing binder/box name, or a new one. */
export async function findOrCreate(name) {
  const n = cleanName(name);
  return (await list()).find((l) => l.name.toLowerCase() === n.toLowerCase()) ?? create(n);
}

export async function rename(id, name) {
  const n = cleanName(name);
  const all = await records();
  if (all.some((l) => !l.deleted && l.id !== id && l.name.toLowerCase() === n.toLowerCase())) throw new Error(`There’s already a location called “${n}”.`);
  await save(all.map((l) => (l.id === id ? { ...l, name: n, updatedAt: Date.now() } : l)));
}

/** Deletes a binder/box; its cards move to Unsorted. */
export async function remove(id) {
  const here = (await collection.entries()).filter((e) => e.location === id);
  if (here.length) await collection.move(here.map((e) => ({ entry: e, qty: e.qty, to: UNSORTED })));
  await save((await records()).map((l) => (l.id === id ? { ...l, deleted: true, updatedAt: Date.now() } : l)));
}

/** Every place a card can be: [{ id, name, kind: 'unsorted' | 'binder' | 'deck', deckId?, format? }]. */
export async function all() {
  const binders = (await list()).map((l) => ({ id: l.id, name: l.name, kind: 'binder' }));
  const deckLocs = (await decks.list()).map((d) => ({ id: deckLocation(d.id), name: d.name, kind: 'deck', deckId: d.id, format: d.format })).sort(byName);
  return [{ id: UNSORTED, name: 'Unsorted', kind: 'unsorted' }, ...binders, ...deckLocs];
}

/** Returns a sync lookup: id → { id, name, kind }. Unknown ids (e.g. a location deleted on another device) read as such. */
export async function lookup() {
  const map = new Map((await all()).map((l) => [l.id, l]));
  return (id) =>
    map.get(id ?? '') ?? { id, name: isDeckLocation(id) ? 'Deleted deck' : 'Removed location', kind: isDeckLocation(id) ? 'deck' : 'binder' };
}

/** Returns a sync check: does this location id exist right now? */
export async function existsCheck() {
  const ids = new Set((await all()).map((l) => l.id));
  return (id) => ids.has(id);
}

/** Moves copies into a deck's location. pulls: [{ entry, qty }] from deckPlan. */
export async function pullIntoDeck(deckId, pulls) {
  return collection.move(pulls.map((p) => ({ entry: p.entry, qty: p.qty, to: deckLocation(deckId) })));
}

/** Sends copies back to where they came from (or Unsorted). items: [{ entry, qty }]. */
export async function sendBack(items) {
  const exists = await existsCheck();
  return collection.move(items.map(({ entry, qty }) => ({ entry, qty, to: returnTarget(entry, exists) })));
}

/** Before a deck is deleted: everything in its location goes back. */
export async function dismantleDeck(deckId) {
  const here = (await collection.entries()).filter((e) => e.location === deckLocation(deckId));
  const exists = await existsCheck();
  const notSelf = (id) => exists(id) && deckIdOf(id) !== deckId;
  if (!here.length) return 0;
  return collection.move(here.map((e) => ({ entry: e, qty: e.qty, to: returnTarget(e, notSelf) })));
}
