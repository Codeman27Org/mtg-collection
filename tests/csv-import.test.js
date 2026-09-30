import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseCardCsv, normalizeScryfallId, detectColumns, parseFinish, parseCondition, parseLanguage } from '../src/csv-import.js';
import { setCodeFor } from '../src/import-resolve.js';
import { shortfall } from '../src/analytics.js';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
// These use personal export files kept in the project root (not committed); skip when they're absent.
const sample = (name) => ({ skip: existsSync(new URL(`../${name}`, import.meta.url)) ? false : `${name} not found` });

test('normalizeScryfallId strips a trailing face-index digit', () => {
  assert.equal(normalizeScryfallId('11bf83bb-c95b-4b4f-9a56-ce7a1816307a0'), '11bf83bb-c95b-4b4f-9a56-ce7a1816307a');
  assert.equal(normalizeScryfallId('B88C530A-ABC3-4CC4-8A48-5B76E1504A3C'), 'b88c530a-abc3-4cc4-8a48-5b76e1504a3c');
  assert.equal(normalizeScryfallId('not-an-id'), null);
});

test('CardCastle full export (one row per card, JSON ID column)', sample('export_cardcastle_1787773253.csv'), () => {
  const { rows, totalCards, skipped, columns } = parseCardCsv(read('export_cardcastle_1787773253.csv'));
  assert.equal(columns.scryfallId, 'JSON ID');
  assert.equal(columns.qty, undefined);
  assert.equal(skipped, 0);
  assert.equal(totalCards, 2668);
  assert.ok(rows.every((r) => r.scryfallId), 'all IDs normalize');
  const delver = rows.find((r) => r.name.startsWith('Delver of Secrets'));
  assert.equal(delver.scryfallId, '11bf83bb-c95b-4b4f-9a56-ce7a1816307a');
  assert.equal(delver.qty, 5);
  const foilIsland = rows.find((r) => r.name === 'Island' && r.setName === 'Unstable' && r.finish === 'foil');
  assert.equal(foilIsland.qty, 1);
});

test('CardCastle simple export (Count column, true/false foil)', sample('export_simple_1787773281.csv'), () => {
  const { rows, totalCards } = parseCardCsv(read('export_simple_1787773281.csv'));
  assert.equal(totalCards, 2668);
  const beacon = rows.find((r) => r.name === 'Beacon Bolt');
  assert.equal(beacon.finish, 'foil');
  assert.equal(beacon.qty, 2);
  assert.ok(rows.some((r) => r.cn === 'C14-43'));
});

test('deck CSV with board and json_id columns (Odric.csv)', sample('Odric.csv'), () => {
  const { rows, totalCards, columns } = parseCardCsv(read('Odric.csv'));
  assert.equal(columns.section, 'board');
  assert.equal(columns.scryfallId, 'json_id');
  assert.ok(rows.every((r) => r.section === 'main' && r.scryfallId));
  assert.equal(rows.find((r) => r.name === 'Plains').qty, 38);
  assert.equal(totalCards, rows.reduce((n, r) => n + r.qty, 0));
});

test('column detection for other common exporters', () => {
  assert.deepEqual(
    detectColumns(['Count', 'Tradelist Count', 'Name', 'Edition', 'Condition', 'Language', 'Foil', 'Collector Number']),
    { qty: 'Count', name: 'Name', set: 'Edition', cn: 'Collector Number', finish: 'Foil', condition: 'Condition', language: 'Language' },
  );
  const manabox = detectColumns(['Name', 'Set code', 'Set name', 'Collector number', 'Foil', 'Rarity', 'Quantity', 'ManaBox ID', 'Scryfall ID', 'Condition', 'Language']);
  assert.equal(manabox.scryfallId, 'Scryfall ID');
  assert.equal(manabox.setCode, 'Set code');
  assert.equal(manabox.qty, 'Quantity');
  const tcg = detectColumns(['Quantity', 'Name', 'Simple Name', 'Set', 'Card Number', 'Set Code', 'Printing', 'Condition']);
  assert.equal(tcg.cn, 'Card Number');
  assert.equal(tcg.finish, 'Printing');
});

test('value normalizers', () => {
  assert.deepEqual(['Foil', 'foil', 'true', 'Normal', 'Non-Foil', '', 'etched', 'false'].map(parseFinish), ['foil', 'foil', 'foil', 'nonfoil', 'nonfoil', 'nonfoil', 'etched', 'nonfoil']);
  assert.deepEqual(['Near Mint', 'near_mint', 'Good (Lightly Played)', 'Played', 'HP', 'Damaged', ''].map(parseCondition), ['NM', 'NM', 'LP', 'MP', 'HP', 'DMG', 'NM']);
  assert.deepEqual(['English', 'ja', 'Japanese', 'Klingon', ''].map(parseLanguage), ['en', 'ja', 'ja', 'en', 'en']);
});

test('a minimal name-only CSV counts each row as one card', () => {
  const { rows, totalCards } = parseCardCsv('Card\nSol Ring\nSol Ring\nForest\n');
  assert.equal(totalCards, 3);
  assert.equal(rows.find((r) => r.name === 'Sol Ring').qty, 2);
});

test('CSV without a name or ID column is rejected with the headers it saw', () => {
  assert.throws(() => parseCardCsv('a,b\n1,2\n'), /Columns found: a, b/);
});

test('set text resolves as either a code or a name', () => {
  const codes = new Set(['ons', 'afr']);
  const byName = new Map([['onslaught', 'ons'], ['adventures in the forgotten realms', 'afr']]);
  assert.equal(setCodeFor({ setCode: 'ONS', setName: 'ONS' }, codes, byName), 'ons');
  assert.equal(setCodeFor({ setCode: 'Onslaught', setName: 'Onslaught' }, codes, byName), 'ons');
  assert.equal(setCodeFor({ setCode: '', setName: 'Adventures in the Forgotten Realms' }, codes, byName), 'afr');
  assert.equal(setCodeFor({ setCode: 'nope', setName: '' }, codes, byName), null);
});

test('shortfall adds only what the collection can’t cover after other decks', () => {
  const rows = [
    { oracleId: 'sol', qty: 1, scryfallId: 'a' },
    { oracleId: 'plains', qty: 38, scryfallId: 'p' },
    { oracleId: 'odric', qty: 1, scryfallId: 'o' },
  ];
  const owned = new Map([['sol', 5], ['plains', 20], ['odric', 1]]);
  const used = new Map([['sol', 5], ['odric', 0]]);
  assert.deepEqual(shortfall(rows, owned, used).map((r) => [r.oracleId, r.qty]), [['sol', 1], ['plains', 18]]);
});
