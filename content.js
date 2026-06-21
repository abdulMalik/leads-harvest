let harvesting = false;
let collected = new Map();
let currentLimit = Infinity;
let deepHarvest = true;
let fastMode = false;          // skip email/social enrichment for speed
let scanDelay = 1200;          // ms between scroll/scan ticks (user-tunable)
let stableThreshold = 30;      // ticks of no-new-leads before declaring end-of-list
let observer = null;
let stableTimer = null;
let stableTicks = 0;
let lastCount = 0;
let originalSearchUrl = "";
let bannerEl = null;
let selectorDegradeStrikes = 0;
let selectorDegradedFlagged = false;

const PLACE_HREF = 'a[href^="https://www.google.com/maps/place/"]';
const HOURS_RE = /^(open|closed|opens|closes|24 hours)/i;
// Selector-health watchdog. When Google ships a Maps DOM change that breaks our
// card selectors, the results feed stays visibly populated but our extractor
// parses nothing. Flag that gap so the popup warning banner tells the user the
// data is incomplete instead of silently harvesting zero leads. We require a
// few populated cards (not a mid-load empty feed) and two consecutive misses
// (not a single transient pass where anchors/aria-labels haven't rendered yet).
const SELECTOR_DEGRADE_MIN_CARDS = 3;
const SELECTOR_DEGRADE_STRIKES = 2;
const PRICE_RE = /^(\$+|€+|£+|¥+|Rs\b|₹|Rs\s*[\d,]+\s*[–-]\s*[\d,]+)/i;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 5000, interval = 120 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const v = fn();
      if (v) return v;
    } catch {}
    await wait(interval);
  }
  return null;
}

const DEFAULT_BANNER_TEXT = "Leads Harvest is running — keep this tab in front. Chrome slows background tabs.";

function showBanner(text) {
  const message = text || DEFAULT_BANNER_TEXT;
  if (bannerEl && document.body.contains(bannerEl)) {
    bannerEl.textContent = message;
    return;
  }
  bannerEl = document.createElement("div");
  bannerEl.id = "leads-harvest-banner";
  bannerEl.textContent = message;
  Object.assign(bannerEl.style, {
    position: "fixed",
    top: "12px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: "2147483647",
    background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
    color: "#fff",
    padding: "10px 18px",
    borderRadius: "999px",
    fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif",
    fontSize: "13px",
    fontWeight: "600",
    boxShadow: "0 6px 20px rgba(99, 102, 241, 0.35)",
    pointerEvents: "none",
    maxWidth: "90vw",
    textAlign: "center",
  });
  document.body.appendChild(bannerEl);
}

function hideBanner() {
  if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
  bannerEl = null;
}

function bannerTextForEnrichment(crawl) {
  const phase = crawl.phase === "deep" ? "Deep-scanning sites" : "Finding emails & socials";
  return `${phase}… ${crawl.done}/${crawl.total}`;
}

function getPlaceIdFromUrl(url) {
  const m = url.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
  return m ? m[1] : null;
}

// Maps' "Visit Site" ad anchors point to ad-click trackers, not the advertiser's
// real site. Saving a tracker URL as the lead's website is worse than empty.
const AD_REDIRECT_HOSTS = /^(www\.)?(googleadservices|googlesyndication|doubleclick|google)\./i;
function isAdRedirectUrl(url) {
  try { return AD_REDIRECT_HOSTS.test(new URL(url).hostname); }
  catch { return true; }
}

