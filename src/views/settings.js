import { h } from '../dom.js';
import { on } from '../bus.js';
import * as account from '../account.js';
import * as sync from '../sync.js';
import * as shares from '../shares.js';
import * as collection from '../collection.js';
import * as decks from '../decks.js';
import * as locations from '../locations.js';
import { navigate } from '../router.js';
import { getPref, setPref } from '../db.js';
import { action, toast, confirmDialog, field, qrImage } from '../components.js';
import { describeFilter } from '../collection-filter.js';
import { copyText, download, timeAgo } from '../util.js';
import { DEFAULT_RELAYS, APP_NAME } from '../constants.js';

function section(title, ...children) {
  return h('section', { class: 'panel stack' }, h('h2', {}, title), ...children);
}

async function accountSection() {
  const npub = account.npub(account.current());
  const nsec = account.nsec(account.secretKey());
  const secretBox = h('div', { class: 'stack' });
  const remember = h('input', {
    type: 'checkbox',
    checked: await account.isRemembered(),
    onchange: action(async (e) => {
      await account.setRemembered(e.target.checked);
      toast(e.target.checked ? 'This device will stay logged in' : 'You’ll need your nsec next time you open the app here');
    }),
  });

  const reveal = (withQr) =>
    action(async () => {
      secretBox.replaceChildren(
        h('p', { class: 'warn-text small' }, withQr ? 'Anyone who scans this code or has this key can edit your collection and decks.' : 'Anyone with this key can edit your collection and decks.'),
        withQr ? h('p', {}, 'Scan this with the other device’s camera to open the site and log in. Or choose Log In there and paste the key below.') : null,
        withQr ? await qrImage(account.loginLink(account.secretKey()), 'QR code that logs another device into this account') : null,
        h('code', { class: 'secret' }, nsec),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: action(async () => { await copyText(nsec); toast('Key copied'); }) }, 'Copy'),
          h('button', { class: 'btn', type: 'button', onclick: () => secretBox.replaceChildren() }, 'Hide'),
        ),
      );
    });

  return section(
    'Account',
    h('div', { class: 'row wrap' }, h('code', { class: 'mono grow' }, npub), h('button', { class: 'btn', type: 'button', onclick: action(async () => { await copyText(npub); toast('npub copied'); }) }, 'Copy npub')),
    h(
      'div',
      { class: 'row wrap' },
      h('button', { class: 'btn', type: 'button', onclick: reveal(false) }, 'Reveal nsec'),
      h('button', { class: 'btn', type: 'button', onclick: reveal(true) }, 'Add another device'),
    ),
    secretBox,
    h('label', { class: 'check' }, remember, ' Remember me on this device'),
  );
}

