export const APP_NAME = "Cody's MTG Collection";

export const KIND = 30078;
export const PREFIX = 'codys-mtg:';
export const SHARE_PREFIX = 'codys-mtg:share:';
export const SHARE_REGISTRY = 'codys-mtg:share-registry';

export const HEX = [...'0123456789abcdef'];
export const SHARDS = 16;

export const DAY = 24 * 60 * 60 * 1000;
export const SHARE_TTL = 30 * DAY;
export const TOMBSTONE_TTL = 90 * DAY;
export const PRICE_TTL = DAY;

export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol', 'wss://nostr.mom'];

export const FORMATS = ['commander', 'tinyleaders', 'standard', 'modern', 'pioneer', 'legacy', 'vintage', 'pauper', 'brawl'];
export const FORMAT_LABELS = {
  commander: 'Commander',
  tinyleaders: 'Tiny Leaders',
  standard: 'Standard',
  modern: 'Modern',
  pioneer: 'Pioneer',
  legacy: 'Legacy',
  vintage: 'Vintage',
  pauper: 'Pauper',
  brawl: 'Brawl',
};

export const SECTIONS = ['commander', 'companion', 'main', 'sideboard', 'maybeboard'];
export const SECTION_LABELS = {
  commander: 'Commander',
  companion: 'Companion',
  main: 'Main',
  sideboard: 'Sideboard',
  maybeboard: 'Maybeboard',
};

export const FINISHES = ['nonfoil', 'foil', 'etched'];
export const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'];

export const COLORS = ['W', 'U', 'B', 'R', 'G'];
export const COLOR_NAMES = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };

export const RARITIES = ['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus'];

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