function parseCardText(card, leadName = "") {
  const rawAll = (card.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean);
  // Sponsored cards prepend a "Sponsored" / "Ad" line, pushing the business name
  // off line 0. Without this skip, the name lands on a line our category regex
  // accepts, and category ends up equal to the name.
  let i0 = 0;
  while (i0 < rawAll.length && /^(sponsored|ad|ads)$/i.test(rawAll[i0])) i0++;
  const raw = rawAll.slice(i0);

  const normLeadName = leadName ? normalizeName(leadName) : "";
  const isLeadName = (line) => normLeadName && normalizeName(line) === normLeadName;

  let rating = "", reviews = "", category = "", address = "", price = "", hours = "", phone = "";

  for (let i = 1; i < raw.length; i++) {
    const line = raw[i];

    const r = line.match(/^(\d(?:\.\d)?)\s*\(\s*([\d,]+)\s*\)/);
    if (r && !rating) {
      rating = r[1];
      reviews = r[2].replace(/,/g, "");
      const rest = line.replace(r[0], "").replace(/^[\s·•|]+/, "").trim();
      if (rest && PRICE_RE.test(rest)) price = rest;
      continue;
    }

    if (HOURS_RE.test(line)) {
      const segs = line.split("·").map((s) => s.trim()).filter(Boolean);
      const hoursSegs = [];
      for (const seg of segs) {
        if (!phone && looksLikePhone(seg)) phone = seg;
        else hoursSegs.push(seg);
      }
      hours = hoursSegs.join(" · ");
      continue;
    }

    if (line.includes("·")) {
      const parts = line.split("·").map((p) => p.trim()).filter(Boolean);
      if (!category && parts[0] && !/^\d/.test(parts[0]) && !isLeadName(parts[0])) category = parts[0];
      const a = parts.slice(1).find((p) => /\d/.test(p) && /[a-z]/i.test(p) && !HOURS_RE.test(p) && !PRICE_RE.test(p) && !looksLikePhone(p));
      if (a && !address) address = a;
      const p = parts.find((seg) => looksLikePhone(seg));
      if (p && !phone) phone = p;
      continue;
    }

    if (!category && !isLeadName(line) && /^[A-Za-z][A-Za-z\s&-]{2,38}$/.test(line)) {
      category = line;
      continue;
    }

    // Address must have both digits and letters — guards against capturing
    // review-histogram numbers ("5", "4", "3", "2", "1") as the address.
    if (!address && /\d/.test(line) && /[a-z]/i.test(line) && !HOURS_RE.test(line) && !PRICE_RE.test(line) && !looksLikePhone(line)) {
      address = line;
    }
  }

  return { rating, reviews, category, address, price, hours, phone };
}

function cleanName(ariaName) {
  return (ariaName || "")
    .replace(/\s*[·•|]\s*Visited link\s*$/i, "")
    .replace(/\s*\(Visited\)\s*$/i, "")
    .trim();
}

function isSponsoredCard(card) {
  if (!card) return false;
  // Sponsored cards show a "Sponsored" label near the top, and have a
  // "Visit Site" / ad-link button that regular cards don't.
  const text = (card.innerText || "");
  if (/(^|\n)\s*Sponsored\s*(\n|$)/i.test(text)) return true;
  if (card.querySelector('[aria-label*="Sponsored" i]')) return true;
  if (card.querySelector('a[aria-label*="Visit Site" i], a[aria-label*="Visit site" i]')) return true;
  return false;
}

function extractCardBasic(link) {
  const url = link.href;
  if (!url || !url.includes("/maps/place/")) return null;
  const card = link.closest('[role="article"]') || link.parentElement;
  if (!card) return null;

  const ariaName = link.getAttribute("aria-label")?.trim() || "";
  if (!ariaName) return null;

  const star = card.querySelector('[role="img"][aria-label*="star" i]');
  const starLabel = star?.getAttribute("aria-label") || "";
  const ariaRating = starLabel.match(/[\d.]+/)?.[0] || "";
  const ariaReviews = starLabel.match(/([\d,]+)\s*reviews?/i)?.[1]?.replace(/,/g, "") || "";

  const parsed = parseCardText(card, cleanName(ariaName));
  const logoEl = card.querySelector('img[src*="googleusercontent"], img[src*="ggpht"]');

  // Sponsored cards have a "Visit Site" anchor with the advertiser's real
  // website — grab it here so we don't depend on the deep panel exposing it.
  const visitSite = card.querySelector('a[aria-label*="Visit site" i], a[aria-label*="Visit Site" i]')
    || card.querySelector('a[data-value*="Visit Site"], a[data-value*="Visit site"]');
  const cardWebsite =
    visitSite && visitSite.href && !isAdRedirectUrl(visitSite.href)
      ? visitSite.href
      : "";

  return {
    name: cleanName(ariaName),
    category: parsed.category,
    rating: ariaRating || parsed.rating,
    reviews: ariaReviews || parsed.reviews,
    address: parsed.address,
    price: parsed.price,
    hours: parsed.hours,
    hours_detail: "",
    phone: parsed.phone || "",
    website: cardWebsite,
    logo: logoEl?.src || "",
    url,
  };
}

