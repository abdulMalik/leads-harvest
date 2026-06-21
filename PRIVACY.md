# Privacy Policy — Leads Harvest

**Effective date:** 2026-06-13
**Contact:** leadsharvestsupport@gmail.com

Leads Harvest is a Chrome extension that helps you collect publicly available business contact information from Google Maps for your own sales prospecting. This policy explains exactly what data the extension touches, where it goes, and what we (the developer) can and cannot see.

## Short version

- Harvested lead data stays on your device. It is never transmitted to us or to any server we control.
- During enrichment, the extension fetches pages from the **business websites you've harvested** to read publicly visible email addresses and social media links from those pages. No data is sent to those sites beyond a normal page request.
- There is no analytics, no telemetry, no tracking pixel, no user account, no advertising SDK, no in-extension payments.

## What the extension processes

### 1. Lead data (your harvested results)

When you click **Start Harvest** on a Google Maps search results page, the extension reads publicly visible business information from that page and from each business's detail panel:

- Business name, category, address
- Phone number, website
- Star rating and review count
- Business hours (per-day)
- Logo image URL
- Social media URLs (Facebook, Instagram, X/Twitter, LinkedIn, YouTube, TikTok) and email address — discovered by fetching the business's own website (see "Enrichment" below)

All of this is stored in `chrome.storage.local` — a local, per-device area provided by Chrome. It is **not synced**, **not backed up by us**, and **not transmitted anywhere**. You can delete it at any time via the **Clear Saved Leads** button in the popup, or by uninstalling the extension.

When you click **Export to CSV** or **Export to JSON**, the file is generated locally and saved through Chrome's standard download flow. We do not receive a copy.

### 2. Enrichment (fetching business websites)

To find email addresses and social media links that Google Maps does not show, the extension visits each harvested business's website. There are two phases:

- **Phase 1:** The background service worker makes ordinary HTTP `GET` requests to the business's home page and a small set of common contact paths (`/`, `/contact`, `/contact-us`, `/about`, `/about-us`). Only publicly returned HTML is read.
- **Phase 2:** For sites that did not return useful results in Phase 1 (typically because their footer is rendered by JavaScript), the extension opens the business's website in a hidden background tab, waits for it to load, reads the rendered page, and closes the tab.

In both phases, the extension is acting as a normal web client. It does not send any data about you to those websites beyond what your browser would normally send when visiting them (User-Agent, IP address, etc., handled by Chrome — not by us).

### 3. Free quota counter

The extension stores a single integer (`freeLeadsUsed`) in `chrome.storage.sync` so the lifetime free quota survives reinstalls and tracks across devices signed in to the same Chrome account. No business data is included — only the count. We do not receive a copy.

## What we do **not** collect

- We do not operate any server that receives your harvested leads.
- We do not collect analytics, crash reports, usage statistics, IP addresses, or device identifiers.
- We do not place advertising, fingerprinting, or third-party tracking code in the extension.
- We do not process any payments or accounts from inside the extension.
- We do not sell, share, or rent any data.

## Permissions and why each is needed

| Permission | Why |
|---|---|
| `storage` | Save your harvested leads, settings, and lifetime free-quota count locally |
| `scripting` | Inject our social-link extractor into hidden enrichment tabs we open ourselves |
| `activeTab` | Read the Google Maps page when you click Start Harvest |
| `downloads` | Save your CSV / JSON export to your Downloads folder |
| `tabs` | Open and close hidden tabs used for phase-2 enrichment |
| Host access to `https://www.google.com/maps/*` | Harvest business listings from Maps |
| Host access to `<all_urls>` | Fetch and load arbitrary business websites during enrichment — we cannot know in advance which domains your harvested leads' websites will be on, so we cannot pre-declare a narrower list |

## Your responsibilities as the user

The data Leads Harvest helps you collect is publicly listed business contact information. Once it's in your browser, **you become the data controller** for it. If you plan to use it for outreach in jurisdictions covered by laws such as GDPR, UK GDPR, CCPA, CAN-SPAM, CASL, or similar, you are responsible for complying with those laws — including any required lawful basis for processing, suppression of opt-outs, and identification requirements in your outreach.

## Data retention and deletion

- **Lead data:** removed when you click **Clear Saved Leads** in the popup, or when you uninstall the extension.
- **Lifetime free-quota counter:** removed when you clear Chrome sync data or uninstall the extension and disable Chrome sync.

We retain no copies because we never receive any.

## Children

Leads Harvest is a business tool not directed at children under 13 and we do not knowingly process data from them.

## Changes to this policy

If we change this policy, we will update the **Effective date** above and post the revised policy at the same location. Material changes will also be noted in the extension's Chrome Web Store listing.

## Contact

Questions, complaints, or deletion requests (though we hold no data to delete on our end): **leadsharvestsupport@gmail.com**.
