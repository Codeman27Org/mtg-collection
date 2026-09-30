import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as merge from '../src/merge.js';
import {
  normalizeName,
  buildNameIndex,
  matchName,
  nameConfidence,
  parseCollector,
  printingFromCollector,
  dHash,
  hamming,
  artConfidence,
  preferPrinting,
  groupByArt,
  finishFor,
} from '../src/scan/match.js';
import { coverToSource, centeredCard, region, REGIONS } from '../src/scan/geometry.js';
import { newSession, addScan, undoLast, setQty, replaceItem, scannedCount, planRecount } from '../src/scan/session-logic.js';
import { planDeckScan } from '../src/scan/deck-scan.js';
import { deckLocation } from '../src/location-logic.js';

const index = buildNameIndex([
  'Lightning Bolt',
  'Lightning Helix',
  'Lightning Bolt Totem',
  'Sol Ring',
  'Bonecrusher Giant // Stomp',
  'Jötun Grunt',
  'Æther Vial',
  "Urza's Saga",
  'Counterspell',
]);

test('names normalize accents, ligatures, and punctuation', () => {
  assert.equal(normalizeName('Jötun Grunt'), 'jotun grunt');
  assert.equal(normalizeName('Æther Vial'), 'aether vial');
  assert.equal(normalizeName('Urza’s  Saga!'), "urza's saga");
});

test('fuzzy name match survives OCR slips and trailing junk', () => {
  assert.equal(matchName(index, 'Lightning Bolt')[0].name, 'Lightning Bolt');
  assert.equal(matchName(index, 'Lightnlng Boit')[0].name, 'Lightning Bolt');
  assert.equal(matchName(index, 'Sol Ring ®@ 1')[0].name, 'Sol Ring');
  assert.equal(matchName(index, 'Bonecrusher Giant')[0].name, 'Bonecrusher Giant // Stomp');
  assert.equal(matchName(index, 'Aether Vial')[0].name, 'Æther Vial');
  assert.equal(matchName(index, 'Counterspel1')[0].name, 'Counterspell');
  assert.equal(matchName(index, 'A Bonecrusher Giant Hn')[0].name, 'Bonecrusher Giant // Stomp');
  assert.ok(nameConfidence(matchName(index, 'A Bonecrusher Giant Hn')) > 0.9);
  assert.deepEqual(matchName(index, 'x'), []);
  assert.ok(nameConfidence(matchName(index, 'Lightning Bolt')) > 0.95);
  assert.ok(nameConfidence(matchName(index, 'qzx vwpk')) < 0.8);
});

test('collector line parsing handles old and new layouts', () => {
  assert.deepEqual(parseCollector('141/264 R\nM20 • EN  Christopher Moeller'), { set: 'm20', number: '141' });
  assert.deepEqual(parseCollector('R 0123\nWOE • EN Artist Name'), { set: 'woe', number: '123' });
  assert.deepEqual(parseCollector('O47/254 C\nDOM * EN'), { set: 'dom', number: '47' });
  assert.deepEqual(parseCollector('smudge'), { set: null, number: null });
});

test('printings narrow by collector line', () => {
  const printings = [
    { id: 'a', set: 'm20', collector_number: '141' },
    { id: 'b', set: 'm21', collector_number: '141' },
    { id: 'c', set: '2x2', collector_number: '117' },
    { id: 'd', set: '2x2', collector_number: '400' },
  ];
  assert.deepEqual(printingFromCollector(printings, { set: 'm20', number: '141' }), { card: printings[0], confidence: 0.95 });
  assert.equal(printingFromCollector(printings, { set: 'm2o', number: '141' }).candidates.length, 2);
  assert.equal(printingFromCollector(printings, { set: '2x3', number: '117' }).card, printings[2]);
  assert.equal(printingFromCollector(printings, { set: '2x2', number: null }).candidates.length, 2);
  assert.equal(printingFromCollector(printings, { set: null, number: null }).candidates.length, 4);
});

