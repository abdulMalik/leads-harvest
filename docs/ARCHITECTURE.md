# Architecture

How Leads Harvest is put together, for anyone modifying the code.

## Overview

Leads Harvest is a Manifest V3 Chrome extension with three runtime contexts that talk over `chrome.runtime` messages and `chrome.storage`:

```
┌─────────────┐   START_HARVEST / STOP / CLEAR   ┌──────────────────┐
│   popup.js  │ ───────────────────────────────► │   content.js     │
│  (UI/popup) │ ◄─────────────────────────────── │ (Google Maps tab)│
└─────┬───────┘   HARVEST_DONE / progress         └────────┬─────────┘
      │                                                     │ CRAWL_EMAILS
      │ reads/writes                                        ▼
      │ chrome.storage          ┌──────────────────────────────────────┐
      └────────────────────────►│           background.js              │
                                │  (service worker: enrichment + quota) │
                                └──────────────────────────────────────┘
```

There is no backend. All data lives in `chrome.storage` on the user's device.

## Files

| File | Context | Responsibility |
|---|---|---|
| `manifest.json` | — | MV3 manifest: permissions, content-script registration, service worker, icons. |
| `popup.html` / `styles.css` | Popup | UI markup and styling. |
| `popup.js` | Popup | Renders state, handles Start/Stop/Clear/Export buttons, builds CSV/JSON, feedback form. |
| `content.js` | Content script (Maps tab) | Scrolls results, extracts cards, opens detail panels, de-dupes, writes leads to storage. |
| `background.js` | Service worker | Email/social enrichment (two phases), free-quota accounting. |
| `social_classifier.js` | Shared | Classifies/normalizes social URLs. Loaded in all three contexts + Node tests. |
| `release.sh` | Dev tool | Builds the zip, tags, and publishes a GitHub release. |

### `social_classifier.js` is shared three ways
- Content script: listed in `manifest.content_scripts.js`.
- Service worker: `importScripts("social_classifier.js")`.
- Hidden enrichment tabs: injected via `chrome.scripting.executeScript({ files: [...] })`.
- Node test runner: `module.exports` (guarded so browser/SW contexts ignore it).

This keeps `classifySocial` / `extractSocials` / `extractSocialsFromElement` as one source of truth.

## Harvest flow (`content.js`)

1. **START_HARVEST** arms the harvester: clears in-memory state, preloads existing leads from storage into the `collected` Map (keyed by dedup key), records `originalSearchUrl`.
2. A **MutationObserver** on the results `[role="feed"]` (plus a 1.2s fallback timer) drives `tick()`:
   - `extractAll()` reads every visible card via `extractCardBasic()` → `parseCardText()`, de-dupes, and persists.
   - Scrolls the last card into view to trigger Maps' lazy-load.
   - Tracks `stableTicks`; after ~36s of no new leads it declares **end-of-results**.
3. **Deep harvest** (`deepHarvestPass`, run twice): for each lead missing phone/website, clicks its card, waits for the detail panel to *actually swap to that lead* (`panelMatchesLead` checks the `<h1>`), then extracts phone, website, full hours, address, rating, socials. Runs twice so the second pass retries panels that didn't open cleanly.
4. Fires **CRAWL_EMAILS** to the service worker, then `stop()`.

### Key correctness guards
- **De-dup key** (`dedupKeyFor`): Google place ID (`!1s0x…:0x…` from the URL) when present, else the URL. Collapses sponsored + organic duplicates.
- **Panel-swap verification** (`panelMatchesLead`): matches only the panel's primary `<h1>` — *not* `aria-label`s — because the "People also search for" tiles carry other businesses' names and caused data from the wrong lead to leak in.
- **Selector-health watchdog** (`checkSelectorHealth`): if the feed shows ≥3 cards but a pass parses 0, after 2 consecutive strikes it sets `selectorDegraded`, which surfaces the popup warning banner.
- **Ad-redirect filter** (`isAdRedirectUrl`): rejects `googleadservices`/`doubleclick`/etc. "Visit Site" tracker URLs instead of saving them as the website.

## Enrichment flow (`background.js`)

