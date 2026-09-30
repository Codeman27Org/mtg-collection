import * as nip19 from 'nostr-tools/nip19';
import { verifyEvent } from 'nostr-tools/pure';
import { accountDB } from './db.js';
import * as account from './account.js';
import { markDirty, getRelays, pool } from './sync.js';
import { emit, on } from './bus.js';
import { requireEdit } from './collection.js';
import { KIND, SHARE_PREFIX, SHARE_REGISTRY, SHARE_TTL, DEFAULT_RELAYS, HEX } from './constants.js';
import { randomBytes, bytesToHex, toBase64Url, fromBase64Url } from './util.js';
import { decryptJson } from './crypto.js';
import { validShareManifest, validCollectionContent } from './merge.js';

on('remote:shares', () => emit('shares'));

const db = () => accountDB(account.current());

export const isExpired = (s) => s.expiresAt <= Date.now();
export const isActive = (s) => !s.revoked && !isExpired(s);

export async function list() {
  return (await (await db()).getAll('shares')).sort((a, b) => b.createdAt - a.createdAt);
}

export async function activeFor(type, targetId = null) {
  return (await list()).find((s) => isActive(s) && s.type === type && (type === 'collection' || s.targetId === targetId));
}

export async function create({ type, targetId = null, filter = null, title }) {
  requireEdit();
  const now = Date.now();
  const share = {
    id: bytesToHex(randomBytes(16)),
    type,
    targetId,
    filter,
    title: title.slice(0, 200),
    key: toBase64Url(randomBytes(32)),
    createdAt: now,
    updatedAt: now,
    expiresAt: now + SHARE_TTL,
    revoked: false,
  };
  await (await db()).put('shares', share);
  await markDirty(SHARE_REGISTRY, SHARE_PREFIX + share.id);
  emit('shares');
  return share;
}

export async function stop(id) {
  requireEdit();
  const d = await db();
  const share = await d.get('shares', id);
  if (!share || share.revoked) return;
  await d.put('shares', { ...share, revoked: true, updatedAt: Date.now() });
  await markDirty(SHARE_REGISTRY, SHARE_PREFIX + id);
  emit('shares');
}

/** Stops the share and creates a fresh one (new ID, new key, new 30 days). */
export async function renew(id) {
  const old = await (await db()).get('shares', id);
  await stop(id);
  return create({ type: old.type, targetId: old.targetId, filter: old.filter, title: old.title });
}

export async function link(share) {
  const relays = (await getRelays()).slice(0, 3);
  const naddr = nip19.naddrEncode({ identifier: SHARE_PREFIX + share.id, pubkey: account.current(), kind: KIND, relays });
  return `${location.origin}/#/s/${naddr}/${share.key}`;
}

// ---------------------------------------------------------------- viewer side

export class InactiveShareError extends Error {
  constructor() {
    super('This link is no longer active.');
  }
}

function newestValid(events, pubkey, dTag) {
  const now = Math.floor(Date.now() / 1000);
  return events
    .filter((ev) => ev.pubkey === pubkey && ev.tags.some((t) => t[0] === 'd' && t[1] === dTag) && verifyEvent(ev))
    .filter((ev) => Number(ev.tags.find((t) => t[0] === 'expiration')?.[1] ?? Infinity) > now)
    .sort((a, b) => b.created_at - a.created_at)[0];
}

/** Fetches, verifies, and decrypts a shared deck or collection. */
export async function loadShared(naddr, keyText) {
  let pointer;
  let key;
  try {
    const decoded = nip19.decode(naddr);
    if (decoded.type !== 'naddr') throw new Error();
    pointer = decoded.data;
    key = fromBase64Url(keyText);
  } catch {
    throw new InactiveShareError();
  }
  if (pointer.kind !== KIND || !pointer.identifier.startsWith(SHARE_PREFIX) || key.length !== 32) {
    throw new InactiveShareError();
  }
  const hints = (pointer.relays ?? []).filter((r) => /^wss:\/\/\S+$/.test(r)).slice(0, 5);
  const relays = [...new Set([...hints, ...DEFAULT_RELAYS])];
  const dTag = pointer.identifier;

  const manifestEvents = await pool.querySync(relays, { authors: [pointer.pubkey], kinds: [KIND], '#d': [dTag] }, { maxWait: 8000 });
  const ev = newestValid(manifestEvents, pointer.pubkey, dTag);
  if (!ev || !ev.content) throw new InactiveShareError();

  let manifest;
  try {
    manifest = decryptJson(ev.content, key);
  } catch {
    throw new InactiveShareError();
  }
  if (!validShareManifest(manifest)) throw new InactiveShareError();

  let entries = [];
  if (manifest.type === 'collection') {
    const partTags = HEX.map((h) => `${dTag}:${h}`);
    const partEvents = await pool.querySync(relays, { authors: [pointer.pubkey], kinds: [KIND], '#d': partTags }, { maxWait: 8000 });
    for (const tag of partTags) {
      const part = newestValid(partEvents, pointer.pubkey, tag);
      if (!part?.content) continue;
      try {
        const content = decryptJson(part.content, key);
        if (validCollectionContent(content, false)) {
          entries.push(
            ...content.e.map(([scryfallId, finish, condition, language, qty]) => ({
              key: `${scryfallId}:${finish}:${condition}:${language}`,
              scryfallId,
              finish,
              condition,
              language,
              qty,
            })),
          );
        }
      } catch {
        /* skip unreadable part */
      }
    }
  }
  return { manifest, entries, pubkey: pointer.pubkey, updatedAt: ev.created_at * 1000 };
}
