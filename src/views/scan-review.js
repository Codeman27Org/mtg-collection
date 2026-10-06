// Review a scan session and save it. Nothing is written to the collection or decks before Save here.
import { h } from '../dom.js';
import * as decks from '../decks.js';
import * as locations from '../locations.js';
import { getCards } from '../scryfall.js';
import { action, toast, confirmDialog, loading, dropdown } from '../components.js';
import { cardImage } from '../card-utils.js';
import { locationToken } from '../location-logic.js';
import { saveSession, clearSession } from '../scan/session.js';
import { setQty, replaceItem, scannedCount } from '../scan/session-logic.js';
import { planCollectionSave, saveCollectionScan, planDeckSave, saveDeckScan } from '../scan/apply.js';
import { pickCard } from './scan-dialogs.js';
import { SECTION_LABELS } from '../constants.js';

const FINISH_LABELS = { nonfoil: 'Nonfoil', foil: 'Foil', etched: 'Etched' };

/** “Lightning Bolt (M11 #146, foil)” */
export function describe(card, finish) {
  if (!card) return 'Unknown card';
  const extra = finish && finish !== 'nonfoil' ? `, ${finish}` : '';
  return `${card.name} (${card.set.toUpperCase()} #${card.collector_number}${extra})`;
}

/** Where a session's cards are going, for headings. */
export async function targetName(session) {
  if (session.newDeck) return session.newDeck.name;
  if (session.mode === 'deck') return (await decks.get(session.deckId))?.name ?? 'a deleted deck';
  return (await locations.lookup())(session.location).name;
}