function findCardLinks() {
  const feed = document.querySelector('[role="feed"]')
    || document.querySelector('div[aria-label*="Results" i]')
    || document;
  // Iterate articles (one per result card) in feed DOM order, then take the
  // first place anchor in each. This preserves the visual top-to-bottom order
  // of the left panel and avoids extracting the same card multiple times via
  // its image/title/wrapper anchors.
  const articles = feed.querySelectorAll('[role="article"]');
  if (articles.length) {
    return Array.from(articles)
      .map((a) => a.querySelector(PLACE_HREF))
      .filter(Boolean);
  }
  return Array.from(feed.querySelectorAll(PLACE_HREF));
}

async function persistLeads() {
  const leads = Array.from(collected.values());
  await chrome.storage.local.set({ leads, lastUpdated: Date.now() });
  chrome.runtime.sendMessage({ type: "LEADS_UPDATE", leads }).catch(() => {});
}

function isVisible(el) {
  if (!el) return false;
  const s = window.getComputedStyle(el);
  return s.display !== "none" && s.visibility !== "hidden" && el.offsetParent !== null;
}

function getDetailPanel() {
  const mains = document.querySelectorAll('div[role="main"]');
  for (const m of mains) {
    if (m.querySelector('[data-item-id]') && isVisible(m)) return m;
  }
  for (const m of mains) {
    const h1 = m.querySelector('h1')?.textContent?.trim();
    if (h1 && h1 !== "Results" && !/^results/i.test(h1) && isVisible(m)) return m;
  }
  return null;
}

function extractDetailedHours(panel) {
  const hoursContainer = panel.querySelector('[data-item-id="oloc"]')
    || panel.querySelector('[aria-label*="Hours" i]');

  if (hoursContainer) {
    const aria = hoursContainer.getAttribute("aria-label") || "";
    const ariaMatch = aria.match(/(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)[^;]*(?:;|$)/gi);
    if (ariaMatch && ariaMatch.length >= 3) {
      const obj = {};
      ariaMatch.forEach((seg) => {
        const cleaned = seg.replace(/;$/, "").trim();
        const [day, ...rest] = cleaned.split(",");
        if (day && rest.length) obj[day.trim().slice(0, 3)] = rest.join(",").trim();
      });
      if (Object.keys(obj).length) return JSON.stringify(obj);
    }
  }

  const table = panel.querySelector('table');
  if (table) {
    const obj = {};
    table.querySelectorAll("tr").forEach((row) => {
      const cells = row.querySelectorAll("td, th");
      if (cells.length >= 2) {
        const day = cells[0].textContent.trim();
        const time = cells[1].textContent.trim().replace(/\s+/g, " ");
        if (day && time) obj[day.slice(0, 3)] = time;
      }
    });
    if (Object.keys(obj).length) return JSON.stringify(obj);
  }

  // Sponsored panels expose hours only via per-day buttons whose aria-labels look
  // like "Monday, 9:30 AM to 5 PM, Copy open hours" — no oloc, no table.
  const dayRe = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s*,\s*(.+?)(?:\s*,\s*Copy open hours)?\s*$/i;
  const dayObj = {};
  panel.querySelectorAll("[aria-label]").forEach((el) => {
    const m = (el.getAttribute("aria-label") || "").match(dayRe);
    if (!m) return;
    const day = m[1].slice(0, 3);
    if (!dayObj[day]) dayObj[day] = m[2].trim();
  });
  if (Object.keys(dayObj).length >= 3) return JSON.stringify(dayObj);

  return "";
}

function looksLikePhone(s) {
  if (!s) return false;
  if (/\b(am|pm|mon|tue|wed|thu|fri|sat|sun|open|closed|hours|closes|opens)\b/i.test(s)) return false;
  const digits = (s.match(/\d/g) || []).length;
  if (digits < 7 || digits > 16) return false;
  return /^[+0-9][\d\s\-().]{6,}\d$/.test(s.trim());
}

function cleanPhone(raw) {
  if (!raw) return "";
  const cleaned = raw
    .replace(/^Phone:\s*/i, "")
    .replace(/^Call\s+/i, "")
    .replace(/\s*\(Telephone\)\s*$/i, "")
    .trim();
  return looksLikePhone(cleaned) ? cleaned : "";
}