async function relaysSection() {
  const relays = await sync.getRelays();
  const status = sync.getState().relays;
  const input = h('input', { type: 'url', placeholder: 'wss://relay.example.com', 'aria-label': 'Relay URL', class: 'grow' });
  const edit = account.canEdit();
  const save = async (list) => {
    await sync.setRelays(list);
    toast('Relays saved');
    render();
  };
  return section(
    'Relays',
    h('p', { class: 'muted small' }, 'Your data is encrypted before it’s sent. Publishing to several relays keeps a copy if one drops data.'),
    h(
      'ul',
      { class: 'relay-list' },
      relays.map((url) => {
        const st = status[url];
        const pause = sync.relayPause(url);
        const label = pause
          ? `paused until ${new Date(pause.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}: ${pause.reason}`
          : !st
            ? 'not checked yet'
            : st.ok === false
              ? `error: ${st.error}`
              : st.dropping
                ? `not keeping your data: missing ${st.missing} events even after re-sending them`
                : st.missing
                  ? `missing ${st.missing} events (re-sent hourly, a few at a time)`
                  : `OK ${timeAgo(st.at ?? st.checkedAt)}`;
        return h(
          'li',
          { class: 'row between relay-row' },
          h('span', { class: 'mono relay-url' }, url),
          h('span', { class: `small relay-status ${pause || st?.ok === false || st?.missing ? 'warn-text' : 'muted'}` }, label),
          edit && relays.length > 1 ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${url}`, onclick: action(() => save(relays.filter((r) => r !== url))) }, '✕') : null,
        );
      }),
    ),
    edit
      ? h(
          'form',
          {
            class: 'row wrap relay-form',
            onsubmit: action(async (e) => {
              e.preventDefault();
              const url = input.value.trim().replace(/\/+$/, '');
              if (!/^wss:\/\/[^\s/]+/.test(url)) throw new Error('Relay URLs must start with wss://');
              if (!relays.includes(url)) await save([...relays, url]);
            }),
          },
          input,
          h('button', { class: 'btn', type: 'submit' }, 'Add relay'),
          h('button', { class: 'btn', type: 'button', onclick: action(() => save(DEFAULT_RELAYS)) }, 'Reset to defaults'),
        )
      : null,
  );
}

function syncSection() {
  const s = sync.getState();
  return section(
    'Sync',
    h('p', {}, `Status: ${account.canEdit() ? s.status : 'locked'} · ${s.pending} changes pending · last sync ${timeAgo(s.lastSync)}`),
    h(
      'p',
      { class: 'muted small' },
      'Changes are saved on this device right away. They’re sent to relays after a minute without edits (at most five minutes later) and whenever you leave the tab. Relays are checked for changes from other devices every 15 minutes and when you come back.',
    ),
    s.error ? h('p', { class: 'warn-text small' }, s.error) : null,
    account.canEdit()
      ? h(
          'div',
          { class: 'row wrap' },
          h('button', { class: 'btn btn-primary', type: 'button', onclick: action(async () => { await sync.syncNow(); toast('Synced'); }) }, 'Sync now'),
          h('button', { class: 'btn', type: 'button', onclick: action(async () => { await sync.pull(); toast('Pulled from relays'); }) }, 'Pull from relays'),
          h('button', { class: 'btn', type: 'button', onclick: action(async () => { await sync.markEverything(); await sync.flush(); toast('Republished everything'); }) }, 'Push everything'),
        )
      : null,
  );
}

async function sharesSection() {
  const list = await shares.list();
  const edit = account.canEdit();
  const status = (s) => (s.revoked ? 'stopped' : shares.isExpired(s) ? 'expired' : `expires in ${Math.ceil((s.expiresAt - Date.now()) / 86400000)} days`);
  return section(
    'Shared links',
    list.length
      ? h(
          'ul',
          { class: 'share-list' },
          list.map((s) =>
            h(
              'li',
              { class: 'row between wrap' },
              h('span', { class: 'grow' }, h('strong', {}, s.title), h('span', { class: 'muted small' }, ` · ${s.type}${s.type === 'collection' ? ` (${describeFilter(s.filter)})` : ''} · created ${timeAgo(s.createdAt)} · ${status(s)}`)),
              shares.isActive(s)
                ? h('button', { class: 'btn btn-small', type: 'button', onclick: action(async () => { await copyText(await shares.link(s)); toast('Link copied'); }) }, 'Copy link')
                : null,
              edit && shares.isActive(s)
                ? h('button', { class: 'btn btn-small btn-danger', type: 'button', onclick: action(async () => { await shares.stop(s.id); toast('Sharing stopped'); render(); }) }, 'Stop sharing')
                : null,
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'You haven’t shared anything yet. Use Share on a deck or on your collection.'),
  );
}

function backupSection() {
  return section(
    'Backup',
    h('p', { class: 'muted small' }, 'Downloads your collection, decks, and locations as a JSON file. It doesn’t include your key.'),
    h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: action(async () => {
          const data = {
            app: APP_NAME,
            version: 1,
            exportedAt: new Date().toISOString(),
            npub: account.npub(account.current()),
            collection: await collection.entries(),
            decks: await decks.list(),
            locations: await locations.list(),
          };
          download(`codys-mtg-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
        }),
      },
      'Download backup',
    ),
  );
}

async function appearanceSection() {
  const theme = await getPref('theme', 'dark');
  return section(
    'Appearance',
    field(
      'Theme',
      h(
        'select',
        {
          onchange: async (e) => {
            document.documentElement.dataset.theme = e.target.value;
            await setPref('theme', e.target.value);
          },
        },
        ['dark', 'light'].map((t) => h('option', { value: t, selected: t === theme }, t === 'dark' ? 'Dark' : 'Light')),
      ),
    ),
  );
}

function logoutSection() {
  const wipe = h('input', { type: 'checkbox' });
  return section(
    'Log out',
    h('p', { class: 'muted small' }, 'Forgets your key on this device. Make sure you have your nsec saved before logging out.'),
    h('label', { class: 'check' }, wipe, ' Also delete this account’s data from this device'),
    h(
      'button',
      {
        class: 'btn btn-danger',
        type: 'button',
        onclick: action(async () => {
          const pending = sync.getState().pending;
          const msg = pending
            ? `${pending} changes haven’t synced to relays yet.${wipe.checked ? ' Deleting local data will lose them.' : ' They’ll stay on this device until you log in again.'} Log out anyway?`
            : 'Log out of this device?';
          if (!(await confirmDialog(msg, { confirmLabel: 'Log out', danger: true }))) return;
          await account.logout({ deleteData: wipe.checked });
          navigate('/welcome');
        }),
      },
      'Log out',
    ),
  );
}

let rootEl;
async function render() {
  if (!rootEl) return;
  const parts = await Promise.all([accountSection(), relaysSection(), syncSection(), sharesSection(), backupSection(), appearanceSection(), logoutSection()]);
  rootEl.replaceChildren(h('h1', {}, 'Settings'), ...parts);
}

export default async function settingsView(root) {
  rootEl = root;
  await render();
  let timer;
  const rerender = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Don't wipe a revealed key or the field being edited.
      if (root.querySelector('.secret')) return;
      if (!root.contains(document.activeElement) || document.activeElement === document.body) render();
    }, 400);
  };
  const offs = [on('sync', rerender), on('shares', rerender), on('settings', rerender)];
  return () => {
    rootEl = null;
    offs.forEach((off) => off());
  };
}
