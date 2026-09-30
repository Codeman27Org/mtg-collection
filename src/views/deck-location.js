import { h } from '../dom.js';
import * as locations from '../locations.js';
import { modal, action, toast } from '../components.js';
import { returnTarget } from '../location-logic.js';
import { groupBy } from '../util.js';

function stackLine({ entry, qty }, card) {
  const details = [card?.set?.toUpperCase(), entry.finish === 'nonfoil' ? null : entry.finish, entry.condition === 'NM' ? null : entry.condition].filter(Boolean).join(' · ');
  return h('li', {}, `${qty}× ${card?.name ?? 'Unknown card'}`, h('span', { class: 'muted small' }, ` ${details}`));
}

const byCardName = (cards) => (a, b) => (cards.get(a.entry.scryfallId)?.name ?? '').localeCompare(cards.get(b.entry.scryfallId)?.name ?? '');

/** Pull list grouped by where to find each card; each source can be skipped. */
export async function openPullDialog(deck, plan, cards) {
  const lookup = await locations.lookup();
  const groups = [...groupBy(plan.pulls, (p) => p.entry.location ?? '')].sort((a, b) => lookup(a[0]).name.localeCompare(lookup(b[0]).name));
  const chosen = new Set(groups.map(([loc]) => loc));
  const button = h('button', { class: 'btn btn-primary', type: 'submit' });
  const updateButton = () => {
    const n = plan.pulls.filter((p) => chosen.has(p.entry.location ?? '')).reduce((s, p) => s + p.qty, 0);
    button.textContent = `Move ${n} cards into ${deck.name}`;
    button.disabled = n === 0;
  };
  const otherDecks = [...plan.byOracle.values()].filter((r) => r.missing && r.inOtherDecks.length);
  const dlg = modal({
    title: `Pull cards for ${deck.name}`,
    wide: true,
    content: h(
      'form',
      {
        class: 'stack',
        onsubmit: action(async (e) => {
          e.preventDefault();
          const n = await locations.pullIntoDeck(deck.id, plan.pulls.filter((p) => chosen.has(p.entry.location ?? '')));
          toast(`Moved ${n} cards into ${deck.name}`);
          dlg.dismiss();
        }),
      },
      h('p', { class: 'muted' }, 'Grab these cards, then confirm to record that they’re in the deck. Uncheck a location to leave its cards where they are.'),
      h(
        'div',
        { class: 'pull-groups' },
        groups.map(([loc, pulls]) =>
          h(
            'section',
            { class: 'pull-group' },
            h(
              'label',
              { class: 'check' },
              h('input', {
                type: 'checkbox',
                checked: true,
                onchange: (e) => {
                  e.target.checked ? chosen.add(loc) : chosen.delete(loc);
                  updateButton();
                },
              }),
              h('strong', {}, ` ${lookup(loc).name}`),
              h('span', { class: 'muted' }, ` (${pulls.reduce((s, p) => s + p.qty, 0)})`),
            ),
            h('ul', {}, [...pulls].sort(byCardName(cards)).map((p) => stackLine(p, cards.get(p.entry.scryfallId)))),
          ),
        ),
      ),
      plan.missing ? h('p', { class: 'warn-text' }, `${plan.missing} cards aren’t in your collection outside other decks.`) : null,
      otherDecks.length
        ? h(
            'details',
            {},
            h('summary', {}, `${otherDecks.length} of the missing cards are in other decks`),
            h(
              'ul',
              {},
              otherDecks.map((r) => h('li', {}, `${r.card.name}: ${r.inOtherDecks.map((o) => `${lookup(o.location).name} ×${o.qty}`).join(', ')}`)),
            ),
          )
        : null,
      button,
    ),
  });
  updateButton();
}

/** Cards in the deck's location that the list no longer needs go back where they came from. */
export async function openSendBackDialog(deck, plan, cards) {
  const lookup = await locations.lookup();
  const exists = await locations.existsCheck();
  const groups = [...groupBy(plan.extras, (x) => returnTarget(x.entry, exists))].sort((a, b) => lookup(a[0]).name.localeCompare(lookup(b[0]).name));
  const dlg = modal({
    title: `Send back cards from ${deck.name}`,
    content: h(
      'form',
      {
        class: 'stack',
        onsubmit: action(async (e) => {
          e.preventDefault();
          const n = await locations.sendBack(plan.extras);
          toast(`Sent back ${n} cards`);
          dlg.dismiss();
        }),
      },
      h('p', { class: 'muted' }, 'These cards are in the deck but not on its list anymore.'),
      groups.map(([to, items]) =>
        h('section', { class: 'pull-group' }, h('strong', {}, `To ${lookup(to).name}`), h('ul', {}, [...items].sort(byCardName(cards)).map((x) => stackLine(x, cards.get(x.entry.scryfallId))))),
      ),
      h('button', { class: 'btn btn-primary', type: 'submit' }, `Send back ${plan.extraCount} cards`),
    ),
  });
}