function extractPhone(panel) {
  const telAnchor = panel.querySelector('a[href^="tel:"]');
  if (telAnchor) {
    const num = decodeURIComponent(telAnchor.getAttribute("href").replace(/^tel:/, "")).trim();
    const cleaned = cleanPhone(num);
    if (cleaned) return cleaned;
  }

  const phoneItemId = panel.querySelector('[data-item-id^="phone:tel:"]');
  if (phoneItemId) {
    const itemId = phoneItemId.getAttribute("data-item-id") || "";
    const fromId = itemId.replace(/^phone:tel:/, "").trim();
    const cleaned = cleanPhone(fromId);
    if (cleaned) return cleaned;
    const fromAria = cleanPhone(phoneItemId.getAttribute("aria-label") || "");
    if (fromAria) return fromAria;
  }

  const phoneAria = panel.querySelector('[aria-label^="Phone:" i]');
  if (phoneAria) {
    const cleaned = cleanPhone(phoneAria.getAttribute("aria-label") || "");
    if (cleaned) return cleaned;
  }

  return "";
}

function isOnResultsList() {
  // Detail panel has [data-item-id] children for phone/website/address etc.
  // When that's gone, we're back on the results list. Locale-agnostic.
  return !!document.querySelector('[role="feed"]') && !getDetailPanel();
}

async function closeDetailPanel() {
  // Same selectors as the original code (those worked for Maps' close button);
  // we just drop the destructive `location.href = ...` reload fallback that
  // killed the content-script mid-harvest. Short fixed wait keeps things fast.
  const closeBtn = document.querySelector(
    'button[aria-label="Close"][jsaction*="placeCard"], button[jsaction*="placeCard.close"], button[aria-label*="Close" i][jsaction*="pane"]'
  );
  if (closeBtn) {
    closeBtn.click();
    await wait(400);
    if (isOnResultsList()) return true;
  }

  document.body.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true,
  }));
  await wait(400);
  return isOnResultsList();
}