/** “the deck ”, “the new deck ”, or nothing, to go before a target name. */
export const targetKind = (session) => (session.newDeck ? 'the new deck ' : session.mode === 'deck' ? 'the deck ' : '');

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export async function renderReview(root, session, { onScanMore, onDiscard, onSaved }) {
  const target = await targetName(session);
  const intro = h('p', { class: 'muted' });
  const list = h('div', { class: 'stack scan-items' });
  const savePanel = h('section', { class: 'panel stack' });
  root.append(
    h(
      'div',
      { class: 'page-head' },
      h('h1', {}, 'Review scan'),
      h(
        'div',
        { class: 'row wrap' },
        h('button', { class: 'btn', type: 'button', onclick: onScanMore }, 'Keep scanning'),
        h(
          'button',
          {
            class: 'btn btn-danger',
            type: 'button',
            onclick: action(async () => {
              if (!(await confirmDialog('Discard this scan? Nothing has been saved from it.', { confirmLabel: 'Discard', danger: true }))) return;
              await clearSession();
              onDiscard();
            }),
          },
          'Discard',
        ),
      ),
    ),
    intro,
    list,
    savePanel,
  );

  async function changed() {
    await saveSession(session);
    await render();
  }

  async function render() {
    const count = scannedCount(session);
    intro.textContent = `${plural(count, 'card')} for ${targetKind(session)}“${target}”${session.recount ? ' (recount)' : ''}. Nothing has changed yet; changes are made when you save.`;
    savePanel.replaceChildren(loading('Working out changes…'));
    const cards = await getCards(session.items.map((i) => i.scryfallId));
    let plan = null;
    let lookup = null;
    let planError = null;
    if (session.mode === 'deck' && session.items.length) {
      try {
        [plan, lookup] = await Promise.all([planDeckSave(session), locations.lookup()]);
      } catch (err) {
        planError = err;
      }
    }
    list.replaceChildren(
      ...(session.items.length
        ? session.items.map((item) => itemRow(item, cards.get(item.scryfallId), plan && sourceControl(item, plan, lookup)))
        : [h('p', { class: 'muted' }, 'Nothing scanned yet.')]),
    );
    try {
      if (planError) throw planError;
      savePanel.replaceChildren(...(session.mode === 'deck' ? deckSave(plan) : await collectionSave()).filter(Boolean));
    } catch (err) {
      savePanel.replaceChildren(h('div', { class: 'banner banner-error' }, err.message));
    }
  }

  /** Deck scans: where this card's copies come from (a binder, another deck, or new to the collection). */
  function sourceControl(item, plan, lookup) {
    const choice = plan.choices.get(item.key);
    if (!choice) return null;
    if (!choice.options.length) return h('p', { class: 'muted small scan-source' }, 'Already in this deck');
    const label = (o) => {
      if (o.value === 'new') return 'New card (add to collection)';
      if (o.value === 'loose') return `From ${o.locations.map((l) => lookup(l).name).join(', ')} (${o.qty} there)`;
      return `Take from ${lookup(o.value).name} (${o.qty} there)`;
    };
    return h(
      'div',
      { class: 'row wrap scan-source' },
      choice.kept ? h('span', { class: 'muted small' }, `${choice.kept} already in this deck; the rest:`) : null,
      dropdown(
        choice.options.map((o) => [o.value, label(o)]),
        choice.value,
        action(async (v) => {
          item.source = v;
          await changed();
        }),
        { label: `Where ${item.name} comes from` },
      ),
    );
  }

  function itemRow(item, card, source) {
    const finishes = card?.finishes?.length ? card.finishes : [item.finish];
    const finishCtl =
      finishes.length > 1
        ? dropdown(
            finishes.map((f) => [f, FINISH_LABELS[f] ?? f]),
            item.finish,
            action(async (f) => {
              replaceItem(session, item.key, card, f);
              await changed();
            }),
            { label: `Finish for ${item.name}` },
          )
        : h('span', { class: 'muted small' }, FINISH_LABELS[item.finish] ?? item.finish);
    const step = (delta) =>
      action(async () => {
        setQty(session, item.key, item.qty + delta);
        await changed();
      });
    return h(
      'div',
      { class: 'scan-item' },
      h('div', { class: 'thumb' }, card ? h('img', { src: cardImage(card, 'small'), alt: '', loading: 'lazy', width: 48, height: 67 }) : null),
      h('div', { class: 'result-info grow' }, h('span', { class: 'result-name' }, item.name), h('span', { class: 'muted small' }, card ? `${card.set_name} · ${card.set.toUpperCase()} #${card.collector_number}` : '')),
      finishCtl,
      h(
        'div',
        { class: 'row scan-qty' },
        h('button', { class: 'btn btn-small', type: 'button', 'aria-label': `One fewer ${item.name}`, onclick: step(-1) }, '−'),
        h('span', { 'aria-label': 'Quantity' }, String(item.qty)),
        h('button', { class: 'btn btn-small', type: 'button', 'aria-label': `One more ${item.name}`, onclick: step(1) }, '+'),
      ),
      h(
        'button',
        {
          class: 'btn btn-small',
          type: 'button',
          onclick: action(async () => {
            const next = await pickCard(card);
            if (!next) return;
            replaceItem(session, item.key, next, next.finishes?.includes(item.finish) ? item.finish : (next.finishes?.[0] ?? 'nonfoil'));
            await changed();
          }),
        },
        'Change',
      ),
      source,
    );
  }

  async function collectionSave() {
    const plan = await planCollectionSave(session);
    const count = scannedCount(session);
    if (!count) return [h('p', { class: 'muted' }, 'Scan some cards to save.')];
    if (plan.mode === 'merge') {
      return [
        h('h2', {}, 'Save'),
        h('p', {}, `Adds ${plural(count, 'card')} to ${target} (near mint, English).`),
        h(
          'div',
          { class: 'row end' },
          h(
            'button',
            {
              class: 'btn btn-primary',
              type: 'button',
              onclick: action(async () => {
                await saveCollectionScan(plan);
                await clearSession();
                toast(`Added ${plural(count, 'card')} to ${target}`);
                onSaved(`/collection?location=${encodeURIComponent(locationToken(session.location))}`);
              }),
            },
            `Add ${plural(count, 'card')}`,
          ),
        ),
      ];
    }
    const removedCards = await getCards(plan.removed.map((r) => r.entry.scryfallId));
    const removedCount = plan.removed.reduce((n, r) => n + r.qty, 0);
    const addedCount = plan.added.reduce((n, r) => n + r.qty, 0);
    return [
      h('h2', {}, 'Save recount'),
      h('p', {}, `${target} will hold exactly the ${plural(count, 'card')} you scanned (plus any basic lands already there): ${addedCount} new, ${removedCount} removed.`),
      plan.removed.length
        ? h(
            'details',
            {},
            h('summary', {}, `${plural(removedCount, 'card')} not scanned will be removed from your collection`),
            h('ul', { class: 'small' }, plan.removed.map((r) => h('li', {}, `${r.qty} × ${describe(removedCards.get(r.entry.scryfallId), r.entry.finish)}${r.entry.condition !== 'NM' ? `, ${r.entry.condition}` : ''}`))),
          )
        : null,
      h(
        'div',
        { class: 'row end' },
        h(
          'button',
          {
            class: 'btn btn-primary',
            type: 'button',
            onclick: action(async () => {
              if (removedCount && !(await confirmDialog(`Remove ${plural(removedCount, 'card')} that weren’t scanned from ${target}?`, { confirmLabel: 'Save recount', danger: true }))) return;
              await saveCollectionScan(plan);
              await clearSession();
              toast(`Recounted ${target}`);
              onSaved(`/collection?location=${encodeURIComponent(locationToken(session.location))}`);
            }),
          },
          'Save recount',
        ),
      ),
    ];
  }

  function deckSave(plan) {
    if (!plan) return [h('p', { class: 'muted' }, 'Scan some cards to save.')];
    const count = scannedCount(session);
    const section = (s) => (s === 'main' ? '' : ` (${SECTION_LABELS[s] ?? s})`);
    const nameOf = (l) => `${l.card?.name ?? 'Unknown card'}${section(l.section)}`;
    const total = (list) => list.reduce((n, x) => n + x.qty, 0);
    const fromBinders = total(plan.moves.filter((m) => !m.fromDeck));
    const fromDecks = total(plan.moves.filter((m) => m.fromDeck));
    const added = total(plan.adds);
    const parts = [
      plan.kept && `${plan.kept} already in the deck`,
      fromBinders && `${fromBinders} from your binders`,
      fromDecks && `${fromDecks} from other decks`,
      added && `${added} new to your collection`,
    ].filter(Boolean);
    const removed = plan.lines.filter((l) => l.checked && (l.kind === 'remove' || l.kind === 'fewer'));
    const keptCommanders = plan.lines.filter((l) => !l.checked);

    return [
      h('h2', {}, plan.deck.isNew ? `Create “${plan.deck.name}”` : 'Save to deck'),
      h('p', {}, `The deck list will match the ${plural(count, 'card')} you scanned${parts.length ? `: ${parts.join(', ')}.` : '.'}`),
      removed.length
        ? h('p', { class: 'small' }, `Not scanned, so taken out of the deck: ${removed.map((l) => (l.kind === 'remove' ? nameOf(l) : `${nameOf(l)} ${l.from} → ${l.to}`)).join(', ')}. Their copies go back to where they came from.`)
        : null,
      keptCommanders.length ? h('p', { class: 'muted small' }, `${keptCommanders.map(nameOf).join(', ')} wasn’t scanned but stays in the deck.`) : null,
      h('p', { class: 'muted small' }, 'Basic lands are left as they are.'),
      h(
        'div',
        { class: 'row end' },
        h(
          'button',
          {
            class: 'btn btn-primary',
            type: 'button',
            onclick: action(async () => {
              const deck = await saveDeckScan(plan);
              await clearSession();
              toast(`Saved the scan to ${deck.name}`);
              onSaved(`/decks/${deck.id}`);
            }),
          },
          plan.deck.isNew ? 'Create deck' : 'Save deck',
        ),
      ),
    ];
  }

  await render();
}
