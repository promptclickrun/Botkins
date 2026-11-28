// Registrable domain (eTLD+1) matching and strict origin pinning for credentials.
//
// Two deliberately distinct operations live here:
// 1. Discovery (`siteMatches` / `registrableDomain`): matches a page URL against saved credential
//    websites and aliases by eTLD+1 (so `www.scissorsscotch.com` and `app.scissorsscotch.com`
//    find a login saved for `scissorsscotch.com`), while rejecting look-alike domains such as
//    `evil-scissorsscotch.com` or `scissorsscotch.com.evil.com`, and keeping shared hosting
//    subdomains (e.g. `*.github.io`, `*.vercel.app`) isolated from one another.
// 2. Pinning (`originMatches` / `pinOrigin`): exact scheme + ASCII host + port equality used at
//    grant lookup and fill time, so a grant for `https://scissorsscotch.com` never fills on
//    another origin, a redirect, a cross-origin iframe, or a look-alike domain.

import { isIP } from "node:net";

/** Common multi-label public suffixes and shared hosting platforms where each tenant owns one label below. */
const MULTI_LABEL_SUFFIXES = new Set([
  // Country-code second-level domains
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "net.uk", "ltd.uk", "plc.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz", "geek.nz", "gen.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "ed.jp", "gr.jp",
  "com.br", "net.br", "org.br", "gov.br", "edu.br", "art.br",
  "com.mx", "org.mx", "gob.mx", "edu.mx", "net.mx",
  "co.in", "net.in", "org.in", "gov.in", "ac.in", "edu.in", "res.in",
  "co.za", "org.za", "gov.za", "ac.za", "net.za", "web.za",
  "co.kr", "or.kr", "ne.kr", "go.kr", "ac.kr", "re.kr",
  "com.sg", "net.sg", "org.sg", "gov.sg", "edu.sg",
  "com.hk", "net.hk", "org.hk", "gov.hk", "edu.hk",
  "com.tw", "net.tw", "org.tw", "gov.tw", "edu.tw",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "com.tr", "net.tr", "org.tr", "gov.tr", "edu.tr",
  "com.ar", "net.ar", "org.ar", "gob.ar", "edu.ar",
  "com.co", "net.co", "org.co", "gov.co", "edu.co",
  "com.pe", "net.pe", "org.pe", "gob.pe", "edu.pe",
  "com.ua", "net.ua", "org.ua", "gov.ua", "edu.ua",
  "com.pl", "net.pl", "org.pl", "gov.pl", "edu.pl",
  "co.il", "org.il", "gov.il", "ac.il", "net.il",
  "co.id", "or.id", "ac.id", "go.id", "web.id",
  "com.my", "net.my", "org.my", "gov.my", "edu.my",
  "com.ph", "net.ph", "org.ph", "gov.ph", "edu.ph",
  "com.vn", "net.vn", "org.vn", "gov.vn", "edu.vn",
  "com.eg", "net.eg", "org.eg", "gov.eg", "edu.eg",
  "com.ng", "net.ng", "org.ng", "gov.ng", "edu.ng",
  "com.pk", "net.pk", "org.pk", "gov.pk", "edu.pk",
  "com.sa", "net.sa", "org.sa", "gov.sa", "edu.sa",
  "com.es", "nom.es", "org.es", "gob.es", "edu.es",
  "co.th", "or.th", "ac.th", "go.th", "in.th",
  "com.fr", "asso.fr", "gouv.fr",
  // Shared multi-tenant hosting suffixes (public suffix list private section)
  "github.io", "gitlab.io", "netlify.app", "vercel.app", "pages.dev", "workers.dev",
  "herokuapp.com", "appspot.com", "azurewebsites.net", "cloudfront.net", "fly.dev",
  "render.com", "onrender.com", "railway.app", "web.app", "firebaseapp.com",
  "s3.amazonaws.com", "amazonaws.com", "myshopify.com", "blogspot.com", "wordpress.com",
  "zendesk.com", "okta.com", "auth0.com", "us.auth0.com", "eu.auth0.com",
]);

/** Strip brackets from an IPv6 literal hostname. */
function bareHost(hostname) {
  const h = String(hostname ?? "").trim().toLowerCase().replace(/\.+$/, "");
  if (h.startsWith("[") && h.endsWith("]")) return h.slice(1, -1);
  return h;
}

/**
 * Parse a web URL or bare host string into a URL object (defaulting bare hosts to https://).
 * Returns null for non-http(s) schemes, embedded credentials, or invalid hosts.
 */
