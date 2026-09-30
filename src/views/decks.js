import { h } from '../dom.js';
import { on } from '../bus.js';
import * as account from '../account.js';
import * as collection from '../collection.js';
import * as decks from '../decks.js';
import { getCards } from '../scryfall.js';
import { lockedBanner, loading, emptyState, dropdown, firstSyncNotice, cardDataLoading, loadError } from '../components.js';
import { deckTile, assemblyStatus } from './deck-tile.js';
import { deckPlan } from '../location-logic.js';
import { deckStats } from '../analytics.js';
import { deckCreatedAt } from '../merge.js';
import * as sync from '../sync.js';

const FILTERS = [
  ['all', 'All'],
  ['assembled', 'Assembled'],
  ['progress', 'In progress'],
];
const SORTS = {
  recent: ['Recently edited', (a, b) => (b.deck.touchedAt ?? 0) - (a.deck.touchedAt ?? 0)],
  value: ['Value: high to low', (a, b) => b.price - a.price],
  added: ['Date added: newest first', (a, b) => b.createdAt - a.createdAt],
  name: ['Name: A to Z', (a, b) => a.deck.name.localeCompare(b.deck.name, undefined, { numeric: true, sensitivity: 'base' })],
};
let filter = 'all';
let sort = 'recent';

export default async function decksView(root) {
  const body = h('div', {}, loading());
  root.append(
    ...[
      lockedBanner(),
      h('div', { class: 'page-head' }, h('h1', {}, 'Decks'), account.canEdit() ? h('a', { class: 'btn btn-primary', href: '#/decks/new' }, 'New deck') : null),
      body,
    ].filter(Boolean),
  );

  let shownPhase = null;
  let drawing = null;
  let redraw = false;
  function render() {
    if (drawing) {
      redraw = true;
      return drawing;
    }
    drawing = draw()
      .catch((err) => {
        console.error('decks failed to load', err);
        body.replaceChildren(loadError(err, render));
      })
      .finally(() => {
        drawing = null;
        if (redraw) {
          redraw = false;
          render();
        }
      });
    return drawing;
  }
  async function draw() {
    const list = await decks.list();
    if (!list.length && sync.firstPullPending()) {
      const fp = sync.getState().firstPull;
      shownPhase = fp?.phase ?? 'checking';
      body.replaceChildren(firstSyncNotice(fp, () => sync.syncNow()));
      return;
    }
    shownPhase = null;
    if (!list.length) {
      body.replaceChildren(
        emptyState('No decks yet', account.canEdit() ? h('a', { class: 'btn btn-primary', href: '#/decks/new' }, 'Create your first deck') : null),
      );
      return;
    }
    const entries = await collection.entries();
    const cards = await getCards([...list.flatMap(decks.activeIds), ...entries.map((e) => e.scryfallId)], {
      onProgress: (done, total, paused) => body.replaceChildren(cardDataLoading(done, total, paused)),
    });
    const owned = await collection.ownedByOracle();
    const items = list.map((deck) => {
      const plan = deckPlan(deck, cards, entries);
      return { deck, plan, status: assemblyStatus(plan), price: deckStats(deck, cards).price, createdAt: deckCreatedAt(deck) };
    });
    const count = (key) => (key === 'all' ? items.length : items.filter((x) => x.status === key).length);
    const shown = items.filter((x) => filter === 'all' || x.status === filter).sort(SORTS[sort][1]);
    const filterBar = h(
      'div',
      { class: 'seg', role: 'group', 'aria-label': 'Show decks' },
      FILTERS.map(([key, label]) =>
        h(
          'button',
          {
            type: 'button',
            class: key === filter ? 'active' : '',
            'aria-pressed': String(key === filter),
            onclick: () => {
              filter = key;
              render();
            },
          },
          `${label} (${count(key)})`,
        ),
      ),
    );
    const sortMenu = dropdown(
      Object.entries(SORTS).map(([key, [label]]) => [key, `Sort: ${label}`]),
      sort,
      (v) => {
        sort = v;
        render();
      },
      { label: 'Sort decks' },
    );
    body.replaceChildren(
      h('div', { class: 'row wrap between deck-filters' }, filterBar, sortMenu),
      shown.length
        ? h('div', { class: 'deck-grid' }, shown.map((x) => deckTile(x.deck, cards, owned, x.plan)))
        : h('p', { class: 'muted' }, filter === 'assembled' ? 'No decks are fully assembled yet. Use “Pull cards” in a deck.' : 'Every deck is assembled.'),
    );
  }
  await render();
  const offs = [
    on('decks', render),
    on('collection', render),
    on('locations', render),
    on('sync', (s) => shownPhase && shownPhase !== (s.firstPull?.phase ?? 'done') && render()),
  ];
  return () => offs.forEach((off) => off());
}
