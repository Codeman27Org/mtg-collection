import { h } from '../dom.js';
import { on } from '../bus.js';
import * as account from '../account.js';
import * as collection from '../collection.js';
import * as locations from '../locations.js';
import { summarize } from '../collection-stats.js';
import { locationToken } from '../location-logic.js';
import { action, toast, confirmDialog, lockedBanner, loading } from '../components.js';
import { usd } from '../util.js';

const money = (n) => (n >= 1000 ? `$${Math.round(n).toLocaleString()}` : usd(n));

export default async function locationsView(root) {
  const editable = account.canEdit();
  const body = h('div', { class: 'stack' }, loading());
  root.append(
    ...[
      lockedBanner(),
      h('div', { class: 'page-head' }, h('h1', {}, 'Locations'), h('a', { class: 'btn', href: '#/collection' }, 'Collection')),
      h(
        'p',
        { class: 'muted' },
        'Where your physical cards are. Every deck is a location too; use “Pull cards” in a deck to move its cards there. New and imported cards go to Unsorted unless you pick a location.',
      ),
      body,
    ].filter(Boolean),
  );

  async function render() {
    const entries = await collection.entries();
    const cards = await collection.cardsFor(entries);
    const totals = new Map(summarize(entries, cards).locations.map((l) => [l.id, l]));
    const all = await locations.all();

    const nameInput = h('input', { type: 'text', maxlength: 100, placeholder: 'e.g. Red binder', 'aria-label': 'New location name' });
    const addForm = editable
      ? h(
          'form',
          {
            class: 'row wrap',
            onsubmit: action(async (e) => {
              e.preventDefault();
              const rec = await locations.create(nameInput.value);
              toast(`Added ${rec.name}`);
            }),
          },
          nameInput,
          h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add location'),
        )
      : null;

    const row = (l) => {
      const t = totals.get(l.id) ?? { qty: 0, value: 0 };
      const name =
        l.kind === 'binder' && editable
          ? h('input', {
              type: 'text',
              class: 'location-name-input',
              value: l.name,
              maxlength: 100,
              'aria-label': `Rename ${l.name}`,
              onchange: action(async (e) => {
                await locations.rename(l.id, e.target.value);
                toast('Renamed');
              }),
            })
          : l.kind === 'deck'
            ? h('a', { href: `#/decks/${l.deckId}` }, l.name)
            : h('strong', {}, l.name);
      return h(
        'tr',
        {},
        h('td', {}, name),
        h('td', { class: 'num' }, t.qty.toLocaleString()),
        h('td', { class: 'num' }, money(t.value)),
        h(
          'td',
          { class: 'row wrap end' },
          t.qty ? h('a', { class: 'btn btn-small', href: `#/collection?location=${encodeURIComponent(locationToken(l.id))}` }, 'View cards') : null,
          editable && l.kind === 'binder'
            ? h(
                'button',
                {
                  class: 'btn btn-small btn-danger',
                  type: 'button',
                  onclick: action(async () => {
                    const msg = t.qty ? `Delete “${l.name}”? Its ${t.qty} cards move to Unsorted.` : `Delete “${l.name}”?`;
                    if (!(await confirmDialog(msg, { confirmLabel: 'Delete', danger: true }))) return;
                    await locations.remove(l.id);
                    toast(`Deleted ${l.name}`);
                  }),
                },
                'Delete',
              )
            : null,
          editable && l.kind === 'deck' && t.qty
            ? h(
                'button',
                {
                  class: 'btn btn-small',
                  type: 'button',
                  title: 'Move every card in this deck back to where it came from',
                  onclick: action(async () => {
                    if (!(await confirmDialog(`Send all ${t.qty} cards in “${l.name}” back to where they came from? The deck list stays as it is.`, { confirmLabel: 'Send back' }))) return;
                    const n = await locations.dismantleDeck(l.deckId);
                    toast(`Sent back ${n} cards`);
                  }),
                },
                'Send all back',
              )
            : null,
        ),
      );
    };

    const table = (title, list) =>
      h(
        'section',
        { class: 'panel stack' },
        h('h2', {}, title),
        list.length
          ? h(
              'div',
              { class: 'table-wrap' },
              h(
                'table',
                { class: 'data-table' },
                h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', { class: 'num' }, 'Cards'), h('th', { class: 'num' }, 'Value'), h('th', {}, ''))),
                h('tbody', {}, list.map(row)),
              ),
            )
          : h('p', { class: 'muted' }, title === 'Decks' ? 'No decks yet.' : 'No binders or boxes yet. Add one below.'),
      );

    body.replaceChildren(
      table('Binders & boxes', all.filter((l) => l.kind !== 'deck')),
      addForm,
      table('Decks', all.filter((l) => l.kind === 'deck')),
    );
  }

  await render();
  const offs = [on('locations', render), on('collection', render), on('decks', render)];
  return () => offs.forEach((off) => off());
}
