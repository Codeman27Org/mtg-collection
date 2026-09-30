import { openDB, deleteDB } from 'idb';

let sharedDb;
const accountDbs = new Map();

export function sharedDB() {
  sharedDb ??= openDB('codys-mtg', 1, {
    upgrade(db) {
      db.createObjectStore('accounts', { keyPath: 'pubkey' });
      db.createObjectStore('cards', { keyPath: 'id' });
      db.createObjectStore('prefs');
    },
  });
  return sharedDb;
}

export function accountDB(pubkey) {
  if (!pubkey) throw new Error('No account selected');
  if (!accountDbs.has(pubkey)) {
    accountDbs.set(
      pubkey,
      openDB(`codys-mtg-${pubkey}`, 1, {
        upgrade(db) {
          db.createObjectStore('collection', { keyPath: 'key' });
          db.createObjectStore('decks', { keyPath: 'id' });
          db.createObjectStore('shares', { keyPath: 'id' });
          db.createObjectStore('sync', { keyPath: 'dTag' });
          db.createObjectStore('settings');
        },
      }),
    );
  }
  return accountDbs.get(pubkey);
}

export async function deleteAccountDB(pubkey) {
  const db = accountDbs.get(pubkey);
  if (db) (await db).close();
  accountDbs.delete(pubkey);
  await deleteDB(`codys-mtg-${pubkey}`);
}

export async function getPref(key, fallback) {
  return (await (await sharedDB()).get('prefs', key)) ?? fallback;
}

export async function setPref(key, value) {
  await (await sharedDB()).put('prefs', value, key);
}