async function deepHarvestOne(lead) {
  if (!harvesting) return lead;

  // If a previous lead's panel didn't close cleanly, try once more before giving up.
  if (!isOnResultsList()) {
    await closeDetailPanel();
  }

  const expectedId = getPlaceIdFromUrl(lead.url);

  // Find an anchor for this lead. Match by place ID so a sponsored-card URL
  // can still resolve to its canonical anchor (and vice versa). Prefer the
  // non-sponsored card when both exist — the sponsored panel sometimes lacks
  // the data-item-id structure our deep extractors rely on. Final fallback:
  // match by aria-label name, because sponsored slots can re-render with a
  // slightly different URL between the basic pass and deep pass.
  const allLinks = findCardLinks();
  const candidates = allLinks.filter((a) => {
    if (a.href === lead.url) return true;
    if (expectedId && getPlaceIdFromUrl(a.href) === expectedId) return true;
    const ariaName = cleanName(a.getAttribute("aria-label") || "");
    return ariaName && lead.name && namesMatch(ariaName, lead.name);
  });
  const link =
    candidates.find((a) => !isSponsoredCard(a.closest('[role="article"]')))
    || candidates[0];
  const linkIsSponsored = link && isSponsoredCard(link.closest('[role="article"]'));
  console.log(`[Leads Harvest] deep harvest "${lead.name}" found=${!!link} sponsored=${!!linkIsSponsored} candidates=${candidates.length} expectedId=${expectedId}`);
  if (!link) return lead;

  const oldUrl = location.href;
  link.scrollIntoView({ block: "center" });
  await wait(300);
  // Synthetic .click() sometimes no-ops on Maps' sponsored anchors. Dispatch a
  // real mouse-event sequence as a fallback if the panel doesn't open quickly.
  link.click();
  await wait(400);
  if (location.href === oldUrl && !getDetailPanel()) {
    console.log("[Leads Harvest] click had no effect, retrying with MouseEvents", lead.name);
    for (const type of ["mousedown", "mouseup", "click"]) {
      link.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
    }
  }

  // Wait for URL to switch to the new place.
  await waitFor(() => {
    if (location.href === oldUrl) return null;
    if (expectedId && !location.href.includes(expectedId)) return null;
    return true;
  }, { timeout: 6000 });

  // Wait for the panel to actually swap to this lead's content. Critically,
  // verify the heading matches `lead.name` — otherwise we'll extract the
  // *previous* lead's data into this row (the URL updates before the panel
  // content does). Sponsored panels take longer to paint than organic ones, so
  // we wait up to 12s before giving up.
  const panelReady = await waitFor(() => {
    const p = getDetailPanel();
    if (!p) return null;
    if (!p.querySelector('[data-item-id]')) return null;
    if (!panelMatchesLead(p, lead.name)) return null;
    return p;
  }, { timeout: 12000 });

  await wait(400);

  const panel = getDetailPanel();
  if (!panel) {
    await closeDetailPanel();
    return lead;
  }

  // If the wait timed out, the panel never matched this lead — bail without
  // extracting stale data from the previous panel.
  if (!panelReady) {
    const h1Texts = Array.from(panel.querySelectorAll("h1")).map((h) => h.textContent.trim()).filter(Boolean);
    const itemIdCount = panel.querySelectorAll("[data-item-id]").length;
    const nameHitAria = Array.from(panel.querySelectorAll("[aria-label]"))
      .map((e) => e.getAttribute("aria-label") || "")
      .filter((s) => normalizeName(s).includes(normalizeName(lead.name).slice(0, 8)))
      .slice(0, 3);
    console.warn(
      `[Leads Harvest] panel didn't switch "${lead.name}" h1=[${h1Texts.join(" | ")}] itemIds=${itemIdCount} urlChanged=${location.href !== oldUrl} ariaHits=[${nameHitAria.join(" | ")}]`
    );
    await closeDetailPanel();
    return lead;
  }

  // Phone: structured extractors first, then a text-scan fallback for layouts
  // the structured selectors don't cover.
  const phone = extractPhone(panel);
  if (phone) lead.phone = phone;
  if (!lead.phone) {
    const panelText = panel.innerText || "";
    const matches = panelText.match(/[+]?[\d][\d\s\-().]{6,20}\d/g) || [];
    for (const m of matches) {
      const cleaned = cleanPhone(m);
      if (cleaned) { lead.phone = cleaned; break; }
    }
  }

  const websiteEl = panel.querySelector('a[data-item-id="authority"]')
    || panel.querySelector('a[aria-label^="Website" i]')
    || panel.querySelector('a[aria-label*="Visit site" i]')
    || panel.querySelector('a[aria-label*="Visit Site" i]');
  if (websiteEl && websiteEl.href && !isAdRedirectUrl(websiteEl.href)) {
    lead.website = websiteEl.href;
  }

  const addressBtn = panel.querySelector('button[data-item-id="address"]');
  if (addressBtn) {
    const addr = (addressBtn.getAttribute("aria-label") || addressBtn.textContent || "")
      .replace(/^Address:\s*/i, "").trim();
    if (addr) lead.address = addr;
  }

  // Hours: expand the day-by-day table if it's collapsed, otherwise we only get
  // the summary line. Then extract.
  if (!extractDetailedHours(panel)) {
    const hoursToggle = panel.querySelector('button[aria-label*="Hours" i], [role="button"][aria-label*="Hours" i]')
      || panel.querySelector('[data-item-id="oh"] button')
      || panel.querySelector('[data-item-id="oh"]');
    if (hoursToggle) {
      try { hoursToggle.click(); } catch {}
      await waitFor(() => extractDetailedHours(panel), { timeout: 1500 });
    }
  }
  lead.hours_detail = extractDetailedHours(panel) || lead.hours_detail;
  if (!lead.hours) {
    const hoursBtn = panel.querySelector('[aria-label*="Hours" i][role="button"], div[aria-label*="Hours" i]');
    if (hoursBtn) {
      const lbl = hoursBtn.getAttribute("aria-label") || "";
      const summary = lbl.match(/(Open|Closed)[^;]*/i)?.[0];
      if (summary) lead.hours = summary;
    }
  }

  // Category fallback — basic card extraction misses it on some layouts.
  if (!lead.category) {
    const catBtn = panel.querySelector('button[jsaction*="category"]')
      || panel.querySelector('button[aria-label*="Category" i]');
    if (catBtn) {
      const cat = catBtn.textContent.trim();
      if (cat) lead.category = cat;
    }
  }

  // Rating / reviews fallback from the detail panel.
  if (!lead.rating || !lead.reviews) {
    const star = panel.querySelector('[role="img"][aria-label*="star" i]');
    const sLbl = star?.getAttribute("aria-label") || "";
    const r = sLbl.match(/[\d.]+/)?.[0];
    const rev = sLbl.match(/([\d,]+)\s*reviews?/i)?.[1]?.replace(/,/g, "");
    if (r && !lead.rating) lead.rating = r;
    if (rev && !lead.reviews) lead.reviews = rev;
  }

  const heroImg = panel.querySelector('img[src*="googleusercontent"], img[src*="ggpht"]');
  if (heroImg?.src) lead.logo = heroImg.src;

  if (lead.phone && !looksLikePhone(lead.phone)) lead.phone = "";

  // Socials from the Maps detail panel itself — usually surfaced as
  // [data-item-id^="place-info-links:"] but sometimes also as plain anchors.
  // We scan all anchors in the panel; classifySocial rejects everything that
  // isn't a known platform's profile URL (including google.com internals).
  // Free yield: no extra network, no JS-rendering dependency.
  const panelSocials = extractSocialsFromElement(panel);
  if (panelSocials.facebook) lead.facebook = panelSocials.facebook;
  if (panelSocials.instagram) lead.instagram = panelSocials.instagram;
  if (panelSocials.twitter) lead.twitter = panelSocials.twitter;
  if (panelSocials.linkedin) lead.linkedin = panelSocials.linkedin;
  if (panelSocials.youtube) lead.youtube = panelSocials.youtube;
  if (panelSocials.tiktok) lead.tiktok = panelSocials.tiktok;

  const socialCount = Object.keys(panelSocials).length;
  console.log(`[Leads Harvest] extracted "${lead.name}" phone=${!!lead.phone} website=${!!lead.website} hours_detail=${!!lead.hours_detail} address=${!!lead.address} socials=${socialCount}`);

  await closeDetailPanel();
  await wait(300);

  return lead;
}

