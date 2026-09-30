import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { accountDB } from './db.js';
import * as account from './account.js';
import { emit, on } from './bus.js';
import {
  KIND,
  PREFIX,
  SHARE_PREFIX,
  SHARE_REGISTRY,
  DEFAULT_RELAYS,
  SHARDS,
  HEX,
  TOMBSTONE_TTL,
} from './constants.js';
import { encryptJson, decryptJson, selfConversationKey } from './crypto.js';
import * as merge from './merge.js';
import { applyFilter } from './collection-filter.js';
import { getCachedCards } from './scryfall.js';
import { sleep, fromBase64Url } from './util.js';

export const pool = new SimplePool();

const state = { status: 'idle', pending: 0, lastSync: null, error: null, relays: {} };
let flushTimer = null;
let pullTimer = null;
let flushing = false;
let flushAgain = false;
let running = false;
let firstPendingAt = null;
let lastPullAt = 0;

// Batch edits so relays see a few writes per session instead of one per click.
const IDLE_MS = 60_000;
const MAX_WAIT_MS = 5 * 60_000;
const PULL_EVERY_MS = 15 * 60_000;
const LAST_PULL_KEY = 'codys-mtg:last-pull';
// Per account, so logging into another account always pulls its data.
const lastPullKey = () => `${LAST_PULL_KEY}:${account.current()}`;

export const getState = () => state;

function setState(patch) {
  Object.assign(state, patch);
  emit('sync', state);
}

const db = () => accountDB(account.current());
const nowSec = () => Math.floor(Date.now() / 1000);
const dTagOf = (ev) => ev.tags.find((t) => t[0] === 'd')?.[1];
const expirationOf = (ev) => Number(ev.tags.find((t) => t[0] === 'expiration')?.[1] ?? Infinity);
const pruneBefore = () => Date.now() - TOMBSTONE_TTL;
const isActiveShare = (s) => !s.revoked && s.expiresAt > Date.now();

export async function getRelays() {
  const settings = await (await db()).get('settings', 'settings');
  return settings?.relays?.length ? settings.relays : DEFAULT_RELAYS;
}

export async function setRelays(relays) {
  if (!account.canEdit()) throw new Error('Unlock your account to make changes.');
  await (await db()).put('settings', { relays, updatedAt: Date.now() }, 'settings');
  await markDirty(`${PREFIX}settings`);
  emit('settings');
}

// ---------------------------------------------------------------- outbox

export async function markDirty(...dTags) {
  if (!account.current() || !dTags.length) return;
  const d = await db();
  const tx = d.transaction('sync', 'readwrite');
  for (const dTag of dTags) {
    const rec = (await tx.store.get(dTag)) ?? { dTag, remoteCreatedAt: 0, version: 0 };
    rec.dirty = true;
    rec.version = (rec.version ?? 0) + 1;
    await tx.store.put(rec);
  }
  await tx.done;
  await refreshPending();
  scheduleFlush();
}

export async function markSharesFor({ deckId, collection }) {
  if (!account.current()) return;
  const shares = await (await db()).getAll('shares');
  const tags = shares
    .filter(isActiveShare)
    .filter((s) => (deckId && s.type === 'deck' && s.targetId === deckId) || (collection && s.type === 'collection'))
    .map((s) => SHARE_PREFIX + s.id);
  await markDirty(...tags);
}

export async function markEverything() {
  const d = await db();
  const tags = [`${PREFIX}meta`, `${PREFIX}settings`, `${PREFIX}locations`, SHARE_REGISTRY, ...HEX.map((h) => `${PREFIX}collection:${h}`)];
  for (const deck of await d.getAll('decks')) tags.push(`${PREFIX}deck:${deck.id}`);
  for (const share of await d.getAll('shares')) if (isActiveShare(share)) tags.push(SHARE_PREFIX + share.id);
  await markDirty(...tags);
}

