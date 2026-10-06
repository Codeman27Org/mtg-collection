import { h } from '../dom.js';
import { on } from '../bus.js';
import * as account from '../account.js';
import * as collection from '../collection.js';
import * as decks from '../decks.js';
import * as scryfall from '../scryfall.js';
import * as shares from '../shares.js';
import { context, addCard, cardImg, openCardModal } from '../cardui.js';
import { cardPrice, manaCostOf } from '../card-utils.js';
import { manaCost } from '../mana.js';
import { navigate } from '../router.js';
import { modal, action, toast, confirmDialog, lockedBanner, loading, field, dropdown } from '../components.js';
import { deckList, deckAnalytics } from './deck-panels.js';
import { openShareDialog } from './share-dialog.js';
import { openPullDialog, openSendBackDialog } from './deck-location.js';
import * as locations from '../locations.js';
import { deckPlan, deckLocation } from '../location-logic.js';
import { readDeckFile, readDeckText, importIntoDeck, importSummary } from '../deck-import.js';
import { collectionModeField } from './deck-new.js';
import { toText, toCsv, toDek } from '../deck-text.js';
import { applyFilter } from '../collection-filter.js';
import { FORMATS, FORMAT_LABELS, SECTIONS, SECTION_LABELS } from '../constants.js';
import { isPlayableIn, scryfallFormatQuery } from '../formats.js';
import { debounce, download, copyText, usd, slug } from '../util.js';

function importDialog(deck) {
  const text = h('textarea', { rows: 12, placeholder: 'Paste a deck list…' });
  const file = h('input', { type: 'file', accept: '.txt,.csv,.dek' });
  const replace = h('input', { type: 'checkbox' });
  const modeField = collectionModeField();
  const status = h('p', { class: 'muted small', role: 'status' });
  const dlg = modal({
    title: 'Import into deck',
    content: h(
      'form',
      {
        class: 'stack',
        onsubmit: action(async (e) => {
          e.preventDefault();
          const parsed = file.files[0] ? await readDeckFile(file.files[0]) : readDeckText(text.value);
          if (!parsed.rows.length) throw new Error('No cards found in that list.');
          const mode = modeField.value();
          const result = await importIntoDeck(deck.id, parsed.rows, {
            format: deck.format,
            mode,
            replace: replace.checked,
            onProgress: (label, done, total) => (status.textContent = `${label}… ${done}/${total}`),
          });
          toast(importSummary(result, mode), result.unresolved.length ? 'error' : 'info');
          dlg.dismiss();
        }),
      },
      modeField.el,
      field('Deck list', text, 'MTGA, Moxfield, Archidekt, or TappedOut format.'),
      field('…or a file', file, '.csv, .txt, or .dek'),
      h('label', { class: 'check' }, replace, ' Replace the current deck contents'),
      status,
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Import'),
    ),
  });
}

function exportMenu(deck, cards) {
  const base = slug(deck.name);
  const item = (label, fn) => h('button', { type: 'button', class: 'menu-item', onclick: action(fn) }, label);
  return h(
    'details',
    { class: 'menu' },
    h('summary', { class: 'btn' }, 'Export'),
    h(
      'div',
      { class: 'menu-list' },
      item('Copy as text (MTGA)', async () => {
        await copyText(toText(deck, cards));
        toast('Deck list copied');
      }),
      item('Download .txt', () => download(`${base}.txt`, toText(deck, cards))),
      item('Download .csv', () => download(`${base}.csv`, toCsv(deck, cards), 'text/csv')),
      item('Download .dek (MTGO)', () => download(`${base}.dek`, toDek(deck, cards), 'application/xml')),
    ),
  );
}

const BASICS = [
  ['W', 'Plains'],
  ['U', 'Island'],
  ['B', 'Swamp'],
  ['R', 'Mountain'],
  ['G', 'Forest'],
];

function countPicker(card, onPick) {
  const dlg = modal({
    title: `Add ${card.name}`,
    content: h(
      'div',
      { class: 'row' },
      [1, 2, 3, 4].map((n) => h('button', { class: 'btn', type: 'button', onclick: () => { onPick(n); dlg.dismiss(); } }, `${n}×`)),
    ),
  });
}

