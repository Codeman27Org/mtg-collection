// Pure sync helpers: content builders, schema validators, and per-entry last-write-wins merges.
import { UUID_RE, FINISHES, CONDITIONS, SECTIONS, FORMATS } from './constants.js';

/**
 * location: '' (Unsorted), a location UUID, or `deck:<deckId>`. from: where a copy in a deck came from.
 * Both are left out of the key when empty so entries made before locations keep their keys.
 */
export const entryKey = (scryfallId, finish, condition, language, location = '', from = '') =>
  `${scryfallId}:${finish}:${condition}:${language}${location ? `@${location}` : ''}${from ? `<${from}` : ''}`;
export const recordKey = (e) => entryKey(e.scryfallId, e.finish, e.condition, e.language, e.location, e.from);
export const lineKey = (scryfallId, section) => `${scryfallId}:${section}`;

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isQty = (n) => Number.isInteger(n) && n >= 0 && n <= 9999;
const isStr = (s, max = 500) => typeof s === 'string' && s.length <= max;
const isPlainObject = (o) => o != null && typeof o === 'object' && !Array.isArray(o);

export const isLocationId = (s) =>
  s === undefined || s === '' || (typeof s === 'string' && (UUID_RE.test(s) || (s.startsWith('deck:') && UUID_RE.test(s.slice(5)))));

export const isEntryTuple = (t, withTime = true) =>
  Array.isArray(t) &&
  UUID_RE.test(t[0]) &&
  FINISHES.includes(t[1]) &&
  CONDITIONS.includes(t[2]) &&
  isStr(t[3], 8) &&
  isQty(t[4]) &&
  (!withTime || isNum(t[5])) &&
  isLocationId(t[6]) &&
  isLocationId(t[7]);

/** [scryfallId, finish, condition, language, qty, updatedAt, location?, from?] */
export function entryToTuple(e) {
  const t = [e.scryfallId, e.finish, e.condition, e.language, e.qty, e.updatedAt];
  if (e.location || e.from) t.push(e.location ?? '', e.from ?? '');
  return t;
}

export const isLineTuple = (t, withTime = true) =>
  Array.isArray(t) && UUID_RE.test(t[0]) && SECTIONS.includes(t[1]) && isQty(t[2]) && (!withTime || isNum(t[3]));

export const validCollectionContent = (c, withTime = true) =>
  c?.v === 1 && Array.isArray(c.e) && c.e.every((t) => isEntryTuple(t, withTime));

export const validDeckContent = (c, id) =>
  c?.v === 1 &&
  (id === undefined || c.id === id) &&
  isStr(c.name, 200) &&
  FORMATS.includes(c.format) &&
  isStr(c.description ?? '', 5000) &&
  isNum(c.fieldsUpdatedAt) &&
  typeof c.deleted === 'boolean' &&
  (c.createdAt == null || isNum(c.createdAt)) &&
  Array.isArray(c.lines) &&
  c.lines.every((t) => isLineTuple(t));

export const validShare = (s) =>
  isPlainObject(s) &&
  /^[0-9a-f]{32}$/.test(s.id) &&
  ['deck', 'collection'].includes(s.type) &&
  isStr(s.key, 64) &&
  isStr(s.title ?? '', 200) &&
  (s.targetId == null || isStr(s.targetId, 64)) &&
  (s.filter == null || isPlainObject(s.filter)) &&
  isNum(s.createdAt) &&
  isNum(s.updatedAt) &&
  isNum(s.expiresAt) &&
  typeof s.revoked === 'boolean';

export const validShareRegistry = (c) => c?.v === 1 && Array.isArray(c.shares) && c.shares.every(validShare);

export const validSettings = (c) =>
  c?.v === 1 &&
  Array.isArray(c.relays) &&
  c.relays.length <= 20 &&
  c.relays.every((r) => typeof r === 'string' && /^wss:\/\/\S+$/.test(r)) &&
  isNum(c.updatedAt);

export const validLocation = (l) =>
  isPlainObject(l) && UUID_RE.test(l.id) && isStr(l.name, 100) && isNum(l.updatedAt) && typeof l.deleted === 'boolean';

export const validLocations = (c) => c?.v === 1 && Array.isArray(c.locations) && c.locations.length <= 500 && c.locations.every(validLocation);

const validSharedDeck = (d) =>
  isPlainObject(d) &&
  isStr(d.name, 200) &&
  FORMATS.includes(d.format) &&
  isStr(d.description ?? '', 5000) &&
  Array.isArray(d.lines) &&
  d.lines.every((t) => isLineTuple(t, false));

