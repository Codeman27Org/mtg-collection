import { h } from '../dom.js';
import { cardTile, openCardModal } from '../cardui.js';
import { cardPrice, colorsOf, primaryType, TYPE_ORDER } from '../card-utils.js';
import { applyFilter, DEFAULT_FILTER } from '../collection-filter.js';
import { locationToken } from '../location-logic.js';
import { manaCost } from '../mana.js';
import { COLORS, COLOR_NAMES, RARITIES } from '../constants.js';
import { usd, groupBy } from '../util.js';

const CHUNK = 240;
let radioGroupId = 0;
const RARITY_RANK = Object.fromEntries(RARITIES.map((r, i) => [r, i]));

const SORTS = {
  name: (a, b) => a.card.name.localeCompare(b.card.name),
  price: (a, b) => b.price - a.price,
  total: (a, b) => b.price * b.qty - a.price * a.qty,
  qty: (a, b) => b.qty - a.qty,
  cmc: (a, b) => (a.card.cmc ?? 0) - (b.card.cmc ?? 0),
  set: (a, b) => a.card.set_name.localeCompare(b.card.set_name) || a.card.collector_number.localeCompare(b.card.collector_number, undefined, { numeric: true }),
  rarity: (a, b) => (RARITY_RANK[b.card.rarity] ?? 0) - (RARITY_RANK[a.card.rarity] ?? 0),
};

const colorGroup = (card) => {
  const c = colorsOf(card);
  return c.length === 0 ? 'Colorless' : c.length > 1 ? 'Multicolor' : COLOR_NAMES[c[0]];
};
const GROUPS = {
  none: null,
  set: (x) => x.card.set_name,
  color: (x) => colorGroup(x.card),
  type: (x) => primaryType(x.card),
  rarity: (x) => x.card.rarity,
};

/** Persisted per page so filters survive navigation. */
export function browserState() {
  return { filter: structuredClone(DEFAULT_FILTER), view: 'grid', sort: 'name', group: 'none' };
}

/**
 * options: { state, readOnly, usedOracles, ownedOverlay (Map oracle → qty), onAdjust(entry, delta), withLocations }
 * Returns { el, setData(entries, cards), setLocations(list, lookup), filtered(), destroy() }.
 */
