import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as merge from '../src/merge.js';
import { deckPlan, deckLocation, originFor, returnTarget, locationToken } from '../src/location-logic.js';
import { applyFilter } from '../src/collection-filter.js';
import { summarize } from '../src/collection-stats.js';

const BOLT_M11 = '0a7b01ce-2729-4b70-ae0a-b9a1007be78f';
const BOLT_2X2 = '0b5dc20a-749f-4ee8-9d7b-ea62e6b4dfcc';
const RING = '1c2d3e4f-0000-4000-8000-000000000001';
const FOREST = '1c2d3e4f-0000-4000-8000-000000000002';
const BINDER = '2a2a2a2a-0000-4000-8000-00000000000a';
const BOX = '2b2b2b2b-0000-4000-8000-00000000000b';
const DECK = '3c3c3c3c-0000-4000-8000-00000000000c';
const OTHER_DECK = '3d3d3d3d-0000-4000-8000-00000000000d';

const cards = new Map([
  [BOLT_M11, { id: BOLT_M11, oracle_id: 'o-bolt', name: 'Lightning Bolt', set: 'm11', prices: { usd: '2.00' } }],
  [BOLT_2X2, { id: BOLT_2X2, oracle_id: 'o-bolt', name: 'Lightning Bolt', set: '2x2', prices: { usd: '1.00' } }],
  [RING, { id: RING, oracle_id: 'o-ring', name: 'Sol Ring', set: 'c21', prices: { usd: '3.00' } }],
  [FOREST, { id: FOREST, oracle_id: 'o-forest', name: 'Forest', set: 'm11', prices: { usd: '0.10' } }],
]);

const entry = (scryfallId, qty, location = '', extra = {}) => ({
  key: merge.entryKey(scryfallId, extra.finish ?? 'nonfoil', 'NM', 'en', location, extra.from ?? ''),
  scryfallId,
  finish: extra.finish ?? 'nonfoil',
  condition: 'NM',
  language: 'en',
  location,
  from: extra.from ?? '',
  qty,
  updatedAt: 1,
});

test('entry keys and tuples only carry location when it is set', () => {
  assert.equal(merge.entryKey(BOLT_M11, 'nonfoil', 'NM', 'en'), `${BOLT_M11}:nonfoil:NM:en`);
  assert.equal(merge.entryKey(BOLT_M11, 'nonfoil', 'NM', 'en', ''), `${BOLT_M11}:nonfoil:NM:en`);
  assert.equal(merge.entryKey(BOLT_M11, 'foil', 'NM', 'en', `deck:${DECK}`, BINDER), `${BOLT_M11}:foil:NM:en@deck:${DECK}<${BINDER}`);
  assert.deepEqual(merge.entryToTuple(entry(BOLT_M11, 2)), [BOLT_M11, 'nonfoil', 'NM', 'en', 2, 1]);
  assert.deepEqual(merge.entryToTuple(entry(BOLT_M11, 2, BINDER)), [BOLT_M11, 'nonfoil', 'NM', 'en', 2, 1, BINDER, '']);
});

test('collection content validates location ids and merges them into keys', () => {
  const ok = { v: 1, e: [[BOLT_M11, 'nonfoil', 'NM', 'en', 1, 5, `deck:${DECK}`, BINDER], [RING, 'nonfoil', 'NM', 'en', 1, 5]] };
  assert.equal(merge.validCollectionContent(ok), true);
  assert.equal(merge.validCollectionContent({ v: 1, e: [[BOLT_M11, 'nonfoil', 'NM', 'en', 1, 5, 'Red binder']] }), false);
  assert.equal(merge.validCollectionContent({ v: 1, e: [[BOLT_M11, 'nonfoil', 'NM', 'en', 1, 5, 'deck:nope']] }), false);

  const local = [entry(BOLT_M11, 3)];
  const { toWrite, republish } = merge.mergeCollectionShard(local, ok.e, 0);
  // The deck stack is a different key from the Unsorted one, so both survive.
  assert.equal(toWrite.find((r) => r.scryfallId === BOLT_M11).key, merge.entryKey(BOLT_M11, 'nonfoil', 'NM', 'en', `deck:${DECK}`, BINDER));
  assert.equal(toWrite.find((r) => r.scryfallId === BOLT_M11).from, BINDER);
  assert.equal(republish, true);
});

test('location records validate', () => {
  const rec = { id: BINDER, name: 'Red binder', updatedAt: 1, deleted: false };
  assert.equal(merge.validLocations({ v: 1, locations: [rec] }), true);
  assert.equal(merge.validLocations({ v: 1, locations: [{ ...rec, id: 'x' }] }), false);
  assert.equal(merge.validLocations({ v: 1, locations: [{ ...rec, name: 'x'.repeat(101) }] }), false);
});

test('origin and return targets', () => {
  const here = deckLocation(DECK);
  assert.equal(originFor(entry(BOLT_M11, 1, BINDER), here), BINDER);
  assert.equal(originFor(entry(BOLT_M11, 1, ''), here), '');
  // Moving deck to deck keeps the original origin; moving out of decks drops it.
  assert.equal(originFor(entry(BOLT_M11, 1, deckLocation(OTHER_DECK), { from: BOX }), here), BOX);
  assert.equal(originFor(entry(BOLT_M11, 1, here, { from: BOX }), BINDER), '');
  const exists = (id) => id === BINDER;
  assert.equal(returnTarget(entry(BOLT_M11, 1, here, { from: BINDER }), exists), BINDER);
  assert.equal(returnTarget(entry(BOLT_M11, 1, here, { from: BOX }), exists), '');
  assert.equal(returnTarget(entry(BOLT_M11, 1, here), exists), '');
});

