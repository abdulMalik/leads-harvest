# Leads Harvest

A Chrome extension that extracts local-business contact data from Google Maps search results — name, phone, website, email, address, hours, ratings, and social profiles — and exports it to CSV or JSON for sales prospecting and outreach.

> **Not on the Chrome Web Store.** Install it manually from the latest release (instructions below).
>
> 📦 **Install page for end users:** https://abdulmalik.github.io/leads-harvest/

---

## Features

- **One-click harvest** of every business in a Google Maps search result, in the order Maps shows them.
- **Deep detail extraction** — opens each listing's detail panel to capture phone, website, full per-day hours, address, rating, and review count.
- **Email + social discovery** — finds emails and social profiles (Facebook, Instagram, X/Twitter, LinkedIn, YouTube, TikTok) that Maps doesn't show, by reading each business's own website.
- **Smart de-duplication** — sponsored and organic cards for the same business collapse into one row (matched on Google's place ID).
- **CSV & JSON export** with a sales-priority column order.
- **In-popup feedback form** — Request a Feature / Report a Bug without leaving the extension.

---

## Install (Chrome / Edge / Brave)

1. Download the latest **`leads-harvest-*.zip`** from the [latest release](../../releases/latest).
2. **Unzip** it to a folder you'll keep — *don't delete it afterward*; Chrome loads the extension from this folder.
3. Open `chrome://extensions` (or `edge://extensions`).
4. Turn on **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the unzipped folder.
6. Pin the Leads Harvest icon to your toolbar.

### Updating to a new version
Download the newer zip, unzip it (overwrite the old folder), then click the **reload** icon on the extension card at `chrome://extensions`.

---

## Usage

1. Go to [google.com/maps](https://www.google.com/maps) and search for a business type + location (e.g. *"medspas in Austin"*).
2. Wait for the results list to appear on the left.
3. Open the Leads Harvest popup and click **Start Harvesting**.
4. **Keep the Maps tab in front** — Chrome throttles background tabs, which slows or stalls harvesting. A banner on the page shows progress.
5. The extension scrolls the results, opens each listing for details, then runs an email/social enrichment pass in the background. Let it finish (the banner switches to *"Finding emails & socials…"*).
6. Click **Export to CSV** or **Export to JSON**.

You can stop early with **Stop**, resume later with **Continue Harvesting**, and wipe everything with **Clear Saved Leads**.

### Free limit
The free tier captures **50 leads total (lifetime)**. The counter is stored in Chrome sync, so it persists across reinstalls when Chrome sync is enabled.

---

## Export columns

CSV and JSON share the same fields, ordered for outreach:

```
name, phone, email, website, address,
category, rating, reviews,
facebook, instagram, twitter, linkedin, youtube, tiktok,
hours_mon, hours_tue, hours_wed, hours_thu, hours_fri, hours_sat, hours_sun
```

- Phone numbers are normalized to a readable format (US/Canada and best-effort international).
- The business logo is captured for in-popup display but intentionally **omitted from exports** (the URLs expire within weeks).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Selectors may be outdated" banner | Google changed the Maps DOM and the extractor parsed nothing. The harvest still runs but data may be incomplete — check for an update. |
| Harvest seems stuck / slow | The Maps tab must stay focused and in front. Background tabs are throttled by Chrome. |
| No emails found for some leads | Not every business publishes an email; the crawler only accepts addresses on the business's own domain or a known personal provider (Gmail, etc.). |
| "Open google.com/maps first" | Run it from a `google.com/maps` search results tab. |
| Export button disabled | Wait for harvesting **and** the email/social enrichment pass to finish. |

---

## Feedback

Use the **Request a Feature / Report a Bug** link inside the popup to message us directly (name, email, optional phone, message). See [PRIVACY.md](PRIVACY.md) for how that data is handled.

## Documentation

- [PRIVACY.md](PRIVACY.md) — what data the extension touches and where it goes.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the code is structured (for developers).

## License

© 2026. All rights reserved. Personal use of your own harvested data only — see [PRIVACY.md](PRIVACY.md#your-responsibilities-as-the-user) for your obligations as the data controller.
