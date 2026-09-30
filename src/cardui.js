import { h } from './dom.js';
import * as account from './account.js';
import * as collection from './collection.js';
import * as decks from './decks.js';
import * as scryfall from './scryfall.js';
import * as locations from './locations.js';
import { locationToken } from './location-logic.js';
import { locationPicker, openMoveDialog } from './views/location-ui.js';
import { cardImage, cardPrice, isDoubleFaced, manaCostOf, scryfallLink } from './card-utils.js';
import { manaCost, oracleText } from './mana.js';
import { modal, toast, action, dropdown, loading } from './components.js';
import { FORMATS, FORMAT_LABELS, SECTIONS, SECTION_LABELS } from './constants.js';
import { legalityOf } from './formats.js';
import { usd } from './util.js';

/** The deck most recently opened in the builder; quick-add buttons target it. */
export const context = { deckId: null, deckName: null };

/** The single path for adding cards (search, import, and later the camera scanner). */
export async function addCard({ target, scryfallId, qty = 1, finish = 'nonfoil', section = 'main', location = '' }) {
  if (target === 'collection') return collection.adjust(scryfallId, finish, qty, { location });
  return decks.addCard(target.deckId, scryfallId, section, qty);
}

export function cardImg(card, size = 'small', face = 0) {
  const src = cardImage(card, size, face);
  return src
    ? h('img', { src, alt: card.name, loading: 'lazy', decoding: 'async', width: size === 'small' ? 146 : 488, height: size === 'small' ? 204 : 680 })
    : h('div', { class: 'card-placeholder' }, card?.name ?? 'Unknown card');
}

export function cardTile(card, { qty, finish, owned, onOpen, actions, extra } = {}) {
  return h(
    'article',
    { class: 'card-tile' },
    h(
      'button',
      { class: 'card-img-btn', type: 'button', 'aria-label': `Open ${card.name}`, onclick: () => (onOpen ?? openCardModal)(card) },
      cardImg(card),
      finish === 'foil' || finish === 'etched' ? h('span', { class: 'foil-badge' }, finish === 'foil' ? 'Foil' : 'Etched') : null,
      qty ? h('span', { class: 'qty-badge' }, `×${qty}`) : null,
      owned ? h('span', { class: 'owned-badge', title: `You own ${owned}` }, `Own ${owned}`) : null,
    ),
    h(
      'div',
      { class: 'card-meta' },
      h('div', { class: 'card-name', title: card.name }, card.name),
      h('div', { class: 'card-sub' }, manaCost(manaCostOf(card)), h('span', { class: 'muted' }, `${card.set?.toUpperCase() ?? ''} · ${card.rarity?.[0]?.toUpperCase() ?? ''}`)),
      h('div', { class: 'card-sub' }, h('span', { class: 'muted small' }, card.type_line), h('span', { class: 'price' }, usd(cardPrice(card, finish ?? 'nonfoil')))),
      extra,
    ),
    actions ? h('div', { class: 'tile-actions' }, actions) : null,
  );
}

function legalityTable(card) {
  return h(
    'table',
    { class: 'legality' },
    h(
      'tbody',
      {},
      FORMATS.map((f) => {
        const status = legalityOf(card, f);
        return h('tr', {}, h('th', {}, FORMAT_LABELS[f]), h('td', { class: `legal-${status}` }, status.replace('_', ' ')));
      }),
    ),
  );
}

async function ownedPanel(card, rerender) {
  const owned = (await collection.ownedById()).get(card.id);
  const byOracle = (await collection.ownedByOracle()).get(card.oracle_id) ?? 0;
  const inDecks = await decks.decksUsing(card.oracle_id);
  const used = inDecks.reduce((n, x) => n + x.qty, 0);
  return h(
    'div',
    { class: 'owned-panel' },
    h('strong', {}, 'Owned: '),
    `this printing ${owned?.nonfoil ?? 0} nonfoil · ${owned?.foil ?? 0} foil${owned?.etched ? ` · ${owned.etched} etched` : ''}`,
    h('br'),
    h('span', { class: 'muted' }, `All printings: ${byOracle}`),
    h('br'),
    h('strong', {}, 'In decks: '),
    inDecks.length
      ? inDecks.map(({ deck, qty }, i) => [i ? ', ' : '', h('a', { href: `#/decks/${deck.id}` }, deck.name), ` (${qty})`])
      : h('span', { class: 'muted' }, 'none'),
    used > byOracle ? h('div', { class: 'warn-text small' }, `Decks use ${used} but you own ${byOracle}.`) : null,
    await wherePanel(card, rerender),
  );
}

