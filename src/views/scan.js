// Scan cards with the camera (or photos) into a location or a deck. Nothing is saved until the review's Save.
import { h } from '../dom.js';
import * as account from '../account.js';
import * as collection from '../collection.js';
import * as decks from '../decks.js';
import { navigate } from '../router.js';
import { action, confirmDialog, lockedBanner, dropdown, field } from '../components.js';
import { cardImage } from '../card-utils.js';
import { FORMATS, FORMAT_LABELS } from '../constants.js';
import { locationPicker } from './location-ui.js';
import { askName, askPrinting, pickCard, RESCAN } from './scan-dialogs.js';
import { renderReview, targetName, targetKind, deckModeText, describe } from './scan-review.js';
import { loadSession, saveSession, clearSession } from '../scan/session.js';
import { newSession, addScan, undoLast, replaceItem, scannedCount, itemKey } from '../scan/session-logic.js';
import { finishFor, hamming } from '../scan/match.js';
import { REGIONS, coverToSource, centeredCard, region } from '../scan/geometry.js';
import { openCamera, grabFrame, photoCanvas } from '../scan/camera.js';
import { ocrWorker } from '../scan/ocr.js';
import { nameIndex, readName, identifyPrinting, regionHash } from '../scan/identify.js';

// Below this, ask instead of guessing.
const THRESHOLD = 0.8;
const AUTO_EVERY_MS = 250;
const NEW_DECK = '__new__';
const DECK_MODES = [
  ['add', 'Add cards to the deck', 'Scan the cards you’re putting in. Nothing is taken out.'],
  ['replace', 'Rescan the whole deck', 'Scan every card. Anything you don’t scan is taken out of the deck.'],
];
const pct = (n) => `${Math.round(n * 100)}%`;

