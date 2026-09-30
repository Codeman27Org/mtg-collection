// Pure helpers over trimmed Scryfall card objects.

const IMAGE_HOST = 'https://cards.scryfall.io/';

export function cardImage(card, size = 'normal', face = 0) {
  const url = card?.image_uris?.[size] ?? card?.card_faces?.[face]?.image_uris?.[size] ?? null;
  return url?.startsWith(IMAGE_HOST) ? url : null;
}

export function isDoubleFaced(card) {
  return !card?.image_uris && card?.card_faces?.length > 1 && !!card.card_faces[1].image_uris;
}

export function cardPrice(card, finish = 'nonfoil') {
  const p = card?.prices ?? {};
  const raw = finish === 'foil' ? p.usd_foil : finish === 'etched' ? p.usd_etched : p.usd;
  const n = parseFloat(raw ?? (finish === 'nonfoil' ? (p.usd_foil ?? p.usd_etched) : null));
  return Number.isFinite(n) ? n : null;
}

export function cheapestPrice(card) {
  const values = [card?.prices?.usd, card?.prices?.usd_foil, card?.prices?.usd_etched]
    .map((v) => parseFloat(v))
    .filter(Number.isFinite);
  return values.length ? Math.min(...values) : null;
}

export function manaCostOf(card) {
  return card?.mana_cost || card?.card_faces?.map((f) => f.mana_cost).filter(Boolean).join(' // ') || '';
}

export function colorsOf(card) {
  if (card?.colors) return card.colors;
  return [...new Set(card?.card_faces?.flatMap((f) => f.colors ?? []) ?? [])];
}

export function searchableText(card) {
  const faces = card.card_faces ?? [];
  return [card.name, card.type_line, card.oracle_text, ...faces.map((f) => f.oracle_text)]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

export const TYPE_ORDER = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Other'];

export function primaryType(card) {
  const t = card?.card_faces?.[0]?.type_line ?? card?.type_line ?? '';
  if (t.includes('Land') && !t.includes('Creature')) return 'Land';
  return TYPE_ORDER.find((x) => t.includes(x)) ?? 'Other';
}

export const isBasicLand = (card) => /\bBasic\b/.test(card?.type_line ?? '');

export const canBeCommander = (card) =>
  (/\bLegendary\b/.test(card?.type_line ?? '') && /\bCreature\b/.test(card?.type_line ?? '')) ||
  /can be your commander/i.test(card?.oracle_text ?? '');

export const anyNumberAllowed = (card) =>
  /a deck can have any number of cards named/i.test(card?.oracle_text ?? '') || isBasicLand(card);

export function scryfallLink(card) {
  return card?.scryfall_uri?.startsWith('https://scryfall.com/') ? card.scryfall_uri : null;
}