function normalizeName(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20);
}

function panelMatchesLead(panel, leadName) {
  if (!leadName) return true;
  const target = normalizeName(leadName);
  if (!target) return true;
  const needle = target.slice(0, 8);
  if (!needle) return true;

  // Match only against the panel's primary <h1>. The previous implementation
  // also scanned h2 + every [aria-label] descendant — but Maps' detail panel
  // includes a "People also search for" / "Similar places" section whose
  // suggestion tiles carry the names of *other* nearby businesses in their
  // aria-labels. When harvesting a niche (e.g. medspas in one neighborhood),
  // the next lead's name was reliably present in the current panel's
  // suggestion tiles, causing verification to falsely pass and the previous
  // lead's data (address, phone, website, etc.) to leak into the next row.
  const h1 = panel.querySelector("h1");
  if (!h1) return false;
  return normalizeName(h1.textContent).includes(needle);
}

function namesMatch(a, b) {
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return false;
  const sa = na.slice(0, 8), sb = nb.slice(0, 8);
  return na.startsWith(sb) || nb.startsWith(sa) || na.includes(sb) || nb.includes(sa);
}

function dedupKeyFor(lead) {
  // Use Google's place ID when present so sponsored + canonical cards for the
  // same business collapse into one entry. Fall back to URL.
  const placeId = getPlaceIdFromUrl(lead.url);
  return placeId ? `pid:${placeId}` : `url:${lead.url}`;
}

async function extractAll() {
  if (!harvesting) return;

  const links = findCardLinks();
  const linkByUrl = new Map(links.map((a) => [a.href, a]));
  let parsedCount = 0;
  for (const link of links) {
    const lead = extractCardBasic(link);
    if (!lead) continue;
    parsedCount++;
    const key = dedupKeyFor(lead);
    const existing = collected.get(key);

    if (existing) {
      // Merge: fill in any empty fields from this version (sponsored cards
      // sometimes have data the canonical doesn't expose yet, and vice versa).
      // Prefer the canonical (non-sponsored) URL for the dedup'd entry so deep
      // harvest's click finds the regular detail panel.
      const card = link.closest('[role="article"]');
      const existingLink = linkByUrl.get(existing.url);
      const existingCard = existingLink ? existingLink.closest('[role="article"]') : null;
      const existingIsSponsored = isSponsoredCard(existingCard);
      const thisIsSponsored = isSponsoredCard(card);
      if (existingIsSponsored && !thisIsSponsored) existing.url = lead.url;
      for (const k of Object.keys(lead)) {
        if (!existing[k] && lead[k]) existing[k] = lead[k];
      }
      continue;
    }

    collected.set(key, lead);

    if (collected.size >= currentLimit) {
      stop({ limitReached: true });
      return;
    }
  }
  checkSelectorHealth(parsedCount);
  await persistLeads();
}

