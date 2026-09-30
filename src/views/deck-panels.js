import { h } from '../dom.js';
import { openCardModal } from '../cardui.js';
import { cheapestPrice, primaryType, isBasicLand, TYPE_ORDER } from '../card-utils.js';
import { deckSize, hasCommander, canLead } from '../formats.js';
import { dropdown } from '../components.js';
import { deckStats, legalityIssues, ownership } from '../analytics.js';
import { manaCurveChart, colorDonut, hBars } from '../charts.js';
import { manaCost, colorPips } from '../mana.js';
import { SECTIONS, SECTION_LABELS, FORMAT_LABELS } from '../constants.js';
import { usd } from '../util.js';

// Kept across re-renders (sync and collection updates redraw the list while you type).
let commanderQuery = '';

/** Every eligible legend as a button; a search box filters them once there are more than a handful. */
function commanderPicker(candidates, cards, onPick) {
  const buttons = candidates.map((l) => {
    const name = cards.get(l.scryfallId).name;
    return h('button', { class: 'btn btn-small', type: 'button', dataset: { name: name.toLowerCase() }, onclick: () => onPick(l) }, name);
  });
  const none = h('span', { class: 'muted small', hidden: true }, 'No matches.');
  const applyFilter = () => {
    const q = commanderQuery.trim().toLowerCase();
    for (const b of buttons) b.hidden = !!q && !b.dataset.name.includes(q);
    none.hidden = buttons.some((b) => !b.hidden);
  };
  const search =
    candidates.length > 6
      ? h('input', {
          type: 'search',
          class: 'commander-search',
          value: commanderQuery,
          placeholder: `Search ${candidates.length} legends…`,
          'aria-label': 'Search commander candidates',
          oninput: (e) => {
            commanderQuery = e.target.value;
            applyFilter();
          },
        })
      : null;
  applyFilter();
  return h(
    'div',
    { class: 'commander-picker' },
    h('span', { class: 'small' }, 'Pick your commander:'),
    search,
    h('div', { class: 'commander-options' }, buttons, none),
  );
}

/**
 * opts: { readOnly, ownedByOracle, usageByOracle, plan, locationName(id), onQty(line, qty), onMove(line, section) }
 * With a plan (see deckPlan), rows show whether each card is in the deck, where to pull it from, or missing.
 */
