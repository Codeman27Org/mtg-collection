import { h } from '../dom.js';
import { cardImage, primaryType } from '../card-utils.js';
import { colorPips } from '../mana.js';
import { deckStats, legalityIssues, ownership } from '../analytics.js';
import { FORMAT_LABELS } from '../constants.js';
import { usd } from '../util.js';

const isLegendary = (card) => /\bLegendary\b/.test(card?.type_line ?? '');
const isCreature = (card) => /\bCreature\b/.test(card?.type_line ?? '');

/** The card whose art represents a deck: its commander, else a legend, else the first creature by name. */
export function coverCard(deck, cards) {
  const active = Object.values(deck.lines).filter((l) => l.qty > 0 && l.section !== 'maybeboard');
  const commander = active.find((l) => l.section === 'commander');
  if (commander && cards.get(commander.scryfallId)) return cards.get(commander.scryfallId);
  const pool = active
    .filter((l) => l.section !== 'sideboard')
    .map((l) => cards.get(l.scryfallId))
    .filter((c) => c && primaryType(c) !== 'Land')
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    pool.find((c) => isLegendary(c) && isCreature(c)) ??
    pool.find(isLegendary) ??
    pool.find(isCreature) ??
    pool[0] ??
    null
  );
}

/** 'assembled' when every tracked card is in the deck's location; otherwise 'progress'. */
export function assemblyStatus(plan) {
  return plan && plan.need > 0 && plan.inDeck >= plan.need ? 'assembled' : 'progress';
}

export function newDeckTile() {
  return h(
    'a',
    { class: 'deck-tile deck-tile-new', href: '#/decks/new' },
    h('span', { class: 'deck-tile-plus', 'aria-hidden': 'true' }, '+'),
    h('span', { class: 'deck-tile-new-label' }, 'New deck'),
  );
}

/** plan (optional, from deckPlan): adds an Assembled / In progress status. */
export function deckTile(deck, cards, ownedByOracle, plan) {
  const stats = deckStats(deck, cards);
  const cover = coverCard(deck, cards);
  const art = cardImage(cover, 'art_crop');
  const { missing } = ownership(deck, cards, ownedByOracle, new Map());
  const missingCount = missing.reduce((n, m) => n + m.qty, 0);
  const issues = legalityIssues(deck, cards);
  const legality = issues.length
    ? h(
        'span',
        {
          class: 'chip chip-warn',
          title: issues.length > 8 ? [...issues.slice(0, 8), `…and ${issues.length - 8} more`].join('\n') : issues.join('\n'),
          'aria-label': `Not legal: ${issues.join(' ')}`,
        },
        '⚠ Not legal',
      )
    : null;
  const status = plan
    ? assemblyStatus(plan) === 'assembled'
      ? h('span', { class: 'chip chip-ok', title: 'Every card is in this deck’s location' }, '✓ Assembled')
      : h(
          'span',
          { class: 'chip', title: `${plan.inDeck} of ${plan.need} tracked cards are in the deck${plan.pullCount ? `; ${plan.pullCount} to pull` : ''}` },
          `In progress · ${plan.inDeck}/${plan.need}`,
        )
    : null;
  return h(
    'a',
    { class: 'deck-tile', href: `#/decks/${deck.id}` },
    h(
      'div',
      { class: `deck-art${art ? '' : ` deck-art-${stats.identity.join('') || 'C'}`}` },
      art ? h('img', { src: art, alt: '', loading: 'lazy' }) : null,
      art && cover.artist ? h('span', { class: 'art-credit' }, `Art: ${cover.artist}`) : null,
    ),
    h(
      'div',
      { class: 'deck-meta' },
      h('h3', {}, deck.name),
      h(
        'div',
        { class: 'row between' },
        h('span', { class: 'row wrap' }, h('span', { class: 'pill' }, FORMAT_LABELS[deck.format]), legality),
        colorPips(stats.identity),
      ),
      h(
        'div',
        { class: 'muted small' },
        `${stats.count} cards · `,
        missingCount ? h('span', { class: 'warn-text' }, `${missingCount} missing`) : h('span', { class: 'ok-text' }, 'all owned'),
      ),
      h('div', { class: 'row between' }, status ?? h('span'), h('span', { class: 'price', title: 'Deck price (cheapest printings, maybeboard excluded)' }, usd(stats.price))),
    ),
  );
}