Emails aren't on Maps, so enrichment reads the business's own website. Triggered by `CRAWL_EMAILS`:

- **Phase 1 — `crawlAllEmails()`**: service-worker `fetch` (concurrency 3) of `/`, `/contact`, `/contact-us`, `/about`, `/about-us`. Greps HTML for emails (`mailto:` first) and social links. Stops early once it has an email + ≥3 socials. No tab lifecycle, but only sees server-rendered HTML.
- **Phase 2 — `deepEnrichLeads()`**: for leads still thin (no email or <2 socials), opens the site in a **hidden background tab**, waits for the footer to render, reads the live DOM via injected `extractInPage`, then closes the tab. Serial (hidden tabs are memory-heavy). Leads sharing a canonical website are visited once and the result fanned out.

### Email validation
- `isValidEmail` + `EMAIL_JUNK` filters reject placeholders, image filenames, Sentry/Wix tokens, calendar addresses.
- `emailMatchesSite` only accepts an email whose domain matches the site's root domain **or** is a known personal provider (`PERSONAL_EMAIL_HOSTS`). This filters out web-dev/agency leaks (e.g. `support@agency.com` in a client's footer).

### Merge rule
Enrichment never erases existing data: `lead.field = found || lead.field || ""`. Maps-panel socials captured by the content script survive even if a JS-rendered footer returns nothing.

## Storage schema

**`chrome.storage.local`** (per-device, the working set):

| Key | Meaning |
|---|---|
| `leads` | Array of lead objects (the harvest results). |
| `isHarvesting` | Whether a harvest is active (cleared on stale resume). |
| `selectorDegraded` | Selector watchdog tripped → show warning banner. |
| `limitReached` | Free quota hit during this run. |
| `emailCrawl` | `{ done, total, active, phase }` enrichment progress, or `null`. |
| `lastUpdated` | Timestamp of last lead write. |
| `lastHarvestReason` | `end-of-results` / `user-stopped` / `interrupted` — drives "Continue Harvesting". |

**`chrome.storage.sync`** (cross-device): `freeLeadsUsed` — single integer, the lifetime quota counter. Incremented in `background.js` on any positive change to `leads.length`.

## Messages

| Message | From → To | Purpose |
|---|---|---|
| `START_HARVEST` `{ limit, deepHarvest }` | popup → content | Begin harvesting. `limit` = existing + free-quota remaining. |
| `STOP_HARVEST` | popup → content | User stopped. |
| `CLEAR_LEADS` | popup → content | Drop in-memory `collected` map. |
| `HARVEST_DONE` `{ reason, limitReached }` | content → popup | Harvest finished/interrupted. |
| `CRAWL_EMAILS` | content → background | Kick off enrichment phases. |
| `EMAIL_PROGRESS` / `EMAIL_CRAWL_DONE` | background → popup | Enrichment progress + completion. |
| `LEADS_UPDATE` | content → popup | Leads written (popup also watches `storage.onChanged`). |

## Export (`popup.js`)

`EXPORT_HEADERS` defines the sales-priority column order. `buildExportRow` flattens each lead, `formatPhone` normalizes numbers, `splitHoursDetail` expands the stored hours JSON into `hours_mon…hours_sun`. CSV is UTF-8 with a BOM; both formats download via `chrome.downloads`. The `logo` field is deliberately excluded (URLs expire).

## Feedback form (`popup.js`)

The popup's Request a Feature / Report a Bug form POSTs `{ name, email, phone, message }` to **Web3Forms** (`api.web3forms.com`), which emails the submission to the support address. The access key is a public client key (send-only to the verified inbox). This is the only outbound call that leaves the user's machine with user-entered data — see [PRIVACY.md](../PRIVACY.md).

## Conventions

- All log lines are prefixed `[Leads Harvest]` for easy filtering in DevTools.
- New runtime files must be added to the `FILES=(…)` list in `release.sh` so they're packaged.
- `social_classifier.js`'s platform path-blocklists (e.g. Instagram `/p`, `/reel`) prevent post/share URLs from being mistaken for profile handles — extend these when adding platforms.