export function deckList(deck, cards, opts = {}) {
  const { readOnly, ownedByOracle, usageByOracle, plan, locationName } = opts;
  const lines = Object.values(deck.lines).filter((l) => l.qty > 0);
  const stats = deckStats(deck, cards);
  const price = lines.reduce((n, l) => n + (l.section === 'maybeboard' ? 0 : (cheapestPrice(cards.get(l.scryfallId)) ?? 0) * l.qty), 0);

  function planChips(p) {
    if (p.basic && !p.need) return [h('span', { class: 'chip', title: 'Basic lands aren’t tracked unless you own this exact printing' }, 'basic')];
    const untracked = p.untracked ? ` (${p.untracked} more are untracked basics)` : '';
    if (p.inDeck >= p.need) return [h('span', { class: 'chip chip-ok', title: `In the deck${untracked}` }, '✓ in deck')];
    const chips = [];
    const pullQty = p.pulls.reduce((s, x) => s + x.qty, 0);
    if (pullQty) {
      const from = [...new Set(p.pulls.map((x) => locationName(x.entry.location)))].join(', ');
      chips.push(h('span', { class: 'chip chip-info', title: `Pull ${pullQty} from ${from}` }, `pull ${pullQty} · ${from}`));
    }
    if (p.missing) {
      const elsewhere = p.inOtherDecks.map((o) => `${locationName(o.location)} ×${o.qty}`).join(', ');
      chips.push(h('span', { class: 'chip chip-warn', title: elsewhere ? `Also in: ${elsewhere}` : 'Not in your collection' }, `missing ${p.missing}`));
    }
    return chips;
  }

  function row(l) {
    const card = cards.get(l.scryfallId);
    const name = card?.name ?? 'Unknown card';
    const owned = card && ownedByOracle ? ownedByOracle.get(card.oracle_id) ?? 0 : null;
    const used = card && usageByOracle ? usageByOracle.get(card.oracle_id) ?? 0 : 0;
    const chips = [];
    const p = plan && card ? plan.byOracle.get(card.oracle_id) : null;
    const basic = isBasicLand(card);
    if (p && l.section !== 'maybeboard') {
      chips.push(...planChips(p));
      if (!basic && owned > 0 && used > owned) chips.push(h('span', { class: 'chip chip-warn', title: `${used} copies used across decks; you own ${owned}` }, `⚠ ${used}/${owned}`));
    } else if (owned != null && l.section !== 'maybeboard' && !basic) {
      if (owned < l.qty) chips.push(h('span', { class: 'chip chip-warn', title: `You own ${owned}` }, `missing ${l.qty - owned}`));
      else chips.push(h('span', { class: 'chip chip-ok', title: `You own ${owned}` }, '✓'));
      if (owned > 0 && used > owned) chips.push(h('span', { class: 'chip chip-warn', title: `${used} copies used across decks; you own ${owned}` }, `⚠ ${used}/${owned}`));
    }
    return h(
      'li',
      { class: 'deck-row' },
      readOnly
        ? h('span', { class: 'qty' }, String(l.qty))
        : h(
            'span',
            { class: 'qty-controls' },
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove one ${name}`, onclick: () => opts.onQty(l, l.qty - 1) }, '−'),
            h('span', { class: 'qty' }, String(l.qty)),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Add one ${name}`, onclick: () => opts.onQty(l, l.qty + 1) }, '+'),
          ),
      h('button', { class: 'link-btn deck-row-name', type: 'button', onclick: () => card && openCardModal(card) }, name),
      ...chips,
      card ? manaCost(card.mana_cost ?? card.card_faces?.[0]?.mana_cost) : null,
      h('span', { class: 'price' }, usd(card ? cheapestPrice(card) : null)),
      readOnly
        ? null
        : dropdown(
            SECTIONS.map((s) => [s, SECTION_LABELS[s]]),
            l.section,
            (v) => opts.onMove(l, v),
            { label: `Section for ${name}` },
          ),
      readOnly ? null : h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${name}`, onclick: () => opts.onQty(l, 0) }, '✕'),
    );
  }

  const byName = (a, b) => (cards.get(a.scryfallId)?.name ?? '').localeCompare(cards.get(b.scryfallId)?.name ?? '');
  const groups = [];
  for (const section of SECTIONS) {
    const inSection = lines.filter((l) => l.section === section).sort(byName);
    if (!inSection.length) continue;
    if (section === 'main') {
      for (const type of TYPE_ORDER) {
        const typed = inSection.filter((l) => primaryType(cards.get(l.scryfallId)) === type);
        if (typed.length) groups.push([type === 'Other' ? 'Other' : type === 'Sorcery' ? 'Sorceries' : `${type}s`, typed]);
      }
    } else {
      groups.push([SECTION_LABELS[section], inSection]);
    }
  }

  const target = deckSize(deck.format);
  const needsCommander = !readOnly && hasCommander(deck.format) && lines.length && !lines.some((l) => l.section === 'commander');
  const candidates = needsCommander ? lines.filter((l) => l.section !== 'commander' && canLead(cards.get(l.scryfallId), deck.format)).sort(byName) : [];
  const commanderPrompt = needsCommander
    ? h(
        'div',
        { class: 'banner banner-warn commander-prompt' },
        h('strong', {}, 'No commander set.'),
        candidates.length
          ? commanderPicker(candidates, cards, (l) => opts.onMove(l, 'commander'))
          : ' Use a card’s section menu to move it to Commander.',
      )
    : null;
  return h(
    'div',
    { class: 'deck-list' },
    commanderPrompt,
    h(
      'div',
      { class: 'deck-totals' },
      h('strong', {}, target ? `${stats.count}/${target}` : `${stats.count} cards`),
      h('span', {}, FORMAT_LABELS[deck.format]),
      h('span', { class: 'price' }, usd(price)),
      plan && plan.need
        ? h(
            'span',
            { class: 'muted small', title: 'Physical copies in this deck’s location' },
            `In deck ${plan.inDeck}/${plan.need}${plan.pullCount ? ` · ${plan.pullCount} to pull` : ''}${plan.missing ? ` · ${plan.missing} missing` : ''}`,
          )
        : null,
    ),
    groups.length
      ? groups.map(([label, ls]) =>
          h('section', { class: 'deck-group' }, h('h4', {}, `${label} (${ls.reduce((n, l) => n + l.qty, 0)})`), h('ul', {}, ls.map(row))),
        )
      : h('p', { class: 'muted' }, readOnly ? 'This deck is empty.' : 'Search for cards on the left to add them.'),
  );
}

export function deckAnalytics(deck, cards, { ownedByOracle, usageByOracle } = {}) {
  const stats = deckStats(deck, cards);
  const issues = legalityIssues(deck, cards);
  const own = ownedByOracle ? ownership(deck, cards, ownedByOracle, usageByOracle ?? new Map()) : null;
  return h(
    'div',
    { class: 'analytics stack' },
    h('section', {}, h('h4', {}, 'Mana curve'), manaCurveChart(stats.curve)),
    h('section', {}, h('h4', {}, 'Color distribution'), colorDonut(stats.pips)),
    h('section', {}, h('h4', {}, 'Card types'), stats.types.length ? hBars(stats.types) : h('p', { class: 'muted' }, 'No cards yet.')),
    h(
      'section',
      { class: 'kv' },
      h('div', {}, h('span', {}, 'Average mana value'), h('strong', {}, stats.avgCmc.toFixed(2))),
      h('div', {}, h('span', {}, 'Color identity'), colorPips(stats.identity)),
      h('div', {}, h('span', {}, 'Total price'), h('strong', {}, usd(stats.price))),
    ),
    h(
      'section',
      {},
      h('h4', {}, `Format legality: ${FORMAT_LABELS[deck.format]}`),
      issues.length
        ? h('ul', { class: 'issues' }, issues.slice(0, 15).map((i) => h('li', {}, i)), issues.length > 15 ? h('li', {}, `…and ${issues.length - 15} more`) : null)
        : h('p', { class: 'ok-text' }, '✓ Legal'),
    ),
    own
      ? h(
          'section',
          {},
          h('h4', {}, own.missing.length ? `Missing cards (${own.missing.reduce((n, m) => n + m.qty, 0)}) · ${usd(own.missingCost)} to complete` : 'Missing cards'),
          own.missing.length
            ? h('ul', { class: 'missing' }, own.missing.map((m) => h('li', {}, h('button', { class: 'link-btn', type: 'button', onclick: () => openCardModal(m.card) }, `${m.qty}× ${m.card.name}`), h('span', { class: 'muted' }, ` ${usd(cheapestPrice(m.card))}`))))
            : h('p', { class: 'ok-text' }, '✓ You own every card in this deck.'),
          own.overAllocated.length
            ? h(
                'details',
                {},
                h('summary', {}, `${own.overAllocated.length} cards used in more decks than you own`),
                h('ul', {}, own.overAllocated.map((o) => h('li', {}, `${o.card.name}: used ${o.used}, own ${o.owned}`))),
              )
            : null,
        )
      : null,
  );
}
