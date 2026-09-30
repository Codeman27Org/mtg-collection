// The in-progress scan, kept on this device only (never synced) until it's saved or discarded.
import { accountDB } from '../db.js';
import * as account from '../account.js';

const KEY = 'scan-session';

export async function loadSession() {
  return (await (await accountDB(account.current())).get('settings', KEY)) ?? null;
}

export async function saveSession(session) {
  await (await accountDB(account.current())).put('settings', session, KEY);
}

export async function clearSession() {
  await (await accountDB(account.current())).delete('settings', KEY);
}