/** Every stack of this card (any printing), by location, with Move. */
async function wherePanel(card, rerender) {
  const all = await collection.entries();
  const allCards = await collection.cardsFor(all);
  const lookup = await locations.lookup();
  const label = (id) => (lookup(id).kind === 'deck' ? `Deck: ${lookup(id).name}` : lookup(id).name);
  const stacks = all
    .filter((e) => allCards.get(e.scryfallId)?.oracle_id === card.oracle_id)
    .sort((a, b) => label(a.location).localeCompare(label(b.location)) || b.qty - a.qty);
  if (!stacks.length) return null;
  return h(
    'div',
    { class: 'where' },
    h('strong', {}, 'Where: '),
    h(
      'ul',
      { class: 'where-list' },
      stacks.map((e) => {
        const c = allCards.get(e.scryfallId);
        const details = [c.set.toUpperCase(), e.finish === 'nonfoil' ? null : e.finish, e.condition === 'NM' ? null : e.condition].filter(Boolean).join(' · ');
        return h(
          'li',
          {},
          h('a', { href: `#/collection?location=${encodeURIComponent(locationToken(e.location))}` }, label(e.location)),
          h('span', { class: 'muted' }, ` ${details} ×${e.qty}`),
          e.from ? h('span', { class: 'muted small' }, ` (from ${label(e.from)})`) : null,
          account.canEdit()
            ? h('button', { class: 'btn btn-small', type: 'button', onclick: action(() => openMoveDialog(e, c, { onDone: rerender })) }, 'Move')
            : null,
        );
      }),
    ),
  );
}

let addLocation = '';

