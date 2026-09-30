import { h } from './dom.js';
import { on } from './bus.js';
import * as account from './account.js';
import * as sync from './sync.js';
import * as collection from './collection.js';
import * as decks from './decks.js';
import * as scryfall from './scryfall.js';
import { getPref, setPref } from './db.js';
import { route, setGuard, mount, navigate } from './router.js';
import { openCardModal } from './cardui.js';
import { action } from './components.js';
import { debounce } from './util.js';

import homeView from './views/home.js';
import collectionView from './views/collection.js';
import importView from './views/import.js';
import locationsView from './views/locations.js';
import cardsView from './views/cards.js';
import decksView from './views/decks.js';
import newDeckView from './views/deck-new.js';
import builderView from './views/builder.js';
import settingsView from './views/settings.js';
import welcomeView from './views/welcome.js';
import shareView from './views/share-view.js';
import scanView from './views/scan.js';

route(/^\/$/, homeView);
route(/^\/collection$/, collectionView);
route(/^\/collection\/import$/, importView);
route(/^\/locations$/, locationsView);
route(/^\/scan$/, scanView);
route(/^\/cards$/, cardsView);
route(/^\/decks$/, decksView);
route(/^\/decks\/new$/, newDeckView);
route(/^\/decks\/([\w-]+)$/, builderView);
route(/^\/settings$/, settingsView);
route(/^\/welcome$/, welcomeView, { isPublic: true });
route(/^\/s\/([^/]+)\/([^/]+)$/, shareView, { isPublic: true });

setGuard(async (r, path) => {
  if (r.isPublic || account.current() || (await account.restore())) return null;
  return path === '/' ? '/welcome' : `/welcome?next=${encodeURIComponent(path)}`;
});

// ---------------------------------------------------------------- theme

async function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  await setPref('theme', theme);
}

// ---------------------------------------------------------------- global search

function globalSearch() {
  const list = h('ul', { class: 'suggestions', role: 'listbox', hidden: true });
  let ownedByName = null;
  on('collection', () => (ownedByName = null));

  async function loadOwnedByName() {
    if (ownedByName || !account.current()) return ownedByName ?? new Map();
    const entries = await collection.entries();
    const cards = await scryfall.getCachedCards(entries.map((e) => e.scryfallId));
    ownedByName = new Map();
    for (const e of entries) {
      const name = cards.get(e.scryfallId)?.name;
      if (name) ownedByName.set(name, (ownedByName.get(name) ?? 0) + e.qty);
    }
    return ownedByName;
  }

  async function choose(name) {
    list.hidden = true;
    input.value = '';
    const card = await scryfall.named(name);
    if (card) openCardModal(card);
  }

  const update = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) {
      list.hidden = true;
      return;
    }
    const [names, owned] = await Promise.all([scryfall.autocomplete(q), loadOwnedByName()]);
    list.replaceChildren(
      ...names.slice(0, 10).map((name) =>
        h(
          'li',
          { role: 'option' },
          h(
            'button',
            { type: 'button', class: 'suggestion', onmousedown: (e) => e.preventDefault(), onclick: () => choose(name) },
            name,
            owned.get(name) ? h('span', { class: 'owned-badge inline' }, `Own ${owned.get(name)}`) : null,
          ),
        ),
      ),
    );
    list.hidden = !names.length;
  }, 250);

  const input = h('input', {
    type: 'search',
    class: 'search-input',
    placeholder: 'Search cards…',
    'aria-label': 'Search cards',
    autocomplete: 'off',
    oninput: update,
    onkeydown: (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        e.preventDefault();
        list.hidden = true;
        navigate(`/cards?q=${encodeURIComponent(input.value.trim())}`);
        input.value = '';
      } else if (e.key === 'Escape') list.hidden = true;
    },
    onblur: () => setTimeout(() => (list.hidden = true), 150),
  });
  return h('div', { class: 'global-search' }, input, list);
}

// ---------------------------------------------------------------- sync indicator

