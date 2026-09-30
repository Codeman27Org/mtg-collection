# Cody's MTG Collection

A personal Magic: The Gathering collection manager and deck builder that runs entirely in the browser. There's no app server: your collection and decks live in IndexedDB on each device and sync between devices through [Nostr](https://nostr.com) relays, encrypted so only your key can read them.

Card data, images, and prices come from [Scryfall](https://scryfall.com).

## Features

**Collection**
- Import any collection CSV (CardCastle, Moxfield, ManaBox, Archidekt, Deckbox, TCGplayer, …). Columns are detected by header name, and cards are matched by Scryfall ID, then set + collector number, then name.
- Grid and table views with local filters (color, type, rarity, set, mana value, finish, price, location, deck use) and grouping.
- Home dashboard: value by price tier and by location, most valuable cards, colors, types, rarity, top sets, mana curve, card age, and how much of the collection is in decks. Every bar links to the matching filtered view.

**Locations**
- Track where each physical copy is: binders and boxes you name, plus an automatic location for every deck.
- A card's details show where every copy is, and you can move copies one stack at a time or move everything that matches a filter.
- Import a CSV straight into a location, or read a `Binder`/`Location` column.

**Decks**
- Build from your collection or all of Scryfall, with format legality and commander color-identity filters.
- Formats: Commander, Tiny Leaders, Standard, Modern, Pioneer, Legacy, Vintage, Pauper, Brawl. Tiny Leaders isn't tracked by Scryfall, so its rules (50 cards, mana value 3 or less, Commander ban list) live in `src/formats.js`.
- Import lists from MTGA, Moxfield, Archidekt, or TappedOut text, `.csv`, or MTGO `.dek`, and optionally add the cards to your collection. Export as text, `.csv`, or `.dek`.
- Analytics: mana curve, color distribution, card types, average mana value, price, legality, and missing cards with the cost to complete.
- **Pull cards**: see exactly which binder each card is in, then move them into the deck. **Send back** returns cut cards to where they came from. The Decks page filters assembled vs. in-progress decks and sorts by recent edits, value, date added, or name.
- Basic lands aren't tracked by count unless a deck uses a specific printing you own, such as full-art foils.

**Scan**
- Scan cards with the phone camera (or from photos) into a binder, or recount a binder so it holds exactly what you scanned. Recounts keep each stack's condition and language, and leave basic lands alone.
- Scan a deck: the scanned cards become the deck list, and each copy is kept, moved in from a binder, taken from another deck (your choice), or added as new. Cards you didn't scan are sent back. Every change has its own checkbox.
- Each scan shows the matched card's image right away, so you can keep going. You're only asked when the name or printing is uncertain (under 80%). Nothing changes until you review and press **Save**, and an unfinished scan survives reloads.
- The name is read from the title bar with [Tesseract.js](https://github.com/naptha/tesseract.js), running on the device, and matched against Scryfall's name list. The printing comes from the set code and number on newer cards, otherwise from comparing the artwork. Foil can't be seen reliably, so it's a toggle.

**Sync and sharing**
- Your account is a Nostr key. Create one in the app or log in with an existing `nsec`.
- Changes save locally at once and sync in batches: after a minute without edits, whenever you leave the tab, or when you press **Sync now**.
- Share a deck or a filtered view of the collection with a secret link. Viewers don't need an account, and relays can't read what's shared. Links expire after 30 days and can be stopped at any time.
- Installable PWA that works offline.

## Getting started

Requires Node.js 20 or newer.

```sh
npm install
npm run dev        # http://localhost:5173
```

On first launch, choose **Create Account** (it shows your new `nsec` once; save it in a password manager) or **Log In** with an existing `nsec`. Then import a collection CSV from the Collection page.

Browsers only allow the camera on HTTPS pages, so to try scanning on a phone run `npm run dev:phone`. It serves HTTPS on your network with a self-signed certificate. Open the "Network" URL it prints on the phone (on the same Wi-Fi) and accept the certificate warning.

| Script | What it does |
|---|---|
| `npm run dev` | Start the Vite dev server |
| `npm run dev:phone` | Dev server over HTTPS on your network, for testing the camera on a phone |
| `npm run build` | Build static files into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Run the unit tests (`node --test`) |
| `npm run deploy` | Build and upload to S3 + CloudFront (see [Deploying](#deploying)) |

## Tech stack

- Vanilla JavaScript (ES modules), HTML, and CSS, with no framework. Charts are hand-built SVG.
- [Vite](https://vitejs.dev) for the dev server and build.
- [`idb`](https://github.com/jakearchibald/idb) for IndexedDB, [`nostr-tools`](https://github.com/nbd-wtf/nostr-tools) for keys, NIP-44 encryption, and relays, [Papa Parse](https://www.papaparse.com) for CSVs, and [`qrcode`](https://github.com/soldair/node-qrcode) for share and device QR codes.
- [Tesseract.js](https://github.com/naptha/tesseract.js) for reading card names. It's self-hosted, not loaded from a CDN: `scripts/ocr-assets.mjs` copies the worker, the WebAssembly engines, and the English model into `public/ocr/<versions>/` whenever Vite starts. It's only downloaded the first time you scan (about 7 MB), then cached on the device.

## Project structure

```
src/
  main.js              App shell, routes, sync indicator
  account.js           Keys, login, "remember me"
  sync.js              Nostr outbox/pull, batching, relay backoff and repair
  merge.js             Sync content builders, schema validation, last-write-wins merges
  collection.js        Collection store (stacks per printing, finish, condition, language, location)
  decks.js             Deck store
  locations.js         Binders/boxes, pulling cards into decks, sending them back
  location-logic.js    Pure deck pull plan and origin/return rules
  formats.js           Format rules, including Tiny Leaders
  scryfall.js          Scryfall API client with caching and rate limits
  csv-import.js        Generic CSV column detection and parsing
  deck-import.js       Deck list import and collection updates
  collection-stats.js  Dashboard numbers
  scan/                Card scanning: camera, OCR, name matching, printing choice, session, save plans
  views/               One module per page plus shared panels and dialogs
public/                Service worker, web manifest, icon (and generated OCR files in ocr/)
scripts/               Build helpers (OCR file copy)
tests/                 Unit tests for the pure modules
deploy/                Deploy script, CloudFormation stack, and CloudFront security headers
.github/workflows/     Deploys to AWS on every push to master
```

## How sync works

- **Local first.** IndexedDB is the source of truth, and the app works fully offline. Relays hold encrypted copies for backup and for syncing to your other devices.
- **Events.** Everything is published as NIP-78 app data (kind 30078), encrypted with NIP-44 to your own key. The collection is split into 16 shards by Scryfall ID to stay under relay size limits. Each deck, the location list, the share registry, and settings are separate events.
- **Merging.** Every collection stack and deck line has its own timestamp, and the newer one wins. Removals are kept as zero-quantity tombstones for 90 days so they sync too. Editing on two devices at once doesn't lose changes.
- **Being a good relay citizen.** Publishes are throttled to one every 2 seconds and 6 per minute. The budget is kept in `localStorage`, so reloads and extra tabs share it. Relays that reply `rate-limited` are paused for 10 minutes, and relays that reply `banned`, `blocked`, or `restricted` are paused for an hour. Events a relay is missing are re-sent at most 10 at a time, once an hour, and Settings flags relays that keep losing data. Reloading the page doesn't start a new sync if that account synced in the last minute.
- **Defaults.** `wss://relay.damus.io`, `wss://relay.primal.net`, `wss://nos.lol`, and `wss://nostr.mom`. Change them in Settings.

**What relays can see:** your public key, the number and size of your events, and when you edit. Card names, quantities, deck names, and shared content are encrypted.

## Security notes

- Use a key made for this app rather than your main Nostr identity. With "Remember me" on, the `nsec` is stored in this site's IndexedDB so the app opens logged in. Leave it off on shared computers.
- All untrusted text (CSV contents, anything decrypted from relays or share links) is rendered as text, never HTML, and relay content is schema-checked before it's merged.
- The production site sends a strict Content Security Policy with no inline or third-party scripts (`deploy/response-headers-policy.json`). Dependencies are bundled, not loaded from CDNs. The only allowance beyond `'self'` is `'wasm-unsafe-eval'`, which the OCR engine needs to run WebAssembly.
- The camera is only used on the Scan page, and frames never leave the device. Only the recognized card name is looked up on Scryfall.
- Your JSON backup (Settings → Backup) doesn't include your key.

## Deploying

The build is static files, hosted on AWS: a private S3 bucket behind CloudFront (Origin Access Control) with an ACM certificate for `mtg.cody-roof.com`. Any HTTPS static host works. Hash routing means no rewrite rules are needed.

The AWS resources are defined in `deploy/infra.yml` (CloudFormation stack `mtg-collection` in us-east-2): the bucket, the distribution with the security headers policy, the Route 53 records, and an IAM role that GitHub Actions assumes through OIDC. Only pushes to `master` of this repo can use the role, and it can only write to the bucket and invalidate the distribution.

Every push to `master` runs `.github/workflows/deploy.yml`, which tests, builds, and deploys. It needs three repository secrets: `AWS_ROLE_ARN`, `MTG_BUCKET`, and `MTG_DISTRIBUTION_ID` (the stack outputs `DeployRoleArn`, `BucketName`, and `DistributionId`). To deploy by hand instead:

```sh
MTG_BUCKET=<bucket> MTG_DISTRIBUTION_ID=<distribution id> npm run deploy
```

The script builds and uploads hashed assets and the versioned OCR files with a one-year immutable cache. It uploads `index.html`, `sw.js`, and the manifest with `no-cache`, and invalidates those on CloudFront. The headers policy (CSP, HSTS, `nosniff`, `no-referrer`, camera allowed for this site only) is in both `deploy/infra.yml` and `deploy/response-headers-policy.json`; keep them in sync.

Hosting the site on its own subdomain keeps its storage, service worker, and CSP separate from any other site on the domain.

## Roadmap

- Scanning: check a whole binder page in one photo.
- A personal relay on a home server, added alongside the public relays.
- NIP-07 browser extension and NIP-46 remote signer support.

## Credits

Card data and images are provided by [Scryfall](https://scryfall.com). This is a personal, non-commercial project and isn't affiliated with or endorsed by Wizards of the Coast. Magic: The Gathering is a trademark of Wizards of the Coast.
