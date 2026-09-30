import { h } from '../dom.js';
import * as account from '../account.js';
import { markEverything } from '../sync.js';
import { navigate, nextPath } from '../router.js';
import { field, action, toast } from '../components.js';
import { copyText, download } from '../util.js';
import { APP_NAME } from '../constants.js';

function rememberField() {
  const remember = h('input', { type: 'checkbox', checked: true });
  return {
    el: h(
      'label',
      { class: 'check' },
      remember,
      ' Remember me on this device',
      h('span', { class: 'muted small' }, ' (stays logged in; uncheck on shared computers)'),
    ),
    read: () => ({ remember: remember.checked }),
  };
}

function createPanel(next) {
  const sk = account.newSecretKey();
  const nsec = account.nsec(sk);
  const saved = h('input', { type: 'checkbox' });
  const rem = rememberField();
  const secretBox = h('code', { class: 'secret' }, nsec);
  return h(
    'form',
    {
      class: 'stack',
      onsubmit: action(async (e) => {
        e.preventDefault();
        if (!saved.checked) throw new Error('Please confirm you saved your key first.');
        await account.login(sk, rem.read());
        await markEverything();
        navigate(next);
      }),
    },
    h('p', {}, 'This is your account key. It’s the ', h('strong', {}, 'only'), ' way to log in. If you lose it, the account is gone. Nobody can reset it.'),
    secretBox,
    h(
      'div',
      { class: 'row wrap' },
      h('button', { class: 'btn', type: 'button', onclick: action(async () => { await copyText(nsec); toast('Key copied'); }) }, 'Copy key'),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () =>
            download(
              `codys-mtg-key-${account.npub(account.pubkeyOf(sk)).slice(5, 13)}.txt`,
              `${APP_NAME} — account key\n\n${nsec}\n\nMove this key into a password manager, then delete this file.\nAnyone with this key can edit your collection.\n`,
            ),
        },
        'Download key',
      ),
    ),
    h('label', { class: 'check' }, saved, ' I saved my key somewhere safe'),
    rem.el,
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create Account'),
  );
}

function loginPanel(next) {
  const secret = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'nsec1…' });
  const rem = rememberField();
  return h(
    'form',
    {
      class: 'stack',
      onsubmit: action(async (e) => {
        e.preventDefault();
        const sk = account.parseSecret(secret.value);
        secret.value = '';
        await account.login(sk, rem.read());
        toast('Logged in. Pulling your data from relays…');
        navigate(next);
      }),
    },
    field('Your key', secret),
    h('p', { class: 'muted small' }, 'Tip: use a key made for this app rather than your main Nostr account.'),
    rem.el,
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Log In'),
  );
}

export default async function welcomeView(root, { query }) {
  const next = nextPath(query);
  // Accounts saved before the passphrase was removed only have an encrypted key.
  const legacy = (await account.listAccounts()).some((a) => a.ncryptsec && !a.nsec);
  const panel = h('div', { class: 'panel stack' });
  const switchLink = (text, label, show) =>
    h('p', { class: 'muted auth-switch' }, text, ' ', h('button', { type: 'button', class: 'link-btn', onclick: show }, label));

  function showLogin() {
    panel.replaceChildren(h('h2', {}, 'Log in'), loginPanel(next), switchLink('New here?', 'Create an account', showCreate));
    panel.querySelector('input[type="password"]')?.focus();
  }
  function showCreate() {
    panel.replaceChildren(h('h2', {}, 'Create an account'), createPanel(next), switchLink('Already have a key?', 'Log in', showLogin));
  }
  showLogin();
  root.append(
    h(
      'section',
      { class: 'narrow' },
      h('h1', {}, APP_NAME),
      h('p', { class: 'lead' }, 'Your Magic collection and decks, synced across devices with Nostr. Your key is your account.'),
      legacy ? h('div', { class: 'banner banner-warn' }, 'The device passphrase is gone. Log in with your nsec once and this device will remember it.') : null,
      panel,
    ),
  );
}
