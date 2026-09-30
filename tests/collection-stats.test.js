import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, eraLabel } from '../src/collection-stats.js';

const cards = new Map([
  ['bolt', { id: 'bolt', oracle_id: 'o-bolt', name: 'Lightning Bolt', type_line: 'Instant', colors: ['R'], cmc: 1, rarity: 'common', set: 'm11', set_name: 'Magic 2011', released_at: '2010-07-16', prices: { usd: '2.00', usd_foil: '10.00' } }],
  ['forest', { id: 'forest', oracle_id: 'o-forest', name: 'Forest', type_line: 'Basic Land — Forest', colors: [], cmc: 0, rarity: 'common', set: 'm11', set_name: 'Magic 2011', released_at: '2010-07-16', prices: { usd: '0.10' } }],
  ['kolaghan', { id: 'kolaghan', oracle_id: 'o-kol', name: 'Kolaghan', type_line: 'Legendary Creature — Dragon', colors: ['B', 'R'], cmc: 6, rarity: 'mythic', set: 'lea', set_name: 'Alpha', released_at: '1993-08-05', prices: { usd: '60.00' } }],
  ['token', { id: 'token', oracle_id: 'o-tok', name: 'Odd', type_line: 'Artifact', colors: [], cmc: 9, rarity: 'rare', set: 'xyz', set_name: 'Xyz', released_at: '2024-01-01', prices: {} }],
]);
const entries = [
  { scryfallId: 'bolt', finish: 'nonfoil', qty: 3 },
  { scryfallId: 'bolt', finish: 'foil', qty: 1 },
  { scryfallId: 'forest', finish: 'nonfoil', qty: 10 },
  { scryfallId: 'kolaghan', finish: 'nonfoil', qty: 1 },
  { scryfallId: 'token', finish: 'nonfoil', qty: 2 },
  { scryfallId: 'gone', finish: 'nonfoil', qty: 0 },
];

test('collection summary: totals, tiers, colors, sets, decks', () => {
  const s = summarize(entries, cards, new Set(['o-bolt']));
  assert.equal(s.total, 17);
  assert.equal(s.names, 4);
  assert.equal(s.value, 3 * 2 + 10 + 1 + 60);
  assert.deepEqual([s.foils, s.foilValue], [1, 10]);
  assert.equal(s.unpriced, 2);
  assert.deepEqual(s.tiers.map((t) => t.qty), [12, 3, 1, 0, 1]);
  // Lands are left out of colors and the curve; two-color cards are multicolor; cmc 9 lands in 7+.
  assert.deepEqual(s.colors, { W: 0, U: 0, B: 0, R: 4, G: 0, M: 1, C: 2 });
  assert.equal(s.curve[1].Instant, 4);
  assert.equal(s.curve[6].Creature, 1);
  assert.equal(s.curve[7].Artifact, 2);
  assert.equal(s.types.Land, 10);
  assert.deepEqual(s.rarities, { common: 14, uncommon: 0, rare: 2, mythic: 1 });
  assert.deepEqual(s.sets.map((x) => [x.code, x.qty]), [['m11', 14], ['xyz', 2], ['lea', 1]]);
  assert.equal(s.oldest.card.name, 'Kolaghan');
  assert.deepEqual(s.eras, [['1993–97', 1], ['2008–12', 14], ['2023–27', 2]]);
  assert.equal(s.top[0].card.name, 'Kolaghan');
  assert.equal(s.top[1].finish, 'foil');
  assert.deepEqual([s.inDecks.names, s.inDecks.value], [1, 16]);
  assert.deepEqual([s.free.names, s.free.value], [3, 61]);
  assert.equal(s.topShare, 1);
});

test('era labels are 5-year buckets from 1993', () => {
  assert.equal(eraLabel(1993), '1993–97');
  assert.equal(eraLabel(1998), '1998–02');
  assert.equal(eraLabel(2026), '2023–27');
});
