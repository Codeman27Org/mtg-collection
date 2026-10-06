// Pure planner for "scan a deck": the scanned cards become the deck, and the scanned copies end up in its location.
import { isBasicLand } from '../card-utils.js';
import { deckLocation, isDeckLocation } from '../location-logic.js';

const PLAYED = ['commander', 'companion', 'main', 'sideboard'];
// When the scan has fewer copies than the list, trim these sections first.
const TRIM_ORDER = ['main', 'sideboard', 'companion', 'commander'];

/**
 * deck: { id, lines }; cards: Map scryfallId → card (deck lines, entries, and scans);
 * entries: every owned stack; scanned: [{ scryfallId, finish, qty }].
 * sources: Map itemKey ("scryfallId:finish") → where those copies come from: 'loose' (binders and Unsorted), 'new',
 * or another deck's location id. Unset means 'loose' when there's a loose copy, else 'new'.
 * Basic lands are left alone, in the list and in the deck's location.
 *
 * Returns {
 *   lines: [{ id, kind: 'add' | 'more' | 'fewer' | 'remove', card, scryfallId, section, from, to, checked }],
 *     (checked: false for an unscanned commander, which is left in the list)
 *   kept,                                    // scanned copies already recorded in the deck
 *   moves: [{ id, entry, qty, fromDeck, unit }], // copies to move in; fromDeck is set for copies in another deck
 *   adds: [{ id, scryfallId, finish, qty }],  // scanned copies added to the collection as new
 *   returns: [{ id, entry, qty }],            // copies recorded in the deck that weren't scanned
 *   choices: Map itemKey → { kept, value, options: [{ value, qty, locations? }] },
 * }
 */
