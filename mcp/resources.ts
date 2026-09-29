// Checks the external resources of an artifact before anyone looks at it.
// Agents often guess library versions that do not exist, or fetch from hosts
// the viewer's CSP blocks; without this, only the user's browser would notice.
// Only the allowed CDNs are ever requested, so this cannot be used to reach
// other hosts.

import { CDN_ORIGINS, FONT_FILE_ORIGIN, FONT_STYLE_ORIGIN } from "../src/allowed-origins.ts";

const ALLOWED = new Set([...CDN_ORIGINS, FONT_STYLE_ORIGIN, FONT_FILE_ORIGIN]);
const URL_CHARS = String.raw`https?:\/\/[^"'\`\s>)]+`;

// Places where a URL is loaded as a resource (not links, which are fine).
const RESOURCE_PATTERNS = [
  new RegExp(String.raw`<(?:script|img|audio|video|source|track|embed)\b[^>]*?\ssrc\s*=\s*["']?(${URL_CHARS})`, "gi"),
  new RegExp(String.raw`<link\b[^>]*?\shref\s*=\s*["']?(${URL_CHARS})`, "gi"),
  new RegExp(String.raw`\b(?:fetch|import)\s*\(\s*["'\`](${URL_CHARS})`, "g"),
  new RegExp(String.raw`\bfrom\s*["'](${URL_CHARS})`, "g"),
  new RegExp(String.raw`@import\s+(?:url\(\s*)?["']?(${URL_CHARS})`, "g"),
  new RegExp(String.raw`url\(\s*["']?(${URL_CHARS})`, "g"),
];

const MAX_CHECKS = 20;
const TIMEOUT_MS = 3000;
const MAX_REDIRECTS = 3;

/** URLs that existed once; CDN files under a fixed URL do not disappear. */
const known = new Set<string>();
const MAX_KNOWN = 1000;

/** Status of a URL on the allowed hosts, or null when that cannot be told. */
async function status(url: string, fetchImpl: typeof fetch): Promise<number | null> {
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetchImpl(current, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) return res.status;
      const next = new URL(location, current);
      if (!ALLOWED.has(next.origin)) return null; // never follow a redirect off the allowed hosts
      current = next.href;
    }
  } catch {} // offline, timeout: no verdict
  return null;
}

/**
 * Returns warnings for resources the page will not be able to load: hosts the
 * viewer's CSP blocks, and CDN files that do not exist. Never throws; checks
 * that cannot be decided (network errors, timeouts) produce no warning.
 */
export async function checkResources(html: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const firstSeen = new Map<string, number>();
  for (const pattern of RESOURCE_PATTERNS) {
    for (const m of html.matchAll(pattern)) {
      const url = m[1].replace(/&amp;/g, "&");
      firstSeen.set(url, Math.min(firstSeen.get(url) ?? Infinity, m.index));
    }
  }
  const urls = [...firstSeen].sort((a, b) => a[1] - b[1]).map(([url]) => url);

  let checks = 0;
  const warnings = await Promise.all(
    urls.map(async (url): Promise<string | null> => {
      if (url.includes("${")) return null; // built at runtime
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return null;
      }
      if (parsed.pathname === "/" && !parsed.search) return null; // a bare origin, e.g. preconnect
      if (!ALLOWED.has(parsed.origin)) return `Blocked by the viewer's CSP (host not allowed): ${url}`;
      if (known.has(url) || ++checks > MAX_CHECKS) return null;
      const code = await status(url, fetchImpl);
      if (code !== null && code < 400) {
        if (known.size >= MAX_KNOWN) known.clear();
        known.add(url);
      }
      // 405 and 429 say nothing about the file itself.
      return code !== null && code >= 400 && code !== 405 && code !== 429 ? `CDN resource returned ${code}: ${url}` : null;
    }),
  );
  return warnings.filter((w): w is string => w !== null);
}
