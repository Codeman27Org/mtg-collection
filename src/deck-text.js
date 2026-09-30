import { SECTIONS } from './constants.js';

export const SECTION_ALIASES = {
  commander: 'commander',
  commanders: 'commander',
  companion: 'companion',
  deck: 'main',
  main: 'main',
  mainboard: 'main',
  maindeck: 'main',
  sideboard: 'sideboard',
  side: 'sideboard',
  maybeboard: 'maybeboard',
  maybe: 'maybeboard',
  considering: 'maybeboard',
};

const MTGA_HEADERS = {
  commander: 'Commander',
  companion: 'Companion',
  main: 'Deck',
  sideboard: 'Sideboard',
  maybeboard: 'Maybeboard',
};

/**
 * Parses MTGA / Moxfield / Archidekt / TappedOut text lists.
 * Returns { lines: [{qty, name, set, cn, section, foil}], errors: [rawLine] }.
 */
export function parseDeckText(text) {
  let section = 'main';
  const lines = [];
  const errors = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/\s#.*$/, '').replace(/^#.*$/, '').trim();
    if (!line) continue;

    const header = line.replace(/^\/\/\s*/, '').replace(/:$/, '').replace(/\s*\(\d+\)$/, '').trim().toLowerCase();
    if (!/^\d/.test(line) && SECTION_ALIASES[header]) {
      section = SECTION_ALIASES[header];
      continue;
    }
    if (line.startsWith('//')) continue;

    let lineSection = section;
    const sb = line.match(/^SB:\s*(.*)$/i);
    if (sb) {
      lineSection = 'sideboard';
      line = sb[1];
    }

    const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    if (!m) {
      errors.push(raw);
      continue;
    }
    let rest = m[2].trim();
    let foil = false;
    rest = rest
      .replace(/\s*\*[FE]\*\s*/gi, () => {
        foil = true;
        return ' ';
      })
      .replace(/\s+\[[^\]]*\]\s*$/, '')
      .replace(/\s+\^[^^]*\^\s*$/, '')
      .trim();

    let set = null;
    let cn = null;
    const printing = rest.match(/^(.*?)\s+\(([A-Za-z0-9]{2,6})\)(?:\s+(\S+))?$/);
    if (printing) {
      rest = printing[1];
      set = printing[2].toLowerCase();
      cn = printing[3] ?? null;
    }
    lines.push({ qty: parseInt(m[1], 10), name: rest, set, cn, section: lineSection, foil });
  }
  return { lines, errors };
}

/** Parses an MTGO .dek XML file. Requires DOMParser (browser only). */
export function parseDek(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Not a valid .dek file.');
  return [...doc.querySelectorAll('Cards')].map((el) => ({
    qty: parseInt(el.getAttribute('Quantity'), 10) || 1,
    name: el.getAttribute('Name') ?? '',
    set: null,
    cn: null,
    section: el.getAttribute('Sideboard') === 'true' ? 'sideboard' : 'main',
    foil: false,
  }));
}

const activeLines = (deck) =>
  Object.values(deck.lines)
    .filter((l) => l.qty > 0)
    .sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section));

export function toText(deck, cards) {
  const out = [];
  for (const section of SECTIONS) {
    const lines = activeLines(deck).filter((l) => l.section === section);
    if (!lines.length) continue;
    if (out.length) out.push('');
    out.push(MTGA_HEADERS[section]);
    for (const l of lines) {
      const c = cards.get(l.scryfallId);
      out.push(c ? `${l.qty} ${c.name} (${c.set.toUpperCase()}) ${c.collector_number}` : `${l.qty} ${l.scryfallId}`);
    }
  }
  return out.join('\n') + '\n';
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export function toCsv(deck, cards) {
  const rows = [['Count', 'Name', 'Set', 'Collector Number', 'Section', 'Scryfall ID']];
  for (const l of activeLines(deck)) {
    const c = cards.get(l.scryfallId);
    rows.push([l.qty, c?.name ?? '', c?.set ?? '', c?.collector_number ?? '', l.section, l.scryfallId]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

const xmlAttr = (v) =>
  String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function toDek(deck, cards) {
  const body = activeLines(deck)
    .filter((l) => l.section !== 'maybeboard')
    .map((l) => {
      const c = cards.get(l.scryfallId);
      const side = l.section === 'sideboard' || l.section === 'companion';
      return `  <Cards CatID="${xmlAttr(c?.mtgo_id ?? 0)}" Quantity="${l.qty}" Sideboard="${side}" Name="${xmlAttr(c?.name ?? '')}" Annotation="0" />`;
    });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Deck xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '  <NetDeckID>0</NetDeckID>',
    '  <PreconstructedDeckID>0</PreconstructedDeckID>',
    ...body,
    '</Deck>',
    '',
  ].join('\n');
}
