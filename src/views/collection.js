import { h } from '../dom.js';
import { on } from '../bus.js';
import * as account from '../account.js';
import * as collection from '../collection.js';
import * as decks from '../decks.js';
import { getCards } from '../scryfall.js';
import { lockedBanner, loading, emptyState, firstSyncNotice, action, toast } from '../components.js';
import { navigate } from '../router.js';
import * as sync from '../sync.js';
import { collectionBrowser, browserState } from './collection-browser.js';
import { openShareDialog } from './share-dialog.js';
import { openBulkMoveDialog } from './location-ui.js';
import * as locations from '../locations.js';
import { DEFAULT_FILTER } from '../collection-filter.js';

const state = browserState();

/** Filters from links like #/collection?set=m13 or ?colors=R,G replace the current ones. */
function filterFromQuery(query) {
  const keys = Object.keys(DEFAULT_FILTER).filter((k) => query?.has(k));
  if (!keys.length) return null;
  const filter = structuredClone(DEFAULT_FILTER);
  for (const k of keys) {
    const v = query.get(k);
    if (k === 'colors') filter.colors = v.split(',').filter(Boolean);
    else if (k === 'unused' || k === 'used' || k === 'unpriced') filter[k] = v === '1' || v === 'true';
    else filter[k] = v;
  }
  return filter;
}

async function usedOracleSet() {
  const list = await decks.list();
  const cards = await getCards(list.flatMap(decks.activeIds));
  return new Set(
    list.flatMap((d) => decks.activeIds(d)).map((id) => cards.get(id)?.oracle_id).filter(Boolean),
  );
}

export default async function collectionView(root, { query } = {}) {
  const linked = filterFromQuery(query);
  if (linked) state.filter = linked;
  const moveBtn = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      hidden: true,
      onclick: action(async () => {
        const shown = browser?.filtered() ?? [];
        if (!shown.length) throw new Error('No cards match the current filters.');
        await openBulkMoveDialog(shown);
      }),
    },
    'Move shown…',
  );
  let browser = null;
  const header = h(
    'div',
    { class: 'page-head' },
    h('h1', {}, 'Collection'),
    h(
      'div',
      { class: 'row wrap' },
      h('a', { class: 'btn', href: '#/locations' }, 'Locations'),
      account.canEdit() ? moveBtn : null,
      account.canEdit() ? h('a', { class: 'btn', href: '#/scan' }, 'Scan') : null,
      account.canEdit() ? h('a', { class: 'btn', href: '#/collection/import' }, 'Import') : null,
      account.canEdit()
        ? h('button', { class: 'btn', type: 'button', onclick: action(() => openShareDialog({ type: 'collection', title: 'Collection', filter: state.filter })) }, 'Share')
        : null,
    ),
  );
  const body = h('div', {}, loading('Loading collection…'));
  root.append(...[lockedBanner(), header, body].filter(Boolean));

  let entries = await collection.entries();
  if (!entries.length && sync.firstPullPending()) {
    let phase = sync.getState().firstPull?.phase;
    body.replaceChildren(firstSyncNotice(sync.getState().firstPull, () => sync.syncNow()));
    const offs = [
      on('collection', () => navigate('/collection')),
      on('sync', (s) => {
        if (!sync.firstPullPending()) return navigate('/collection');
        if (s.firstPull?.phase === phase) return;
        phase = s.firstPull?.phase;
        body.replaceChildren(firstSyncNotice(s.firstPull, () => sync.syncNow()));
      }),
    ];
    return () => offs.forEach((off) => off());
  }
  if (!entries.length) {
    body.replaceChildren(
      emptyState('No cards yet', h('p', {}, 'Import a collection CSV to get started.'), h('a', { class: 'btn btn-primary', href: '#/collection/import' }, 'Import collection')),
    );
    return on('collection', () => navigate('/collection'));
  }

  let cards = await collection.cardsFor(entries, {
    onProgress: (done, total) => body.replaceChildren(loading(`Loading card data… ${done}/${total}`)),
  });
  browser = collectionBrowser({
    state,
    readOnly: !account.canEdit(),
    usedOracles: await usedOracleSet(),
    withLocations: true,
    onAdjust: (entry, delta) =>
      collection.adjust(entry.scryfallId, entry.finish, delta, entry).catch((err) => toast(err.message, 'error')),
  });
  const refreshLocations = async () => browser.setLocations(await locations.all(), await locations.lookup());
  await refreshLocations();
  body.replaceChildren(browser.el);
  browser.setData(entries, cards);
  moveBtn.hidden = false;

  const offs = [
    on('collection', async () => {
      entries = await collection.entries();
      cards = await collection.cardsFor(entries);
      browser.setData(entries, cards);
    }),
    on('locations', refreshLocations),
    on('decks', refreshLocations),
  ];
  return () => {
    offs.forEach((off) => off());
    browser.destroy();
  };
}