export function parseWebUrl(input, { allowHttp = false, allowBareHost = false } = {}) {
  const raw = String(input ?? "").trim();
  if (!raw || /\s/.test(raw)) return null;
  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    if (!allowBareHost) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return null; // javascript:, data:, chrome-extension:, etc.
    candidate = "https://" + candidate;
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) return null;
  if (!parsed.hostname) return null;
  return parsed;
}

/**
 * Canonical strict origin (`scheme://ascii-host[:port]`) for pinning grants and fill targets.
 * Only `https:` is accepted by default; `allowLocalHttp` permits `http://localhost` and `http://127.0.0.1`
 * only when explicitly requested (e.g. local integration tests).
 */
export function pinOrigin(input, { allowLocalHttp = false } = {}) {
  const parsed = parseWebUrl(input, { allowHttp: allowLocalHttp, allowBareHost: false });
  if (!parsed) return null;
  if (parsed.protocol === "http:") {
    const host = bareHost(parsed.hostname);
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return null;
  }
  return parsed.origin;
}

/** Strict origin equality check used at fill time (handles punycode, default ports, case). */
export function originMatches(actualUrl, pinnedOrigin, { allowLocalHttp = false } = {}) {
  const actual = pinOrigin(actualUrl, { allowLocalHttp });
  const expected = pinOrigin(pinnedOrigin, { allowLocalHttp });
  if (!actual || !expected) return false;
  return actual === expected;
}

/**
 * Registrable domain (eTLD+1) for a hostname or URL.
 * Returns exact host for IP literals and localhost so they never collide with another host.
 */
export function registrableDomain(input) {
  let host = "";
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const parsed = parseWebUrl(raw, { allowHttp: true, allowBareHost: true });
  if (parsed) {
    host = bareHost(parsed.hostname);
  } else {
    return null;
  }
  if (!host) return null;
  if (host === "localhost" || isIP(host)) return host;
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  // Check 3-label private suffixes first (e.g. s3.amazonaws.com, us.auth0.com), then 2-label.
  if (labels.length >= 4) {
    const last3 = labels.slice(-3).join(".");
    if (MULTI_LABEL_SUFFIXES.has(last3)) return labels.slice(-4).join(".");
  }
  if (labels.length >= 3) {
    const last2 = labels.slice(-2).join(".");
    if (MULTI_LABEL_SUFFIXES.has(last2)) return labels.slice(-3).join(".");
  }
  const last2 = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(last2)) return null; // bare public suffix like "co.uk" is not a registrable site
  return last2;
}

/** Extract normalized hostname from a URL or bare host string. */
export function hostnameOf(input) {
  const parsed = parseWebUrl(input, { allowHttp: true, allowBareHost: true });
  return parsed ? bareHost(parsed.hostname) : null;
}

/** Split a website / alias field that may hold one or more URLs/hosts (array or comma/newline separated). */
export function extractSiteList(websites) {
  const rawList = Array.isArray(websites) ? websites : websites ? [websites] : [];
  const out = [];
  const seen = new Set();
  for (const item of rawList) {
    if (typeof item !== "string") continue;
    for (const part of item.split(/[\r\n,;]+/)) {
      const trimmed = part.trim();
      if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
      seen.add(trimmed.toLowerCase());
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Whether a target site URL matches any of the candidate saved websites/aliases.
 * Returns match rank:
 *   3 = exact origin match
 *   2 = exact hostname match (different scheme/port, e.g. bare host alias)
 *   1 = registrable domain (eTLD+1) match (e.g. `www.scissorsscotch.com` ↔ `scissorsscotch.com`)
 *   0 = no match
 */
export function siteMatchScore(targetUrl, candidates) {
  const target = parseWebUrl(targetUrl, { allowHttp: true, allowBareHost: true });
  if (!target) return 0;
  const targetHost = bareHost(target.hostname);
  const targetDomain = registrableDomain(target.href);
  const targetIsIpOrLocal = targetHost === "localhost" || Boolean(isIP(targetHost));

  let best = 0;
  for (const candidate of extractSiteList(candidates)) {
    const parsed = parseWebUrl(candidate, { allowHttp: true, allowBareHost: true });
    if (!parsed) continue;
    const candHost = bareHost(parsed.hostname);
    if (parsed.origin === target.origin && target.protocol === parsed.protocol) {
      best = Math.max(best, 3);
      continue;
    }
    if (candHost === targetHost) {
      best = Math.max(best, 2);
      continue;
    }
    if (targetIsIpOrLocal) continue;
    const candDomain = registrableDomain(parsed.href);
    if (targetDomain && candDomain && targetDomain === candDomain) {
      best = Math.max(best, 1);
    }
  }
  return best;
}

/** Convenience boolean check for site matching. */
export function siteMatches(targetUrl, candidates) {
  return siteMatchScore(targetUrl, candidates) > 0;
}