async function actionsPanel(card, rerender, { deckId: forDeck, section: forSection, onAdded } = {}) {
  if (!account.canEdit()) return h('p', { class: 'muted' }, 'Unlock your account to add this card.');
  const deckList = await decks.list();
  const preferred = forDeck ?? context.deckId;
  let deckId = preferred && deckList.some((d) => d.id === preferred) ? preferred : deckList[0]?.id;
  let section = forSection ?? 'main';
  const picker = await locationPicker(addLocation, { label: 'Add to location', onChange: (v) => (addLocation = v) });
  const target = async () => (addLocation = await picker.value());
  // Pull cards only moves copies you own that aren't already in a deck (any printing counts).
  let spare = Infinity;
  let status = null;
  if (forDeck) {
    const owned = (await collection.ownedByOracle()).get(card.oracle_id) ?? 0;
    spare = owned - ((await decks.usageByOracle()).get(card.oracle_id) ?? 0);
    const deckName = () => deckList.find((d) => d.id === deckId)?.name ?? 'the deck';
    const mainFinish = !card.finishes?.length || card.finishes.includes('nonfoil') ? 'nonfoil' : card.finishes[0];
    const foil = mainFinish === 'nonfoil' && card.finishes?.includes('foil') ? h('input', { type: 'checkbox' }) : null;
    const addBoth = action(async () => {
      const finish = foil?.checked ? 'foil' : mainFinish;
      await addCard({ target: 'collection', scryfallId: card.id, finish, location: await target() });
      await addCard({ target: { deckId }, scryfallId: card.id, section });
      toast(`Added ${card.name} (${card.set.toUpperCase()}${finish === 'nonfoil' ? '' : `, ${finish}`}) to your collection and ${deckName()}`);
      onAdded?.();
    });
    status =
      spare > 0
        ? h('p', { class: 'ok-text small' }, `✓ You have ${spare} spare ${spare === 1 ? 'copy' : 'copies'} in your collection, so Pull cards can move one into the deck.`)
        : h(
            'div',
            { class: 'banner banner-warn add-callout' },
            h('strong', {}, owned ? 'No spare copy in your collection' : 'Not in your collection yet'),
            h(
              'p',
              { class: 'small' },
              owned ? `You own ${owned}, but ${owned === 1 ? 'it’s' : 'they’re all'} already used by ${owned === 1 ? 'a deck' : 'your decks'}. ` : 'You don’t own this card. ',
              'Pull cards can only move cards from your collection, so add this printing to your collection to pull it into the deck.',
            ),
            h(
              'div',
              { class: 'row wrap' },
              foil ? h('label', { class: 'check' }, foil, ' Foil') : null,
              h('span', { class: 'small' }, 'Store it in'),
              picker.el,
            ),
            h('div', { class: 'row wrap' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: addBoth }, 'Add to collection + deck')),
          );
  }
  const collectionBtns = h(
    'div',
    { class: 'row wrap' },
    h('span', { class: 'field-label' }, 'Collection'),
    h('button', { class: 'btn', type: 'button', onclick: action(async () => { await addCard({ target: 'collection', scryfallId: card.id, location: await target() }); rerender(); }) }, '+1'),
    card.finishes?.includes('foil')
      ? h('button', { class: 'btn', type: 'button', onclick: action(async () => { await addCard({ target: 'collection', scryfallId: card.id, finish: 'foil', location: await target() }); rerender(); }) }, '+1 foil')
      : null,
    h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: action(async () => {
          const loc = await target();
          const here = (await collection.entries()).filter((e) => e.scryfallId === card.id && (e.location ?? '') === loc);
          const stack = here.find((e) => e.finish === 'nonfoil') ?? here[0];
          if (!stack) throw new Error('None of this printing in that location. Use Move or pick another location.');
          await collection.adjust(stack.scryfallId, stack.finish, -1, stack);
          rerender();
        }),
      },
      '−1',
    ),
    h('span', { class: 'muted small' }, 'in'),
    spare > 0 ? picker.el : null,
  );
  const deckRow = deckList.length
    ? h(
        'div',
        { class: 'row wrap' },
        h('span', { class: 'field-label' }, 'Deck'),
        dropdown(deckList.map((d) => [d.id, d.name]), deckId, (v) => (deckId = v), { label: 'Deck' }),
        dropdown(SECTIONS.map((s) => [s, SECTION_LABELS[s]]), section, (v) => (section = v), { label: 'Section' }),
        h(
          'button',
          {
            class: `btn${spare > 0 ? ' btn-primary' : ''}`,
            type: 'button',
            onclick: action(async () => {
              await addCard({ target: { deckId }, scryfallId: card.id, section });
              toast(`Added ${card.name} (${card.set.toUpperCase()})`);
              onAdded?.();
            }),
          },
          !forDeck ? 'Add' : spare > 0 ? 'Add this printing' : 'Add to deck only',
        ),
      )
    : h('p', { class: 'muted' }, 'Create a deck to add cards to it.');
  return h('div', { class: 'stack' }, status, spare > 0 ? collectionBtns : null, deckRow);
}

const setIcon = (icons, code) => {
  const src = icons?.get(code);
  return src ? h('img', { class: 'set-icon set-icon-sm', src, alt: '', width: 18, height: 18 }) : null;
};

/**
 * opts.deckId: opened from a deck's search to add a card; preselects that deck and opts.section,
 * lists printings right away so the set can be picked, and closes after adding.
 */
