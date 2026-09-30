import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeckText, toText, toCsv, toDek } from '../src/deck-text.js';

test('parses MTGA, Moxfield, and TappedOut styles with sections', () => {
  const { lines, errors } = parseDeckText(`
1 Sol Ring
1x Command Tower (CLB) 361
1 x Arcane Signet *F*
# a comment
2 Lightning Bolt (M11) 149 [Removal]

//Commander
1 Giada, Font of Hope

Sideboard:
1 Hullbreacher
SB: 2 Negate
not a card line
`);
  assert.deepEqual(errors.map((e) => e.trim()), ['not a card line']);
  assert.deepEqual(lines[0], { qty: 1, name: 'Sol Ring', set: null, cn: null, section: 'main', foil: false });
  assert.deepEqual(lines[1], { qty: 1, name: 'Command Tower', set: 'clb', cn: '361', section: 'main', foil: false });
  assert.equal(lines[2].name, 'Arcane Signet');
  assert.equal(lines[2].foil, true);
  assert.deepEqual([lines[3].name, lines[3].set, lines[3].cn], ['Lightning Bolt', 'm11', '149']);
  assert.equal(lines[4].section, 'commander');
  assert.equal(lines[5].section, 'sideboard');
  assert.deepEqual([lines[6].qty, lines[6].name, lines[6].section], [2, 'Negate', 'sideboard']);
});

test('MTGA "Deck" header maps to main', () => {
  const { lines } = parseDeckText('Commander\n1 Krenko, Mob Boss\n\nDeck\n1 Goblin King');
  assert.deepEqual(lines.map((l) => l.section), ['commander', 'main']);
});

const deck = {
  name: 'Test',
  format: 'commander',
  lines: {
    'a:commander': { scryfallId: 'a', section: 'commander', qty: 1, updatedAt: 1 },
    'b:main': { scryfallId: 'b', section: 'main', qty: 2, updatedAt: 1 },
    'c:main': { scryfallId: 'c', section: 'main', qty: 0, updatedAt: 1 },
  },
};
const cards = new Map([
  ['a', { name: 'Krenko, Mob Boss', set: 'm13', collector_number: '138', mtgo_id: 123 }],
  ['b', { name: 'Goblin "King"', set: '8ed', collector_number: '190' }],
]);

test('exports round-trip through the text parser', () => {
  const text = toText(deck, cards);
  assert.equal(text, 'Commander\n1 Krenko, Mob Boss (M13) 138\n\nDeck\n2 Goblin "King" (8ED) 190\n');
  const { lines } = parseDeckText(text);
  assert.deepEqual(lines.map((l) => [l.qty, l.name, l.section]), [[1, 'Krenko, Mob Boss', 'commander'], [2, 'Goblin "King"', 'main']]);
});

test('csv export escapes quotes and commas', () => {
  const csv = toCsv(deck, cards);
  assert.match(csv, /"Krenko, Mob Boss"/);
  assert.match(csv, /"Goblin ""King"""/);
});

test('dek export escapes XML attributes', () => {
  const dek = toDek(deck, cards);
  assert.match(dek, /Name="Goblin &quot;King&quot;"/);
  assert.match(dek, /CatID="123"/);
});