test('deck plan: in deck, pulls by preference, missing, other decks, and extras', () => {
  const deck = {
    id: DECK,
    lines: {
      a: { scryfallId: BOLT_M11, section: 'main', qty: 4 },
      b: { scryfallId: RING, section: 'main', qty: 1 },
      c: { scryfallId: FOREST, section: 'maybeboard', qty: 5 },
    },
  };
  const here = deckLocation(DECK);
  const entries = [
    entry(BOLT_M11, 1, here, { from: BINDER }),
    entry(BOLT_2X2, 3, BOX),
    entry(BOLT_M11, 1, BINDER, { finish: 'foil' }),
    entry(BOLT_M11, 1, BINDER),
    entry(RING, 1, deckLocation(OTHER_DECK), { from: BOX }),
    entry(FOREST, 2, here, { from: BOX }),
  ];
  const plan = deckPlan(deck, cards, entries);
  const bolt = plan.byOracle.get('o-bolt');
  assert.deepEqual([bolt.need, bolt.inDeck, bolt.missing], [4, 1, 0]);
  // Same printing first (nonfoil before foil), then other printings.
  assert.deepEqual(bolt.pulls.map((p) => [p.entry.scryfallId, p.entry.finish, p.qty]), [
    [BOLT_M11, 'nonfoil', 1],
    [BOLT_M11, 'foil', 1],
    [BOLT_2X2, 'nonfoil', 1],
  ]);
  const ring = plan.byOracle.get('o-ring');
  assert.deepEqual([ring.missing, ring.pulls.length, ring.inOtherDecks], [1, 0, [{ location: deckLocation(OTHER_DECK), qty: 1 }]]);
  // Maybeboard doesn't count, so Forests in the deck are extras.
  assert.equal(plan.byOracle.has('o-forest'), false);
  assert.deepEqual(plan.extras.map((x) => [x.entry.scryfallId, x.qty]), [[FOREST, 2]]);
  assert.deepEqual([plan.need, plan.inDeck, plan.pullCount, plan.missing, plan.extraCount], [5, 1, 3, 1, 2]);
});

test('location filter and per-location totals', () => {
  const entries = [entry(BOLT_M11, 2, BINDER), entry(RING, 1), entry(FOREST, 10, deckLocation(DECK))];
  const ids = (list) => list.map((e) => e.scryfallId);
  assert.deepEqual(ids(applyFilter(entries, cards, { location: BINDER })), [BOLT_M11]);
  assert.deepEqual(ids(applyFilter(entries, cards, { location: locationToken('') })), [RING]);
  assert.deepEqual(ids(applyFilter(entries, cards, { location: deckLocation(DECK) })), [FOREST]);
  const s = summarize(entries, cards);
  assert.deepEqual(s.locations.map((l) => [l.id, l.qty, l.value]), [
    [BINDER, 2, 4],
    ['', 1, 3],
    [deckLocation(DECK), 10, 1],
  ]);
});

test('basic lands: generic ones are never missing; an owned exact printing is tracked', () => {
  const PLAINS = '4a4a4a4a-0000-4000-8000-000000000001';
  const FULL_ART = '4a4a4a4a-0000-4000-8000-000000000002';
  const basics = new Map([
    [PLAINS, { id: PLAINS, oracle_id: 'o-plains', name: 'Plains', type_line: 'Basic Land — Plains' }],
    [FULL_ART, { id: FULL_ART, oracle_id: 'o-plains', name: 'Plains', type_line: 'Basic Land — Plains' }],
  ]);
  const generic = { id: DECK, lines: { a: { scryfallId: PLAINS, section: 'main', qty: 12 } } };
  const owned = [entry(FULL_ART, 4, BINDER, { finish: 'foil' })];
  let plan = deckPlan(generic, basics, owned);
  // The full-art foils aren't pulled for a generic Plains line.
  assert.deepEqual([plan.need, plan.pullCount, plan.missing], [0, 0, 0]);
  assert.deepEqual([plan.byOracle.get('o-plains').basic, plan.byOracle.get('o-plains').untracked], [true, 12]);

  const specific = { id: DECK, lines: { a: { scryfallId: FULL_ART, section: 'main', qty: 12 } } };
  plan = deckPlan(specific, basics, owned);
  // Only the 4 owned copies of that printing are tracked; the other 8 are generic basics.
  assert.deepEqual([plan.need, plan.pullCount, plan.missing, plan.byOracle.get('o-plains').untracked], [4, 4, 0, 8]);
});

test('ownership ignores basic lands', async () => {
  const { ownership } = await import('../src/analytics.js');
  const PLAINS = '4a4a4a4a-0000-4000-8000-000000000001';
  const c = new Map([
    [PLAINS, { id: PLAINS, oracle_id: 'o-plains', name: 'Plains', type_line: 'Basic Land — Plains', prices: {} }],
    [RING, { ...cards.get(RING), type_line: 'Artifact' }],
  ]);
  const deck = { lines: { a: { scryfallId: PLAINS, section: 'main', qty: 30 }, b: { scryfallId: RING, section: 'main', qty: 1 } } };
  const r = ownership(deck, c, new Map(), new Map([['o-plains', 60]]));
  assert.deepEqual(r.missing.map((m) => m.card.name), ['Sol Ring']);
  assert.equal(r.overAllocated.length, 0);
});
