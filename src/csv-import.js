import Papa from 'papaparse';
import { UUID_RE } from './constants.js';
import { SECTION_ALIASES } from './deck-text.js';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const norm = (header) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

// Header aliases from CardCastle, Moxfield, ManaBox, Archidekt, Deckbox, and TCGplayer exports, in priority order.
const COLUMNS = {
  scryfallId: ['scryfallid', 'jsonid', 'scryfalluuid', 'scryfallcardid'],
  qty: ['count', 'quantity', 'qty', 'amount', 'copies'],
  name: ['name', 'cardname', 'card'],
  setCode: ['setcode', 'editioncode'],
  setName: ['setname', 'editionname'],
  set: ['set', 'edition', 'expansion'],
  cn: ['collectornumber', 'cardnumber', 'number', 'cn', 'collectorno'],
  finish: ['foil', 'finish', 'printing', 'foiling'],
  condition: ['condition'],
  language: ['language', 'lang'],
  section: ['board', 'section'],
  location: ['bindername', 'binder', 'location', 'storagelocation', 'folder'],
};

const LANGUAGES = {
  english: 'en',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  italian: 'it',
  portuguese: 'pt',
  japanese: 'ja',
  korean: 'ko',
  russian: 'ru',
  'simplified chinese': 'zhs',
  'traditional chinese': 'zht',
  'chinese simplified': 'zhs',
  'chinese traditional': 'zht',
};

/** Some exporters append a face index to multi-face card IDs (37 chars); Scryfall IDs are 36. */
export function normalizeScryfallId(raw) {
  let id = String(raw ?? '').trim().toLowerCase();
  if (id.length === 37) id = id.slice(0, 36);
  return UUID_RE.test(id) ? id : null;
}

export function parseFinish(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s.includes('etched')) return 'etched';
  if (/non-?foil|normal|regular|^(false|no|n|0)$/.test(s)) return 'nonfoil';
  if (/^(true|yes|y|1)$/.test(s) || s.includes('foil')) return 'foil';
  return 'nonfoil';
}

export function parseCondition(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!s || s.includes('near mint') || s === 'nm' || s === 'mint' || s === 'm') return 'NM';
  if (s.includes('light') || s === 'lp' || s.includes('excellent') || s === 'ex' || s.startsWith('good')) return 'LP';
  if (s.includes('moderate') || s === 'mp' || s === 'played' || s === 'pl') return 'MP';
  if (s.includes('heav') || s === 'hp') return 'HP';
  if (s.includes('damage') || s === 'dmg' || s === 'poor') return 'DMG';
  return 'NM';
}

export function parseLanguage(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return 'en';
  if (LANGUAGES[s]) return LANGUAGES[s];
  return /^[a-z]{2,3}$/.test(s) ? s : 'en';
}

/** Maps our field names to the CSV's actual headers. */
export function detectColumns(headers) {
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  const cols = {};
  for (const [field, aliases] of Object.entries(COLUMNS)) {
    const hit = aliases.find((a) => byNorm.has(a));
    if (hit) cols[field] = byNorm.get(hit);
  }
  return cols;
}

/**
 * Parses any card CSV (collection or deck export).
 * Rows: { scryfallId, name, setCode, setName, cn, finish, condition, language, qty, section, locationName }.
 */
export function parseCardCsv(text) {
  const { data, meta } = Papa.parse(text, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() });
  const headers = meta.fields ?? [];
  const cols = detectColumns(headers);
  if (!cols.name && !cols.scryfallId) {
    throw new Error(`Couldn’t find a card name or Scryfall ID column. Columns found: ${headers.join(', ') || 'none'}.`);
  }
  const get = (r, field) => (cols[field] ? String(r[cols[field]] ?? '').trim() : '');
  const grouped = new Map();
  let skipped = 0;
  for (const r of data) {
    const setText = get(r, 'set');
    const row = {
      scryfallId: normalizeScryfallId(get(r, 'scryfallId')),
      name: get(r, 'name'),
      setCode: get(r, 'setCode') || setText,
      setName: get(r, 'setName') || setText,
      cn: get(r, 'cn'),
      finish: parseFinish(get(r, 'finish')),
      condition: parseCondition(get(r, 'condition')),
      language: parseLanguage(get(r, 'language')),
      qty: cols.qty ? parseInt(get(r, 'qty'), 10) || 0 : 1,
      section: SECTION_ALIASES[get(r, 'section').toLowerCase()] ?? 'main',
      locationName: get(r, 'location').slice(0, 100),
    };
    if ((!row.name && !row.scryfallId) || row.qty <= 0) {
      skipped++;
      continue;
    }
    const ident = row.scryfallId ?? `${row.name}|${row.setCode}|${row.cn}`.toLowerCase();
    const key = [ident, row.finish, row.condition, row.language, row.section, row.locationName.toLowerCase()].join('|');
    const existing = grouped.get(key);
    if (existing) existing.qty += row.qty;
    else grouped.set(key, row);
  }
  const rows = [...grouped.values()];
  return { rows, columns: cols, totalCards: rows.reduce((n, r) => n + r.qty, 0), skipped };
}