export async function openCardModal(input, opts = {}) {
  let card = typeof input === 'string' ? await scryfall.getCard(input) : input;
  if (!card) return toast('Card not found.', 'error');
  let face = 0;
  let printings = null;
  let printingsFailed = false;
  let icons = null;
  let ownedById = new Map();
  const dlg = modal({ title: card.name, content: loading(), wide: true });
  const actionOpts = opts.deckId ? { ...opts, onAdded: () => dlg.dismiss() } : {};
  icons = await scryfall.setIcons();

  async function loadPrintings() {
    const paper = await scryfall.paperPrints(card.oracle_id);
    // Digital-only cards have no paper printings; show those rather than nothing.
    printings = paper.length ? paper : await scryfall.prints(card.oracle_id);
    if (account.current()) ownedById = await collection.ownedById();
    // Printings you own first (stable, so newest-first order holds within each group).
    if (opts.deckId) printings.sort((a, b) => Number(!!ownedById.get(b.id)?.total) - Number(!!ownedById.get(a.id)?.total));
  }

  function printingList() {
    return h(
      'ul',
      { class: 'printing-list' },
      printings.map((p) => {
        const own = ownedById.get(p.id)?.total;
        return h(
          'li',
          {},
          h(
            'button',
            {
              class: `printing${p.id === card.id ? ' active' : ''}`,
              type: 'button',
              'aria-pressed': String(p.id === card.id),
              onclick: () => {
                card = p;
                face = 0;
                render();
              },
            },
            setIcon(icons, p.set),
            h('span', { class: 'printing-set' }, p.set_name),
            h('span', { class: 'muted small' }, `${p.set.toUpperCase()} #${p.collector_number}`),
            own ? h('span', { class: 'owned-badge inline' }, `Own ${own}`) : null,
            h('span', { class: 'price small' }, usd(cardPrice(p))),
          ),
        );
      }),
    );
  }

  async function render() {
    const faces = card.card_faces?.length ? card.card_faces : [card];
    const link = scryfallLink(card);
    const listScroll = dlg.querySelector('.printing-list')?.scrollTop ?? 0;
    const printingsBox = h(
      'div',
      { class: 'printings' },
      printings
        ? [h('h4', {}, opts.deckId ? 'Pick a printing' : 'Printings'), printingList()]
        : opts.deckId && !printingsFailed
          ? loading('Loading printings…')
          : null,
    );
    const content = h(
      'div',
      { class: 'card-detail' },
      h(
        'div',
        { class: 'card-detail-img' },
        cardImg(card, 'normal', face),
        isDoubleFaced(card)
          ? h('button', { class: 'btn', type: 'button', onclick: () => { face = face ? 0 : 1; render(); } }, 'Flip')
          : null,
      ),
      h(
        'div',
        { class: 'card-detail-info' },
        ...faces.map((f) =>
          h(
            'section',
            { class: 'face' },
            h('h3', { class: 'row between' }, h('span', {}, f.name), manaCost(f.mana_cost)),
            h('p', { class: 'type-line' }, f.type_line ?? card.type_line),
            h('div', { class: 'oracle' }, oracleText(f.oracle_text)),
            f.power != null ? h('p', { class: 'pt' }, `${f.power}/${f.toughness}`) : null,
            f.loyalty != null ? h('p', { class: 'pt' }, `Loyalty ${f.loyalty}`) : null,
            f.flavor_text ? h('p', { class: 'flavor' }, f.flavor_text) : null,
          ),
        ),
        h('p', { class: 'muted row' }, setIcon(icons, card.set), `${card.set_name} (${card.set.toUpperCase()}) · #${card.collector_number} · ${card.rarity}`),
        h('p', {}, `Price: ${usd(cardPrice(card, 'nonfoil'))} · Foil ${usd(cardPrice(card, 'foil'))}`),
        account.current() && !opts.deckId ? await ownedPanel(card, render) : null,
        printingsBox,
        account.current() ? await actionsPanel(card, render, actionOpts) : null,
        account.current() && opts.deckId ? await ownedPanel(card, render) : null,
        h(
          'div',
          { class: 'row wrap' },
          link ? h('a', { class: 'btn', href: link, target: '_blank', rel: 'noopener noreferrer' }, 'View on Scryfall') : null,
          printings
            ? null
            : h(
                'button',
                {
                  class: 'btn',
                  type: 'button',
                  onclick: action(async () => {
                    printingsBox.replaceChildren(loading('Loading printings…'));
                    await loadPrintings();
                    await render();
                  }),
                },
                'Printings',
              ),
        ),
        h('h4', {}, 'Legality'),
        legalityTable(card),
      ),
    );
    dlg.setBody(content);
    const list = dlg.querySelector('.printing-list');
    if (list) list.scrollTop = listScroll;
  }
  if (opts.deckId) {
    await render();
    try {
      await loadPrintings();
    } catch (err) {
      printingsFailed = true;
      toast(err.message, 'error');
    }
  }
  await render();
}
