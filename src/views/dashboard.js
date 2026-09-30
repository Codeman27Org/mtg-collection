import { h } from '../dom.js';
import { cardImg, openCardModal } from '../cardui.js';
import { colorDonut, hBars, manaCurveChart } from '../charts.js';
import { COLOR_KEYS } from '../collection-stats.js';
import { locationToken } from '../location-logic.js';
import { COLOR_NAMES, FORMAT_LABELS } from '../constants.js';
import { usd } from '../util.js';

const money = (n) => (n >= 1000 ? `$${Math.round(n).toLocaleString()}` : usd(n));
const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '0%');
const RARITY_LABELS = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', mythic: 'Mythic' };

/** Link to the collection page with a filter applied (see collection view). */
export const collectionHref = (filter) => `#/collection?${new URLSearchParams(filter)}`;

function panel(title, ...children) {
  return h('section', { class: 'dash-panel' }, h('h3', {}, title), ...children);
}

function widePanel(title, ...children) {
  const el = panel(title, ...children);
  el.classList.add('dash-wide');
  return el;
}

function note(...children) {
  return h('p', { class: 'dash-note muted small' }, ...children);
}

function valuePanel(sum) {
  return panel(
    'Where the value is',
    hBars(
      sum.tiers.map((t) => [t.label, t.qty, t]),
      {
        wide: true,
        classFor: () => 'fill-accent',
        format: (qty, t) => `${qty.toLocaleString()} · ${money(t.value)}`,
        hrefFor: (_, t) => (t.qty ? collectionHref({ priceMin: t.min, ...(t.max != null && { priceMax: t.max }) }) : null),
      },
    ),
    note(`Your 10 most valuable cards are ${pct(sum.topShare, 1)} of the total value.`),
    sum.foils ? note(`${sum.foils.toLocaleString()} foils worth ${money(sum.foilValue)}.`) : null,
    sum.unpriced
      ? note(
          h('a', { href: collectionHref({ unpriced: 1 }) }, `${sum.unpriced.toLocaleString()} ${sum.unpriced === 1 ? 'card has' : 'cards have'} no price`),
          ' on Scryfall and count as $0.',
        )
      : null,
  );
}

const MAX_LOCATION_ROWS = 10;

function locationsPanel(sum, location) {
  let rows = sum.locations.map((l) => {
    const info = location(l.id);
    return [info.name, l.value, { ...l, kind: info.kind, format: info.format }];
  });
  // sum.locations is sorted by value, so everything past the top 9 folds into one "Other" bar.
  if (rows.length > MAX_LOCATION_ROWS) {
    const rest = rows.slice(MAX_LOCATION_ROWS - 1);
    const other = {
      kind: 'other',
      count: rest.length,
      qty: rest.reduce((s, [, , l]) => s + l.qty, 0),
      value: rest.reduce((s, [, , l]) => s + l.value, 0),
    };
    rows = [...rows.slice(0, MAX_LOCATION_ROWS - 1), [`Other (${other.count} locations)`, other.value, other]];
  }
  const kindClass = { deck: 'fill-loc-deck', binder: 'fill-accent', unsorted: 'fill-muted', other: 'fill-loc-other' };
  const inDecks = sum.locations.filter((l) => location(l.id).kind === 'deck').reduce((s, l) => s + l.value, 0);
  const legend = [['fill-accent', 'Binders & boxes'], ['fill-loc-deck', 'Decks'], ['fill-muted', 'Unsorted']];
  if (rows.some(([, , l]) => l.kind === 'other')) legend.push(['fill-loc-other', 'Other decks, binders & boxes']);
  return widePanel(
    'Value by location',
    h(
      'ul',
      { class: 'legend legend-row' },
      legend.map(([cls, label]) => h('li', {}, h('span', { class: `swatch ${cls}` }), label)),
    ),
    hBars(rows, {
      wide: true,
      classFor: (_, l) => kindClass[l.kind],
      format: (_, l) => `${l.qty.toLocaleString()} · ${money(l.value)}`,
      hrefFor: (_, l) => (l.kind === 'other' ? '#/locations' : collectionHref({ location: locationToken(l.id) })),
      tagFor: (_, l) => (l.kind === 'deck' && l.format ? FORMAT_LABELS[l.format] : null),
    }),
    note(
      `${money(inDecks)} (${pct(inDecks, sum.value)}) is in decks. `,
      h('a', { href: '#/locations' }, 'Manage locations'),
    ),
  );
}

