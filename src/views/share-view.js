import { h } from '../dom.js';
import * as account from '../account.js';
import * as collection from '../collection.js';
import * as decks from '../decks.js';
import * as shares from '../shares.js';
import { getCards } from '../scryfall.js';
import { navigate } from '../router.js';
import { loading, action, toast } from '../components.js';
import { deckList, deckAnalytics } from './deck-panels.js';
import { collectionBrowser, browserState } from './collection-browser.js';
import { lineKey } from '../merge.js';
import { timeAgo } from '../util.js';

function inactive(root) {
  root.replaceChildren(
    h(
      'section',
      { class: 'narrow empty' },
      h('h1', {}, 'This link is no longer active'),
      h('p', {}, 'The owner may have stopped sharing it, or it expired (links last 30 days).'),
      h('a', { class: 'btn', href: '#/' }, 'Go home'),
    ),
  );
}

export default async function shareView(root, { params: [naddr, key] }) {
  root.append(loading('Opening shared link…'));
  let data;
  try {
    data = await shares.loadShared(naddr, key);
  } catch (err) {
    if (!(err instanceof shares.InactiveShareError)) console.error(err);
    return inactive(root);
  }
  const { manifest, entries, pubkey, updatedAt } = data;
  const ownedByOracle = account.current() ? await collection.ownedByOracle() : null;

  const header = h(
    'div',
    { class: 'page-head' },
    h(
      'div',
      {},
      h('h1', {}, manifest.title || (manifest.type === 'deck' ? 'Shared deck' : 'Shared collection')),
      h('p', { class: 'muted' }, `Shared by `, h('span', { class: 'mono' }, account.shortNpub(pubkey)), ` · Updated ${timeAgo(updatedAt)} · read-only`),
    ),
  );

  if (manifest.type === 'deck') {
    const deck = {
      id: 'shared',
      name: manifest.deck.name,
      format: manifest.deck.format,
      description: manifest.deck.description ?? '',
      lines: Object.fromEntries(
        manifest.deck.lines.map(([scryfallId, section, qty]) => [lineKey(scryfallId, section), { scryfallId, section, qty, updatedAt: 0 }]),
      ),
    };
    const cards = await getCards(Object.values(deck.lines).map((l) => l.scryfallId));
    if (account.canEdit()) {
      header.append(
        h(
          'button',
          {
            class: 'btn btn-primary',
            type: 'button',
            onclick: action(async () => {
              const copy = await decks.create({ name: `${deck.name} (copy)`, format: deck.format, description: deck.description });
              await decks.importLines(copy.id, Object.values(deck.lines));
              toast('Copied to your decks');
              navigate(`/decks/${copy.id}`);
            }),
          },
          'Copy to my decks',
        ),
      );
    }
    root.replaceChildren(
      ...[
        header,
        deck.description ? h('p', { class: 'description-text' }, deck.description) : null,
        h(
          'div',
          { class: 'builder builder-readonly', dataset: { active: 'deck' } },
          h('section', { class: 'builder-col builder-list' }, deckList(deck, cards, { readOnly: true, ownedByOracle })),
          h('section', { class: 'builder-col builder-stats' }, deckAnalytics(deck, cards, { ownedByOracle })),
        ),
      ].filter(Boolean),
    );
    return;
  }

  root.replaceChildren(header, loading(`Loading ${entries.length} cards…`));
  const cards = await getCards(entries.map((e) => e.scryfallId));
  const browser = collectionBrowser({ state: browserState(), readOnly: true, ownedOverlay: ownedByOracle });
  root.replaceChildren(header, browser.el);
  browser.setData(entries, cards);
  return () => browser.destroy();
}
