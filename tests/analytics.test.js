import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pips, deckStats, legalityIssues, ownership } from '../src/analytics.js';
import { applyFilter, describeFilter } from '../src/collection-filter.js';

const card = (id, over) => ({
  id,
  oracle_id: `o-${id}`,
  name: id,
  type_line: 'Creature — Goblin',
  mana_cost: '{R}',
  cmc: 1,
  colors: ['R'],
  color_identity: ['R'],
  legalities: { commander: 'legal', modern: 'legal' },
  prices: { usd: '1.00' },
  rarity: 'common',
  set: 'm13',
  set_name: 'Magic 2013',
  ...over,
});

test('pips counts hybrid and phyrexian symbols toward each color', () => {
  assert.deepEqual(pips('{2}{W/U}{G/P}{R}{R}'), { W: 1, U: 1, B: 0, R: 2, G: 1, C: 0 });
});

test('deck stats: curve, types, identity, price', () => {
  const cards = new Map([
    ['k', card('k', { name: 'Krenko', cmc: 4, mana_cost: '{2}{R}{R}', type_line: 'Legendary Creature — Goblin' })],
    ['m', card('m', { name: 'Mountain', cmc: 0, mana_cost: '', type_line: 'Basic Land — Mountain', color_identity: [], prices: { usd: '0.10' } })],
    ['b', card('b', { name: 'Bolt', type_line: 'Instant' })],
  ]);
  const deck = {
    format: 'commander',
    lines: {
      1: { scryfallId: 'k', section: 'commander', qty: 1 },
      2: { scryfallId: 'm', section: 'main', qty: 10 },
      3: { scryfallId: 'b', section: 'main', qty: 1 },
      4: { scryfallId: 'b', section: 'maybeboard', qty: 3 },
    },
  };
  const s = deckStats(deck, cards);
  assert.equal(s.count, 12);
  assert.equal(s.curve[4].Creature, 1);
  assert.equal(s.curve[1].Instant, 1);
  assert.deepEqual(s.types, [['Creature', 1], ['Instant', 1], ['Land', 10]]);
  assert.deepEqual(s.identity, ['R']);
  assert.equal(s.avgCmc, 2.5);
  assert.equal(Math.round(s.price * 100), 300);

  const issues = legalityIssues(deck, cards);
  assert.ok(issues.some((i) => i.includes('needs exactly 100')));
  assert.ok(!issues.some((i) => i.includes('Mountain')), 'basic lands are exempt from singleton');
});

test('legality flags off-identity cards and extra copies', () => {
  const cards = new Map([
    ['k', card('k', { name: 'Krenko' })],
    ['u', card('u', { name: 'Counterspell', color_identity: ['U'], type_line: 'Instant' })],
  ]);
  const deck = {
    format: 'commander',
    lines: { 1: { scryfallId: 'k', section: 'commander', qty: 1 }, 2: { scryfallId: 'u', section: 'main', qty: 2 } },
  };
  const issues = legalityIssues(deck, cards);
  assert.ok(issues.some((i) => i.includes('outside')));
  assert.ok(issues.some((i) => i.includes('2 copies')));
});

test('ownership: missing cards, cost, and over-allocation', () => {
  const cards = new Map([['a', card('a', { prices: { usd: '2.50' } })]]);
  const deck = { format: 'modern', lines: { 1: { scryfallId: 'a', section: 'main', qty: 4 } } };
  const r = ownership(deck, cards, new Map([['o-a', 1]]), new Map([['o-a', 6]]));
  assert.deepEqual(r.missing.map((m) => m.qty), [3]);
  assert.equal(r.missingCost, 7.5);
  assert.deepEqual(r.overAllocated.map((o) => [o.owned, o.used]), [[1, 6]]);
});

test('collection filter: text, colors, finish, price, unused', () => {
  const cards = new Map([
    ['a', card('a', { name: 'Goblin King' })],
    ['b', card('b', { name: 'Island', colors: [], type_line: 'Basic Land — Island', prices: { usd: '0.10', usd_foil: '5.00' } })],
  ]);
  const entries = [
    { scryfallId: 'a', finish: 'nonfoil', qty: 1 },
    { scryfallId: 'b', finish: 'foil', qty: 2 },
  ];
  const ids = (f, used) => applyFilter(entries, cards, f, used).map((e) => e.scryfallId);
  assert.deepEqual(ids({ text: 'goblin' }), ['a']);
  assert.deepEqual(ids({ colors: ['C'] }), ['b']);
  assert.deepEqual(ids({ finish: 'foil' }), ['b']);
  assert.deepEqual(ids({ priceMin: '2' }), ['b']);
  const withUnpriced = new Map([...cards, ['c', card('c', { prices: {} })]]);
  const unpricedIds = applyFilter([...entries, { scryfallId: 'c', finish: 'nonfoil', qty: 1 }], withUnpriced, { unpriced: true }).map((e) => e.scryfallId);
  assert.deepEqual(unpricedIds, ['c']);
  assert.deepEqual(ids({ unused: true }, new Set(['o-a'])), ['b']);
  assert.equal(describeFilter({ unused: true, finish: 'foil' }), 'foil, not in any deck');
});

test('Tiny Leaders: 50 cards, mana value 3 or less, Commander ban list, commander eligibility', async () => {
  const { legalityOf, canLead, scryfallFormatQuery } = await import('../src/formats.js');
  const leader = card('l', { name: 'Tiny Goblin Boss', cmc: 3, type_line: 'Legendary Creature — Goblin' });
  const krenko = card('k', { name: 'Krenko, Mob Boss', cmc: 4, type_line: 'Legendary Creature — Goblin' });
  const banned = card('b', { name: 'Banned Thing', cmc: 1, legalities: { commander: 'banned' } });
  const bolt = card('x', { name: 'Lightning Bolt', type_line: 'Instant' });
  const mountain = card('m', { name: 'Mountain', cmc: 0, type_line: 'Basic Land — Mountain', color_identity: [] });

  assert.equal(legalityOf(bolt, 'tinyleaders'), 'legal');
  assert.equal(legalityOf(krenko, 'tinyleaders'), 'not_legal');
  assert.equal(legalityOf(banned, 'tinyleaders'), 'banned');
  assert.equal(canLead(leader, 'tinyleaders'), true);
  assert.equal(canLead(krenko, 'tinyleaders'), false);
  assert.equal(canLead(krenko, 'commander'), true);
  assert.equal(scryfallFormatQuery('tinyleaders'), 'f:commander mv<=3');
  assert.equal(scryfallFormatQuery('modern'), 'f:modern');

  const cards = new Map([leader, krenko, banned, bolt, mountain].map((c) => [c.id, c]));
  const deck = {
    format: 'tinyleaders',
    lines: {
      1: { scryfallId: 'l', section: 'commander', qty: 1 },
      2: { scryfallId: 'k', section: 'main', qty: 1 },
      3: { scryfallId: 'b', section: 'main', qty: 1 },
      4: { scryfallId: 'x', section: 'main', qty: 1 },
      5: { scryfallId: 'm', section: 'main', qty: 46 },
    },
  };
  const issues = legalityIssues(deck, cards);
  assert.deepEqual(issues, ['Krenko, Mob Boss: mana value 4 is over 3 for Tiny Leaders.', 'Banned Thing is banned in Tiny Leaders.']);
  deck.lines[5].qty = 40;
  assert.ok(legalityIssues(deck, cards).includes('Deck has 44 cards; Tiny Leaders needs exactly 50.'));
});
