// Shared classifier + extractor for social-handle URLs. Loaded in three
// contexts: content script (manifest content_scripts), service worker
// (importScripts), and Node test runner (CommonJS require).

function classifySocial(u) {
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|business|web|[a-z]{2})\./, "");
  const path = u.pathname || "/";

  if (host === "facebook.com" || host === "fb.com" || host === "fb.me") {
    if (/^\/(sharer|share|tr|plugins|dialog|login|recover|reg|signup|help|policies|policy|terms|legal|privacy|brand|gaming|watch|marketplace|games|payments|ads|business|notes|events|groups|hashtag)(\/|$)/i.test(path)) return null;
    const handle = path.replace(/^\/+|\/+$/g, "");
    if (!handle) return null;
    return { platform: "facebook", url: `https://facebook.com/${handle}` };
  }
  if (host === "instagram.com") {
    if (/^\/(p|reel|reels|tv|stories|explore|accounts|developer|legal|press|jobs|api|about|directory)(\/|$)/i.test(path)) return null;
    const handle = path.replace(/^\/+/, "").split("/")[0];
    if (!handle) return null;
    return { platform: "instagram", url: `https://instagram.com/${handle}` };
  }
  if (host === "twitter.com" || host === "x.com") {
    if (/^\/(share|intent|home|i|search|hashtag|explore|notifications|messages|settings|login|signup|tos|privacy|about|jobs|compose)(\/|$)/i.test(path)) return null;
    const handle = path.replace(/^\/+/, "").split("/")[0];
    if (!handle) return null;
    return { platform: "twitter", url: `https://x.com/${handle}` };
  }
  if (host === "linkedin.com") {
    const m = path.match(/^\/(company|in|school|showcase)\/([^\/?#]+)/i);
    if (!m) return null;
    return { platform: "linkedin", url: `https://linkedin.com/${m[1].toLowerCase()}/${m[2]}` };
  }
  if (host === "youtube.com" || host === "youtu.be") {
    const m = path.match(/^\/(@[^\/?#]+|c\/[^\/?#]+|channel\/[^\/?#]+|user\/[^\/?#]+)/i);
    if (!m) return null;
    return { platform: "youtube", url: `https://youtube.com/${m[1]}` };
  }
  if (host === "tiktok.com") {
    const m = path.match(/^\/(@[^\/?#]+)/);
    if (!m) return null;
    return { platform: "tiktok", url: `https://tiktok.com/${m[1]}` };
  }
  return null;
}

const SOCIAL_HREF_RE = /href\s*=\s*["']([^"']+)["']/gi;

function extractSocials(html) {
  if (!html) return {};
  const found = {};
  SOCIAL_HREF_RE.lastIndex = 0;
  let m;
  while ((m = SOCIAL_HREF_RE.exec(html)) !== null) {
    let u;
    try { u = new URL(m[1]); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const c = classifySocial(u);
    if (!c) continue;
    if (!found[c.platform]) found[c.platform] = c.url;
  }
  return found;
}

// Classify every <a href> inside a DOM element. Used by content.js to scan
// the Maps detail panel — no string-level HTML grep needed since we already
// have live nodes. Returns the same shape as extractSocials.
function extractSocialsFromElement(root) {
  if (!root) return {};
  const found = {};
  const anchors = root.querySelectorAll("a[href]");
  for (const a of anchors) {
    let u;
    try { u = new URL(a.href); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const c = classifySocial(u);
    if (!c) continue;
    if (!found[c.platform]) found[c.platform] = c.url;
  }
  return found;
}

// Node test runner picks these up via require(). Browser/SW contexts ignore
// the assignment (module is undefined and the try/catch swallows it).
try {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { classifySocial, extractSocials, extractSocialsFromElement };
  }
} catch {}