function topCardsPanel(sum) {
  return widePanel(
    'Most valuable',
    h(
      'div',
      { class: 'top-cards' },
      sum.top.map((x) =>
        h(
          'button',
          { type: 'button', class: 'top-card', onclick: () => openCardModal(x.card), title: `${x.card.name} (${x.card.set_name})` },
          cardImg(x.card, 'small'),
          h('span', { class: 'price' }, `${usd(x.price)}${x.finish !== 'nonfoil' ? ` ${x.finish}` : ''}${x.qty > 1 ? ` ×${x.qty}` : ''}`),
        ),
      ),
    ),
  );
}

function colorPanel(sum) {
  const counts = Object.fromEntries(COLOR_KEYS.map((k) => [k, sum.colors[k]]));
  return panel(
    'Colors',
    colorDonut(counts, {
      unit: 'cards',
      names: { ...COLOR_NAMES, M: 'Multicolor' },
      hrefFor: (c) => (c === 'M' ? null : collectionHref({ colors: c })),
    }),
    note('Nonland cards. Multicolor cards count once, under Multicolor; a color link shows every card with that color.'),
  );
}

function typesPanel(sum) {
  const rows = Object.entries(sum.types).filter(([, n]) => n > 0);
  return panel('Card types', hBars(rows, { hrefFor: (t) => (t === 'Other' ? null : collectionHref({ type: t })) }));
}

function rarityPanel(sum) {
  const rows = Object.entries(sum.rarities).map(([r, n]) => [RARITY_LABELS[r], n, r]);
  return panel(
    'Rarity',
    hBars(rows, {
      classFor: (label) => `fill-rarity-${label.toLowerCase()}`,
      hrefFor: (_, r) => collectionHref({ rarity: r }),
    }),
  );
}

function setsPanel(sum) {
  const top = sum.sets.slice(0, 8);
  const byValue = [...sum.sets].sort((a, b) => b.value - a.value)[0];
  return panel(
    'Top sets',
    hBars(
      top.map((s) => [s.name, s.qty, s]),
      {
        wide: true,
        classFor: () => 'fill-accent',
        format: (qty, s) => `${qty.toLocaleString()} · ${money(s.value)}`,
        hrefFor: (_, s) => collectionHref({ set: s.code }),
      },
    ),
    note(
      `Cards from ${sum.sets.length.toLocaleString()} sets.`,
      byValue ? ` Most valuable set: ${byValue.name} (${money(byValue.value)}).` : null,
    ),
  );
}

function curvePanel(sum) {
  return panel('Mana curve', manaCurveChart(sum.curve), note('Nonland cards, by copies.'));
}

function agePanel(sum) {
  return panel(
    'Card age',
    hBars(sum.eras, { classFor: () => 'fill-accent' }),
    sum.oldest
      ? note(
          'Oldest: ',
          h('button', { type: 'button', class: 'link-btn', onclick: () => openCardModal(sum.oldest.card) }, sum.oldest.card.name),
          ` (${sum.oldest.card.set_name}, ${sum.oldest.card.released_at.slice(0, 4)})`,
        )
      : null,
  );
}

function decksPanel(sum) {
  const { inDecks, free } = sum;
  return panel(
    'Collection in decks',
    hBars(
      [
        ['In decks', inDecks.names, inDecks],
        ['Not in a deck', free.names, free],
      ],
      {
        wide: true,
        classFor: (label) => (label === 'In decks' ? 'fill-accent' : 'fill-muted'),
        format: (n, x) => `${n.toLocaleString()} · ${money(x.value)}`,
        hrefFor: (label) => collectionHref(label === 'In decks' ? { used: 1 } : { unused: 1 }),
      },
    ),
    note(`${pct(inDecks.names, sum.names)} of your unique cards are in at least one deck.`),
  );
}

export function collectionDashboard(sum, { location }) {
  return h(
    'div',
    { class: 'dash-grid' },
    valuePanel(sum),
    locationsPanel(sum, location),
    sum.top.length ? topCardsPanel(sum) : null,
    colorPanel(sum),
    typesPanel(sum),
    rarityPanel(sum),
    setsPanel(sum),
    curvePanel(sum),
    agePanel(sum),
    decksPanel(sum),
  );
}
