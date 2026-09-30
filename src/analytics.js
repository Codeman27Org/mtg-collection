import { COLORS } from './constants.js';
import { primaryType, cheapestPrice, anyNumberAllowed, isBasicLand, TYPE_ORDER } from './card-utils.js';
import { formatLabel, deckSize, isSingleton, hasCommander, legalityOf, illegalReason } from './formats.js';

const PIP_KEYS = [...COLORS, 'C'];

/** Counts colored pips in a mana cost; hybrid pips count toward each color. */
export function pips(cost) {
  const counts = Object.fromEntries(PIP_KEYS.map((k) => [k, 0]));
  for (const [, sym] of (cost ?? '').matchAll(/\{([^}]+)\}/g)) {
    for (const part of sym.split('/')) if (part in counts) counts[part]++;
  }
  return counts;
}

const frontCost = (card) => card.mana_cost || card.card_faces?.[0]?.mana_cost || '';

export function activeLines(deck, cards, sections) {
  return Object.values(deck.lines)
    .filter((l) => l.qty > 0 && (!sections || sections.includes(l.section)))
    .map((l) => ({ ...l, card: cards.get(l.scryfallId) }));
}

export function deckStats(deck, cards) {
  const lines = activeLines(deck, cards, ['commander', 'main']);
  const curve = Array.from({ length: 8 }, () => ({}));
  const types = {};
  const pipTotals = Object.fromEntries(PIP_KEYS.map((k) => [k, 0]));
  const identity = new Set();
  let count = 0;
  let cmcSum = 0;
  let nonLand = 0;
  for (const { qty, card } of lines) {
    count += qty;
    if (!card) continue;
    const type = primaryType(card);
    types[type] = (types[type] ?? 0) + qty;
    for (const c of card.color_identity ?? []) identity.add(c);
    const p = pips(frontCost(card));
    for (const k of PIP_KEYS) pipTotals[k] += p[k] * qty;
    if (type !== 'Land') {
      const bucket = Math.min(7, Math.floor(card.cmc ?? 0));
      curve[bucket][type] = (curve[bucket][type] ?? 0) + qty;
      cmcSum += (card.cmc ?? 0) * qty;
      nonLand += qty;
    }
  }
  let price = 0;
  for (const { qty, card } of activeLines(deck, cards, ['commander', 'companion', 'main', 'sideboard'])) {
    price += (cheapestPrice(card) ?? 0) * qty;
  }
  return {
    count,
    curve,
    types: TYPE_ORDER.filter((t) => types[t]).map((t) => [t, types[t]]),
    pips: pipTotals,
    avgCmc: nonLand ? cmcSum / nonLand : 0,
    identity: COLORS.filter((c) => identity.has(c)),
    price,
  };
}

/** Returns a list of human-readable legality problems (empty = legal). */
export function legalityIssues(deck, cards) {
  const issues = [];
  const format = deck.format;
  const label = formatLabel(format);
  const main = activeLines(deck, cards, ['commander', 'main']);
  const side = activeLines(deck, cards, ['sideboard']);
  const count = main.reduce((n, l) => n + l.qty, 0);

  if (deckSize(format)) {
    if (count !== deckSize(format)) issues.push(`Deck has ${count} cards; ${label} needs exactly ${deckSize(format)}.`);
  } else {
    if (count < 60) issues.push(`Deck has ${count} cards; needs at least 60.`);
    const sideCount = side.reduce((n, l) => n + l.qty, 0);
    if (sideCount > 15) issues.push(`Sideboard has ${sideCount} cards; max 15.`);
  }

  const byName = new Map();
  for (const l of [...main, ...side]) {
    if (!l.card) continue;
    const entry = byName.get(l.card.name) ?? { card: l.card, qty: 0 };
    entry.qty += l.qty;
    byName.set(l.card.name, entry);
  }
  const maxCopies = isSingleton(format) ? 1 : 4;
  for (const [name, { card, qty }] of byName) {
    const reason = illegalReason(card, format);
    if (legalityOf(card, format) === 'restricted' && qty > 1) issues.push(`${name} is restricted (max 1).`);
    else if (reason) issues.push(reason.startsWith('mana') ? `${name}: ${reason} for ${label}.` : `${name} is ${reason} in ${label}.`);
    if (qty > maxCopies && !anyNumberAllowed(card)) issues.push(`${name}: ${qty} copies (max ${maxCopies}).`);
  }

  if (hasCommander(format)) {
    const commanders = activeLines(deck, cards, ['commander']);
    if (!commanders.length) issues.push('No commander set.');
    const allowed = new Set(commanders.flatMap((l) => l.card?.color_identity ?? []));
    if (commanders.length) {
      for (const l of activeLines(deck, cards, ['main'])) {
        const outside = (l.card?.color_identity ?? []).filter((c) => !allowed.has(c));
        if (outside.length) issues.push(`${l.card.name} is outside the commander's color identity.`);
      }
    }
  }
  return issues;
}

/**
 * Copies to add so the collection covers a deck list, after what other decks already use.
 * rows: [{ oracleId, qty, ...rest }] → [{ ...rest, oracleId, qty }] limited to the shortfall.
 */
export function shortfall(rows, ownedByOracle, usedByOracle) {
  const remaining = new Map();
  for (const r of rows) {
    if (!remaining.has(r.oracleId)) {
      const available = Math.max(0, (ownedByOracle.get(r.oracleId) ?? 0) - (usedByOracle.get(r.oracleId) ?? 0));
      remaining.set(r.oracleId, -available);
    }
    remaining.set(r.oracleId, remaining.get(r.oracleId) + r.qty);
  }
  const out = [];
  for (const r of rows) {
    const need = remaining.get(r.oracleId);
    if (need <= 0) continue;
    const qty = Math.min(need, r.qty);
    out.push({ ...r, qty });
    remaining.set(r.oracleId, need - qty);
  }
  return out;
}

/**
 * ownedByOracle: Map oracle_id → owned count (all printings).
 * usageByOracle: Map oracle_id → copies used across all decks.
 * Basic lands are never missing or over-allocated; they aren't tracked by count.
 */
export function ownership(deck, cards, ownedByOracle, usageByOracle) {
  const need = new Map();
  for (const l of activeLines(deck, cards, ['commander', 'companion', 'main', 'sideboard'])) {
    if (!l.card || isBasicLand(l.card)) continue;
    const entry = need.get(l.card.oracle_id) ?? { card: l.card, qty: 0 };
    entry.qty += l.qty;
    need.set(l.card.oracle_id, entry);
  }
  const missing = [];
  const overAllocated = [];
  let missingCost = 0;
  for (const [oracleId, { card, qty }] of need) {
    const owned = ownedByOracle.get(oracleId) ?? 0;
    if (owned < qty) {
      missing.push({ card, qty: qty - owned });
      missingCost += (cheapestPrice(card) ?? 0) * (qty - owned);
    }
    const used = usageByOracle.get(oracleId) ?? 0;
    if (owned > 0 && used > owned) overAllocated.push({ card, owned, used });
  }
  missing.sort((a, b) => a.card.name.localeCompare(b.card.name));
  return { missing, missingCost, overAllocated };
}