// Compare the number of cards visibly present in the feed against how many we
// actually parsed this pass. A populated feed that yields zero parsed leads is
// the signature of a stale selector. Writes selectorDegraded to storage only on
// a state change so the popup banner (storage.onChanged) toggles without churn.
function checkSelectorHealth(parsedCount) {
  const feed = document.querySelector('[role="feed"]')
    || document.querySelector('div[aria-label*="Results" i]')
    || document;
  const articleCount = feed.querySelectorAll('[role="article"]').length;
  const degradedNow = articleCount >= SELECTOR_DEGRADE_MIN_CARDS && parsedCount === 0;

  selectorDegradeStrikes = degradedNow ? selectorDegradeStrikes + 1 : 0;
  const degraded = selectorDegradeStrikes >= SELECTOR_DEGRADE_STRIKES;

  if (degraded === selectorDegradedFlagged) return;
  selectorDegradedFlagged = degraded;
  chrome.storage.local.set({ selectorDegraded: degraded });
}

async function deepHarvestPass() {
  if (!deepHarvest || !harvesting) return;

  // After tick() scrolled the feed to the bottom (loading more results), the
  // earliest cards may have been virtualized out of the DOM. Scroll back to the
  // top so `findCardLinks().find(href === lead.url)` can resolve them.
  const feed = document.querySelector('[role="feed"]');
  if (feed) {
    feed.scrollTop = 0;
    await wait(800);
  }

  const entries = Array.from(collected.entries());
  for (const [key, lead] of entries) {
    if (!harvesting) return;
    // Skip when the two important deep fields are populated. hours_detail is
    // "nice to have" so don't keep re-clicking leads that just don't expose it.
    if (lead.phone && lead.website) continue;
    try {
      await deepHarvestOne(lead);
      collected.set(key, lead);
      await persistLeads();
    } catch (e) {
      console.warn("[Leads Harvest] deep harvest failed for", lead.name, e);
    }
  }
}

function startObserver() {
  const panel = document.querySelector('[role="feed"]')
    || document.querySelector('div[aria-label*="Results" i]');
  if (!panel) {
    chrome.runtime.sendMessage({ type: "HARVEST_DONE", reason: "no-feed" }).catch(() => {});
    return false;
  }

  let tickRunning = false;
  const tick = async () => {
    if (tickRunning) return;
    tickRunning = true;
    try { await tickInner(); } finally { tickRunning = false; }
  };
  const tickInner = async () => {
    if (!harvesting) return;
    await extractAll();
    if (!harvesting) return;

    const now = collected.size;
    if (now === lastCount) stableTicks++;
    else { stableTicks = 0; lastCount = now; }

    // ~36s of no new leads before declaring end-of-list, regardless of the
    // user's scan-delay setting (stableThreshold is derived from scanDelay so
    // a faster cadence doesn't end the harvest prematurely). Generous so we
    // outlast Google's lazy-load batch pauses on big result sets.
    if (stableTicks >= stableThreshold) {
      if (observer) { observer.disconnect(); observer = null; }
      if (stableTimer) { clearInterval(stableTimer); stableTimer = null; }
      // First pass populates most leads. Second pass auto-skips successful ones
      // (via the phone+website skip condition) and retries any whose panel
      // didn't open / didn't swap cleanly on the first attempt.
      await deepHarvestPass();
      if (harvesting) await deepHarvestPass();
      // Kick off email/social enrichment unless the user chose Fast mode.
      // Enrichment (website fetch + hidden-tab render) is the slow phase, so
      // Fast mode skips it for Maps-only speed.
      if (!fastMode) {
        chrome.runtime.sendMessage({ type: "CRAWL_EMAILS" }).catch(() => {});
      }
      stop({ reason: "end-of-results" });
      return;
    }
    // Trigger Google's lazy load. scrollTop alone is sometimes ignored by the
    // IntersectionObserver that watches the sentinel; scrollIntoView on the
    // last article is more reliable.
    const lastArticle = panel.querySelector('[role="article"]:last-of-type');
    if (lastArticle) lastArticle.scrollIntoView({ block: "end" });
    panel.scrollTop = panel.scrollHeight;
  };

  observer = new MutationObserver(tick);
  observer.observe(panel, { childList: true, subtree: true });
  // Fallback ticker: when Google Maps stops mutating (end of list reached) the
  // observer goes silent and stableTicks would never advance. Poll on a timer too.
  // Interval is the user-tunable scan delay.
  stableTimer = setInterval(tick, scanDelay);
  tick();
  return true;
}