export const validShareManifest = (m) =>
  m?.v === 1 &&
  isStr(m.title ?? '', 200) &&
  ((m.type === 'deck' && m.parts === 0 && validSharedDeck(m.deck)) || (m.type === 'collection' && m.parts === 16));

export function deckTouchedAt(deck) {
  return Math.max(deck.fieldsUpdatedAt ?? 0, ...Object.values(deck.lines).map((l) => l.updatedAt));
}

/** When the deck was made. Decks from before createdAt existed use their oldest timestamp as an estimate. */
export function deckCreatedAt(deck) {
  return deck.createdAt ?? Math.min(deck.fieldsUpdatedAt ?? Infinity, ...Object.values(deck.lines).map((l) => l.updatedAt));
}

export function deckToContent(deck, pruneBefore) {
  return {
    v: 1,
    id: deck.id,
    name: deck.name,
    format: deck.format,
    description: deck.description ?? '',
    fieldsUpdatedAt: deck.fieldsUpdatedAt,
    deleted: !!deck.deleted,
    ...(deck.createdAt ? { createdAt: deck.createdAt } : {}),
    lines: Object.values(deck.lines)
      .filter((l) => !(l.qty === 0 && l.updatedAt < pruneBefore))
      .map((l) => [l.scryfallId, l.section, l.qty, l.updatedAt]),
  };
}

/** localEntries: collection records in this shard. Returns records to write and whether local has newer data. */
export function mergeCollectionShard(localEntries, remoteTuples, pruneBefore) {
  const local = new Map(localEntries.map((e) => [e.key, e]));
  const seen = new Set();
  const toWrite = [];
  let republish = false;
  for (const [scryfallId, finish, condition, language, qty, updatedAt, location = '', from = ''] of remoteTuples) {
    const key = entryKey(scryfallId, finish, condition, language, location, from);
    seen.add(key);
    const l = local.get(key);
    if (!l || updatedAt > l.updatedAt) toWrite.push({ key, scryfallId, finish, condition, language, location, from, qty, updatedAt });
    else if (l.updatedAt > updatedAt) republish = true;
  }
  for (const [key, l] of local) {
    if (!seen.has(key) && !(l.qty === 0 && l.updatedAt < pruneBefore)) republish = true;
  }
  return { toWrite, republish };
}

export function mergeDeck(local, remote, pruneBefore) {
  const deck = local
    ? structuredClone(local)
    : {
        id: remote.id,
        name: remote.name,
        format: remote.format,
        description: remote.description ?? '',
        fieldsUpdatedAt: remote.fieldsUpdatedAt,
        deleted: remote.deleted,
        lines: {},
      };
  let changed = !local;
  let republish = false;
  if (local) {
    if (remote.fieldsUpdatedAt > local.fieldsUpdatedAt) {
      Object.assign(deck, {
        name: remote.name,
        format: remote.format,
        description: remote.description ?? '',
        deleted: remote.deleted,
        fieldsUpdatedAt: remote.fieldsUpdatedAt,
      });
      changed = true;
    } else if (remote.fieldsUpdatedAt < local.fieldsUpdatedAt) {
      republish = true;
    }
  }
  const seen = new Set();
  for (const [scryfallId, section, qty, updatedAt] of remote.lines) {
    const key = lineKey(scryfallId, section);
    seen.add(key);
    const l = deck.lines[key];
    if (!l || updatedAt > l.updatedAt) {
      deck.lines[key] = { scryfallId, section, qty, updatedAt };
      changed = true;
    } else if (l.updatedAt > updatedAt) {
      republish = true;
    }
  }
  for (const [key, l] of Object.entries(deck.lines)) {
    if (!seen.has(key) && !(l.qty === 0 && l.updatedAt < pruneBefore)) republish = true;
  }
  // createdAt never changes once set; keep the earliest either side knows.
  const created = [local?.createdAt, remote.createdAt].filter(isNum);
  if (created.length) {
    const earliest = Math.min(...created);
    if (deck.createdAt !== earliest) {
      deck.createdAt = earliest;
      changed = true;
    }
    if (remote.createdAt !== earliest) republish = true;
  }
  deck.touchedAt = deckTouchedAt(deck);
  return { deck, changed, republish };
}

/** Last-write-wins by updatedAt for records with an id (shares). */
export function mergeById(localList, remoteList) {
  const local = new Map(localList.map((r) => [r.id, r]));
  const seen = new Set();
  const toWrite = [];
  let republish = false;
  for (const r of remoteList) {
    seen.add(r.id);
    const l = local.get(r.id);
    if (!l || r.updatedAt > l.updatedAt) toWrite.push(r);
    else if (l.updatedAt > r.updatedAt) republish = true;
  }
  for (const id of local.keys()) if (!seen.has(id)) republish = true;
  return { toWrite, republish };
}
