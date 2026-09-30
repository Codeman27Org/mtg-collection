import { fetchCollection, getCards, sets as fetchSets } from './scryfall.js';

const nameKey = (name) => name.trim().toLowerCase();

function indexByName(cards) {
  const map = new Map();
  for (const card of cards) {
    map.set(nameKey(card.name), card);
    for (const face of card.card_faces ?? []) if (!map.has(nameKey(face.name))) map.set(nameKey(face.name), card);
  }
  return map;
}

/** Picks a real set code from a row's set code or set name, whichever the CSV provided. */
export function setCodeFor(row, codes, codeByName) {
  for (const v of [row.setCode, row.setName]) {
    const s = v?.trim().toLowerCase();
    if (!s) continue;
    if (codes.has(s)) return s;
    if (codeByName.has(s)) return codeByName.get(s);
  }
  return null;
}

/**
 * Attaches a Scryfall card to each parsed row (row.card), in place, trying in order:
 * Scryfall ID → set + collector number → name + set → name. Rows matched by name only get row.review = true.
 */
export async function resolveRows(rows, onProgress) {
  const ids = [...new Set(rows.map((r) => r.scryfallId).filter(Boolean))];
  const byId = ids.length
    ? await getCards(ids, { onProgress: (done, total) => onProgress?.('Looking up cards by Scryfall ID', done, total) })
    : new Map();
  for (const r of rows) r.card = (r.scryfallId && byId.get(r.scryfallId)) || null;

  let pending = rows.filter((r) => !r.card);
  if (pending.some((r) => r.setCode || r.setName)) {
    onProgress?.('Loading set list', 0, 1);
    const list = await fetchSets();
    const codes = new Set(list.map((s) => s.code));
    const codeByName = new Map(list.map((s) => [s.name.toLowerCase(), s.code]));
    for (const r of pending) r.set = setCodeFor(r, codes, codeByName);
  }

  const withNumber = pending.filter((r) => r.set && r.cn);
  if (withNumber.length) {
    const identifiers = [...new Map(withNumber.map((r) => [`${r.set}|${r.cn.toLowerCase()}`, { set: r.set, collector_number: r.cn }])).values()];
    const { found } = await fetchCollection(identifiers, (done, total) => onProgress?.('Looking up cards by set and number', done, total));
    const bySetNumber = new Map(found.map((c) => [`${c.set}|${c.collector_number.toLowerCase()}`, c]));
    for (const r of withNumber) r.card = bySetNumber.get(`${r.set}|${r.cn.toLowerCase()}`) ?? null;
  }

  pending = rows.filter((r) => !r.card && r.name && r.set);
  if (pending.length) {
    const identifiers = [...new Map(pending.map((r) => [`${nameKey(r.name)}|${r.set}`, { name: r.name, set: r.set }])).values()];
    const { found } = await fetchCollection(identifiers, (done, total) => onProgress?.('Matching cards by name and set', done, total));
    const byNameSet = new Map();
    for (const c of found) for (const [name, card] of indexByName([c])) byNameSet.set(`${name}|${c.set}`, card);
    for (const r of pending) r.card = byNameSet.get(`${nameKey(r.name)}|${r.set}`) ?? null;
  }

  pending = rows.filter((r) => !r.card && r.name);
  if (pending.length) {
    const names = [...new Set(pending.map((r) => nameKey(r.name)))];
    const { found } = await fetchCollection(
      names.map((name) => ({ name })),
      (done, total) => onProgress?.('Matching remaining cards by name', done, total),
    );
    const byName = indexByName(found);
    for (const r of pending) {
      r.card = byName.get(nameKey(r.name)) ?? null;
      r.review = !!r.card;
    }
  }
  return rows;
}
