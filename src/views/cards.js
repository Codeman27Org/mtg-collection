import { h } from '../dom.js';
import * as account from '../account.js';
import * as collection from '../collection.js';
import * as scryfall from '../scryfall.js';
import { cardTile, context, addCard } from '../cardui.js';
import { applyFilter } from '../collection-filter.js';
import { action, toast, loading } from '../components.js';
import { COLORS, COLOR_NAMES, FORMATS, FORMAT_LABELS, RARITIES } from '../constants.js';
import { scryfallFormatQuery } from '../formats.js';
import { TYPE_ORDER } from '../card-utils.js';

const state = {
  q: '',
  colors: [],
  format: '',
  type: '',
  rarity: '',
  set: '',
  oracle: '',
  cmcMin: '',
  cmcMax: '',
  priceMin: '',
  priceMax: '',
  powMin: '',
  touMin: '',
  sort: 'edhrec',
  ownedOnly: false,
};

const SORTS = {
  edhrec: ['edhrec', 'auto', 'Popular (EDHREC)'],
  name: ['name', 'asc', 'Name A–Z'],
  usdAsc: ['usd', 'asc', 'Price ↑'],
  usdDesc: ['usd', 'desc', 'Price ↓'],
  released: ['released', 'desc', 'Newest'],
};

const quote = (s) => (/\s/.test(s) ? `"${s.replace(/"/g, '')}"` : s);

export function buildQuery(st) {
  const parts = [];
  if (st.q.trim()) parts.push(st.q.trim());
  if (st.colors.length) parts.push(st.colors.includes('C') ? 'c:c' : `c:${st.colors.join('').toLowerCase()}`);
  if (st.format) parts.push(scryfallFormatQuery(st.format));
  if (st.type) parts.push(`t:${st.type.toLowerCase()}`);
  if (st.rarity) parts.push(`r:${st.rarity}`);
  if (st.set.trim()) parts.push(`s:${st.set.trim().toLowerCase()}`);
  if (st.oracle.trim()) parts.push(`o:${quote(st.oracle.trim())}`);
  if (st.cmcMin !== '') parts.push(`mv>=${Number(st.cmcMin)}`);
  if (st.cmcMax !== '') parts.push(`mv<=${Number(st.cmcMax)}`);
  if (st.priceMin !== '') parts.push(`usd>=${Number(st.priceMin)}`);
  if (st.priceMax !== '') parts.push(`usd<=${Number(st.priceMax)}`);
  if (st.powMin !== '') parts.push(`pow>=${Number(st.powMin)}`);
  if (st.touMin !== '') parts.push(`tou>=${Number(st.touMin)}`);
  return parts.join(' ') || 'game:paper';
}