async function refreshPending() {
  if (!account.current()) return;
  const recs = await (await db()).getAll('sync');
  setState({ pending: recs.filter((r) => r.dirty).length });
}

function flushIn(ms) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, Math.max(0, ms));
}

/** Publish once edits pause for a minute, but never hold changes longer than five minutes. */
function scheduleFlush() {
  const now = Date.now();
  firstPendingAt ??= now;
  flushIn(Math.min(now + IDLE_MS, firstPendingAt + MAX_WAIT_MS) - now);
}

// Public relays ban clients that burst writes (relay.damus.io did), so cap publishes per minute.
// The log lives in localStorage so page reloads and other tabs share one budget.
const PUBLISH_GAP_MS = 2000;
const PUBLISHES_PER_MINUTE = 6;
const PUBLISH_LOG_KEY = 'codys-mtg:publish-log';

function readLog(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

async function throttle() {
  for (;;) {
    const now = Date.now();
    const recent = (readLog(PUBLISH_LOG_KEY) ?? []).filter((t) => t > now - 60_000);
    const last = recent.at(-1) ?? 0;
    const wait = recent.length >= PUBLISHES_PER_MINUTE ? recent[0] + 60_000 - now : last + PUBLISH_GAP_MS - now;
    if (wait <= 0) {
      localStorage.setItem(PUBLISH_LOG_KEY, JSON.stringify([...recent, now]));
      return;
    }
    await sleep(wait);
  }
}

// NIP-01 machine-readable prefixes in OK/CLOSED messages. Sending more after these only adds violations.
const BACKOFF_MS = { 'rate-limited': 10 * 60_000, banned: 60 * 60_000, blocked: 60 * 60_000, restricted: 60 * 60_000 };
// The relay has the event or refuses it for good (e.g. it honored our deletion); resending won't help.
const SETTLED = new Set(['duplicate', 'deleted']);
const PAUSES_KEY = 'codys-mtg:relay-pauses';
// Re-sending missing events to a relay is capped and spaced out: a relay that drops data would otherwise
// be refilled on every pull, spending the whole publish budget.
const REPAIR_PER_RELAY = 10;
const REPAIR_EVERY_MS = 60 * 60_000;
const REPAIR_LOG_KEY = 'codys-mtg:relay-repairs';
const settledIds = new Map();

const reasonPrefix = (msg) => /^([a-z-]+):/.exec(msg)?.[1] ?? null;

function loadPauses() {
  try {
    return JSON.parse(localStorage.getItem(PAUSES_KEY) ?? '{}');
  } catch {
    return {};
  }
}
const pauses = loadPauses();

function pauseRelay(url, prefix, message) {
  pauses[url] = { until: Date.now() + BACKOFF_MS[prefix], reason: message };
  localStorage.setItem(PAUSES_KEY, JSON.stringify(pauses));
}

/** { until, reason } while a relay asked us to back off, else null. */
export function relayPause(url) {
  const p = pauses[url];
  return p && p.until > Date.now() ? p : null;
}

const isSettled = (url, id) => settledIds.get(url)?.has(id) ?? false;
function markSettled(url, id) {
  if (!settledIds.has(url)) settledIds.set(url, new Set());
  settledIds.get(url).add(id);
}

/** Returns how many relays accepted (or already had / deliberately refuse) the event. Paused relays are skipped. */
async function publish(ev, relays) {
  const targets = relays.filter((url) => !relayPause(url));
  if (!targets.length) return 0;
  await throttle();
  const results = await Promise.allSettled(pool.publish(targets, ev, { maxWait: 8000 }));
  let ok = 0;
  results.forEach((r, i) => {
    const url = targets[i];
    const st = (state.relays[url] ??= {});
    const message = r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : '';
    const prefix = reasonPrefix(message);
    if (r.status === 'fulfilled' || SETTLED.has(prefix)) {
      ok++;
      if (prefix) markSettled(url, ev.id);
      Object.assign(st, { ok: true, at: Date.now(), error: null });
    } else {
      if (BACKOFF_MS[prefix]) pauseRelay(url, prefix, message);
      Object.assign(st, { ok: false, error: message });
    }
  });
  setState({ relays: state.relays });
  return ok;
}

export async function flush() {
  if (!account.current()) return;
  if (!account.canEdit()) return setState({ status: 'locked' });
  if (!navigator.onLine) return setState({ status: 'offline' });
  if (flushing) {
    flushAgain = true;
    return;
  }
  clearTimeout(flushTimer);
  firstPendingAt = null;
  flushing = true;
  setState({ status: 'syncing' });
  let failed = false;
  try {
    const d = await db();
    const relays = await getRelays();
    const dirty = (await d.getAll('sync')).filter((r) => r.dirty);
    for (const rec of dirty) {
      const events = await buildEvents(rec);
      let allOk = true;
      let createdAt = rec.remoteCreatedAt ?? 0;
      for (const ev of events) {
        if (!(await publish(ev, relays))) allOk = false;
        createdAt = Math.max(createdAt, ev.created_at);
      }
      const latest = await d.get('sync', rec.dTag);
      if (allOk) {
        latest.remoteCreatedAt = createdAt;
        // Only clear if nothing re-marked this tag while we were publishing.
        if (latest.version === rec.version) latest.dirty = false;
        await d.put('sync', latest);
      } else {
        failed = true;
      }
    }
  } catch (err) {
    console.error('sync flush failed', err);
    failed = true;
    setState({ error: err.message });
  } finally {
    flushing = false;
  }
  await refreshPending();
  setState({ status: failed ? 'error' : 'idle', lastSync: failed ? state.lastSync : Date.now() });
  if (flushAgain) {
    flushAgain = false;
    flushIn(500);
  } else if (failed) {
    flushIn(30000);
  }
}

// ---------------------------------------------------------------- event builders

async function buildEvents(rec) {
  const sk = account.secretKey();
  const pubkey = account.current();
  const d = await db();
  const created_at = Math.max(nowSec(), (rec.remoteCreatedAt ?? 0) + 1);
  const key = selfConversationKey(sk, pubkey);
  const priv = (obj) =>
    finalizeEvent({ kind: KIND, created_at, tags: [['d', rec.dTag]], content: encryptJson(obj, key) }, sk);

  if (rec.dTag.startsWith(SHARE_PREFIX)) return buildShareEvents(rec.dTag, created_at);
  const tag = rec.dTag.slice(PREFIX.length);
  if (tag === 'meta') return [priv({ v: 1, shards: SHARDS })];
  if (tag === 'settings') {
    const s = (await d.get('settings', 'settings')) ?? { relays: DEFAULT_RELAYS, updatedAt: 0 };
    return [priv({ v: 1, relays: s.relays, updatedAt: s.updatedAt })];
  }
  if (tag === 'share-registry') {
    const shares = await d.getAll('shares');
    return shares.length || rec.remoteCreatedAt ? [priv({ v: 1, shares })] : [];
  }
  if (tag === 'locations') {
    const locations = (await d.get('settings', 'locations')) ?? [];
    return locations.length || rec.remoteCreatedAt ? [priv({ v: 1, locations })] : [];
  }
  if (tag.startsWith('collection:')) {
    const digit = tag.split(':')[1];
    const cutoff = pruneBefore();
    const e = (await d.getAll('collection'))
      .filter((x) => x.scryfallId[0] === digit && !(x.qty === 0 && x.updatedAt < cutoff))
      .map(merge.entryToTuple);
    // Skip empty shards that were never published; nothing to replace on relays.
    return e.length || rec.remoteCreatedAt ? [priv({ v: 1, e })] : [];
  }
  if (tag.startsWith('deck:')) {
    const deck = await d.get('decks', tag.slice(5));
    return deck ? [priv(merge.deckToContent(deck, pruneBefore()))] : [];
  }
  return [];
}

async function sharedCollectionEntries(share) {
  const d = await db();
  const entries = (await d.getAll('collection')).filter((e) => e.qty > 0);
  const decks = (await d.getAll('decks')).filter((x) => !x.deleted);
  const deckIds = decks.flatMap((x) => Object.values(x.lines).filter((l) => l.qty > 0).map((l) => l.scryfallId));
  const cards = await getCachedCards([...entries.map((e) => e.scryfallId), ...deckIds]);
  const usedOracles = new Set(deckIds.map((id) => cards.get(id)?.oracle_id).filter(Boolean));
  // Viewers don't get location names, so stacks of the same card in different places are combined.
  const combined = new Map();
  for (const e of applyFilter(entries, cards, share.filter ?? {}, usedOracles)) {
    const key = merge.entryKey(e.scryfallId, e.finish, e.condition, e.language);
    const prev = combined.get(key);
    combined.set(key, { ...e, qty: (prev?.qty ?? 0) + e.qty });
  }
  return [...combined.values()];
}

async function buildShareEvents(dTag, created_at) {
  const sk = account.secretKey();
  const pubkey = account.current();
  const d = await db();
  const share = await d.get('shares', dTag.slice(SHARE_PREFIX.length));
  if (!share) return [];
  if (!share.revoked && share.expiresAt <= Date.now()) return [];

  const key = fromBase64Url(share.key);
  const expiration = String(Math.floor(share.expiresAt / 1000));
  const partTags = share.type === 'collection' ? HEX.map((h) => `${dTag}:${h}`) : [];
  const make = (tag, content) =>
    finalizeEvent({ kind: KIND, created_at, tags: [['d', tag], ['expiration', expiration]], content }, sk);

  const deck = share.type === 'deck' ? await d.get('decks', share.targetId) : null;
  if (share.revoked || (share.type === 'deck' && (!deck || deck.deleted))) {
    const tags = [dTag, ...partTags];
    return [
      ...tags.map((t) => make(t, '')),
      finalizeEvent(
        { kind: 5, created_at, tags: tags.map((t) => ['a', `${KIND}:${pubkey}:${t}`]), content: 'Share stopped' },
        sk,
      ),
    ];
  }

  if (share.type === 'deck') {
    const lines = Object.values(deck.lines)
      .filter((l) => l.qty > 0)
      .map((l) => [l.scryfallId, l.section, l.qty]);
    const manifest = {
      v: 1,
      type: 'deck',
      title: deck.name,
      updatedAt: Date.now(),
      parts: 0,
      deck: { name: deck.name, format: deck.format, description: deck.description ?? '', lines },
    };
    return [make(dTag, encryptJson(manifest, key))];
  }

  const entries = await sharedCollectionEntries(share);
  const manifest = { v: 1, type: 'collection', title: share.title, updatedAt: Date.now(), parts: SHARDS };
  return [
    make(dTag, encryptJson(manifest, key)),
    ...HEX.map((h, i) =>
      make(
        partTags[i],
        encryptJson(
          {
            v: 1,
            e: entries
              .filter((e) => e.scryfallId[0] === h)
              .map((e) => [e.scryfallId, e.finish, e.condition, e.language, e.qty]),
          },
          key,
        ),
      ),
    ),
  ];
}

// ---------------------------------------------------------------- pull + merge

async function applyRemote(d, dTag, content) {
  const tag = dTag.slice(PREFIX.length);
  if (tag === 'meta') return {};

  if (tag === 'settings') {
    if (!merge.validSettings(content)) return {};
    const local = await d.get('settings', 'settings');
    if (!local || content.updatedAt > local.updatedAt) {
      await d.put('settings', { relays: content.relays, updatedAt: content.updatedAt }, 'settings');
      return { changed: 'settings' };
    }
    return { republish: local.updatedAt > content.updatedAt };
  }

  if (tag === 'share-registry') {
    if (!merge.validShareRegistry(content)) return {};
    const { toWrite, republish } = merge.mergeById(await d.getAll('shares'), content.shares);
    const tx = d.transaction('shares', 'readwrite');
    for (const s of toWrite) tx.store.put(s);
    await tx.done;
    return { changed: toWrite.length ? 'shares' : null, republish };
  }

  if (tag === 'locations') {
    if (!merge.validLocations(content)) return {};
    const local = (await d.get('settings', 'locations')) ?? [];
    const { toWrite, republish } = merge.mergeById(local, content.locations);
    if (toWrite.length) {
      const byId = new Map(local.map((l) => [l.id, l]));
      for (const l of toWrite) byId.set(l.id, l);
      await d.put('settings', [...byId.values()], 'locations');
    }
    return { changed: toWrite.length ? 'locations' : null, republish };
  }

  if (tag.startsWith('collection:')) {
    const digit = tag.split(':')[1];
    if (!HEX.includes(digit) || !merge.validCollectionContent(content)) return {};
    if (!content.e.every((t) => t[0][0] === digit)) return {};
    const local = (await d.getAll('collection')).filter((e) => e.scryfallId[0] === digit);
    const { toWrite, republish } = merge.mergeCollectionShard(local, content.e, pruneBefore());
    const tx = d.transaction('collection', 'readwrite');
    for (const r of toWrite) tx.store.put(r);
    await tx.done;
    return { changed: toWrite.length ? 'collection' : null, republish };
  }

  if (tag.startsWith('deck:')) {
    const id = tag.slice(5);
    if (!merge.validDeckContent(content, id)) return {};
    const { deck, changed, republish } = merge.mergeDeck(await d.get('decks', id), content, pruneBefore());
    if (changed) await d.put('decks', deck);
    return { changed: changed ? 'decks' : null, republish };
  }
  return {};
}

export async function pull() {
  const pubkey = account.current();
  const sk = account.secretKey();
  if (!pubkey || !sk) return;
  if (!navigator.onLine) return setState({ status: 'offline' });
  lastPullAt = Date.now();
  localStorage.setItem(lastPullKey(), String(lastPullAt));
  setState({ status: 'syncing' });
  try {
    const d = await db();
    const relays = (await getRelays()).filter((url) => !relayPause(url));
    if (!relays.length) return setState({ status: 'error', error: 'Every relay asked us to back off; sync resumes automatically.' });
    const key = selfConversationKey(sk, pubkey);
    const filter = { authors: [pubkey], kinds: [KIND] };
    const results = await Promise.all(
      relays.map(async (url) => {
        try {
          return { url, events: await pool.querySync([url], filter, { maxWait: 8000 }) };
        } catch (err) {
          Object.assign((state.relays[url] ??= {}), { ok: false, error: String(err?.message ?? err) });
          return { url, events: null };
        }
      }),
    );

    const newest = new Map();
    for (const { events } of results) {
      for (const ev of events ?? []) {
        const dTag = dTagOf(ev);
        if (!dTag?.startsWith(PREFIX) || ev.pubkey !== pubkey || !verifyEvent(ev)) continue;
        const cur = newest.get(dTag);
        if (!cur || ev.created_at > cur.created_at || (ev.created_at === cur.created_at && ev.id < cur.id)) {
          newest.set(dTag, ev);
        }
      }
    }

    const changed = new Set();
    const republish = [];
    for (const [dTag, ev] of newest) {
      if (dTag.startsWith(SHARE_PREFIX)) continue;
      const rec = await d.get('sync', dTag);
      if (ev.created_at <= (rec?.remoteCreatedAt ?? 0)) continue;
      let content;
      try {
        content = decryptJson(ev.content, key);
      } catch {
        continue;
      }
      const res = await applyRemote(d, dTag, content);
      if (res.changed) changed.add(res.changed);
      if (res.republish) republish.push(dTag);
      const latest = (await d.get('sync', dTag)) ?? { dTag, version: 0, dirty: false };
      latest.remoteCreatedAt = Math.max(latest.remoteCreatedAt ?? 0, ev.created_at);
      latest.remoteEventId = ev.id;
      await d.put('sync', latest);
    }
    // Show pulled changes now; the relay repair below is throttled and can take a while.
    for (const store of changed) emit(`remote:${store}`);

    // Relay repair: re-send the newest signed event to relays that lack it. Emptied share events are skipped:
    // relays that honored the share's deletion refuse them, and they carry nothing worth keeping.
    const repairs = readLog(REPAIR_LOG_KEY) ?? {};
    for (const r of results) {
      if (!r.events) continue;
      const have = new Set(r.events.map((e) => e.id));
      const missing = [...newest.values()].filter(
        (ev) => !have.has(ev.id) && ev.content !== '' && expirationOf(ev) > nowSec() && !isSettled(r.url, ev.id),
      );
      const prev = repairs[r.url];
      // Still missing events after an earlier repair means the relay isn't keeping them.
      const dropping = !!(missing.length && prev?.sent && prev.at < Date.now() - 5 * 60_000);
      Object.assign((state.relays[r.url] ??= {}), { missing: missing.length, dropping, checkedAt: Date.now() });
      if (!missing.length) {
        delete repairs[r.url];
        continue;
      }
      if (prev && Date.now() - prev.at < REPAIR_EVERY_MS) continue;
      let sent = 0;
      for (const ev of missing.slice(0, REPAIR_PER_RELAY)) {
        if (relayPause(r.url)) break;
        if (await publish(ev, [r.url])) sent++;
      }
      repairs[r.url] = { at: Date.now(), sent };
    }
    localStorage.setItem(REPAIR_LOG_KEY, JSON.stringify(repairs));

    for (const share of await d.getAll('shares')) {
      if (isActiveShare(share) && !newest.has(SHARE_PREFIX + share.id)) republish.push(SHARE_PREFIX + share.id);
    }

    if (republish.length) await markDirty(...republish);
    setState({ status: 'idle', lastSync: Date.now(), error: null, relays: state.relays });
  } catch (err) {
    console.error('sync pull failed', err);
    setState({ status: 'error', error: err.message });
  }
  flush();
}

// ---------------------------------------------------------------- lifecycle

/** Publish pending changes now, then check relays for changes from other devices. */
export async function syncNow() {
  await flush();
  await pull();
}

export function start({ pullNow = false } = {}) {
  stop();
  if (!account.canEdit()) return setState({ status: 'locked' });
  running = true;
  // Reloads (and the dev server's hot reloads) shouldn't each trigger a full pull and repair; logging in always pulls.
  lastPullAt = Number(localStorage.getItem(lastPullKey())) || 0;
  if (pullNow || Date.now() - lastPullAt > 60_000) pull();
  else refreshPending().then(() => state.pending && scheduleFlush());
  pullTimer = setInterval(pull, PULL_EVERY_MS);
}

export function stop() {
  running = false;
  clearInterval(pullTimer);
  clearTimeout(flushTimer);
  pullTimer = null;
  firstPendingAt = null;
  setState({ status: 'idle', pending: 0, relays: {}, error: null });
}

if (typeof document !== 'undefined') {
  // Leaving the tab (or the phone locking) is when unsynced edits are most at risk.
  document.addEventListener('visibilitychange', () => {
    if (!running) return;
    if (document.visibilityState === 'hidden') {
      if (state.pending) flush();
    } else if (Date.now() - lastPullAt > 60_000) {
      pull();
    }
  });
  addEventListener('pagehide', () => running && state.pending && flush());
  addEventListener('online', () => running && pull());
}

on('account', ({ pubkey, unlocked, loggedIn }) => (pubkey && unlocked ? start({ pullNow: loggedIn }) : stop()));

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => account.canEdit() && pull());
  window.addEventListener('offline', () => setState({ status: 'offline' }));
}
