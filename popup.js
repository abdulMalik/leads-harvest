 const FREE_LIMIT = 50;

  // Web3Forms access key — get a free one at https://web3forms.com
  // (enter your email, the key is emailed to you). Submissions are emailed
  // to that address. The key is safe to ship publicly; it only allows
  // sending TO your verified email, not reading anything.
  const WEB3FORMS_ACCESS_KEY = "bc03d913-7e40-4e5b-bd26-0c2069430e83";

  // User settings, persisted in chrome.storage.sync under "settings".
  const DEFAULT_SETTINGS = {
    fastMode: false,   // skip email/social enrichment for speed
    scanDelay: 1200,   // ms between scroll/scan ticks
    target: FREE_LIMIT, // stop after this many new leads in a run
    fields: {
      phone: true, email: true, website: true, address: true,
      category: true, ratings: true, socials: true, hours: true,
    },
  };
  let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

  const els = {
    startBtn: document.getElementById("startBtn"),
    stopBtn: document.getElementById("stopBtn"),
    exportBtn: document.getElementById("exportBtn"),
    exportExcelBtn: document.getElementById("exportExcelBtn"),
    exportJsonBtn: document.getElementById("exportJsonBtn"),
    clearBtn: document.getElementById("clearBtn"),
    leadCount: document.getElementById("leadCount"),
    leadLimit: document.getElementById("leadLimit"),
    progressBar: document.getElementById("progressBar"),
    status: document.getElementById("status"),
    warningBanner: document.getElementById("warningBanner"),
    limitBanner: document.getElementById("limitBanner"),
    lastUpdated: document.getElementById("lastUpdated"),
    harvestProgress: document.getElementById("harvestProgress"),
    harvestProgressBar: document.getElementById("harvestProgressBar"),
    harvestProgressLabel: document.getElementById("harvestProgressLabel"),
    harvestTip: document.getElementById("harvestTip"),
    counterLabel: document.getElementById("counterLabel"),
    fastModeNote: document.getElementById("fastModeNote"),
    // tabs
    tabBtns: Array.from(document.querySelectorAll(".tab-btn")),
    tabPanes: Array.from(document.querySelectorAll(".tab-pane")),
    // data tab
    statTotal: document.getElementById("statTotal"),
    statEmail: document.getElementById("statEmail"),
    statPhone: document.getElementById("statPhone"),
    dataTableBody: document.getElementById("dataTableBody"),
    // settings tab
    settingFastMode: document.getElementById("settingFastMode"),
    settingScanDelay: document.getElementById("settingScanDelay"),
    settingTarget: document.getElementById("settingTarget"),
    fieldChecks: Array.from(document.querySelectorAll("[data-field]")),
    saveSettingsBtn: document.getElementById("saveSettingsBtn"),
    settingsStatus: document.getElementById("settingsStatus"),
    // feedback
    feedbackToggle: document.getElementById("feedbackToggle"),
    feedbackForm: document.getElementById("feedbackForm"),
    fbName: document.getElementById("fbName"),
    fbEmail: document.getElementById("fbEmail"),
    fbPhone: document.getElementById("fbPhone"),
    fbMessage: document.getElementById("fbMessage"),
    fbStatus: document.getElementById("fbStatus"),
    fbSendBtn: document.getElementById("fbSendBtn"),
    fbCancelBtn: document.getElementById("fbCancelBtn"),
  };

  const state = {
    leads: [],
    isHarvesting: false,
    freeLeadsUsed: 0,
    selectorDegraded: false,
    limitReached: false,
    lastUpdated: null,
    lastHarvestReason: null,
    emailCrawl: null,
  };

  async function getActiveMapsTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith("https://www.google.com/maps")) return null;
    return tab;
  }

  async function refreshQuota() {
    const { freeLeadsUsed = 0 } = await chrome.storage.sync.get(["freeLeadsUsed"]);
    state.freeLeadsUsed = freeLeadsUsed;
  }

  async function restoreState() {
    const stored = await chrome.storage.local.get([
      "leads", "isHarvesting", "selectorDegraded", "limitReached", "lastUpdated", "lastHarvestReason", "emailCrawl",
    ]);
    Object.assign(state, {
      leads: stored.leads || [],
      isHarvesting: !!stored.isHarvesting,
      selectorDegraded: !!stored.selectorDegraded,
      limitReached: !!stored.limitReached,
      lastUpdated: stored.lastUpdated || null,
      lastHarvestReason: stored.lastHarvestReason || null,
      emailCrawl: stored.emailCrawl || null,
    });
    await refreshQuota();
    render();
  }

  function render() {
    const count = state.leads.length;
    // limitReached is true if either the runtime flag fired during a harvest
    // OR the user has hit their lifetime quota — covers the case where they
    // cleared leads but already burned through their free quota.
    const quotaFull = state.freeLeadsUsed >= FREE_LIMIT;
    const limitReached = state.limitReached || quotaFull;

    els.leadCount.textContent = state.freeLeadsUsed;
    els.leadLimit.textContent = `/ ${FREE_LIMIT}`;
    els.progressBar.style.width = `${Math.min(100, (state.freeLeadsUsed / FREE_LIMIT) * 100)}%`;

    const enriching = !!(state.emailCrawl && state.emailCrawl.active);
    els.startBtn.disabled = state.isHarvesting || enriching || limitReached;
    const hasMoreToHarvest =
      count > 0 &&
      !state.isHarvesting &&
      state.lastHarvestReason &&
      state.lastHarvestReason !== "end-of-results";
    els.startBtn.textContent = hasMoreToHarvest ? "Continue Harvesting" : "Start Harvesting";
    els.stopBtn.disabled = !state.isHarvesting;
    // Disable export while enrichment is still writing emails/socials.
    // Otherwise users export an incomplete file and assume the tool is broken.
    const exportDisabled = count === 0 || state.isHarvesting || enriching;
    els.exportBtn.disabled = exportDisabled;
    els.exportExcelBtn.disabled = exportDisabled;
    els.exportJsonBtn.disabled = exportDisabled;
    els.warningBanner.classList.toggle("hidden", !state.selectorDegraded);
    els.limitBanner.classList.toggle("hidden", !limitReached);
    els.fastModeNote.classList.toggle("hidden", !settings.fastMode);

    els.harvestProgress.classList.toggle("hidden", !state.isHarvesting);
    els.harvestTip.classList.toggle("hidden", !state.isHarvesting);
    if (state.isHarvesting) {
      const pct = Math.min(100, Math.round((count / FREE_LIMIT) * 100));
      els.harvestProgressBar.style.width = `${pct}%`;
      els.harvestProgressLabel.textContent = `Harvesting… ${pct}%`;
    }

    if (state.isHarvesting) {
      els.status.classList.add("hidden");
    } else if (state.emailCrawl && state.emailCrawl.active) {
      els.status.textContent = state.emailCrawl.phase === "deep"
        ? `Deep-scanning sites… ${state.emailCrawl.done}/${state.emailCrawl.total}`
        : `Finding emails & socials… ${state.emailCrawl.done}/${state.emailCrawl.total}`;
      els.status.className = "status";
      els.status.classList.remove("hidden");
    } else if (limitReached) {
      els.status.textContent = "Lifetime free limit reached.";
      els.status.className = "status";
    } else if (count === 0) {
      els.status.textContent = "Open Google Maps and search to begin.";
      els.status.className = "status";
    } else {
      els.status.textContent = `${count} lead${count === 1 ? "" : "s"} ready to export.`;
      els.status.className = "status";
    }

    els.lastUpdated.textContent = state.lastUpdated
      ? `Last updated ${new Date(state.lastUpdated).toLocaleTimeString()}`
      : "";

    renderDataTab();
  }

  // --- Data tab: stats + preview table --------------------------------------
  function renderDataTab() {
    const leads = state.leads;
    els.statTotal.textContent = leads.length;
    els.statEmail.textContent = leads.filter((l) => l.email).length;
    els.statPhone.textContent = leads.filter((l) => l.phone).length;

    const tbody = els.dataTableBody;
    tbody.textContent = "";
    if (!leads.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.className = "data-empty";
      td.textContent = "No leads yet — run a harvest.";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    const cell = (text) => {
      const td = document.createElement("td");
      td.textContent = text || "";
      td.title = text || "";
      return td;
    };
    for (const l of leads) {
      const tr = document.createElement("tr");
      tr.appendChild(cell(l.name));
      tr.appendChild(cell(formatPhone(l.phone)));
      tr.appendChild(cell(l.email));
      tr.appendChild(cell(l.website ? shortHost(l.website) : ""));
      tbody.appendChild(tr);
    }
  }

  function shortHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch { return url; }
  }

  // --- Tabs ------------------------------------------------------------------
  els.tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.tab;
      els.tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
      els.tabPanes.forEach((p) => p.classList.toggle("active", p.id === `tab-${id}`));
    });
  });

  // --- Settings --------------------------------------------------------------
  async function loadSettings() {
    const { settings: stored } = await chrome.storage.sync.get("settings");
    settings = {
      ...DEFAULT_SETTINGS,
      ...(stored || {}),
      fields: { ...DEFAULT_SETTINGS.fields, ...((stored && stored.fields) || {}) },
    };
    applySettingsToUI();
  }

  function applySettingsToUI() {
    els.settingFastMode.checked = !!settings.fastMode;
    els.settingScanDelay.value = String(settings.scanDelay);
    els.settingTarget.value = String(settings.target);
    els.fieldChecks.forEach((cb) => {
      cb.checked = settings.fields[cb.dataset.field] !== false;
    });
  }

  function setSettingsStatus(msg, kind) {
    els.settingsStatus.textContent = msg || "";
    els.settingsStatus.className = `settings-status${kind ? " " + kind : ""}`;
  }

  els.saveSettingsBtn.addEventListener("click", async () => {
    let target = parseInt(els.settingTarget.value, 10);
    if (!Number.isFinite(target)) target = FREE_LIMIT;
    target = Math.min(FREE_LIMIT, Math.max(1, target));
    els.settingTarget.value = String(target);

    const fields = {};
    els.fieldChecks.forEach((cb) => { fields[cb.dataset.field] = cb.checked; });

    settings = {
      fastMode: els.settingFastMode.checked,
      scanDelay: parseInt(els.settingScanDelay.value, 10) || 1200,
      target,
      fields,
    };
    await chrome.storage.sync.set({ settings });
    setSettingsStatus("Settings saved.", "success");
    setTimeout(() => setSettingsStatus("", null), 2500);
    render();
  });

  els.startBtn.addEventListener("click", async () => {
    await refreshQuota();
    const tab = await getActiveMapsTab();
    if (!tab) {
      els.status.textContent = "Open google.com/maps first.";
      els.status.className = "status error";
      return;
    }
    // content.js preloads saved leads into its `collected` map and compares
    // `collected.size >= limit`. So the per-harvest limit we pass must be
    // `existingLoadedCount + thisRunTarget`, where the run target is the
    // smaller of the user's target setting and the remaining free quota.
    const remaining = Math.max(0, FREE_LIMIT - state.freeLeadsUsed);
    const runTarget = Math.min(remaining, settings.target || FREE_LIMIT);
    const limit = state.leads.length + runTarget;
    state.isHarvesting = true;
    state.limitReached = false;
    state.lastHarvestReason = null;
    await chrome.storage.local.set({ isHarvesting: true, limitReached: false, lastHarvestReason: null });
    render();
    chrome.tabs.sendMessage(tab.id, {
      type: "START_HARVEST",
      limit,
      deepHarvest: true,
      fastMode: settings.fastMode,
      scanDelay: settings.scanDelay,
    }).catch(() => {});
  });

  els.stopBtn.addEventListener("click", async () => {
    const tab = await getActiveMapsTab();
    state.isHarvesting = false;
    await chrome.storage.local.set({ isHarvesting: false });
    if (tab) chrome.tabs.sendMessage(tab.id, { type: "STOP_HARVEST" }).catch(() => {});
    render();
  });

  // --- Export helpers --------------------------------------------------------
  function formatPhone(raw) {
    if (!raw) return "";
    const digits = String(raw).replace(/\D/g, "");
    if (!digits) return "";
    // US/Canada — most common for this niche; format with parens for sales-tool readability.
    if (digits.length === 10) {
      return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    if (digits.length === 11 && digits.startsWith("1")) {
      return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    // International — best-effort grouping. Assumes a 1-3 digit country code,
    // then groups of 2-3. Not perfect for every country plan, but readable.
    if (digits.length >= 7 && digits.length <= 15) {
      // Common 2-digit country codes for our likely traffic (PK, UK, IN, SA, AE).
      const TWO_DIGIT_CC = /^(92|44|91|34|39|49|81|82|86|55|54|61|64|27|20|62|66|65|60|63|31|32|33|41|43|45|46|47|48|90|94|95|98)/;
      let cc, rest;
      if (TWO_DIGIT_CC.test(digits)) {
        cc = digits.slice(0, 2);
        rest = digits.slice(2);
      } else {
        cc = digits.slice(0, digits.length > 10 ? 3 : 2);
        rest = digits.slice(cc.length);
      }
      // Group the national number in chunks for readability.
      const groups = [];
      let i = 0;
      while (i < rest.length) {
        const chunkSize = (rest.length - i) >= 4 ? 3 : (rest.length - i);
        groups.push(rest.slice(i, i + chunkSize));
        i += chunkSize;
      }
      return `+${cc} ${groups.join(" ")}`.trim();
    }
    return String(raw); // give up — return as-is
  }

  function splitHoursDetail(jsonStr) {
    const blank = { mon: "", tue: "", wed: "", thu: "", fri: "", sat: "", sun: "" };
    if (!jsonStr) return blank;
    try {
      const parsed = typeof jsonStr === "string" ? JSON.parse(jsonStr) : jsonStr;
      return {
        mon: parsed.Mon || parsed.Monday || "",
        tue: parsed.Tue || parsed.Tuesday || "",
        wed: parsed.Wed || parsed.Wednesday || "",
        thu: parsed.Thu || parsed.Thursday || "",
        fri: parsed.Fri || parsed.Friday || "",
        sat: parsed.Sat || parsed.Saturday || "",
        sun: parsed.Sun || parsed.Sunday || "",
      };
    } catch {
      return blank;
    }
  }

  // Column order is sales-priority: identifier + direct contact channels
  // first, then qualifying context (category/rating), then social profiles,
  // then per-day hours for filtering. `logo` is intentionally omitted — the
  // googleusercontent URLs expire in a few weeks and aren't useful in a CSV;
  // they stay in storage for in-popup display only.
  const EXPORT_HEADERS = [
    "name", "phone", "email", "website", "address",
    "category", "rating", "reviews",
    "facebook", "instagram", "twitter", "linkedin", "youtube", "tiktok",
    "hours_mon", "hours_tue", "hours_wed", "hours_thu", "hours_fri", "hours_sat", "hours_sun",
  ];

  // Maps each export column to the settings field-group that toggles it.
  // "name" has no group — it's always included.
  const HEADER_FIELD = {
    name: null,
    phone: "phone", email: "email", website: "website", address: "address",
    category: "category", rating: "ratings", reviews: "ratings",
    facebook: "socials", instagram: "socials", twitter: "socials",
    linkedin: "socials", youtube: "socials", tiktok: "socials",
    hours_mon: "hours", hours_tue: "hours", hours_wed: "hours", hours_thu: "hours",
    hours_fri: "hours", hours_sat: "hours", hours_sun: "hours",
  };

  // Headers the user has enabled via the Settings → Export fields checkboxes.
  function activeHeaders() {
    return EXPORT_HEADERS.filter((h) => {
      const group = HEADER_FIELD[h];
      return group === null || settings.fields[group] !== false;
    });
  }

  function buildExportRow(lead) {
    const h = splitHoursDetail(lead.hours_detail);
    return {
      name: lead.name || "",
      phone: formatPhone(lead.phone),
      email: lead.email || "",
      website: lead.website || "",
      address: lead.address || "",
      category: lead.category || "",
      rating: lead.rating ?? "",
      reviews: lead.reviews ?? "",
      facebook: lead.facebook || "",
      instagram: lead.instagram || "",
      twitter: lead.twitter || "",
      linkedin: lead.linkedin || "",
      youtube: lead.youtube || "",
      tiktok: lead.tiktok || "",
      hours_mon: h.mon,
      hours_tue: h.tue,
      hours_wed: h.wed,
      hours_thu: h.thu,
      hours_fri: h.fri,
      hours_sat: h.sat,
      hours_sun: h.sun,
    };
  }

  function triggerDownload(blob, ext) {
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    chrome.downloads.download(
      { url, filename: `leads-harvest-${ts}.${ext}`, saveAs: true },
      () => URL.revokeObjectURL(url)
    );
  }

  els.exportBtn.addEventListener("click", () => {
    if (state.leads.length === 0) return;
    const headers = activeHeaders();
    const escape = (v) => {
      const s = (v ?? "").toString().replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const rows = state.leads.map(buildExportRow);
    const csv = "﻿" + [
      headers.join(","),
      ...rows.map((r) => headers.map((h) => escape(r[h])).join(",")),
    ].join("\n");
    triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8" }), "csv");
  });

  els.exportJsonBtn.addEventListener("click", () => {
    if (state.leads.length === 0) return;
    const headers = activeHeaders();
    const rows = state.leads.map((lead) => {
      const full = buildExportRow(lead);
      const filtered = {};
      headers.forEach((h) => { filtered[h] = full[h]; });
      return filtered;
    });
    const json = JSON.stringify(rows, null, 2);
    triggerDownload(new Blob([json], { type: "application/json;charset=utf-8" }), "json");
  });

  els.exportExcelBtn.addEventListener("click", () => {
    if (state.leads.length === 0) return;
    if (typeof XLSX === "undefined") {
      els.status.textContent = "Excel library failed to load — try CSV.";
      els.status.className = "status error";
      return;
    }
    const headers = activeHeaders();
    const rows = state.leads.map(buildExportRow);
    const aoa = [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ""))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Leads");
    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    triggerDownload(
      new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      "xlsx"
    );
  });

  els.clearBtn.addEventListener("click", async () => {
    if (!confirm("Clear all captured leads?")) return;
    await chrome.storage.local.set({ leads: [], limitReached: false, lastUpdated: null, lastHarvestReason: null, selectorDegraded: false });
    state.leads = [];
    state.limitReached = false;
    state.lastUpdated = null;
    state.lastHarvestReason = null;
    state.selectorDegraded = false;
    // Tell the content script (if running on a Maps tab) to drop its in-memory
    // copy too — otherwise the next harvest re-uses the previous run's leads.
    const tab = await getActiveMapsTab();
    if (tab) chrome.tabs.sendMessage(tab.id, { type: "CLEAR_LEADS" }).catch(() => {});
    render();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") {
      if (changes.freeLeadsUsed) {
        state.freeLeadsUsed = changes.freeLeadsUsed.newValue || 0;
        render();
      }
      if (changes.settings) {
        const v = changes.settings.newValue;
        if (v) {
          settings = { ...DEFAULT_SETTINGS, ...v, fields: { ...DEFAULT_SETTINGS.fields, ...(v.fields || {}) } };
          applySettingsToUI();
          render();
        }
      }
      return;
    }
    if (area !== "local") return;
    if (changes.leads) state.leads = changes.leads.newValue || [];
    if (changes.isHarvesting) state.isHarvesting = !!changes.isHarvesting.newValue;
    if (changes.selectorDegraded) state.selectorDegraded = !!changes.selectorDegraded.newValue;
    if (changes.limitReached) state.limitReached = !!changes.limitReached.newValue;
    if (changes.lastUpdated) state.lastUpdated = changes.lastUpdated.newValue;
    if (changes.lastHarvestReason) state.lastHarvestReason = changes.lastHarvestReason.newValue || null;
    if (changes.emailCrawl) state.emailCrawl = changes.emailCrawl.newValue || null;
    render();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "HARVEST_DONE") {
      state.isHarvesting = false;
      chrome.storage.local.set({ isHarvesting: false });
      render();
    } else if (msg.type === "EMAIL_PROGRESS") {
      state.emailCrawl = { done: msg.done, total: msg.total, active: true };
      render();
    } else if (msg.type === "EMAIL_CRAWL_DONE") {
      state.emailCrawl = null;
      render();
    }
  });

  // --- Feedback form ---------------------------------------------------------
  function setFbStatus(message, kind) {
    els.fbStatus.textContent = message;
    els.fbStatus.className = `feedback-status${kind ? " " + kind : ""}`;
    els.fbStatus.classList.toggle("hidden", !message);
  }

  els.feedbackToggle.addEventListener("click", (e) => {
    e.preventDefault();
    els.feedbackForm.classList.toggle("hidden");
    if (!els.feedbackForm.classList.contains("hidden")) {
      els.fbName.focus();
    }
  });

  els.fbCancelBtn.addEventListener("click", () => {
    els.feedbackForm.classList.add("hidden");
    setFbStatus("", null);
  });

  els.fbSendBtn.addEventListener("click", async () => {
    const name = els.fbName.value.trim();
    const email = els.fbEmail.value.trim();
    const phone = els.fbPhone.value.trim();
    const message = els.fbMessage.value.trim();

    if (!name || !email || !message) {
      setFbStatus("Please fill in your name, email, and message.", "error");
      return;
    }
    if (WEB3FORMS_ACCESS_KEY === "YOUR-ACCESS-KEY-HERE") {
      setFbStatus("Feedback isn't configured yet. Please try again later.", "error");
      return;
    }

    els.fbSendBtn.disabled = true;
    setFbStatus("Sending…", null);
    try {
      const res = await fetch("https://api.web3forms.com/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          access_key: WEB3FORMS_ACCESS_KEY,
          subject: "Leads Harvest — Feedback",
          from_name: "Leads Harvest Extension",
          name,
          email,
          phone: phone || "(not provided)",
          message,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setFbStatus("Thanks! Your message has been sent.", "success");
        els.fbName.value = els.fbEmail.value = els.fbPhone.value = els.fbMessage.value = "";
      } else {
        setFbStatus(data.message || "Couldn't send. Please try again.", "error");
      }
    } catch {
      setFbStatus("Network error. Please check your connection and retry.", "error");
    } finally {
      els.fbSendBtn.disabled = false;
    }
  });

  // --- Init ------------------------------------------------------------------
  loadSettings();
  restoreState();
