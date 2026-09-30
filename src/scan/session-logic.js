// Pure scan-session state. A session is stored as-is; these helpers mutate it and return it.

export const itemKey = (scryfallId, finish) => `${scryfallId}:${finish}`;

/** newDeck: { name, format } for a deck that's only created when the scan is saved. */
export function newSession({ mode, location = '', recount = false, deckId = null, newDeck = null }) {
  const now = Date.now();
  return { mode, location, recount, deckId, newDeck, items: [], log: [], createdAt: now, updatedAt: now };
}

export const scannedCount = (session) => session.items.reduce((n, i) => n + i.qty, 0);

function itemFor(card, finish) {
  return { key: itemKey(card.id, finish), scryfallId: card.id, oracleId: card.oracle_id, name: card.name, finish, qty: 0 };
}

/** One scanned copy. Repeats of the same printing and finish stack up. */
export function addScan(session, card, finish) {
  const key = itemKey(card.id, finish);
  let item = session.items.find((i) => i.key === key);
  if (!item) session.items.push((item = itemFor(card, finish)));
  item.qty++;
  session.log.push(key);
  session.updatedAt = Date.now();
  return session;
}

/** Removes the most recent scan. Returns the item key it came from, or null. */
export function undoLast(session) {
  const key = session.log.pop();
  if (!key) return null;
  const item = session.items.find((i) => i.key === key);
  if (item && --item.qty <= 0) session.items = session.items.filter((i) => i !== item);
  session.updatedAt = Date.now();
  return key;
}

export function setQty(session, key, qty) {
  const item = session.items.find((i) => i.key === key);
  if (!item) return session;
  const n = Math.max(0, Math.floor(qty));
  // Keep the undo log in step: drop the newest entries for this item when copies are taken away.
  for (let extra = item.qty - n, i = session.log.length - 1; extra > 0 && i >= 0; i--) {
    if (session.log[i] === key) {
      session.log.splice(i, 1);
      extra--;
    }
  }
  item.qty = n;
  if (!n) session.items = session.items.filter((i) => i.key !== key);
  session.updatedAt = Date.now();
  return session;
}

/**
 * Moves copies of an item to another card/printing/finish (fixing a misread).
 * qty defaults to every copy; the most recent scan only is { qty: 1 }.
 */
export function replaceItem(session, key, card, finish, qty = Infinity) {
  const item = session.items.find((i) => i.key === key);
  if (!item) return session;
  const n = Math.min(item.qty, qty);
  const newKey = itemKey(card.id, finish);
  if (newKey === key) return session;
  let target = session.items.find((i) => i.key === newKey);
  if (!target) session.items.splice(session.items.indexOf(item) + 1, 0, (target = itemFor(card, finish)));
  target.qty += n;
  item.qty -= n;
  for (let moved = 0, i = session.log.length - 1; moved < n && i >= 0; i--) {
    if (session.log[i] === key) {
      session.log[i] = newKey;
      moved++;
    }
  }
  if (!item.qty) session.items = session.items.filter((i) => i !== item);
  session.updatedAt = Date.now();
  return session;
}

/**
 * Rows for recounting a binder: the location should hold exactly what was scanned.
 * existing: stacks at the location; scanned: [{ scryfallId, finish, qty }]; keep(entry): stacks left alone (basic lands).
 * Scanned copies take over matching stacks first so their condition and language survive.
 * Returns { rows, added: [{ scryfallId, finish, qty }], removed: [{ entry, qty }] }.
 */
export function planRecount(location, existing, scanned, keep = () => false) {
  const rows = [];
  const added = [];
  const removed = [];
  const byItem = new Map();
  for (const e of existing) {
    if (e.qty <= 0) continue;
    if (keep(e)) {
      rows.push(rowOf(e, e.qty, location));
      continue;
    }
    const k = itemKey(e.scryfallId, e.finish);
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k).push(e);
  }
  const scannedQty = new Map();
  for (const s of scanned) {
    const k = itemKey(s.scryfallId, s.finish);
    scannedQty.set(k, (scannedQty.get(k) ?? 0) + s.qty);
  }
  for (const [k, qty] of scannedQty) {
    let left = qty;
    const [scryfallId, finish] = [k.slice(0, k.lastIndexOf(':')), k.slice(k.lastIndexOf(':') + 1)];
    for (const e of (byItem.get(k) ?? []).sort((a, b) => b.qty - a.qty)) {
      const take = Math.min(left, e.qty);
      if (take) rows.push(rowOf(e, take, location));
      if (e.qty > take) removed.push({ entry: e, qty: e.qty - take });
      left -= take;
    }
    if (left > 0) {
      rows.push({ scryfallId, finish, condition: 'NM', language: 'en', qty: left, location });
      added.push({ scryfallId, finish, qty: left });
    }
    byItem.delete(k);
  }
  for (const list of byItem.values()) for (const e of list) removed.push({ entry: e, qty: e.qty });
  return { rows, added, removed };
}

const rowOf = (e, qty, location) => ({
  scryfallId: e.scryfallId,
  finish: e.finish,
  condition: e.condition ?? 'NM',
  language: e.language ?? 'en',
  qty,
  location,
});