function stop({ limitReached = false, reason = "stopped" } = {}) {
  harvesting = false;
  if (observer) { observer.disconnect(); observer = null; }
  if (stableTimer) { clearInterval(stableTimer); stableTimer = null; }
  // For end-of-results we just fired CRAWL_EMAILS — transition the banner to
  // enrichment text immediately so the user doesn't see a flicker between
  // harvest-done and the first emailCrawl storage write. The storage listener
  // will swap in real progress counts as soon as background.js writes them.
  if (reason === "end-of-results" && !fastMode) {
    showBanner("Finding emails & socials…");
  } else {
    hideBanner();
  }
  const update = { isHarvesting: false, lastHarvestReason: reason };
  if (limitReached) update.limitReached = true;
  chrome.storage.local.set(update);
  chrome.runtime.sendMessage({ type: "HARVEST_DONE", reason, limitReached }).catch(() => {});

  // Restore the original search view so the sidebar/map don't show drift from
  // scrolling + per-card clicks. Skip for user-stopped (user is interacting)
  // and interrupted (context already torn down by a navigation).
  const shouldRestore =
    (reason === "end-of-results" || limitReached) &&
    originalSearchUrl &&
    location.href !== originalSearchUrl;
  if (shouldRestore) {
    setTimeout(() => { location.href = originalSearchUrl; }, 300);
  }
}

// Keep the Maps-tab banner alive through the email/socials enrichment phases.
// background.js writes { done, total, phase, active } to `emailCrawl` in
// chrome.storage.local as it works; we mirror that into banner text here.
// Guarded by `!harvesting` so a stale enrichment message doesn't overwrite
// the harvest-running banner mid-harvest.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.emailCrawl) return;
  if (harvesting) return;
  const crawl = changes.emailCrawl.newValue;
  if (crawl && crawl.active) {
    showBanner(bannerTextForEnrichment(crawl));
  } else {
    hideBanner();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "START_HARVEST") {
    // Tear down any prior observer/timer before re-arming. Without this, a
    // second START_HARVEST (stale popup, second tab) leaves the old observer
    // running alongside the new one and ticks fire twice.
    if (observer) { observer.disconnect(); observer = null; }
    if (stableTimer) { clearInterval(stableTimer); stableTimer = null; }
    harvesting = true;
    currentLimit = msg.limit ?? Infinity;
    deepHarvest = msg.deepHarvest !== false;
    fastMode = msg.fastMode === true;
    // Clamp scan delay to a sane range; derive the end-of-list threshold from
    // it so the ~36s no-new-leads window holds regardless of cadence.
    scanDelay = Math.min(5000, Math.max(500, Number(msg.scanDelay) || 1200));
    stableThreshold = Math.max(8, Math.round(36000 / scanDelay));
    stableTicks = 0;
    lastCount = 0;
    selectorDegradeStrikes = 0;
    selectorDegradedFlagged = false;
    originalSearchUrl = location.href;
    chrome.storage.local.set({ selectorDegraded: false });
    // Reset in-memory state so we never carry leads from a previous search.
    // We reload from storage immediately below — if the user just cleared,
    // storage is empty and we start truly fresh.
    collected.clear();
    showBanner();
    chrome.storage.local.get(["leads"], ({ leads = [] }) => {
      leads.forEach((l) => collected.set(dedupKeyFor(l), l));
      lastCount = collected.size;
      if (collected.size >= currentLimit) {
        stop({ limitReached: true });
        return;
      }
      if (!startObserver()) harvesting = false;
    });
  } else if (msg.type === "STOP_HARVEST") {
    stop({ reason: "user-stopped" });
  } else if (msg.type === "CLEAR_LEADS") {
    // Popup's Clear Saved Leads button — wipe the in-memory map too.
    collected.clear();
    lastCount = 0;
  }
});

(async () => {
  const { leads = [], isHarvesting, emailCrawl } = await chrome.storage.local.get([
    "leads", "isHarvesting", "emailCrawl",
  ]);
  leads.forEach((l) => collected.set(dedupKeyFor(l), l));
  if (isHarvesting) {
    // Stale flag — the previous content script was killed by a page navigation
    // before it could call stop(). Clear the flag so the popup unblocks.
    chrome.storage.local.set({ isHarvesting: false, lastHarvestReason: "interrupted" });
    chrome.runtime.sendMessage({ type: "HARVEST_DONE", reason: "interrupted" }).catch(() => {});
  }
  // Resume the enrichment banner if a crawl was already in flight when the
  // tab navigated / the extension reloaded. Storage listener handles updates
  // from here on; this just restores the visible state on first paint.
  if (emailCrawl && emailCrawl.active) {
    showBanner(bannerTextForEnrichment(emailCrawl));
  }
})();
