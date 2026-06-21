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
| `popup.html` / `styles.css` | Popup | Tabbed UI (Scraper / Data / Settings) markup and styling. |
| `popup.js` | Popup | Renders state, tab switching, settings load/save, Start/Stop/Clear, data preview table, CSV/Excel/JSON export, feedback form. |
| `content.js` | Content script (Maps tab) | Scrolls results, extracts cards, opens detail panels, de-dupes, writes leads to storage. Honors fast mode + scan delay. |
| `background.js` | Service worker | Email/social enrichment (two phases), free-quota accounting. |
| `social_classifier.js` | Shared | Classifies/normalizes social URLs. Loaded in all three contexts + Node tests. |
| `xlsx.full.min.js` | Popup | Bundled SheetJS (Apache-2.0) for Excel export. Verified free of `eval`/`new Function` so it passes the MV3 CSP. |
| `release.sh` | Dev tool | Builds the Chrome zip, tags, and publishes a GitHub release. |
| `build-firefox.sh` | Dev tool | Generates a Firefox manifest (event-page background + gecko id) from `manifest.json` and zips a Firefox build. |

### `social_classifier.js` is shared three ways
- Content script: listed in `manifest.content_scripts.js`.
- Service worker: `importScripts("social_classifier.js")`.
- Hidden enrichment tabs: injected via `chrome.scripting.executeScript({ files: [...] })`.
- Node test runner: `module.exports` (guarded so browser/SW contexts ignore it).

This keeps `classifySocial` / `extractSocials` / `extractSocialsFromElement` as one source of truth.

## Harvest flow (`content.js`)

1. **START_HARVEST** arms the harvester: clears in-memory state, preloads existing leads from storage into the `collected` Map (keyed by dedup key), records `originalSearchUrl`, and reads the run options (`limit`, `fastMode`, `scanDelay`) from the message.
2. A **MutationObserver** on the results `[role="feed"]` (plus a `scanDelay`-interval fallback timer) drives `tick()`:
   - `extractAll()` reads every visible card via `extractCardBasic()` → `parseCardText()`, de-dupes, and persists.
   - Scrolls the last card into view to trigger Maps' lazy-load.
   - Tracks `stableTicks`; after `stableThreshold` ticks of no new leads it declares **end-of-results**. `stableThreshold` is derived from `scanDelay` (`≈36000/scanDelay`) so the ~36s window holds at any cadence.
3. **Deep harvest** (`deepHarvestPass`, run twice): for each lead missing phone/website, clicks its card, waits for the detail panel to *actually swap to that lead* (`panelMatchesLead` checks the `<h1>`), then extracts phone, website, full hours, address, rating, socials. Runs twice so the second pass retries panels that didn't open cleanly.
4. Unless **fast mode** is set, fires **CRAWL_EMAILS** to the service worker; then `stop()`. In fast mode, enrichment is skipped entirely for Maps-only speed.

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

**`chrome.storage.sync`** (cross-device):

| Key | Meaning |
|---|---|
| `freeLeadsUsed` | Single integer, the lifetime quota counter. Incremented in `background.js` on any positive change to `leads.length`. |
| `settings` | `{ fastMode, scanDelay, target, fields }` — the Settings tab. `fields` is a map of export-column groups → bool. Defaults applied in `popup.js` (`DEFAULT_SETTINGS`); the popup watches `storage.onChanged` so changes sync live across windows. |

## Messages

| Message | From → To | Purpose |
|---|---|---|
| `START_HARVEST` `{ limit, deepHarvest, fastMode, scanDelay }` | popup → content | Begin harvesting. `limit` = existing + min(remaining quota, target). `fastMode` skips enrichment; `scanDelay` tunes cadence. |
| `STOP_HARVEST` | popup → content | User stopped. |
| `CLEAR_LEADS` | popup → content | Drop in-memory `collected` map. |
| `HARVEST_DONE` `{ reason, limitReached }` | content → popup | Harvest finished/interrupted. |
| `CRAWL_EMAILS` | content → background | Kick off enrichment phases. |
| `EMAIL_PROGRESS` / `EMAIL_CRAWL_DONE` | background → popup | Enrichment progress + completion. |
| `LEADS_UPDATE` | content → popup | Leads written (popup also watches `storage.onChanged`). |

## Popup UI (`popup.js` / `popup.html`)

The popup is three tabs (`.tab-btn` / `.tab-pane`, switched in JS):
- **Scraper** — quota counter, Start/Stop, progress, banners, Clear.
- **Data** — `statTotal`/`statEmail`/`statPhone` counts and a live preview table (`renderDataTab`, built with `textContent` to avoid injection), plus the export buttons.
- **Settings** — fast mode, scan delay, target count, and export-field checkboxes. `loadSettings`/`applySettingsToUI`/`saveSettingsBtn` persist to `chrome.storage.sync`.

`render()` recomputes everything (including `renderDataTab()`) on each state change.

## Export (`popup.js`)

`EXPORT_HEADERS` defines the sales-priority column order; `HEADER_FIELD` maps each column to a Settings field-group, and `activeHeaders()` filters to the columns the user enabled (name is always included). `buildExportRow` flattens each lead, `formatPhone` normalizes numbers, `splitHoursDetail` expands the stored hours JSON into `hours_mon…hours_sun`.

Three formats, all via `chrome.downloads`:
- **CSV** — UTF-8 with a BOM.
- **JSON** — array of objects limited to `activeHeaders()`.
- **Excel (.xlsx)** — built with SheetJS (`XLSX.utils.aoa_to_sheet` → `XLSX.write({type:"array"})`); guarded with a `typeof XLSX` check.

The `logo` field is deliberately excluded from all exports (URLs expire).

## Feedback form (`popup.js`)

The popup's Request a Feature / Report a Bug form POSTs `{ name, email, phone, message }` to **Web3Forms** (`api.web3forms.com`), which emails the submission to the support address. The access key is a public client key (send-only to the verified inbox). This is the only outbound call that leaves the user's machine with user-entered data — see [PRIVACY.md](../PRIVACY.md).

## Cross-browser (Chrome + Firefox)

The same source builds for both. The only differences are applied at build time by `build-firefox.sh`:

- **Background model:** Chrome uses `background.service_worker`; Firefox MV3 uses an event page (`background.scripts`). The Firefox manifest lists `["social_classifier.js", "background.js"]` so the classifier's globals exist before `background.js` runs.
- **`importScripts`:** worker-only, so `background.js` guards it with `if (typeof importScripts === "function")`. Chrome loads the classifier at runtime; Firefox loads it via the manifest above.
- **Add-on id:** Firefox requires `browser_specific_settings.gecko.id` for signing — injected by the build script.

Everything else (the `chrome.*` API calls, promise usage, `scripting.executeScript` with `func`, hidden tabs) works on both modern engines. `chrome.tabs.update({autoDiscardable})` is Chrome-only but is wrapped in try/catch, so Firefox safely ignores it.

## Conventions

- All log lines are prefixed `[Leads Harvest]` for easy filtering in DevTools.
- New runtime files must be added to the `FILES=(…)` list in **both** `release.sh` and `build-firefox.sh` so they're packaged for each browser.
- `social_classifier.js`'s platform path-blocklists (e.g. Instagram `/p`, `/reel`) prevent post/share URLs from being mistaken for profile handles — extend these when adding platforms.