export default async function scanView(root, { query }) {
  if (!account.canEdit()) {
    root.append(lockedBanner() ?? '', h('h1', {}, 'Scan cards'), h('p', {}, 'Log in with your nsec to scan cards.'));
    return undefined;
  }
  let stop = null;
  async function show(screen, ...args) {
    stop?.();
    stop = null;
    root.replaceChildren();
    window.scrollTo(0, 0);
    stop = (await screen(...args)) ?? null;
  }

  // ---------------------------------------------------------------- resume

  async function resumeScreen(session) {
    const target = await targetName(session);
    const count = scannedCount(session);
    root.append(
      h('h1', {}, 'Scan cards'),
      h(
        'section',
        { class: 'panel stack' },
        h('p', {}, `You have an unsaved scan of ${count} ${count === 1 ? 'card' : 'cards'} for ${targetKind(session)}“${target}”${session.recount ? ' (recount)' : ''}${session.mode === 'deck' ? ` (${deckModeText(session)})` : ''}. Nothing from it has been saved yet.`),
        h(
          'div',
          { class: 'row wrap' },
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => show(scannerScreen, session) }, 'Keep scanning'),
          h('button', { class: 'btn', type: 'button', onclick: () => show(reviewScreen, session) }, 'Review and save'),
          h(
            'button',
            {
              class: 'btn btn-danger',
              type: 'button',
              onclick: action(async () => {
                if (!(await confirmDialog('Discard this scan? Nothing has been saved from it.', { confirmLabel: 'Discard', danger: true }))) return;
                await clearSession();
                show(setupScreen);
              }),
            },
            'Discard',
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- setup

  async function setupScreen() {
    const deckList = (await decks.list()).sort((a, b) => a.name.localeCompare(b.name));
    let mode = query.get('deck') ? 'deck' : 'collection';
    let deckId = deckList.some((d) => d.id === query.get('deck')) ? query.get('deck') : (deckList[0]?.id ?? NEW_DECK);
    const picker = await locationPicker(query.get('location') ?? '', { label: 'Location', includeDecks: false });
    const recount = h('input', { type: 'checkbox' });
    const body = h('div', { class: 'stack' });
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'What to scan' });

    const newName = h('input', { type: 'text', maxlength: 100, placeholder: 'e.g. Odric Soldiers' });
    let newFormat = FORMATS[0];
    const newFields = h(
      'div',
      { class: 'stack', hidden: deckId !== NEW_DECK },
      field('Deck name', newName),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Format'), dropdown(FORMATS.map((f) => [f, FORMAT_LABELS[f]]), newFormat, (v) => (newFormat = v), { label: 'Format' })),
    );
    const deckPicker = dropdown(
      [[NEW_DECK, '+ New deck…'], ...deckList.map((d) => [d.id, d.name])],
      deckId,
      (v) => {
        deckId = v;
        newFields.hidden = v !== NEW_DECK;
        deckModes.hidden = v === NEW_DECK;
        if (v === NEW_DECK) newName.focus();
      },
      { label: 'Deck' },
    );
    let deckMode = 'add';
    const deckModes = h(
      'fieldset',
      { class: 'stack scan-deck-modes', hidden: deckId === NEW_DECK },
      h('legend', {}, 'What are you doing?'),
      DECK_MODES.map(([value, label, hint]) =>
        h(
          'label',
          { class: 'check' },
          h('input', { type: 'radio', name: 'deck-mode', value, checked: value === deckMode, onchange: () => (deckMode = value) }),
          h('span', {}, h('strong', {}, label), h('br'), h('span', { class: 'muted small' }, hint)),
        ),
      ),
    );

    function render() {
      seg.replaceChildren(
        ...[
          ['collection', 'Add to collection'],
          ['deck', 'Scan a deck'],
        ].map(([m, label]) =>
          h(
            'button',
            {
              type: 'button',
              class: mode === m ? 'active' : '',
              'aria-pressed': String(mode === m),
              onclick: () => {
                mode = m;
                render();
              },
            },
            label,
          ),
        ),
      );
      if (mode === 'collection') {
        body.replaceChildren(
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Put the cards in'), picker.el),
          h('p', { class: 'muted small' }, 'Each card you scan is added as a copy (near mint, English) in that location.'),
          h('label', { class: 'check' }, recount, 'Recount this location'),
          h('p', { class: 'muted small' }, 'Recount: the location ends up holding exactly what you scan. Cards there that you don’t scan are removed from your collection. Basic lands are left alone.'),
        );
      } else {
        body.replaceChildren(
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Deck'), deckPicker),
          newFields,
          deckModes,
          h(
            'p',
            { class: 'muted small' },
            'Scanned copies are moved into the deck from your binders, and ones you don’t own yet are added. A new deck is only created when you save. Basic lands are skipped.',
          ),
        );
      }
    }
    render();

    root.append(
      h('h1', {}, 'Scan cards'),
      h(
        'section',
        { class: 'panel stack scan-setup' },
        seg,
        body,
        h(
          'div',
          { class: 'row end' },
          h(
            'button',
            {
              class: 'btn btn-primary',
              type: 'button',
              onclick: action(async () => {
                let session;
                if (mode === 'deck' && deckId === NEW_DECK) {
                  const name = newName.value.trim().replace(/\s+/g, ' ');
                  if (!name) throw new Error('Give the new deck a name.');
                  session = newSession({ mode, newDeck: { name, format: newFormat } });
                } else if (mode === 'deck') {
                  session = newSession({ mode, deckId, deckMode });
                } else {
                  session = newSession({ mode, location: await picker.value(), recount: recount.checked });
                }
                await saveSession(session);
                show(scannerScreen, session);
              }),
            },
            'Start scanning',
          ),
        ),
      ),
      h('p', { class: 'muted small' }, 'Nothing changes in your collection or decks until you review the scan and save it. The first scan downloads the text reader (about 7 MB), which is then kept on this device.'),
    );
  }

  // ---------------------------------------------------------------- scanner

  async function scannerScreen(session) {
    const target = await targetName(session);
    const owned = new Set((await collection.entries()).map((e) => e.scryfallId));
    let foil = false;
    let busy = false;
    let cam = null;
    let closed = false;

    const video = h('video', { class: 'scan-video', autoplay: true, muted: true, playsinline: true, 'aria-label': 'Camera view' });
    const guide = h('div', { class: 'scan-guide', 'aria-hidden': 'true' }, h('div', { class: 'scan-guide-title' }));
    const flash = h('div', { class: 'scan-flash', 'aria-hidden': 'true' });
    const counter = h('div', { class: 'scan-counter', 'aria-hidden': 'true' });
    const viewport = h('div', { class: 'scan-viewport' }, video, guide, counter, flash);
    const status = h('p', { class: 'scan-status', role: 'status', 'aria-live': 'polite' }, 'Starting the camera…');
    const loadNote = h('p', { class: 'muted small', hidden: true });
    const timing = h('p', { class: 'muted small scan-timing', hidden: true });
    const result = h('div', { class: 'scan-result', hidden: true });
    const reviewBtn = h('button', { class: 'btn', type: 'button', onclick: () => show(reviewScreen, session) });
    const extras = h('div', { class: 'row wrap' });
    const tip = h('p', { class: 'muted small' }, 'Tap the card to focus. Glare on the name? Tilt the card slightly away from the light, turn Light off, or lower Brightness.');

    const scanBtn = h('button', { class: 'btn btn-primary scan-btn', type: 'button', disabled: true, onclick: () => captureVideo() }, 'Scan');
    const foilBtn = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        'aria-pressed': 'false',
        title: 'Foil can’t be seen reliably by the camera, so set it here',
        onclick: () => {
          foil = !foil;
          foilBtn.setAttribute('aria-pressed', String(foil));
          foilBtn.classList.toggle('btn-primary', foil);
          foilBtn.textContent = foil ? 'Foil: on' : 'Foil: off';
        },
      },
      'Foil: off',
    );
    const photoInput = h('input', {
      type: 'file',
      accept: 'image/*',
      hidden: true,
      onchange: action(async () => {
        const file = photoInput.files?.[0];
        photoInput.value = '';
        if (!file || busy) return;
        const canvas = await photoCanvas(file);
        // Photos have no guide; try the card filling the picture, then smaller.
        await identifyAndAdd(canvas, [1, 0.8, 0.6].map((f) => centeredCard(canvas.width, canvas.height, f)), { photo: true });
      }),
    });
    const photoBtn = h('label', { class: 'btn' }, 'Use a photo', photoInput);
    const undoBtn = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: action(async () => {
          const key = undoLast(session);
          if (!key) return;
          await saveSession(session);
          armed = true;
          lastAddedName = null;
          result.hidden = true;
          status.textContent = 'Removed the last scan.';
          update();
        }),
      },
      'Undo last',
    );

    function update() {
      const n = scannedCount(session);
      reviewBtn.textContent = `Review and save (${n})`;
      counter.textContent = `${n} scanned`;
      counter.hidden = !n;
      undoBtn.disabled = !session.log.length || busy;
      scanBtn.disabled = busy || !cam;
      viewport.classList.toggle('busy', busy);
    }

    function titleCrop(source, rect) {
      const r = region(rect, REGIONS.title);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(Math.min(480, r.w));
      canvas.height = Math.round((canvas.width * r.h) / r.w);
      canvas.getContext('2d').drawImage(source, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height);
      return canvas;
    }

    let flashTimer = null;
    /** Green frame, a banner with the card over the camera, a counter bump, and a buzz. */
    function celebrate(card, finish) {
      flash.replaceChildren(
        h('img', { src: cardImage(card, 'small'), alt: '', width: 52, height: 73 }),
        h(
          'div',
          {},
          h('span', { class: 'scan-flash-check' }, '✓ Added'),
          h('strong', {}, card.name),
          h('span', { class: 'small' }, `${card.set.toUpperCase()} #${card.collector_number}${finish !== 'nonfoil' ? ` · ${finish}` : ''}`),
        ),
      );
      // Restart the animations even when scans come back to back.
      viewport.classList.remove('hit');
      counter.classList.remove('bump');
      void viewport.offsetWidth;
      viewport.classList.add('hit');
      counter.classList.add('bump');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => viewport.classList.remove('hit'), 2600);
      navigator.vibrate?.(80);
      showFullCard(card);
    }

    let bigCard = null;
    /** The whole card, the size of the guide, held a moment and then shrunk into the banner's thumbnail. */
    function showFullCard(card) {
      bigCard?.remove();
      const src = cardImage(card, 'normal');
      if (!src || viewport.hidden) return;
      const vp = viewport.getBoundingClientRect();
      const g = guide.getBoundingClientRect();
      const img = h('img', {
        class: 'scan-big',
        src,
        alt: '',
        'aria-hidden': 'true',
        style: `left:${g.left - vp.left}px;top:${g.top - vp.top}px;width:${g.width}px;height:${g.height}px`,
      });
      bigCard = img;
      // A late image popping up over the next card would be confusing, so give up after a moment.
      const deadline = Date.now() + 800;
      const play = () => {
        if (bigCard !== img || Date.now() > deadline) return;
        viewport.append(img);
        // Offsets ignore the banner's slide-in, so this is where the thumbnail comes to rest.
        const thumb = flash.querySelector('img');
        const tx = flash.offsetLeft + thumb.offsetLeft - (g.left - vp.left);
        const ty = flash.offsetTop + thumb.offsetTop - (g.top - vp.top);
        const end = matchMedia('(prefers-reduced-motion: reduce)').matches
          ? { opacity: 0 }
          : { opacity: 0.9, transform: `translate(${tx}px, ${ty}px) scale(${thumb.offsetWidth / g.width})` };
        img
          .animate(
            [
              { opacity: 0, transform: 'scale(0.97)', offset: 0 },
              { opacity: 1, transform: 'none', offset: 0.12 },
              { opacity: 1, transform: 'none', offset: 0.6 },
              { ...end, offset: 1 },
            ],
            { duration: 1300, easing: 'ease-in-out', fill: 'forwards' },
          )
          .finished.finally(() => img.remove());
      };
      if (img.complete) play();
      else img.onload = play;
    }

    function showResult(card, finish, { nameConf, printConf, sameArt = 0 }) {
      const key = itemKey(card.id, finish);
      result.hidden = false;
      result.replaceChildren(
        h('img', { class: 'scan-result-img', src: cardImage(card, 'normal'), alt: card.name, width: 244, height: 340 }),
        h(
          'div',
          { class: 'stack' },
          h('strong', {}, card.name),
          h('span', { class: 'muted small' }, `${card.set_name} · ${card.set.toUpperCase()} #${card.collector_number}${finish !== 'nonfoil' ? ` · ${finish}` : ''}`),
          h(
            'div',
            { class: 'row wrap' },
            h('span', { class: 'chip' }, nameConf == null ? 'Name: picked' : `Name ${pct(nameConf)}`),
            h('span', { class: 'chip' }, printConf == null ? 'Printing: picked' : `Printing ${pct(printConf)}`),
          ),
          sameArt > 1 && printConf != null ? h('p', { class: 'muted small' }, `${sameArt} printings share this art, so the set is a best guess. Use “Wrong card?” if it’s a different one.`) : null,
          h(
            'button',
            {
              class: 'btn btn-small',
              type: 'button',
              onclick: action(async () => {
                const next = await pickCard(card);
                if (!next) return;
                const nextFinish = finishFor(next, finish !== 'nonfoil');
                replaceItem(session, key, next, nextFinish, 1);
                await saveSession(session);
                showResult(next, nextFinish, { nameConf: null, printConf: null });
                status.textContent = `Changed to ${next.name}.`;
                update();
              }),
            },
            'Wrong card?',
          ),
        ),
      );
    }

    async function identifyAndAdd(source, rects, { auto = false, photo = false } = {}) {
      if (busy) return;
      busy = true;
      update();
      let rescan = false;
      try {
        status.textContent = 'Reading the name…';
        const t0 = performance.now();
        const read = await readName(source, rects, { quick: auto });
        const t1 = performance.now();
        const rect = read?.rect ?? rects[0];
        let name = read?.matches[0]?.name;
        let nameConf = read?.confidence ?? 0;
        if (!name || nameConf < THRESHOLD) {
          // Auto-scan fires on anything steady in the frame, so it never interrupts with a question.
          if (auto) {
            status.textContent = 'Can’t read the name yet. Fit the card to the frame and hold it steady, or tap Scan to pick it.';
            return;
          }
          name = await askName(read, titleCrop(source, rect));
          nameConf = null;
          if (name === RESCAN) {
            rescan = true;
            return;
          }
          if (!name) {
            status.textContent = 'Skipped. Ready for the next card.';
            return;
          }
        }
        // The same card still sitting in view after a small nudge isn't a second copy.
        if (auto && name === lastAddedName && !changedSinceScan) {
          armed = false;
          status.textContent = `${name} is still in view. Swap in the next card.`;
          return;
        }
        status.textContent = `Finding which printing of ${name}…`;
        const t2 = performance.now();
        const found = await identifyPrinting(source, rect, name, owned);
        const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
        timing.hidden = false;
        timing.textContent = `Name ${secs(t1 - t0)} · printing ${secs(performance.now() - t2)}`;
        if (found.basic) {
          status.textContent = `${name}: basic lands aren’t tracked by scanning, so it was skipped.`;
          return;
        }
        let card = found.card;
        let printConf = found.confidence;
        if (printConf < THRESHOLD) {
          card = await askPrinting(found.candidates, { suggested: found.card, rescan: true, note: `Couldn’t tell which printing of ${name} this is. Tap the one you have.` });
          printConf = null;
          if (card === RESCAN) {
            rescan = true;
            return;
          }
          if (!card) {
            status.textContent = 'Skipped. Ready for the next card.';
            return;
          }
        }
        const finish = finishFor(card, foil);
        addScan(session, card, finish);
        await saveSession(session);
        // Same area the auto-scan loop compares against (the guide), not the detected card outline.
        lastScanSig = regionHash(source, rects[0]);
        armed = false;
        lastAddedName = name;
        changedSinceScan = false;
        pauseUntil = Date.now() + 400;
        if (closed) return;
        celebrate(card, finish);
        showResult(card, finish, { nameConf, printConf, sameArt: printConf == null ? 0 : found.sameArt });
        status.textContent = `Added ${describe(card, finish)}. ${auto ? 'Swap in the next card.' : 'Ready for the next card.'}`;
      } catch (err) {
        console.error(err);
        status.textContent = `Couldn’t identify the card: ${err.message}`;
      } finally {
        busy = false;
        update();
        if (rescan) scanAgain(photo);
      }
    }

    function guideInVideo() {
      const box = video.getBoundingClientRect();
      const g = guide.getBoundingClientRect();
      return coverToSource({ w: video.videoWidth, h: video.videoHeight }, { w: box.width, h: box.height }, { x: g.left - box.left, y: g.top - box.top, w: g.width, h: g.height });
    }

    function captureVideo(auto = false) {
      if (!cam || busy || !video.videoWidth) return;
      identifyAndAdd(grabFrame(video), [guideInVideo()], { auto });
    }

    /** After “Scan again”: read the next steady view right away (auto), or take a new frame after a moment to re-aim. */
    function scanAgain(photo) {
      if (photo || !cam) {
        status.textContent = 'Choose another photo of the card.';
        return;
      }
      status.textContent = 'Scanning again… hold the card steady in the frame.';
      armed = true;
      steady = 0;
      lastTry = { sig: null, at: 0 };
      if (!auto) setTimeout(() => captureVideo(), 600);
    }

    // Auto-scan: read the card once the view holds still, then wait for the view to change (the next card)
    // so a card left in place isn't counted twice.
    let auto = true;
    let ocrReady = false;
    let armed = true;
    let lastScanSig = null;
    let prevSig = null;
    let steady = 0;
    let lastTry = { sig: null, at: 0 };
    let pauseUntil = 0;
    let lastAddedName = null;
    // Whether the view has changed a lot (card taken away or swapped) since the last card was added.
    let changedSinceScan = true;
    function tick() {
      if (closed) return;
      setTimeout(tick, AUTO_EVERY_MS);
      if (!auto || busy || !cam || !ocrReady || !video.videoWidth || document.hidden || document.querySelector('dialog[open]')) return;
      if (Date.now() < pauseUntil) return;
      const sig = regionHash(video, guideInVideo());
      const moved = prevSig ? hamming(sig, prevSig) : 64;
      prevSig = sig;
      if (lastScanSig && hamming(sig, lastScanSig) > 24) changedSinceScan = true;
      if (!armed) {
        if (lastScanSig && hamming(sig, lastScanSig) <= 14) return;
        armed = true;
      }
      // dHash flips a few bits from hand shake alone; real movement flips many more.
      steady = moved <= 7 ? steady + 1 : 0;
      if (steady < 1) return;
      // Don't keep re-reading an unreadable view (an empty table, say) more than about once a second.
      if (lastTry.sig && hamming(sig, lastTry.sig) <= 6 && Date.now() - lastTry.at < 1000) return;
      lastTry = { sig, at: Date.now() };
      steady = 0;
      captureVideo(true);
    }
    const autoBtn = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        'aria-pressed': 'true',
        title: 'Scan automatically when a card is held steady in the frame',
        onclick: () => {
          auto = !auto;
          autoBtn.setAttribute('aria-pressed', String(auto));
          autoBtn.textContent = auto ? 'Auto: on' : 'Auto: off';
        },
      },
      'Auto: on',
    );

    root.append(
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Scanning'), h('p', { class: 'muted small' }, `${session.newDeck ? 'New deck' : session.mode === 'deck' ? 'Deck' : 'Into'}: ${target}${session.recount ? ' (recount)' : ''}${session.mode === 'deck' && !session.newDeck ? ` · ${deckModeText(session)}` : ''}`)), reviewBtn),
      h(
        'div',
        { class: 'scan-layout' },
        h('div', { class: 'stack' }, viewport, status, timing, loadNote, h('div', { class: 'row wrap scan-controls' }, scanBtn, autoBtn, foilBtn, photoBtn, undoBtn), extras, tip),
        result,
      ),
    );
    update();
    tick();

    const cameraName = (d, i) => (d.label ? d.label.replace(/^camera2 (\d+), facing back$/i, 'Rear camera $1') : `Camera ${i + 1}`);
    const slider = (label, r, onInput) =>
      h('label', { class: 'row' }, label, h('input', { type: 'range', min: r.min, max: r.max, step: r.step, value: r.value, oninput: (e) => onInput(Number(e.target.value)) }));

    function focusOn(clientX, clientY) {
      if (!cam || !video.videoWidth) return;
      const box = video.getBoundingClientRect();
      const p = coverToSource({ w: video.videoWidth, h: video.videoHeight }, { w: box.width, h: box.height }, { x: clientX - box.left, y: clientY - box.top, w: 0, h: 0 });
      cam.focusAt(p.x / video.videoWidth, p.y / video.videoHeight);
    }
    viewport.addEventListener('click', (e) => {
      focusOn(e.clientX, e.clientY);
      const box = viewport.getBoundingClientRect();
      const ring = h('div', { class: 'scan-focus-ring', 'aria-hidden': 'true', style: `left:${e.clientX - box.left}px;top:${e.clientY - box.top}px` });
      viewport.append(ring);
      setTimeout(() => ring.remove(), 800);
    });

    // Camera and the text reader start together; the first scan waits for whichever isn't ready.
    async function startCamera(deviceId) {
      cam?.stop();
      cam = null;
      update();
      let c;
      try {
        c = await openCamera(video, { deviceId });
      } catch (err) {
        viewport.hidden = true;
        status.textContent = `${err.message} You can still scan from photos.`;
        return;
      }
      if (closed) return c.stop();
      cam = c;
      viewport.hidden = false;
      status.textContent = c.autofocus
        ? 'Hold a card inside the frame. It scans when the card is steady, or tap Scan.'
        : 'This camera can’t autofocus. Hold the card a little farther away, or pick another camera below.';

      const controls = [];
      if (c.cameras.length > 1) {
        controls.push(
          h(
            'div',
            { class: 'row' },
            'Camera',
            dropdown(
              c.cameras.map((d, i) => [d.deviceId, cameraName(d, i)]),
              c.deviceId,
              (v) => v !== c.deviceId && startCamera(v),
              { label: 'Camera' },
            ),
          ),
        );
      }
      if (c.torch) {
        let on = false;
        const torchBtn = h(
          'button',
          {
            class: 'btn',
            type: 'button',
            'aria-pressed': 'false',
            onclick: () => {
              on = !on;
              c.setTorch(on);
              torchBtn.setAttribute('aria-pressed', String(on));
              torchBtn.textContent = on ? 'Light: on' : 'Light: off';
            },
          },
          'Light: off',
        );
        controls.push(torchBtn);
      }
      if (c.exposure) controls.push(slider('Brightness', c.exposure, (v) => c.setExposure(v)));
      if (c.zoom) controls.push(slider('Zoom', c.zoom, (v) => c.setZoom(v)));
      extras.replaceChildren(...controls);
      // Focus and meter on the name, which is what has to be readable.
      requestAnimationFrame(() => {
        const t = guide.querySelector('.scan-guide-title').getBoundingClientRect();
        focusOn(t.left + t.width / 2, t.top + t.height / 2);
      });
      update();
    }
    startCamera();
    loadNote.hidden = false;
    loadNote.textContent = 'Loading the text reader…';
    Promise.all([
      nameIndex(),
      ocrWorker((what, progress) => {
        if (/load/i.test(what) && progress < 1) loadNote.textContent = `Loading the text reader (first time only)… ${pct(progress)}`;
      }),
    ]).then(
      () => {
        loadNote.hidden = true;
        ocrReady = true;
      },
      (err) => {
        console.error(err);
        loadNote.textContent = `Couldn’t load the text reader: ${err.message}`;
      },
    );

    return () => {
      closed = true;
      cam?.stop();
    };
  }

  // ---------------------------------------------------------------- review

  async function reviewScreen(session) {
    await renderReview(root, session, {
      onScanMore: () => show(scannerScreen, session),
      onDiscard: () => show(setupScreen),
      onSaved: (path) => navigate(path),
    });
  }

  const existing = await loadSession();
  // A session with nothing scanned isn't worth resuming.
  if (existing && !existing.items.length) await clearSession();
  const session = existing?.items.length ? existing : null;
  await show(session ? resumeScreen : setupScreen, session);
  return () => stop?.();
}
