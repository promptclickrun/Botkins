// Same-site (scheme + registrable domain) check used before the extension submits a
// securely filled form. Mirrors desktop/desktop/link/domain-match.mjs `registrableDomain`;
// extension/test/site.test.mjs keeps the two in step.

export const MULTI_LABEL_SUFFIXES = new Set([
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
  "github.io", "gitlab.io", "netlify.app", "vercel.app", "pages.dev", "workers.dev",
  "herokuapp.com", "appspot.com", "azurewebsites.net", "cloudfront.net", "fly.dev",
  "render.com", "onrender.com", "railway.app", "web.app", "firebaseapp.com",
  "s3.amazonaws.com", "amazonaws.com", "myshopify.com", "blogspot.com", "wordpress.com",
  "zendesk.com", "okta.com", "auth0.com", "us.auth0.com", "eu.auth0.com",
]);

const isIpLiteral = (host) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");

/** Registrable domain (eTLD+1) of a hostname; the exact host for IP literals and localhost; null for a bare public suffix. */
export function registrableHost(hostname) {
  let host = String(hostname ?? "").trim().toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) return null;
  if (host === "localhost" || isIpLiteral(host)) return host;
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  if (labels.length >= 4 && MULTI_LABEL_SUFFIXES.has(labels.slice(-3).join("."))) return labels.slice(-4).join(".");
  if (labels.length >= 3 && MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join("."))) return labels.slice(-3).join(".");
  const last2 = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(last2)) return null;
  return last2;
}

/** True when `url` has the same scheme and registrable domain as `pageOrigin`, without embedded credentials. */
export function isSameSite(url, pageOrigin) {
  let a;
  let b;
  try {
    a = url instanceof URL ? url : new URL(String(url));
    b = new URL(String(pageOrigin));
  } catch {
    return false;
  }
  if (a.username || a.password) return false;
  if (a.protocol !== b.protocol || !["https:", "http:"].includes(a.protocol)) return false;
  // An IP literal or localhost has no registrable domain, and each port there is a separate service.
  const hostA = a.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostA === "localhost" || isIpLiteral(hostA)) return a.origin === b.origin;
  const siteA = registrableHost(a.hostname);
  return Boolean(siteA) && siteA === registrableHost(b.hostname);
}