export function planDeckScan(deck, cards, entries, scanned, sources = new Map()) {
  const here = deckLocation(deck.id);
  const oracleOf = (id) => cards.get(id)?.oracle_id;
  const tracked = (id) => {
    const card = cards.get(id);
    return card && !isBasicLand(card);
  };

  const want = new Map();
  for (const s of scanned) {
    if (s.qty <= 0 || !tracked(s.scryfallId)) continue;
    const oracle = oracleOf(s.scryfallId);
    const w = want.get(oracle) ?? { total: 0, units: [] };
    w.total += s.qty;
    const unit = w.units.find((u) => u.scryfallId === s.scryfallId && u.finish === s.finish);
    if (unit) unit.qty += s.qty;
    else w.units.push({ scryfallId: s.scryfallId, finish: s.finish, qty: s.qty });
    want.set(oracle, w);
  }

  const listed = new Map();
  for (const l of Object.values(deck.lines)) {
    if (l.qty <= 0 || !PLAYED.includes(l.section) || !tracked(l.scryfallId)) continue;
    const oracle = oracleOf(l.scryfallId);
    if (!listed.has(oracle)) listed.set(oracle, []);
    listed.get(oracle).push(l);
  }

  // ---- the list
  const lines = [];
  for (const oracle of new Set([...want.keys(), ...listed.keys()])) {
    const scannedQty = want.get(oracle)?.total ?? 0;
    const rows = listed.get(oracle) ?? [];
    const listedQty = rows.reduce((n, l) => n + l.qty, 0);
    if (scannedQty > listedQty) {
      if (!rows.length) {
        const top = [...want.get(oracle).units].sort((a, b) => b.qty - a.qty)[0];
        lines.push(change('add', top.scryfallId, 'main', 0, scannedQty));
      } else {
        const target = rows.find((l) => l.section === 'main') ?? rows[0];
        lines.push(change('more', target.scryfallId, target.section, target.qty, target.qty + scannedQty - listedQty));
      }
    } else if (scannedQty < listedQty) {
      let cut = listedQty - scannedQty;
      for (const l of [...rows].sort((a, b) => TRIM_ORDER.indexOf(a.section) - TRIM_ORDER.indexOf(b.section))) {
        if (!cut) break;
        const n = Math.min(cut, l.qty);
        lines.push(change(n === l.qty ? 'remove' : 'fewer', l.scryfallId, l.section, l.qty, l.qty - n));
        cut -= n;
      }
    }
  }
  function change(kind, scryfallId, section, from, to) {
    // A commander you didn't scan is more likely out of the box than out of the deck, so don't cut it by default.
    const checked = !(section === 'commander' && to < from);
    return { id: `line:${scryfallId}:${section}`, kind, card: cards.get(scryfallId), scryfallId, section, from, to, checked };
  }

  // ---- the copies
  const stacks = new Map();
  for (const e of entries) {
    if (e.qty <= 0 || !tracked(e.scryfallId)) continue;
    const oracle = oracleOf(e.scryfallId);
    if (!stacks.has(oracle)) stacks.set(oracle, []);
    stacks.get(oracle).push(e);
  }

  let kept = 0;
  const moves = [];
  const adds = [];
  const returns = [];
  const choices = new Map();
  for (const [oracle, w] of want) {
    const own = stacks.get(oracle) ?? [];
    const units = w.units.map((u) => ({ ...u, left: u.qty }));
    const avail = new Map(own.map((e) => [e.key, e.qty]));
    const sum = (list) => list.reduce((n, e) => n + (avail.get(e.key) ?? 0), 0);
    const inDeck = own.filter((e) => e.location === here);
    const loose = own.filter((e) => !isDeckLocation(e.location));
    const otherDecks = own.filter((e) => isDeckLocation(e.location) && e.location !== here);

    const keptHere = take(inDeck, units, avail);
    kept += keptHere.reduce((n, t) => n + t.qty, 0);
    for (const u of units) {
      const key = `${u.scryfallId}:${u.finish}`;
      const options = [];
      const looseLeft = loose.filter((e) => avail.get(e.key) > 0);
      if (looseLeft.length) options.push({ value: 'loose', qty: sum(looseLeft), locations: [...new Set(looseLeft.map((e) => e.location))] });
      for (const loc of new Set(otherDecks.map((e) => e.location))) {
        const qty = sum(otherDecks.filter((e) => e.location === loc));
        if (qty > 0) options.push({ value: loc, qty });
      }
      options.push({ value: 'new', qty: Infinity });
      const asked = sources.get(key);
      const value = options.some((o) => o.value === asked) ? asked : looseLeft.length ? 'loose' : 'new';
      const keptQty = keptHere.filter((t) => t.unit.scryfallId === u.scryfallId && t.unit.finish === u.finish).reduce((n, t) => n + t.qty, 0);
      choices.set(key, { kept: keptQty, value: u.left > 0 ? value : null, options: u.left > 0 ? options : [] });
      if (u.left <= 0 || value === 'new') continue;
      const pool = value === 'loose' ? loose : otherDecks.filter((e) => e.location === value);
      for (const t of take(pool, [u], avail)) moves.push({ id: `move:${t.entry.key}:${key}`, entry: t.entry, qty: t.qty, fromDeck: value === 'loose' ? null : value, unit: t.unit });
    }
    for (const u of units) if (u.left > 0) adds.push({ id: `add:${u.scryfallId}:${u.finish}`, scryfallId: u.scryfallId, finish: u.finish, qty: u.left });
    for (const e of inDeck) if (avail.get(e.key) > 0) returns.push({ id: `return:${e.key}`, entry: e, qty: avail.get(e.key) });
  }
  for (const [oracle, own] of stacks) {
    if (want.has(oracle)) continue;
    for (const e of own) if (e.location === here) returns.push({ id: `return:${e.key}`, entry: e, qty: e.qty });
  }

  return { lines, kept, moves, adds, returns, choices };
}

/**
 * Assigns stacks to scanned copies, closest match first: same printing and finish, same printing,
 * same finish, then anything. Updates units[].left and avail; returns [{ entry, qty, unit }].
 */
function take(pool, units, avail) {
  const out = [];
  const rank = (e, u) => (e.scryfallId === u.scryfallId ? 0 : 2) + (e.finish === u.finish ? 0 : 1);
  const sorted = [...pool].sort((a, b) => b.qty - a.qty);
  for (let level = 0; level < 4; level++) {
    for (const u of units) {
      for (const e of sorted) {
        if (u.left <= 0) break;
        const n = Math.min(u.left, avail.get(e.key) ?? 0);
        if (n <= 0 || rank(e, u) !== level) continue;
        avail.set(e.key, avail.get(e.key) - n);
        u.left -= n;
        const prev = out.find((t) => t.entry === e && t.unit.scryfallId === u.scryfallId && t.unit.finish === u.finish);
        if (prev) prev.qty += n;
        else out.push({ entry: e, qty: n, unit: { scryfallId: u.scryfallId, finish: u.finish } });
      }
    }
  }
  // One move per stack, so ids stay unique.
  const merged = new Map();
  for (const t of out) {
    const m = merged.get(t.entry.key);
    if (m) m.qty += t.qty;
    else merged.set(t.entry.key, { ...t });
  }
  return [...merged.values()];
}
