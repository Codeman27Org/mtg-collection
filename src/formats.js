// Deck format rules, including formats Scryfall doesn't track (Tiny Leaders).
import { canBeCommander } from './card-utils.js';
import { FORMAT_LABELS } from './constants.js';

/**
 * size: exact deck size (commander included); singleton: one copy of each card; commander: has a commander.
 * legalityFrom: Scryfall format whose ban list is used; maxMv: highest mana value allowed (commander included).
 */
export const FORMAT_RULES = {
  commander: { size: 100, singleton: true, commander: true },
  brawl: { size: 100, singleton: true, commander: true },
  tinyleaders: { size: 50, singleton: true, commander: true, legalityFrom: 'commander', maxMv: 3 },
};

export const formatLabel = (format) => FORMAT_LABELS[format] ?? format;
export const hasCommander = (format) => !!FORMAT_RULES[format]?.commander;
export const isSingleton = (format) => !!FORMAT_RULES[format]?.singleton;
export const deckSize = (format) => FORMAT_RULES[format]?.size ?? null;

const tooExpensive = (card, format) => {
  const max = FORMAT_RULES[format]?.maxMv;
  return max != null && (card?.cmc ?? 0) > max;
};

/** Scryfall-style legality ('legal' | 'restricted' | 'banned' | 'not_legal') for any supported format. */
export function legalityOf(card, format) {
  const source = FORMAT_RULES[format]?.legalityFrom ?? format;
  // No legality data for this card (e.g. a sparse cache entry): don't flag what we can't check.
  const base = card?.legalities?.[source] ?? (card?.legalities && Object.keys(card.legalities).length ? 'not_legal' : 'legal');
  if ((base === 'legal' || base === 'restricted') && tooExpensive(card, format)) return 'not_legal';
  return base;
}

export const isPlayableIn = (card, format) => ['legal', 'restricted'].includes(legalityOf(card, format));

/** Why a card isn't legal, for messages; null if it is. */
export function illegalReason(card, format) {
  if (isPlayableIn(card, format)) return null;
  if (tooExpensive(card, format) && isPlayableIn(card, FORMAT_RULES[format].legalityFrom)) {
    return `mana value ${card.cmc} is over ${FORMAT_RULES[format].maxMv}`;
  }
  return legalityOf(card, format) === 'banned' ? 'banned' : 'not legal';
}

export const canLead = (card, format) => canBeCommander(card) && !tooExpensive(card, format);

/** Scryfall search clause for "legal in this format". */
export function scryfallFormatQuery(format) {
  const rules = FORMAT_RULES[format];
  return rules?.maxMv != null ? `f:${rules.legalityFrom} mv<=${rules.maxMv}` : `f:${format}`;
}