export default async function builderView(root, { params: [id], query }) {
  let deck = await decks.get(id);
  if (!deck) {
    root.append(h('h1', {}, 'Deck not found'), h('a', { href: '#/decks' }, 'Back to decks'));
    return;
  }
  context.deckId = deck.id;
  context.deckName = deck.name;
  const editable = account.canEdit();

  let cards = await decks.cardsFor(deck);
  let ownedByOracle = await collection.ownedByOracle();
  let usageByOracle = await decks.usageByOracle();
  let addSection = 'main';
  let plan = null;
  let planCards = cards;
  let locationOf = () => ({ name: '' });
  async function computePlan() {
    const entries = await collection.entries();
    planCards = new Map([...(await collection.cardsFor(entries)), ...cards]);
    plan = deckPlan(deck, planCards, entries);
    locationOf = await locations.lookup();
  }
  await computePlan();

  // ---------------------------------------------------------------- header
  const nameInput = h('input', {
    class: 'deck-name-input',
    value: deck.name,
    'aria-label': 'Deck name',
    maxlength: 100,
    disabled: !editable,
    onchange: action(async (e) => {
      await decks.updateFields(deck.id, { name: e.target.value.trim() || 'Untitled deck' });
      context.deckName = e.target.value;
    }),
  });
  const formatSelect = editable
    ? dropdown(FORMATS.map((f) => [f, FORMAT_LABELS[f]]), deck.format, (v) => decks.updateFields(deck.id, { format: v }).catch((err) => toast(err.message, 'error')), { label: 'Format' })
    : h('span', { class: 'pill' }, FORMAT_LABELS[deck.format]);
  const description = h('textarea', {
    rows: 3,
    maxlength: 5000,
    disabled: !editable,
    placeholder: 'Notes about this deck…',
    'aria-label': 'Description',
    onchange: action((e) => decks.updateFields(deck.id, { description: e.target.value })),
  });
  description.value = deck.description ?? '';

  const toolbar = h('div', { class: 'row wrap' });
  function renderToolbar() {
    toolbar.replaceChildren(
      ...[
        editable && plan.pullCount
          ? h('button', { class: 'btn btn-primary', type: 'button', onclick: action(() => openPullDialog(deck, plan, planCards)) }, `Pull cards (${plan.pullCount})`)
          : null,
        editable && plan.extraCount
          ? h('button', { class: 'btn', type: 'button', onclick: action(() => openSendBackDialog(deck, plan, planCards)) }, `Send back (${plan.extraCount})`)
          : null,
        exportMenu(deck, cards),
      editable ? h('a', { class: 'btn', href: `#/scan?deck=${encodeURIComponent(deck.id)}` }, 'Scan') : null,
      editable ? h('button', { class: 'btn', type: 'button', onclick: () => importDialog(deck) }, 'Import') : null,
      editable ? h('button', { class: 'btn', type: 'button', onclick: action(() => openShareDialog({ type: 'deck', targetId: deck.id, title: deck.name })) }, 'Share') : null,
      editable
        ? h(
            'button',
            {
              class: 'btn btn-danger',
              type: 'button',
              onclick: action(async () => {
                const inBox = (await collection.entries()).filter((e) => e.location === deckLocation(deck.id)).reduce((n, e) => n + e.qty, 0);
                const boxNote = inBox ? ` Its ${inBox} cards go back to where they came from.` : '';
                if (!(await confirmDialog(`Delete “${deck.name}”?${boxNote} This also stops any share links for it.`, { confirmLabel: 'Delete', danger: true }))) return;
                for (const s of await shares.list()) if (shares.isActive(s) && s.type === 'deck' && s.targetId === deck.id) await shares.stop(s.id);
                await locations.dismantleDeck(deck.id);
                await decks.remove(deck.id);
                context.deckId = null;
                navigate('/decks');
              }),
            },
            'Delete',
          )
        : null,
      ].filter(Boolean),
    );
  }

  // ---------------------------------------------------------------- search panel
  const results = h('ul', { class: 'search-results' });
  const searchInput = h('input', { type: 'search', 'aria-label': 'Search cards to add', class: 'grow' });
  const legalOnly = h('input', { type: 'checkbox', checked: true });
  const identityOnly = h('input', { type: 'checkbox', checked: true });
  const RESULT_LIMIT = 100;
  let source = query?.get('source') === 'collection' ? 'collection' : 'scryfall';
  const sourceToggle = h(
    'div',
    { class: 'seg', role: 'group', 'aria-label': 'Search in' },
    [['collection', 'My collection'], ['scryfall', 'All cards']].map(([value, label]) =>
      h(
        'button',
        {
          type: 'button',
          class: value === source ? 'active' : '',
          'aria-pressed': String(value === source),
          onclick: (e) => {
            source = value;
            for (const b of sourceToggle.children) {
              b.classList.toggle('active', b === e.currentTarget);
              b.setAttribute('aria-pressed', String(b === e.currentTarget));
            }
            updatePlaceholder();
            results.replaceChildren();
            runSearch();
          },
        },
        label,
      ),
    ),
  );
  function updatePlaceholder() {
    searchInput.placeholder = source === 'collection' ? 'Filter your collection…' : 'Search all cards…';
  }
  updatePlaceholder();

  function commanderIdentity() {
    const colors = Object.values(deck.lines)
      .filter((l) => l.section === 'commander' && l.qty > 0)
      .flatMap((l) => cards.get(l.scryfallId)?.color_identity ?? []);
    return [...new Set(colors)];
  }

  /** One printing per card (the stack with the most copies), sorted by name. */
  async function searchCollection(q) {
    const entries = await collection.entries();
    const all = await collection.cardsFor(entries);
    const identity = identityOnly.checked ? commanderIdentity() : [];
    const byOracle = new Map();
    for (const e of applyFilter(entries, all, { text: q })) {
      const card = all.get(e.scryfallId);
      if (!card) continue;
      if (legalOnly.checked && !isPlayableIn(card, deck.format)) continue;
      if (identity.length && !(card.color_identity ?? []).every((c) => identity.includes(c))) continue;
      const prev = byOracle.get(card.oracle_id);
      if (!prev || e.qty > prev.qty) byOracle.set(card.oracle_id, { card, qty: e.qty });
    }
    return [...byOracle.values()].map((x) => x.card).sort((a, b) => a.name.localeCompare(b.name));
  }

  async function add(card, qty = 1) {
    await addCard({ target: { deckId: deck.id }, scryfallId: card.id, section: addSection, qty });
  }

  function resultRow(card) {
    let pressTimer;
    let longPressed = false;
    const pick = () => countPicker(card, (n) => add(card, n).catch((err) => toast(err.message, 'error')));
    // Collection results are a printing you own; search results need the set chosen first.
    const fromCollection = source === 'collection';
    const owned = ownedByOracle.get(card.oracle_id) ?? 0;
    // usageByOracle counts this deck too, so "free" is what's left for it to take.
    const free = owned - (usageByOracle.get(card.oracle_id) ?? 0);
    const badge = owned
      ? h(
          'span',
          { class: `owned-badge inline${free <= 0 ? ' none-free' : ''}`, title: `You own ${owned}; ${Math.max(free, 0)} not used in any deck` },
          free < owned ? `Own ${owned} · ${Math.max(free, 0)} free` : `Own ${owned}`,
        )
      : null;
    return h(
      'li',
      {},
      h(
        'button',
        {
          type: 'button',
          class: 'result-row',
          disabled: !editable,
          title: fromCollection
            ? 'Click to add 1. Right-click or long-press to choose how many.'
            : 'Click to pick a printing and add it. Right-click or long-press to add this printing quickly.',
          onclick: action(() => {
            if (longPressed) return (longPressed = false);
            if (!fromCollection) return openCardModal(card, { deckId: deck.id, section: addSection });
            return add(card);
          }),
          oncontextmenu: (e) => {
            e.preventDefault();
            clearTimeout(pressTimer);
            pick();
          },
          onpointerdown: () => {
            longPressed = false;
            pressTimer = setTimeout(() => {
              longPressed = true;
              pick();
            }, 550);
          },
          onpointerup: () => clearTimeout(pressTimer),
          onpointerleave: () => clearTimeout(pressTimer),
        },
        h('span', { class: 'thumb' }, cardImg(card, 'small')),
        h(
          'span',
          { class: 'result-info' },
          h('span', { class: 'result-name' }, card.name, badge),
          h('span', { class: 'row small' }, manaCost(manaCostOf(card)), h('span', { class: 'muted' }, card.type_line)),
          h('span', { class: 'price small' }, usd(cardPrice(card))),
        ),
      ),
    );
  }

  let searchSeq = 0;
  const runSearch = debounce(async () => {
    const seq = ++searchSeq;
    const q = searchInput.value.trim();
    if (source === 'scryfall' && q.length < 2) return results.replaceChildren();
    if (!results.children.length) results.replaceChildren(h('li', {}, loading('Searching…')));
    try {
      let found;
      if (source === 'collection') {
        found = await searchCollection(q);
      } else {
        const parts = [q];
        if (legalOnly.checked) parts.push(scryfallFormatQuery(deck.format));
        const identity = commanderIdentity();
        if (identityOnly.checked && identity.length) parts.push(`id<=${identity.join('').toLowerCase()}`);
        found = (await scryfall.search(parts.join(' '))).cards.slice(0, 60);
      }
      if (seq !== searchSeq) return;
      const rows = found.slice(0, RESULT_LIMIT).map(resultRow);
      if (found.length > RESULT_LIMIT) rows.push(h('li', { class: 'muted small' }, `Showing ${RESULT_LIMIT} of ${found.length}. Type to narrow it down.`));
      const empty = source === 'collection' ? 'Nothing in your collection matches.' : 'No matches.';
      results.replaceChildren(...(rows.length ? rows : [h('li', { class: 'muted' }, empty)]));
    } catch (err) {
      if (seq === searchSeq) results.replaceChildren(h('li', { class: 'banner banner-error' }, err.message));
    }
  }, 300);
  searchInput.addEventListener('input', runSearch);
  for (const cb of [legalOnly, identityOnly]) cb.addEventListener('change', runSearch);

  const searchPanel = h(
    'section',
    { class: 'builder-col builder-search', dataset: { tab: 'search' } },
    sourceToggle,
    h('div', { class: 'row' }, searchInput),
    h(
      'div',
      { class: 'row wrap small' },
      h('label', { class: 'check' }, legalOnly, ' Legal in format'),
      h('label', { class: 'check' }, identityOnly, ' Commander colors'),
    ),
    h(
      'label',
      { class: 'row small' },
      'Add to ',
      dropdown(SECTIONS.map((s) => [s, SECTION_LABELS[s]]), addSection, (v) => (addSection = v), { label: 'Add to section' }),
    ),
    results,
  );

  // ---------------------------------------------------------------- deck + analytics panels
  const listPanel = h('section', { class: 'builder-col builder-list', dataset: { tab: 'deck' } });
  const statsPanel = h('section', { class: 'builder-col builder-stats', dataset: { tab: 'stats' } });

  const handlers = {
    readOnly: !editable,
    onQty: (l, qty) => decks.setLine(deck.id, l.scryfallId, l.section, qty).catch((err) => toast(err.message, 'error')),
    onMove: (l, to) => decks.moveLine(deck.id, l.scryfallId, l.section, to).catch((err) => toast(err.message, 'error')),
  };

  function renderPanels() {
    listPanel.replaceChildren(deckList(deck, cards, { ...handlers, ownedByOracle, usageByOracle, plan, locationName: (id) => locationOf(id).name }));
    statsPanel.replaceChildren(deckAnalytics(deck, cards, { ownedByOracle, usageByOracle }));
    renderToolbar();
    renderLands();
  }

  // ---------------------------------------------------------------- basic lands
  const landsBar = h('section', { class: 'basic-lands', 'aria-label': 'Basic lands' });
  const landInputs = new Map();
  const basicLines = (name) =>
    Object.values(deck.lines)
      .filter((l) => l.qty > 0 && l.section !== 'maybeboard' && cards.get(l.scryfallId)?.name === name)
      .sort((a, b) => Number(b.section === 'main') - Number(a.section === 'main'));
  const basicTotal = (name) => basicLines(name).reduce((n, l) => n + l.qty, 0);

  /** The commander's basic land types (Wastes for a colorless commander); all five without a commander. */
  function landsToShow() {
    if (!Object.values(deck.lines).some((l) => l.section === 'commander' && l.qty > 0)) return BASICS;
    const identity = commanderIdentity();
    return identity.length ? BASICS.filter(([c]) => identity.includes(c)) : [['C', 'Wastes']];
  }

  function renderLands() {
    if (!editable) return;
    const lands = landsToShow();
    const key = lands.map(([, name]) => name).join();
    if (landsBar.dataset.key !== key) {
      landsBar.dataset.key = key;
      landInputs.clear();
      landsBar.replaceChildren(
        h('span', { class: 'basic-lands-title' }, 'Basic lands'),
        ...lands.map(([color, name]) => {
          const input = h('input', {
            type: 'number',
            inputmode: 'numeric',
            min: 0,
            max: 99,
            'aria-label': `${name} in the deck`,
            onfocus: (e) => e.target.select(),
            onchange: action((e) => setBasic(name, e.target.value)),
          });
          landInputs.set(name, input);
          return h('label', { class: 'basic-land' }, manaCost(`{${color}}`), h('span', {}, name), input);
        }),
      );
    }
    // Don't overwrite a number while it's being typed.
    for (const [name, input] of landInputs) if (document.activeElement !== input) input.value = String(basicTotal(name));
  }

  /** Sets how many of a basic land the deck has: grows the main-deck line, or trims lines (main first). */
  async function setBasic(name, value) {
    const total = Math.max(0, Math.min(99, Math.floor(Number(value) || 0)));
    const lines = basicLines(name);
    const current = lines.reduce((n, l) => n + l.qty, 0);
    if (total === current) return;
    const changes = [];
    if (total > current) {
      const target = lines.find((l) => l.section === 'main') ?? lines[0];
      if (target) changes.push({ scryfallId: target.scryfallId, section: target.section, qty: target.qty + total - current });
      else {
        const card = await scryfall.namedExact(name);
        if (!card) throw new Error(`Couldn’t find ${name} on Scryfall.`);
        changes.push({ scryfallId: card.id, section: 'main', qty: total });
      }
    } else {
      let cut = current - total;
      for (const l of lines) {
        if (!cut) break;
        const n = Math.min(cut, l.qty);
        changes.push({ scryfallId: l.scryfallId, section: l.section, qty: l.qty - n });
        cut -= n;
      }
    }
    await decks.setLines(deck.id, changes);
  }

  const startTab = editable && query?.has('source') ? 'search' : 'deck';
  const tabs = h(
    'div',
    { class: 'builder-tabs', role: 'tablist' },
    [['search', 'Search'], ['deck', 'Deck'], ['stats', 'Stats']].map(([key, label]) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: key === startTab ? 'active' : '',
          onclick: (e) => {
            grid.dataset.active = key;
            for (const b of tabs.children) b.classList.toggle('active', b === e.currentTarget);
          },
        },
        label,
      ),
    ),
  );
  const grid = h('div', { class: 'builder', dataset: { active: startTab } }, editable ? searchPanel : null, listPanel, statsPanel);

  root.append(
    ...[
      lockedBanner(),
      h(
        'div',
        { class: 'page-head' },
        h('div', { class: 'row wrap grow' }, nameInput, formatSelect),
        toolbar,
      ),
      h('details', { class: 'description' }, h('summary', {}, 'Description'), description),
      tabs,
      editable ? landsBar : null,
      grid,
    ].filter(Boolean),
  );
  renderPanels();
  if (editable && source === 'collection') runSearch();
  if (startTab === 'search') searchInput.focus();

  async function refresh() {
    const fresh = await decks.get(id);
    if (!fresh) return navigate('/decks');
    deck = fresh;
    cards = await decks.cardsFor(deck);
    ownedByOracle = await collection.ownedByOracle();
    usageByOracle = await decks.usageByOracle();
    await computePlan();
    if (document.activeElement !== nameInput) nameInput.value = deck.name;
    if (document.activeElement !== description) description.value = deck.description ?? '';
    if (formatSelect.setValue) formatSelect.setValue(deck.format);
    else formatSelect.textContent = FORMAT_LABELS[deck.format];
    renderPanels();
    // Keeps the "free" counts in collection results current as cards are added.
    if (editable && source === 'collection') runSearch();
  }
  const offs = [on('decks', refresh), on('collection', refresh), on('locations', refresh)];
  return () => offs.forEach((off) => off());
}
