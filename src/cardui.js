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

async function actionsPanel(card, rerender) {
  if (!account.canEdit()) return h('p', { class: 'muted' }, 'Unlock your account to add this card.');
  const deckList = await decks.list();
  let deckId = context.deckId && deckList.some((d) => d.id === context.deckId) ? context.deckId : deckList[0]?.id;
  let section = 'main';
  const picker = await locationPicker(addLocation, { label: 'Add to location', onChange: (v) => (addLocation = v) });
  const target = async () => (addLocation = await picker.value());
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
    picker.el,
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
            class: 'btn btn-primary',
            type: 'button',
            onclick: action(async () => {
              await addCard({ target: { deckId }, scryfallId: card.id, section });
              toast(`Added ${card.name}`);
            }),
          },
          'Add',
        ),
      )
    : h('p', { class: 'muted' }, 'Create a deck to add cards to it.');
  return h('div', { class: 'stack' }, collectionBtns, deckRow);
}

export async function openCardModal(input) {
  let card = typeof input === 'string' ? await scryfall.getCard(input) : input;
  if (!card) return toast('Card not found.', 'error');
  let face = 0;
  const dlg = modal({ title: card.name, content: loading(), wide: true });

  async function render() {
    const faces = card.card_faces?.length ? card.card_faces : [card];
    const link = scryfallLink(card);
    const printingsBox = h('div', { class: 'printings' });
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
        h('p', { class: 'muted' }, `${card.set_name} (${card.set.toUpperCase()}) · #${card.collector_number} · ${card.rarity}`),
        h('p', {}, `Price: ${usd(cardPrice(card, 'nonfoil'))} · Foil ${usd(cardPrice(card, 'foil'))}`),
        account.current() ? await ownedPanel(card, render) : null,
        account.current() ? await actionsPanel(card, render) : null,
        h(
          'div',
          { class: 'row wrap' },
          link ? h('a', { class: 'btn', href: link, target: '_blank', rel: 'noopener noreferrer' }, 'View on Scryfall') : null,
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: action(async () => {
                printingsBox.replaceChildren(loading('Loading printings…'));
                const list = await scryfall.prints(card.oracle_id);
                printingsBox.replaceChildren(
                  h(
                    'ul',
                    { class: 'printing-list' },
                    list.map((p) =>
                      h(
                        'li',
                        {},
                        h(
                          'button',
                          { class: `link-btn${p.id === card.id ? ' active' : ''}`, type: 'button', onclick: () => { card = p; face = 0; render(); } },
                          `${p.set_name} (${p.set.toUpperCase()}) #${p.collector_number}`,
                        ),
                        h('span', { class: 'muted' }, ` ${usd(cardPrice(p))}`),
                      ),
                    ),
                  ),
                );
              }),
            },
            'Printings',
          ),
        ),
        printingsBox,
        h('h4', {}, 'Legality'),
        legalityTable(card),
      ),
    );
    dlg.setBody(content);
  }
  await render();
}