test('art hashes match the same picture and separate different ones', () => {
  const w = 36;
  const h = 32;
  const gradient = Float64Array.from({ length: w * h }, (_, i) => (i % w) * 7 + Math.floor(i / w) * 2);
  const brighter = gradient.map((v) => v * 1.2 + 10);
  const other = Float64Array.from({ length: w * h }, (_, i) => ((i % w) * 13 + Math.floor(i / w) * 29) % 97);
  assert.equal(hamming(dHash(gradient, w, h), dHash(brighter, w, h)), 0);
  assert.ok(hamming(dHash(gradient, w, h), dHash(other, w, h)) > 10);
  assert.ok(artConfidence(6, 30) > 0.9);
  assert.ok(artConfidence(22, 26) < 0.8);
  assert.ok(artConfidence(8) > 0.9);
});

test('printing preference and finishes', () => {
  const ps = [
    { id: 'old', released_at: '2010-01-01', illustration_id: 'i1' },
    { id: 'new', released_at: '2021-01-01', illustration_id: 'i1' },
    { id: 'alt', released_at: '2015-01-01', illustration_id: 'i2' },
  ];
  assert.equal(preferPrinting(ps.slice(0, 2), new Set()).id, 'new');
  assert.equal(preferPrinting(ps.slice(0, 2), new Set(['old'])).id, 'old');
  assert.equal(preferPrinting([...ps, { id: 'list', released_at: '2024-01-01', collector_number: 'M11-146' }], new Set()).id, 'new');
  assert.equal(preferPrinting(ps, new Set(), { before: '2014-07-18' }).id, 'old');
  assert.deepEqual([...groupByArt(ps).keys()], ['i1', 'i2']);
  assert.equal(finishFor({ finishes: ['nonfoil', 'foil'] }, true), 'foil');
  assert.equal(finishFor({ finishes: ['nonfoil', 'foil'] }, false), 'nonfoil');
  assert.equal(finishFor({ finishes: ['foil'] }, false), 'foil');
  assert.equal(finishFor({ finishes: ['nonfoil'] }, true), 'nonfoil');
  assert.equal(finishFor({ finishes: ['etched'] }, true), 'etched');
});

test('guide maps from a cover-fit video back to frame pixels', () => {
  // 1920×1080 frame shown cover-fit in a 400×800 portrait box: scale 800/1080, cropped left/right.
  const r = coverToSource({ w: 1920, h: 1080 }, { w: 400, h: 800 }, { x: 50, y: 100, w: 300, h: 600 });
  const scale = 800 / 1080;
  const offX = (400 - 1920 * scale) / 2;
  assert.ok(Math.abs(r.x - (50 - offX) / scale) < 1e-6);
  assert.ok(Math.abs(r.h - 600 / scale) < 1e-6);
  const c = centeredCard(1000, 1000);
  assert.ok(Math.abs(c.w / c.h - 63 / 88) < 1e-9);
  assert.equal(c.h, 1000);
  const t = region({ x: 0, y: 0, w: 630, h: 880 }, REGIONS.title);
  assert.ok(t.y > 0 && t.y + t.h < 880 * 0.13);
});

const card = (id, oracle, extra = {}) => ({ id, oracle_id: oracle, name: oracle, finishes: ['nonfoil', 'foil'], type_line: 'Instant', ...extra });

test('scan sessions stack repeats and undo in order', () => {
  const s = newSession({ mode: 'collection', location: 'b1' });
  const bolt = card('bolt', 'o-bolt');
  const ring = card('ring', 'o-ring');
  addScan(s, bolt, 'nonfoil');
  addScan(s, ring, 'nonfoil');
  addScan(s, bolt, 'nonfoil');
  assert.equal(s.items.length, 2);
  assert.equal(scannedCount(s), 3);
  assert.equal(undoLast(s), 'bolt:nonfoil');
  assert.equal(s.items[0].qty, 1);
  replaceItem(s, 'ring:nonfoil', ring, 'foil');
  assert.deepEqual(s.items.map((i) => i.key), ['bolt:nonfoil', 'ring:foil']);
  assert.deepEqual(s.log, ['bolt:nonfoil', 'ring:foil']);
  setQty(s, 'bolt:nonfoil', 0);
  assert.deepEqual(s.log, ['ring:foil']);
  assert.equal(scannedCount(s), 1);
});

const BINDER = 'binder-1';
const entry = (scryfallId, qty, location = '', extra = {}) => ({
  key: merge.entryKey(scryfallId, extra.finish ?? 'nonfoil', extra.condition ?? 'NM', 'en', location, extra.from ?? ''),
  scryfallId,
  finish: extra.finish ?? 'nonfoil',
  condition: extra.condition ?? 'NM',
  language: 'en',
  location,
  from: extra.from ?? '',
  qty,
});

