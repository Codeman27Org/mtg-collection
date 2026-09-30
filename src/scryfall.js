import { sharedDB, getPref, setPref } from './db.js';
import { sleep } from './util.js';
import { PRICE_TTL, DAY } from './constants.js';

const API = 'https://api.scryfall.com';
// Scryfall hard limits: 2/s for these endpoints, 10/s for everything else; a 429 blocks for 30 s.
const SLOW = /^\/cards\/(search|named|random|collection)/;
const PENALTY_MS = 30_000;

let queue = Promise.resolve();
let lastRequest = 0;

/** Serializes every Scryfall request and spaces them per Scryfall's published rate limits. */
function request(path, { method = 'GET', body } = {}) {
  const run = async () => {
    const wait = lastRequest + (SLOW.test(path) ? 500 : 100) - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      // Scryfall's 429 responses carry no CORS headers, so the browser reports them as network errors.
      lastRequest = Date.now() + PENALTY_MS;
      throw new Error('Couldn’t reach Scryfall (offline or rate-limited). Try again in 30 seconds.');
    }
    if (res.status === 429) {
      lastRequest = Date.now() + PENALTY_MS;
      throw new Error('Scryfall rate limit hit; please wait 30 seconds and try again.');
    }
    const data = await res.json();
    return { status: res.status, data };
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

const pickImages = (uris) => uris && { small: uris.small, normal: uris.normal, art_crop: uris.art_crop };

export function trim(c) {
  return {
    id: c.id,
    oracle_id: c.oracle_id ?? c.card_faces?.[0]?.oracle_id,
    name: c.name,
    lang: c.lang,
    layout: c.layout,
    mana_cost: c.mana_cost,
    cmc: c.cmc ?? 0,
    type_line: c.type_line ?? c.card_faces?.map((f) => f.type_line).join(' // ') ?? '',
    oracle_text: c.oracle_text,
    flavor_text: c.flavor_text,
    power: c.power,
    toughness: c.toughness,
    loyalty: c.loyalty,
    colors: c.colors,
    color_identity: c.color_identity ?? [],
    keywords: c.keywords ?? [],
    set: c.set,
    set_name: c.set_name,
    collector_number: c.collector_number,
    rarity: c.rarity,
    artist: c.artist ?? c.card_faces?.[0]?.artist,
    illustration_id: c.illustration_id ?? c.card_faces?.[0]?.illustration_id,
    released_at: c.released_at,
    image_uris: pickImages(c.image_uris),
    card_faces: c.card_faces?.map((f) => ({
      name: f.name,
      mana_cost: f.mana_cost,
      type_line: f.type_line,
      oracle_text: f.oracle_text,
      flavor_text: f.flavor_text,
      power: f.power,
      toughness: f.toughness,
      loyalty: f.loyalty,
      colors: f.colors,
      image_uris: pickImages(f.image_uris),
    })),
    prices: c.prices ?? {},
    finishes: c.finishes ?? [],
    legalities: c.legalities ?? {},
    edhrec_rank: c.edhrec_rank,
    mtgo_id: c.mtgo_id,
    scryfall_uri: c.scryfall_uri,
    fetchedAt: Date.now(),
  };
}

async function storeCards(cards) {
  const tx = (await sharedDB()).transaction('cards', 'readwrite');
  for (const card of cards) tx.store.put(card);
  await tx.done;
}

export async function getCachedCards(ids) {
  const db = await sharedDB();
  const out = new Map();
  const tx = db.transaction('cards');
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      const card = await tx.store.get(id);
      if (card) out.set(id, card);
    }),
  );
  return out;
}

export async function allCachedCards() {
  return (await sharedDB()).getAll('cards');
}

/**
 * Batch lookup via POST /cards/collection (75 per request).
 * identifiers: [{id} | {set, collector_number} | {name, set?}]
 */