export function collectionBrowser(options) {
  const { state, readOnly, usedOracles, ownedOverlay, onAdjust, withLocations } = options;
  let entries = [];
  let cards = new Map();
  let observer = null;
  let filtered = [];
  let locationLabel = () => '';
  let locationArgs = null;
  const locationSelect = h('select', { 'aria-label': 'Location', onchange: (e) => setFilter('location', e.target.value) });

  const results = h('div', { class: 'results' });
  const summary = h('div', { class: 'summary muted' });
  const statsBox = h('details', { class: 'stats-details' });
  const setSelect = h('select', { 'aria-label': 'Set', onchange: (e) => setFilter('set', e.target.value) });

  function setFilter(key, value) {
    state.filter[key] = value;
    update();
  }

  const input = (key, attrs) =>
    h('input', { ...attrs, value: state.filter[key], oninput: (e) => setFilter(key, e.target.value) });
  const select = (key, opts, label) =>
    h(
      'select',
      { 'aria-label': label, onchange: (e) => setFilter(key, e.target.value) },
      opts.map(([v, l]) => h('option', { value: v, selected: state.filter[key] === v }, l)),
    );

  function deckUseField() {
    const name = `deck-use-${++radioGroupId}`;
    const current = state.filter.used ? 'used' : state.filter.unused ? 'unused' : 'any';
    return h(
      'div',
      { class: 'field', role: 'radiogroup', 'aria-label': 'Decks' },
      h('span', { class: 'field-label' }, 'Decks'),
      [['any', 'Any'], ['used', 'In a deck'], ['unused', 'Not in any deck']].map(([v, l]) =>
        h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'radio',
            name,
            checked: v === current,
            onchange: () => {
              state.filter.used = v === 'used';
              state.filter.unused = v === 'unused';
              update();
            },
          }),
          ` ${l}`,
        ),
      ),
    );
  }

  const colorChecks = h(
    'div',
    { class: 'color-checks', role: 'group', 'aria-label': 'Colors' },
    [...COLORS, 'C'].map((c) =>
      h(
        'label',
        { class: `color-check pip-${c}`, title: COLOR_NAMES[c] },
        h('input', {
          type: 'checkbox',
          checked: state.filter.colors.includes(c),
          onchange: (e) => {
            const set = new Set(state.filter.colors);
            e.target.checked ? set.add(c) : set.delete(c);
            setFilter('colors', [...set]);
          },
        }),
        c,
      ),
    ),
  );

  const filters = h(
    'aside',
    { class: 'filters' },
    h('h3', {}, 'Filters'),
    withLocations ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Location'), locationSelect) : null,
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Colors'), colorChecks),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Type'), select('type', [['', 'Any'], ...TYPE_ORDER.filter((t) => t !== 'Other').map((t) => [t, t])], 'Type')),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Rarity'), select('rarity', [['', 'Any'], ...RARITIES.slice(0, 4).map((r) => [r, r])], 'Rarity')),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Set'), setSelect),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'field-label' }, 'Mana value'),
      h('div', { class: 'row' }, input('cmcMin', { type: 'number', min: 0, placeholder: 'min', 'aria-label': 'Minimum mana value' }), input('cmcMax', { type: 'number', min: 0, placeholder: 'max', 'aria-label': 'Maximum mana value' })),
    ),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Finish'), select('finish', [['', 'Any'], ['nonfoil', 'Nonfoil'], ['foil', 'Foil'], ['etched', 'Etched']], 'Finish')),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'field-label' }, 'Price (USD)'),
      h('div', { class: 'row' }, input('priceMin', { type: 'number', min: 0, step: '0.01', placeholder: 'min', 'aria-label': 'Minimum price' }), input('priceMax', { type: 'number', min: 0, step: '0.01', placeholder: 'max', 'aria-label': 'Maximum price' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.filter.unpriced, onchange: (e) => setFilter('unpriced', e.target.checked) }), ' No price on Scryfall'),
    ),
    usedOracles ? deckUseField() : null,
    h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: () => {
          observer?.disconnect();
          state.filter = structuredClone(DEFAULT_FILTER);
          // Rebuild so every input shows its reset value; the caller keeps the same api object.
          const fresh = collectionBrowser(options);
          el.replaceWith(fresh.el);
          if (locationArgs) fresh.setLocations(...locationArgs);
          fresh.setData(entries, cards);
          Object.assign(api, fresh);
        },
      },
      'Reset filters',
    ),
  );

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    input('text', { type: 'search', placeholder: 'Filter by name, type, or text…', 'aria-label': 'Filter collection', class: 'grow' }),
    h(
      'select',
      { 'aria-label': 'Sort', onchange: (e) => ((state.sort = e.target.value), update()) },
      [['name', 'Name'], ['price', 'Price'], ['total', 'Stack value'], ['qty', 'Quantity'], ['cmc', 'Mana value'], ['set', 'Set'], ['rarity', 'Rarity']].map(([v, l]) =>
        h('option', { value: v, selected: state.sort === v }, `Sort: ${l}`),
      ),
    ),
    h(
      'select',
      { 'aria-label': 'Group', onchange: (e) => ((state.group = e.target.value), update()) },
      [['none', 'No grouping'], ...(withLocations ? [['location', 'Group: Location']] : []), ['set', 'Group: Set'], ['color', 'Group: Color'], ['type', 'Group: Type'], ['rarity', 'Group: Rarity']].map(([v, l]) =>
        h('option', { value: v, selected: state.group === v }, l),
      ),
    ),
    h(
      'div',
      { class: 'seg', role: 'group', 'aria-label': 'View' },
      ['grid', 'table'].map((v) =>
        h('button', { type: 'button', class: state.view === v ? 'active' : '', onclick: (e) => { state.view = v; for (const b of e.currentTarget.parentNode.children) b.classList.toggle('active', b === e.currentTarget); update(); } }, v === 'grid' ? 'Grid' : 'Table'),
      ),
    ),
    h('button', { class: 'btn filters-toggle', type: 'button', onclick: () => filters.classList.toggle('open') }, 'Filters'),
  );

  const el = h('div', { class: 'browser' }, filters, h('div', { class: 'browser-main' }, toolbar, summary, statsBox, results));

  function tileActions(x) {
    if (readOnly || !onAdjust) return null;
    return [
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove one ${x.card.name}`, onclick: () => onAdjust(x.entry, -1) }, '−'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Add one ${x.card.name}`, onclick: () => onAdjust(x.entry, 1) }, '+'),
    ];
  }

  const overlay = (x) => (ownedOverlay ? ownedOverlay.get(x.card.oracle_id) ?? 0 : null);

  function gridItem(x) {
    const where = withLocations && x.entry.location ? h('div', { class: 'tile-location small', title: 'Location' }, locationLabel(x.entry.location)) : null;
    return () =>
      cardTile(x.card, { qty: x.qty, finish: x.entry.finish, owned: overlay(x), onOpen: openCardModal, actions: tileActions(x), extra: where });
  }

  function tableRow(x) {
    return () =>
      h(
        'tr',
        {},
        h('td', { class: 'num' }, String(x.qty)),
        h('td', {}, h('button', { class: 'link-btn', type: 'button', onclick: () => openCardModal(x.card) }, x.card.name)),
        h('td', {}, manaCost(x.card.mana_cost ?? '')),
        h('td', {}, x.card.set.toUpperCase()),
        h('td', {}, x.card.collector_number),
        h('td', {}, x.entry.finish),
        withLocations ? h('td', { class: 'small' }, locationLabel(x.entry.location)) : null,
        h('td', {}, x.card.rarity),
        h('td', { class: 'small' }, x.card.type_line),
        h('td', { class: 'num' }, usd(x.price)),
        h('td', { class: 'num' }, usd(x.price * x.qty)),
        ownedOverlay ? h('td', { class: 'num' }, String(overlay(x))) : null,
        !readOnly && onAdjust ? h('td', { class: 'row' }, tileActions(x)) : null,
      );
  }

  function chunked(container, thunks) {
    observer?.disconnect();
    let i = 0;
    const sentinel = h('div', { class: 'sentinel', 'aria-hidden': 'true' });
    const next = () => {
      const frag = document.createDocumentFragment();
      const end = Math.min(i + CHUNK, thunks.length);
      for (; i < end; i++) frag.append(thunks[i]());
      container.append(frag);
      if (i < thunks.length) (container.tagName === 'TBODY' ? container.parentNode.parentNode : container).append(sentinel);
      else sentinel.remove();
    };
    observer = new IntersectionObserver((obs) => {
      if (obs.some((o) => o.isIntersecting)) {
        sentinel.remove();
        next();
      }
    }, { rootMargin: '800px' });
    observer.observe(sentinel);
    next();
  }

  function renderStats(list) {
    const bySet = [...groupBy(list, (x) => x.card.set_name)].map(([name, xs]) => [name, xs.reduce((n, x) => n + x.price * x.qty, 0)]).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const top = [...list].sort((a, b) => b.price - a.price).slice(0, 20);
    statsBox.replaceChildren(
      h('summary', {}, 'Stats: value by set and most valuable cards'),
      h(
        'div',
        { class: 'stats-cols' },
        h('div', {}, h('h4', {}, 'Value by set (top 10)'), h('ol', {}, bySet.map(([name, v]) => h('li', {}, `${name}: ${usd(v)}`)))),
        h('div', {}, h('h4', {}, 'Most valuable (top 20)'), h('ol', {}, top.map((x) => h('li', {}, h('button', { class: 'link-btn', type: 'button', onclick: () => openCardModal(x.card) }, x.card.name), ` ${x.entry.finish === 'foil' ? '(foil) ' : ''}${usd(x.price)}`)))),
      ),
    );
  }

  function update() {
    filtered = applyFilter(entries, cards, state.filter, usedOracles);
    const list = filtered
      .map((entry) => {
        const card = cards.get(entry.scryfallId);
        return card ? { entry, card, qty: entry.qty, price: cardPrice(card, entry.finish) ?? 0 } : null;
      })
      .filter(Boolean)
      .sort(SORTS[state.sort] ?? SORTS.name);

    const count = list.reduce((n, x) => n + x.qty, 0);
    const value = list.reduce((n, x) => n + x.price * x.qty, 0);
    summary.textContent = `${count.toLocaleString()} cards · ${list.length.toLocaleString()} printings · ${usd(value)}`;
    renderStats(list);

    const groupFn = state.group === 'location' ? (x) => locationLabel(x.entry.location) : GROUPS[state.group];
    const groups = groupFn ? [...groupBy(list, groupFn)].sort((a, b) => String(a[0]).localeCompare(String(b[0]))) : [[null, list]];

    if (state.view === 'table') {
      const tbody = h('tbody');
      const thunks = [];
      for (const [name, xs] of groups) {
        if (name != null) thunks.push(() => h('tr', { class: 'group-row' }, h('th', { colspan: 14 }, `${name} (${xs.reduce((n, x) => n + x.qty, 0)})`)));
        thunks.push(...xs.map(tableRow));
      }
      results.replaceChildren(
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'data-table' },
            h('thead', {}, h('tr', {}, ['Qty', 'Name', 'Cost', 'Set', '#', 'Finish', withLocations ? 'Location' : null, 'Rarity', 'Type', 'Price', 'Total', ownedOverlay ? 'You own' : null, !readOnly && onAdjust ? '' : null].filter((c) => c != null).map((c) => h('th', {}, c)))),
            tbody,
          ),
        ),
      );
      chunked(tbody, thunks);
    } else {
      const grid = h('div', { class: 'card-grid' });
      const thunks = [];
      for (const [name, xs] of groups) {
        if (name != null) thunks.push(() => h('h3', { class: 'group-head' }, `${name} (${xs.reduce((n, x) => n + x.qty, 0)})`));
        thunks.push(...xs.map(gridItem));
      }
      results.replaceChildren(grid);
      chunked(grid, thunks);
    }
    if (!list.length) results.replaceChildren(h('p', { class: 'muted' }, entries.length ? 'No cards match these filters.' : 'No cards yet.'));
  }

  const api = {
    el,
    setData(newEntries, newCards) {
      entries = newEntries;
      cards = newCards;
      const sets = [...new Map([...cards.values()].map((c) => [c.set, c.set_name]))].sort((a, b) => a[1].localeCompare(b[1]));
      setSelect.replaceChildren(h('option', { value: '' }, 'Any'), ...sets.map(([code, name]) => h('option', { value: code, selected: state.filter.set === code }, name)));
      update();
    },
    /** list: [{ id, name, kind }] from locations.all(); lookup: id → { name, kind }. */
    setLocations(list, lookup) {
      locationArgs = [list, lookup];
      locationLabel = (id) => (lookup(id).kind === 'deck' ? `Deck: ${lookup(id).name}` : lookup(id).name);
      locationSelect.replaceChildren(
        h('option', { value: '' }, 'Any'),
        ...list.map((l) => h('option', { value: locationToken(l.id), selected: state.filter.location === locationToken(l.id) }, locationLabel(l.id))),
      );
      if (entries.length) update();
    },
    filtered: () => filtered,
    destroy() {
      observer?.disconnect();
    },
  };
  return api;
}