test('recounting a binder keeps conditions and basic lands', () => {
  const existing = [entry('bolt', 2, BINDER, { condition: 'LP' }), entry('ring', 1, BINDER), entry('forest', 10, BINDER)];
  const { rows, added, removed } = planRecount(
    BINDER,
    existing,
    [
      { scryfallId: 'bolt', finish: 'nonfoil', qty: 3 },
      { scryfallId: 'helix', finish: 'foil', qty: 1 },
    ],
    (e) => e.scryfallId === 'forest',
  );
  assert.deepEqual(
    rows.map((r) => [r.scryfallId, r.condition, r.qty]),
    [
      ['forest', 'NM', 10],
      ['bolt', 'LP', 2],
      ['bolt', 'NM', 1],
      ['helix', 'NM', 1],
    ],
  );
  assert.deepEqual(added, [
    { scryfallId: 'bolt', finish: 'nonfoil', qty: 1 },
    { scryfallId: 'helix', finish: 'foil', qty: 1 },
  ]);
  assert.deepEqual(removed.map((r) => [r.entry.scryfallId, r.qty]), [['ring', 1]]);
  assert.ok(rows.every((r) => r.location === BINDER));
});

test('deck scan plans list changes and where each copy comes from', () => {
  const DECK = 'd1';
  const here = deckLocation(DECK);
  const cards = new Map(
    [
      card('bolt-a', 'o-bolt'),
      card('bolt-b', 'o-bolt'),
      card('ring', 'o-ring', { type_line: 'Artifact' }),
      card('helix', 'o-helix'),
      card('cmdr', 'o-cmdr', { type_line: 'Legendary Creature' }),
      card('vial', 'o-vial'),
      card('forest', 'o-forest', { type_line: 'Basic Land — Forest' }),
      card('saga', 'o-saga'),
    ].map((c) => [c.id, c]),
  );
  const line = (scryfallId, section, qty) => ({ scryfallId, section, qty, updatedAt: 1 });
  const deck = {
    id: DECK,
    lines: {
      a: line('bolt-a', 'main', 1),
      b: line('ring', 'main', 1),
      c: line('cmdr', 'commander', 1),
      d: line('forest', 'main', 30),
      e: line('vial', 'main', 1),
    },
  };
  const entries = [
    entry('bolt-a', 1, here, { from: BINDER }),
    entry('ring', 1, here),
    entry('vial', 1, here, { from: BINDER }),
    entry('forest', 5, here),
    entry('bolt-b', 3, BINDER),
    entry('helix', 1, 'deck:other'),
    entry('saga', 1, BINDER, { finish: 'foil' }),
  ];
  const scanned = [
    { scryfallId: 'bolt-a', finish: 'nonfoil', qty: 2 }, // one kept, one moved (bolt-b from binder)
    { scryfallId: 'ring', finish: 'nonfoil', qty: 1 }, // kept
    { scryfallId: 'helix', finish: 'nonfoil', qty: 2 }, // one from another deck, one new
    { scryfallId: 'saga', finish: 'nonfoil', qty: 1 }, // the foil copy in the binder
    { scryfallId: 'forest', finish: 'nonfoil', qty: 3 }, // ignored
  ];
  const plan = planDeckScan(deck, cards, entries, scanned);

  const lines = Object.fromEntries(plan.lines.map((l) => [l.scryfallId, [l.kind, l.from, l.to, l.checked]]));
  assert.deepEqual(lines, {
    'bolt-a': ['more', 1, 2, true],
    helix: ['add', 0, 2, true],
    saga: ['add', 0, 1, true],
    cmdr: ['remove', 1, 0, false],
    vial: ['remove', 1, 0, true],
  });
  assert.equal(plan.kept, 2);
  assert.deepEqual(
    plan.moves.map((m) => [m.entry.scryfallId, m.qty, m.fromDeck]),
    [
      ['bolt-b', 1, null],
      ['helix', 1, 'deck:other'],
      ['saga', 1, null],
    ],
  );
  assert.deepEqual(plan.adds.map((a) => [a.scryfallId, a.qty]), [['helix', 1]]);
  assert.deepEqual(plan.returns.map((r) => [r.entry.scryfallId, r.qty]), [['vial', 1]]);
});
