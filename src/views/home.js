import { h } from '../dom.js';
import { on } from '../bus.js';
import * as account from '../account.js';
import * as collection from '../collection.js';
import * as decks from '../decks.js';
import * as locations from '../locations.js';
import * as scryfall from '../scryfall.js';
import * as sync from '../sync.js';
import { summarize } from '../collection-stats.js';
import { lockedBanner, loading, emptyState, firstSyncNotice } from '../components.js';
import { deckTile, newDeckTile } from './deck-tile.js';
import { collectionDashboard } from './dashboard.js';
import { deckPlan } from '../location-logic.js';
import { usd, timeAgo } from '../util.js';

const SET_TYPES = new Set(['expansion', 'core', 'masters', 'commander', 'draft_innovation', 'funny']);

function stat(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label));
}

async function latestReleases(ownedBySet) {
  const today = new Date().toISOString().slice(0, 10);
  const list = (await scryfall.sets())
    .filter((s) => SET_TYPES.has(s.set_type) && s.card_count >= 20 && s.released_at && s.released_at <= today)
    .sort((a, b) => b.released_at.localeCompare(a.released_at))
    .slice(0, 12);
  return h(
    'div',
    { class: 'set-row' },
    list.map((s) =>
      h(
        'a',
        { class: 'set-tile', href: `#/cards?q=${encodeURIComponent(`set:${s.code}`)}` },
        s.icon_svg_uri?.startsWith('https://svgs.scryfall.io/') ? h('img', { class: 'set-icon', src: s.icon_svg_uri, alt: '', width: 32, height: 32 }) : null,
        h('span', { class: 'set-name' }, s.name),
        h('span', { class: 'muted small' }, `${s.card_count} cards${ownedBySet.get(s.code) ? ` · own ${ownedBySet.get(s.code)}` : ''}`),
      ),
    ),
  );
}

export default async function homeView(root) {
  // Phase of the first-sync panel currently shown, or null when showing the normal page.
  let shownPhase = null;
  async function render() {
    root.replaceChildren(loading());
    const entries = await collection.entries();
    const deckList = await decks.list();
    if (!entries.length && !deckList.length && sync.firstPullPending()) {
      const fp = sync.getState().firstPull;
      shownPhase = fp?.phase ?? 'checking';
      root.replaceChildren(...[lockedBanner(), firstSyncNotice(fp, () => sync.syncNow())].filter(Boolean));
      return;
    }
    shownPhase = null;
    const cards = await scryfall.getCards([...entries.map((e) => e.scryfallId), ...deckList.flatMap(decks.activeIds)]);
    const ownedByOracle = await collection.ownedByOracle();
    const usedOracles = new Set(deckList.flatMap(decks.activeIds).map((id) => cards.get(id)?.oracle_id).filter(Boolean));
    const sum = summarize(entries, cards, usedOracles);
    const ownedBySet = new Map(sum.sets.map((x) => [x.code, x.qty]));
    let oldest = Infinity;
    for (const e of entries) oldest = Math.min(oldest, cards.get(e.scryfallId)?.fetchedAt ?? Infinity);
    const s = sync.getState();

    const collectionSection = entries.length
      ? h(
          'section',
          {},
          h('h2', {}, h('a', { class: 'heading-link', href: '#/collection' }, 'Collection', h('span', { class: 'chevron', 'aria-hidden': 'true' }, ' ›'))),
          h(
            'div',
            { class: 'stats' },
            stat('Cards', sum.total.toLocaleString()),
            stat('Unique names', sum.names.toLocaleString()),
            stat('Total value', sum.value >= 1000 ? `$${Math.round(sum.value).toLocaleString()}` : usd(sum.value)),
            stat('Average card', usd(sum.total ? sum.value / sum.total : 0)),
            stat('Foils', sum.foils.toLocaleString()),
            stat('Sets', sum.sets.length.toLocaleString()),
          ),
          collectionDashboard(sum, { location: await locations.lookup() }),
          h('p', { class: 'muted small' }, `Prices updated ${timeAgo(Number.isFinite(oldest) ? oldest : null)}.`),
        )
      : emptyState(
          'Import your collection',
          h('p', {}, 'Start by importing a collection CSV (CardCastle, Moxfield, ManaBox, and others work).'),
          h('a', { class: 'btn btn-primary', href: '#/collection/import' }, 'Import collection'),
        );

    root.replaceChildren(
      ...[
        lockedBanner(),
        collectionSection,
        h(
          'section',
          {},
          h('h2', {}, 'Recent decks'),
          h('div', { class: 'deck-grid' }, account.canEdit() ? newDeckTile() : null, deckList.slice(0, 4).map((d) => deckTile(d, cards, ownedByOracle, deckPlan(d, cards, entries)))),
          deckList.length ? null : h('p', { class: 'muted' }, 'No decks yet.'),
        ),
        h('section', {}, h('h2', {}, 'Latest releases'), await latestReleases(ownedBySet)),
        h('p', { class: 'muted small' }, `Last sync: ${timeAgo(s.lastSync)}`),
      ].filter(Boolean),
    );
  }
  await render();
  const offs = [
    on('collection', render),
    on('decks', render),
    on('locations', render),
    on('sync', (s) => shownPhase && shownPhase !== (s.firstPull?.phase ?? 'done') && render()),
  ];
  return () => offs.forEach((off) => off());
}
