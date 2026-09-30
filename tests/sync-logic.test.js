import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as merge from '../src/merge.js';
import { encryptJson, decryptJson, selfConversationKey } from '../src/crypto.js';
import { randomBytes, toBase64Url, fromBase64Url } from '../src/util.js';

const ID_A = '0a7b01ce-2729-4b70-ae0a-b9a1007be78f';
const ID_B = '0b5dc20a-749f-4ee8-9d7b-ea62e6b4dfcc';
const rec = (scryfallId, qty, updatedAt, finish = 'nonfoil') => ({
  key: merge.entryKey(scryfallId, finish, 'NM', 'en'),
  scryfallId,
  finish,
  condition: 'NM',
  language: 'en',
  qty,
  updatedAt,
});

test('collection merge: newer remote wins, newer local asks to republish', () => {
  const local = [rec(ID_A, 1, 100), rec(ID_B, 3, 300)];
  const remote = [
    [ID_A, 'nonfoil', 'NM', 'en', 4, 200],
    [ID_B, 'nonfoil', 'NM', 'en', 1, 250],
  ];
  const { toWrite, republish } = merge.mergeCollectionShard(local, remote, 0);
  assert.deepEqual(toWrite.map((r) => [r.scryfallId, r.qty]), [[ID_A, 4]]);
  assert.equal(republish, true);
});

test('collection merge: a remote tombstone removes the card', () => {
  const { toWrite } = merge.mergeCollectionShard([rec(ID_A, 2, 100)], [[ID_A, 'nonfoil', 'NM', 'en', 0, 150]], 0);
  assert.equal(toWrite[0].qty, 0);
});

test('collection merge: local entry missing remotely triggers republish, unless it is a pruned tombstone', () => {
  assert.equal(merge.mergeCollectionShard([rec(ID_A, 2, 100)], [], 0).republish, true);
  assert.equal(merge.mergeCollectionShard([rec(ID_A, 0, 100)], [], 500).republish, false);
});

test('deck createdAt: earliest wins across devices; old decks estimate from their oldest timestamp', () => {
  const base = { v: 1, id: 'd1', name: 'D', format: 'modern', description: '', fieldsUpdatedAt: 500, deleted: false, lines: [] };
  const local = { id: 'd1', name: 'D', format: 'modern', description: '', fieldsUpdatedAt: 500, deleted: false, lines: {}, createdAt: 300 };
  let r = merge.mergeDeck(local, { ...base, createdAt: 200 }, 0);
  assert.equal(r.deck.createdAt, 200);
  r = merge.mergeDeck(local, base, 0);
  assert.deepEqual([r.deck.createdAt, r.republish], [300, true]);
  assert.equal(merge.validDeckContent({ ...base, createdAt: 'x' }), false);
  assert.equal(merge.deckToContent(local, 0).createdAt, 300);
  const legacy = { fieldsUpdatedAt: 900, lines: { a: { updatedAt: 400 }, b: { updatedAt: 700 } } };
  assert.equal(merge.deckCreatedAt(legacy), 400);
});

test('deck merge: per-line LWW and field LWW', () => {
  const local = {
    id: 'd1',
    name: 'Local name',
    format: 'commander',
    description: '',
    fieldsUpdatedAt: 500,
    deleted: false,
    lines: {
      [merge.lineKey(ID_A, 'main')]: { scryfallId: ID_A, section: 'main', qty: 1, updatedAt: 100 },
    },
  };
  const remote = {
    v: 1,
    id: 'd1',
    name: 'Remote name',
    format: 'modern',
    description: '',
    fieldsUpdatedAt: 400,
    deleted: false,
    lines: [
      [ID_A, 'main', 3, 200],
      [ID_B, 'sideboard', 2, 50],
    ],
  };
  assert.ok(merge.validDeckContent(remote, 'd1'));
  const { deck, changed, republish } = merge.mergeDeck(local, remote, 0);
  assert.equal(deck.name, 'Local name', 'local fields are newer');
  assert.equal(deck.lines[merge.lineKey(ID_A, 'main')].qty, 3);
  assert.equal(deck.lines[merge.lineKey(ID_B, 'sideboard')].qty, 2);
  assert.equal(changed, true);
  assert.equal(republish, true);
  assert.equal(local.lines[merge.lineKey(ID_A, 'main')].qty, 1, 'input not mutated');
});

test('validators reject malformed content', () => {
  assert.equal(merge.validCollectionContent({ v: 1, e: [['nope', 'nonfoil', 'NM', 'en', 1, 1]] }), false);
  assert.equal(merge.validDeckContent({ v: 1, id: 'x', name: 'x', format: 'nope', fieldsUpdatedAt: 1, deleted: false, lines: [] }), false);
  assert.equal(merge.validSettings({ v: 1, relays: ['https://not-wss'], updatedAt: 1 }), false);
  assert.equal(merge.validShareManifest({ v: 1, type: 'collection', parts: 3 }), false);
});

test('self-encryption round trip and wrong-key failure', () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const key = selfConversationKey(sk, pk);
  const payload = encryptJson({ v: 1, hello: 'world' }, key);
  assert.deepEqual(decryptJson(payload, key), { v: 1, hello: 'world' });
  const other = generateSecretKey();
  assert.throws(() => decryptJson(payload, selfConversationKey(other, getPublicKey(other))));
});

test('share key: base64url round trip and NIP-44 encryption with a raw key', () => {
  const raw = randomBytes(32);
  const text = toBase64Url(raw);
  assert.equal(text.length, 43);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  const back = fromBase64Url(text);
  assert.deepEqual([...back], [...raw]);
  const manifest = { v: 1, type: 'collection', title: 'Trades', updatedAt: 1, parts: 16 };
  assert.ok(merge.validShareManifest(manifest));
  assert.deepEqual(decryptJson(encryptJson(manifest, back), raw), manifest);
});

test('a full 1,875-entry collection fits in 16 shards under 32 KB each', () => {
  const hex = '0123456789abcdef';
  const shards = Array.from({ length: 16 }, () => []);
  for (let i = 0; i < 1875; i++) {
    const id = `${hex[i % 16]}${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`;
    shards[i % 16].push([id, 'nonfoil', 'NM', 'en', 1, Date.now()]);
  }
  for (const e of shards) assert.ok(JSON.stringify({ v: 1, e }).length < 32 * 1024);
});