export async function fetchCollection(identifiers, onProgress) {
  const found = [];
  const notFound = [];
  for (let i = 0; i < identifiers.length; i += 75) {
    const chunk = identifiers.slice(i, i + 75);
    const { status, data } = await request('/cards/collection', { method: 'POST', body: { identifiers: chunk } });
    if (status !== 200) throw new Error(data?.details ?? `Scryfall error ${status}`);
    found.push(...data.data.map(trim));
    notFound.push(...(data.not_found ?? []));
    onProgress?.(Math.min(i + 75, identifiers.length), identifiers.length);
  }
  await storeCards(found);
  return { found, notFound };
}

/** Returns a Map of id → card, fetching anything missing (or stale, if refresh is set). */
export async function getCards(ids, { refresh = false, onProgress } = {}) {
  const unique = [...new Set(ids)];
  const cached = await getCachedCards(unique);
  const cutoff = Date.now() - PRICE_TTL;
  const missing = unique.filter((id) => !cached.has(id) || (refresh && cached.get(id).fetchedAt < cutoff));
  if (missing.length) {
    const { found } = await fetchCollection(
      missing.map((id) => ({ id })),
      onProgress,
    );
    for (const card of found) cached.set(card.id, card);
  }
  return cached;
}

export async function getCard(id) {
  return (await getCards([id])).get(id);
}

export async function search(q, { page = 1, order = 'edhrec', dir = 'auto', unique = 'cards' } = {}) {
  const params = new URLSearchParams({ q, page: String(page), order, dir, unique });
  const { status, data } = await request(`/cards/search?${params}`);
  if (status === 404) return { cards: [], total: 0, hasMore: false };
  if (status !== 200) throw new Error(data?.details ?? `Scryfall error ${status}`);
  const cards = data.data.map(trim);
  await storeCards(cards);
  return { cards, total: data.total_cards, hasMore: data.has_more };
}

const autocompleteMemo = new Map();
export async function autocomplete(q) {
  const key = q.trim().toLowerCase();
  if (key.length < 2) return [];
  if (!autocompleteMemo.has(key)) {
    const { data } = await request(`/cards/autocomplete?q=${encodeURIComponent(key)}`);
    autocompleteMemo.set(key, data?.data ?? []);
  }
  return autocompleteMemo.get(key);
}

export async function named(fuzzy) {
  const { status, data } = await request(`/cards/named?fuzzy=${encodeURIComponent(fuzzy)}`);
  if (status !== 200) return null;
  const card = trim(data);
  await storeCards([card]);
  return card;
}

export async function prints(oracleId) {
  const { cards } = await search(`oracleid:${oracleId}`, { order: 'released', unique: 'prints' });
  return cards;
}

/** Paper printings only (for identifying a physical card). */
export async function paperPrints(oracleId) {
  const { cards } = await search(`oracleid:${oracleId} game:paper`, { order: 'released', unique: 'prints' });
  return cards;
}

export async function namedExact(name) {
  const { status, data } = await request(`/cards/named?exact=${encodeURIComponent(name)}`);
  if (status !== 200) return null;
  const card = trim(data);
  await storeCards([card]);
  return card;
}

/** Every card name (about 35,000), cached for a week. */
export async function cardNames() {
  const cached = await getPref('card-names');
  if (cached && Date.now() - cached.fetchedAt < 7 * DAY) return cached.data;
  try {
    const { status, data } = await request('/catalog/card-names');
    if (status !== 200) throw new Error(data?.details ?? `Scryfall error ${status}`);
    await setPref('card-names', { fetchedAt: Date.now(), data: data.data });
    return data.data;
  } catch (err) {
    if (cached) return cached.data;
    throw err;
  }
}

export async function sets() {
  const cached = await getPref('sets');
  if (cached && Date.now() - cached.fetchedAt < DAY) return cached.data;
  const { status, data } = await request('/sets');
  if (status !== 200) return cached?.data ?? [];
  const slim = data.data.map((s) => ({
    code: s.code,
    name: s.name,
    set_type: s.set_type,
    released_at: s.released_at,
    card_count: s.card_count,
    icon_svg_uri: s.icon_svg_uri,
  }));
  await setPref('sets', { fetchedAt: Date.now(), data: slim });
  return slim;
}
