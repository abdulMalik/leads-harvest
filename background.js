 importScripts("social_classifier.js");

  chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.set({
      leads: [],
      isHarvesting: false,
      selectorDegraded: false,
      limitReached: false,
      emailCrawl: null,
    });
  });

  // --- Email crawler ------------------------------------------------------
  // Emails aren't on Google Maps. After deep harvest captures `website`, the
  // service worker fetches the home page + a few common contact paths and
  // greps for the first valid email. Done from the service worker (not a
  // hidden tab) so we don't manage tab lifecycle and don't get blocked by
  // the site's CSP. Requires `<all_urls>` in host_permissions to bypass CORS.

  const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const MAILTO_RE = /mailto:([^"'?\s>]+)/gi;

  // Filter out obvious junk that matches the email regex: placeholder
  // addresses copy-pasted in templates, image filenames containing `@`,
  // Sentry/crash-report token-style addresses, dev/test domains, and
  // calendar/embed URLs that look like emails.
  const EMAIL_JUNK = [
    /^(you|your|name|email|test|user|noreply|no-reply|donotreply|do-not-reply)@/i,
    /@(example|test|domain|sample|placeholder|localhost|yourdomain|yoursite|change-?me)\./i,
    /@sentry\.io$/i,
    /@wixpress\.com$/i,
    /@group\.calendar\.google\.com$/i,
    /\.(png|jpe?g|gif|svg|webp|css|js|ico)$/i,
    /^[0-9a-f]{16,}@/i,
    /@2x\./i,
  ];

  // Common consumer email hosts a small business legitimately uses for
  // contact. Anything outside this list AND outside the site's own domain
  // is rejected as a likely web-dev/agency leak (e.g. support@cartcoders.com
  // on a Shopify-built site).
  const PERSONAL_EMAIL_HOSTS = /^(gmail|yahoo|hotmail|outlook|aol|icloud|protonmail|proton|mail|msn|yandex|gmx|live|me|fastmail|zoho|tutanota)\.[a-z.]{2,}$/i;

  function rootDomain(host) {
    const parts = (host || "").toLowerCase().split(".").filter(Boolean);
    return parts.slice(-2).join(".");
  }

  function emailMatchesSite(email, siteHost) {
    if (!email) return false;
    const emailHost = (email.split("@")[1] || "").toLowerCase();
    if (!emailHost) return false;
    if (PERSONAL_EMAIL_HOSTS.test(emailHost)) return true;
    if (!siteHost) return false;
    return rootDomain(emailHost) === rootDomain(siteHost);
  }

  function isValidEmail(s) {
    if (!s || s.length < 6 || s.length > 100) return false;
    if (!/^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(s)) return false;
    return !EMAIL_JUNK.some((re) => re.test(s));
  }

  function extractEmails(html) {
    if (!html) return [];
    const found = new Set();
    // mailto: anchors first — most reliable signal that this is an actual
    // contact address rather than incidental text.
    let m;
    MAILTO_RE.lastIndex = 0;
    while ((m = MAILTO_RE.exec(html)) !== null) {
      try {
        const e = decodeURIComponent(m[1]).toLowerCase().trim();
        if (isValidEmail(e)) found.add(e);
      } catch {}
    }
    EMAIL_RE.lastIndex = 0;
    while ((m = EMAIL_RE.exec(html)) !== null) {
      const e = m[0].toLowerCase().trim();
      if (isValidEmail(e)) found.add(e);
    }
    return Array.from(found);
  }

  // classifySocial / extractSocials live in social_classifier.js so the
  // content script and Node test share one source of truth.

  async function fetchWithTimeout(url, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        credentials: "omit",
        redirect: "follow",
      });
      if (!res.ok) {
        console.log(`[Leads Harvest][fetch] ${res.status} ${url} (${Date.now() - t0}ms)`);
        return "";
      }
      const ct = res.headers.get("content-type") || "";
      if (ct && !/text\/(html|plain)/i.test(ct)) {
        console.log(`[Leads Harvest][fetch] non-html ${ct} ${url}`);
        return "";
      }
      const text = await res.text();
      console.log(`[Leads Harvest][fetch] OK ${url} ${text.length}b (${Date.now() - t0}ms)`);
      // Cap memory — huge pages aren't worth scanning fully and the contact
      // block is almost always in the first 500KB.
      return text.length > 500_000 ? text.slice(0, 500_000) : text;
    } catch (e) {
      console.log(`[Leads Harvest][fetch] FAIL ${url} (${Date.now() - t0}ms) ${e?.name || e}`);
      return "";
    } finally {
      clearTimeout(t);
    }
  }

  async function enrichFromWebsite(website) {
    let origin = "";
    let siteHost = "";
    try {
      const u = new URL(website);
      origin = u.origin;
      siteHost = u.hostname;
    } catch { return { email: "", socials: {} }; }

    // Home first (footer carries both contact email and social row on most
    // small-business sites). Continue through contact paths to pick up emails
    // that aren't on the home page. Short-circuit once we have an email AND
    // ≥3 socials — usually means we hit the footer and the rest is redundant.
    const paths = ["", "/contact", "/contact-us", "/about", "/about-us"];
    let email = "";
    const socials = {};
    for (const path of paths) {
      const html = await fetchWithTimeout(origin + path);
      if (!html) continue;
      if (!email) {
        // Only accept emails whose domain matches the site's domain or is a
        // known personal provider. Filters out web-dev/agency leaks like
        // support@cartcoders.com appearing on the client's Shopify footer.
        const candidates = extractEmails(html);
        const matched = candidates.find((e) => emailMatchesSite(e, siteHost));
        if (matched) email = matched;
      }
      const pageSocials = extractSocials(html);
      for (const [k, v] of Object.entries(pageSocials)) {
        if (!socials[k]) socials[k] = v;
      }
      if (email && Object.keys(socials).length >= 3) break;
    }
    return { email, socials };
  }

  let crawlInFlight = false;

  async function crawlAllEmails() {
    if (crawlInFlight) {
      console.log("[Leads Harvest][crawl] already in flight, skipping");
      return;
    }
    crawlInFlight = true;
    try {
      const { leads = [] } = await chrome.storage.local.get(["leads"]);
      const toCrawl = leads.filter((l) => l.website && !l.enriched);
      console.log(`[Leads Harvest][crawl] ${toCrawl.length} of ${leads.length} leads need enrichment`);
      if (!toCrawl.length) {
        await chrome.storage.local.set({ emailCrawl: null });
        chrome.runtime.sendMessage({ type: "EMAIL_CRAWL_DONE", total: 0 }).catch(() => {});
        return;
      }

      await chrome.storage.local.set({
        emailCrawl: { done: 0, total: toCrawl.length, active: true },
      });

      const CONCURRENCY = 3;
      let nextIdx = 0;
      let doneCount = 0;

      async function worker() {
        while (true) {
          const myIdx = nextIdx++;
          if (myIdx >= toCrawl.length) return;
          const lead = toCrawl[myIdx];
          try {
            const { email, socials } = await enrichFromWebsite(lead.website);
            console.log(`[Leads Harvest][crawl] "${lead.name}" email=${!!email} socials=${Object.keys(socials).join(",") || "none"}`);
            lead.email = email || lead.email || "";
            // Preserve socials already captured by the content-script pass off
            // the Maps detail panel — only overwrite when this pass found a
            // value. Otherwise a JS-rendered website footer would erase the
            // Maps-side data we already have.
            lead.facebook = socials.facebook || lead.facebook || "";
            lead.instagram = socials.instagram || lead.instagram || "";
            lead.twitter = socials.twitter || lead.twitter || "";
            lead.linkedin = socials.linkedin || lead.linkedin || "";
            lead.youtube = socials.youtube || lead.youtube || "";
            lead.tiktok = socials.tiktok || lead.tiktok || "";
          } catch {
            lead.email = lead.email || "";
          }
          lead.enriched = true;
          doneCount++;
          // Progress object is tiny — write every iteration so the in-Maps
          // banner (which reads via storage.onChanged) ticks in sync with the
          // popup (which also gets EMAIL_PROGRESS runtime messages per lead).
          await chrome.storage.local.set({
            emailCrawl: { done: doneCount, total: toCrawl.length, active: true },
          });
          // Leads is the heavy write — keep the every-3 throttle so a
          // service-worker shutdown mid-crawl doesn't lose progress without
          // thrashing storage on every completion.
          if (doneCount % 3 === 0 || doneCount === toCrawl.length) {
            await chrome.storage.local.set({ leads });
          }
          chrome.runtime.sendMessage({
            type: "EMAIL_PROGRESS",
            done: doneCount,
            total: toCrawl.length,
            name: lead.name,
            email: lead.email,
          }).catch(() => {});
        }
      }

      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      await chrome.storage.local.set({ leads, emailCrawl: null });
      chrome.runtime.sendMessage({
        type: "EMAIL_CRAWL_DONE",
        total: toCrawl.length,
      }).catch(() => {});
    } finally {
      crawlInFlight = false;
    }
  }

  // --- Deep enrichment via hidden tab -----------------------------------
  // Many small-business sites (Wix, Squarespace, Elementor) render their
  // footer socials in JS — SW fetch returns SSR HTML without them. Phase 2
  // opens each remaining lead's site in a background tab, waits for the
  // footer to render, then reads the live DOM.

  const openedEnrichmentTabs = new Set();

  // Runs inside the hidden tab's isolated world. extractSocialsFromElement
  // is in global scope because we injected social_classifier.js first.
  // siteHost is passed in so we can reject emails whose domain doesn't
  // belong to the business (web-dev/agency leaks).
  function extractInPage(maxWaitMs, siteHost) {
    return new Promise((resolve) => {
      const start = Date.now();

      const personalRe = /^(gmail|yahoo|hotmail|outlook|aol|icloud|protonmail|proton|mail|msn|yandex|gmx|live|me|fastmail|zoho|tutanota)\.[a-z.]{2,}$/i;
      const rootOf = (h) => (h || "").toLowerCase().split(".").filter(Boolean).slice(-2).join(".");
      const matchesSite = (email) => {
        const eh = (email.split("@")[1] || "").toLowerCase();
        if (!eh) return false;
        if (personalRe.test(eh)) return true;
        if (!siteHost) return false;
        return rootOf(eh) === rootOf(siteHost);
      };

      const findEmail = () => {
        const html = document.documentElement.outerHTML;
        const junk = /^(you|your|name|email|test|user|noreply|no-reply|donotreply|do-not-reply)@|@(example|test|domain|sample|placeholder|wixpress|sentry)\.|@group\.calendar\.google\.com$|\.(png|jpe?g|gif|svg|webp|css|js|ico)$/i;
        const mailto = html.match(/mailto:([^"'?\s>#]+)/i);
        if (mailto) {
          try {
            const e = decodeURIComponent(mailto[1]).toLowerCase().trim();
            if (/^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(e) && !junk.test(e) && matchesSite(e)) return e;
          } catch {}
        }
        const matches = html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
        for (const raw of matches) {
          const e = raw.toLowerCase();
          if (junk.test(e)) continue;
          if (!matchesSite(e)) continue;
          return e;
        }
        return "";
      };

      const tryExtract = () => {
        const socials = (typeof extractSocialsFromElement === "function")
          ? extractSocialsFromElement(document.documentElement)
          : {};
        const email = findEmail();

        if (email && Object.keys(socials).length >= 3) {
          resolve({ email, socials });
          return;
        }
        if (Date.now() - start >= maxWaitMs) {
          resolve({ email, socials });
          return;
        }
        setTimeout(tryExtract, 600);
      };

      tryExtract();
    });
  }

  async function enrichFromHiddenTab(website) {
    const result = { email: "", socials: {} };
    let tabId = null;
    let siteHost = "";
    try { siteHost = new URL(website).hostname; } catch {}
    const t0 = Date.now();

    try {
      const tab = await chrome.tabs.create({ url: website, active: false });
      tabId = tab.id;
      openedEnrichmentTabs.add(tabId);
      // Prevent Chrome from auto-discarding the tab mid-extraction under
      // memory pressure — without this, executeScript can fail with
      // "No tab with id" while the tab is being reclaimed.
      try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch {}

      // Wait for load complete (12s cap — slow sites won't paint the footer
      // anyway, so we'd rather move on than block the whole phase).
      await new Promise((resolve) => {
        let resolved = false;
        const finish = () => { if (!resolved) { resolved = true; resolve(); } };
        const onUpdated = (id, info) => {
          if (id === tabId && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            finish();
          }
        };
        chrome.tabs.onUpdated.addListener(onUpdated);
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          finish();
        }, 12000);
      });

      // Inject the shared classifier into the page's isolated world. Errors
      // here (e.g. chrome:// URL, navigation failure) are swallowed by the
      // outer try/catch; the tab still gets closed in finally.
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["social_classifier.js"],
      });

      const injectResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractInPage,
        args: [8000, siteHost],
      });

      if (injectResult?.[0]?.result) {
        Object.assign(result, injectResult[0].result);
      }

      console.log(`[Leads Harvest][tab] ${website} email=${!!result.email} socials=${Object.keys(result.socials).join(",") || "none"} (${Date.now() - t0}ms)`);
    } catch (e) {
      console.log(`[Leads Harvest][tab] FAIL ${website}: ${e?.message || e}`);
    } finally {
      if (tabId !== null) {
        try { await chrome.tabs.remove(tabId); } catch {}
        openedEnrichmentTabs.delete(tabId);
      }
    }

    return result;
  }

  let deepCrawlInFlight = false;

  async function deepEnrichLeads() {
    if (deepCrawlInFlight) {
      console.log("[Leads Harvest][deep] already in flight, skipping");
      return;
    }
    deepCrawlInFlight = true;
    try {
      const { leads = [] } = await chrome.storage.local.get(["leads"]);
      // Only revisit leads where the SW-fetch pass yielded little — leads
      // with email AND ≥2 socials are likely fully covered, skip them.
      const SOCIAL_KEYS = ["facebook", "instagram", "twitter", "linkedin", "youtube", "tiktok"];
      const toCrawl = leads.filter((l) => {
        if (!l.website || !l.enriched || l.deepEnriched) return false;
        const socialCount = SOCIAL_KEYS.filter((k) => l[k]).length;
        return !l.email || socialCount < 2;
      });
      // Group leads by canonical website URL so duplicate Maps listings
      // (chains, multi-location, Maps data dupes) only get one hidden-tab
      // visit. Saves ~15-30s per duplicate on the medspa-type niches.
      const canonicalWebsite = (url) => {
        try {
          const u = new URL(url);
          const path = u.pathname.replace(/\/+$/, "").toLowerCase();
          return `${u.protocol}//${u.host.toLowerCase()}${path}`;
        } catch { return url; }
      };
      const byWebsite = new Map();
      for (const lead of toCrawl) {
        const key = canonicalWebsite(lead.website);
        if (!byWebsite.has(key)) byWebsite.set(key, []);
        byWebsite.get(key).push(lead);
      }
      console.log(`[Leads Harvest][deep] ${toCrawl.length} leads (${byWebsite.size} unique sites) need deep enrichment`);
      if (!toCrawl.length) return;

      await chrome.storage.local.set({
        emailCrawl: { done: 0, total: toCrawl.length, active: true, phase: "deep" },
      });

      let doneCount = 0;
      // Serial — hidden tabs are heavy on memory and Chrome throttles
      // background tabs, so parallelism is unreliable here anyway.
      for (const [siteKey, sharedLeads] of byWebsite) {
        let result = { email: "", socials: {} };
        try {
          result = await enrichFromHiddenTab(sharedLeads[0].website);
          if (sharedLeads.length > 1) {
            console.log(`[Leads Harvest][deep] applying result to ${sharedLeads.length} leads sharing ${siteKey}`);
          }
        } catch (e) {
          console.log(`[Leads Harvest][deep] error ${siteKey}:`, e);
        }

        const { email, socials } = result;
        for (const lead of sharedLeads) {
          lead.email = email || lead.email || "";
          lead.facebook = socials.facebook || lead.facebook || "";
          lead.instagram = socials.instagram || lead.instagram || "";
          lead.twitter = socials.twitter || lead.twitter || "";
          lead.linkedin = socials.linkedin || lead.linkedin || "";
          lead.youtube = socials.youtube || lead.youtube || "";
          lead.tiktok = socials.tiktok || lead.tiktok || "";
          lead.deepEnriched = true;
          doneCount++;
        }

        await chrome.storage.local.set({
          leads,
          emailCrawl: { done: doneCount, total: toCrawl.length, active: true, phase: "deep" },
        });
        chrome.runtime.sendMessage({
          type: "EMAIL_PROGRESS",
          done: doneCount,
          total: toCrawl.length,
          name: sharedLeads.map((l) => l.name).join(", "),
          email,
          phase: "deep",
        }).catch(() => {});
      }

      await chrome.storage.local.set({ leads, emailCrawl: null });
      chrome.runtime.sendMessage({
        type: "EMAIL_CRAWL_DONE",
        total: toCrawl.length,
        phase: "deep",
      }).catch(() => {});
    } finally {
      deepCrawlInFlight = false;
    }
  }

  // --- Free quota tracking ----------------------------------------------------
  // Free-tier cap is lifetime, stored in chrome.storage.sync so reinstalling
  // doesn't reset it (when Chrome sync is on — covers ~60-70% of users; the
  // rest can still reset, accepted as residual leakage). Increments on every
  // positive change to the local `leads` array.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local" || !changes.leads) return;
    const newCount = (changes.leads.newValue || []).length;
    const oldCount = (changes.leads.oldValue || []).length;
    const delta = newCount - oldCount;
    if (delta <= 0) return; // ignore decreases (Clear Saved Leads, etc.)
    const { freeLeadsUsed = 0 } = await chrome.storage.sync.get("freeLeadsUsed");
    await chrome.storage.sync.set({ freeLeadsUsed: freeLeadsUsed + delta });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "CRAWL_EMAILS") {
      (async () => {
        await crawlAllEmails();
        await deepEnrichLeads();
      })();
      return false;
    }
    return false;
  });