function syncIndicator() {
  const link = h('a', { class: 'sync-indicator', href: '#/settings', title: 'Sync status' });
  const syncBtn = h(
    'button',
    {
      class: 'btn btn-small sync-now',
      type: 'button',
      title: 'Send changes to relays now instead of waiting',
      onclick: action(() => sync.syncNow()),
    },
    'Sync now',
  );
  const el = h('div', { class: 'sync-box' }, link, syncBtn);
  const render = () => {
    const s = sync.getState();
    let text = 'Synced';
    let cls = 'ok';
    if (!account.current()) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    if (!account.canEdit()) [text, cls] = ['Locked', 'warn'];
    else if (s.status === 'syncing') [text, cls] = ['Syncing…', 'busy'];
    else if (s.status === 'offline') [text, cls] = ['Offline', 'warn'];
    else if (s.status === 'error') [text, cls] = ['Sync error', 'error'];
    else if (s.pending) [text, cls] = [`${s.pending} pending`, 'busy'];
    link.className = `sync-indicator sync-${cls}`;
    link.title = s.pending && s.status === 'idle' ? 'Changes are saved on this device and sync after a minute without edits' : 'Sync status';
    link.replaceChildren(h('span', { class: 'dot', 'aria-hidden': 'true' }), text);
    syncBtn.hidden = !account.canEdit() || s.status === 'syncing' || s.status === 'offline' || !(s.pending || s.status === 'error');
  };
  on('sync', render);
  on('account', render);
  render();
  return el;
}

// ---------------------------------------------------------------- layout

function navLinks(cls) {
  const links = [
    ['#/', 'Home'],
    ['#/collection', 'Collection'],
    ['#/decks', 'Decks'],
    ['#/cards', 'Cards'],
    ['#/scan', 'Scan'],
  ];
  const nav = h(
    'nav',
    { class: cls, 'aria-label': cls === 'bottom-nav' ? 'Mobile' : 'Main' },
    links.map(([href, label]) => h('a', { href, dataset: { path: href.slice(1) } }, label)),
  );
  on('route', (path) => {
    for (const a of nav.querySelectorAll('a')) {
      const p = a.dataset.path;
      a.classList.toggle('active', p === '/' ? path === '/' : path.startsWith(p));
    }
  });
  return nav;
}

function layout() {
  const themeBtn = h(
    'button',
    {
      class: 'icon-btn theme-btn',
      type: 'button',
      'aria-label': 'Toggle light/dark theme',
      onclick: () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'),
    },
    '◐',
  );
  const main = h('main', { id: 'main', tabindex: '-1' });
  document.getElementById('app').replaceChildren(
    h(
      'header',
      { class: 'topbar' },
      h('a', { class: 'brand', href: '#/' }, "Cody's MTG", h('span', { class: 'brand-long' }, ' Collection')),
      navLinks('top-nav'),
      globalSearch(),
      h('div', { class: 'topbar-right' }, syncIndicator(), themeBtn, h('a', { class: 'icon-btn', href: '#/settings', 'aria-label': 'Settings' }, '⚙')),
    ),
    main,
    h(
      'footer',
      { class: 'footer' },
      'Card data and images by ',
      h('a', { href: 'https://scryfall.com', target: '_blank', rel: 'noopener noreferrer' }, 'Scryfall'),
      '. Not affiliated with Wizards of the Coast.',
    ),
    navLinks('bottom-nav'),
  );
  return main;
}

// ---------------------------------------------------------------- boot

let refreshedFor = null;
on('account', async ({ pubkey }) => {
  if (!pubkey || refreshedFor === pubkey) return;
  refreshedFor = pubkey;
  try {
    const entries = await collection.entries();
    const deckIds = (await decks.list()).flatMap(decks.activeIds);
    await scryfall.getCards([...entries.map((e) => e.scryfallId), ...deckIds], { refresh: true });
  } catch (err) {
    console.warn('price refresh failed', err);
  }
});

async function boot() {
  document.documentElement.dataset.theme = await getPref('theme', 'dark');
  mount(layout());
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('service worker failed', err));
  }
}

boot();