export default async function cardsView(root, { query }) {
  if (query.get('q') != null) state.q = query.get('q');
  const results = h('div', { class: 'card-grid' });
  const summary = h('div', { class: 'summary muted' });
  const more = h('div', { class: 'row center' });
  let page = 1;
  let ownedById = new Map();

  async function loadOwned() {
    if (account.current()) ownedById = await collection.ownedById();
  }

  function tile(card) {
    const owned = ownedById.get(card.id)?.total;
    const quick =
      account.canEdit() && context.deckId
        ? h(
            'button',
            {
              class: 'btn btn-small',
              type: 'button',
              title: `Add to ${context.deckName}`,
              onclick: action(async () => {
                await addCard({ target: { deckId: context.deckId }, scryfallId: card.id });
                toast(`Added ${card.name} to ${context.deckName}`);
              }),
            },
            `+ ${context.deckName}`,
          )
        : null;
    return cardTile(card, { owned, actions: quick });
  }

  async function run(reset = true) {
    if (reset) {
      page = 1;
      results.replaceChildren(loading('Searching…'));
    }
    more.replaceChildren();
    try {
      if (state.ownedOnly) {
        const entries = await collection.entries();
        const cards = await collection.cardsFor(entries);
        const filtered = applyFilter(entries, cards, {
          text: state.q,
          colors: state.colors,
          type: state.type,
          rarity: state.rarity,
          set: state.set.trim().toLowerCase(),
          cmcMin: state.cmcMin,
          cmcMax: state.cmcMax,
          priceMin: state.priceMin,
          priceMax: state.priceMax,
        });
        const unique = [...new Map(filtered.map((e) => [e.scryfallId, cards.get(e.scryfallId)])).values()].filter(Boolean);
        unique.sort((a, b) => a.name.localeCompare(b.name));
        summary.textContent = `${unique.length} owned printings`;
        results.replaceChildren(...unique.map(tile));
        return;
      }
      const [order, dir] = SORTS[state.sort];
      const q = buildQuery(state);
      const res = await scryfall.search(q, { page, order, dir });
      if (reset) results.replaceChildren();
      summary.textContent = `${res.total.toLocaleString()} cards · ${q}`;
      results.append(...res.cards.map(tile));
      if (!res.total) results.replaceChildren(h('p', { class: 'muted' }, 'No cards found.'));
      if (res.hasMore) {
        more.replaceChildren(
          h('button', { class: 'btn', type: 'button', onclick: action(async () => { page++; await run(false); }) }, 'Load more'),
        );
      }
    } catch (err) {
      results.replaceChildren(h('div', { class: 'banner banner-error' }, err.message));
    }
  }

  const bind = (key, attrs = {}) =>
    h('input', { ...attrs, value: state[key], onchange: (e) => { state[key] = e.target.value; run(); } });
  const pick = (key, options, label) =>
    h(
      'select',
      { 'aria-label': label, onchange: (e) => { state[key] = e.target.value; run(); } },
      options.map(([v, l]) => h('option', { value: v, selected: state[key] === v }, l)),
    );

  const filters = h(
    'aside',
    { class: 'filters' },
    h('h3', {}, 'Filters'),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'field-label' }, 'Colors'),
      h(
        'div',
        { class: 'color-checks' },
        [...COLORS, 'C'].map((c) =>
          h(
            'label',
            { class: `color-check pip-${c}`, title: COLOR_NAMES[c] },
            h('input', {
              type: 'checkbox',
              checked: state.colors.includes(c),
              onchange: (e) => {
                const set = new Set(state.colors);
                e.target.checked ? set.add(c) : set.delete(c);
                state.colors = [...set];
                run();
              },
            }),
            c,
          ),
        ),
      ),
    ),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Format'), pick('format', [['', 'All'], ...FORMATS.map((f) => [f, FORMAT_LABELS[f]])], 'Format')),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Type'), pick('type', [['', 'Any'], ...TYPE_ORDER.filter((t) => t !== 'Other').map((t) => [t, t])], 'Type')),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Rarity'), pick('rarity', [['', 'Any'], ...RARITIES.slice(0, 4).map((r) => [r, r])], 'Rarity')),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Mana value'), h('div', { class: 'row' }, bind('cmcMin', { type: 'number', min: 0, placeholder: 'min', 'aria-label': 'Minimum mana value' }), bind('cmcMax', { type: 'number', min: 0, placeholder: 'max', 'aria-label': 'Maximum mana value' }))),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Price (USD)'), h('div', { class: 'row' }, bind('priceMin', { type: 'number', min: 0, step: '0.01', placeholder: 'min', 'aria-label': 'Minimum price' }), bind('priceMax', { type: 'number', min: 0, step: '0.01', placeholder: 'max', 'aria-label': 'Maximum price' }))),
    h(
      'details',
      {},
      h('summary', {}, 'More filters'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Set code'), bind('set', { type: 'text', placeholder: 'e.g. mh3' })),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Rules text'), bind('oracle', { type: 'text', placeholder: 'e.g. draw a card' })),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Power / toughness at least'), h('div', { class: 'row' }, bind('powMin', { type: 'number', placeholder: 'pow', 'aria-label': 'Minimum power' }), bind('touMin', { type: 'number', placeholder: 'tou', 'aria-label': 'Minimum toughness' }))),
    ),
    account.current()
      ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.ownedOnly, onchange: async (e) => { state.ownedOnly = e.target.checked; run(); } }), ' Owned only')
      : null,
  );

  const searchInput = h('input', {
    type: 'search',
    class: 'grow',
    value: state.q,
    placeholder: 'Scryfall search, e.g. t:dragon id<=rg',
    'aria-label': 'Card search',
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        state.q = searchInput.value;
        run();
      }
    },
  });

  root.append(
    h('h1', {}, 'Cards'),
    h(
      'div',
      { class: 'browser' },
      filters,
      h(
        'div',
        { class: 'browser-main' },
        h(
          'div',
          { class: 'toolbar' },
          searchInput,
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { state.q = searchInput.value; run(); } }, 'Search'),
          h(
            'select',
            { 'aria-label': 'Sort', onchange: (e) => { state.sort = e.target.value; run(); } },
            Object.entries(SORTS).map(([k, [, , label]]) => h('option', { value: k, selected: state.sort === k }, label)),
          ),
          h('button', { class: 'btn filters-toggle', type: 'button', onclick: () => filters.classList.toggle('open') }, 'Filters'),
        ),
        h('h2', { class: 'section-title' }, state.q ? 'Results' : 'Popular Cards'),
        summary,
        results,
        more,
      ),
    ),
  );
  await loadOwned();
  run();
}
