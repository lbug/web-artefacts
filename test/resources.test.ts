import { test } from "node:test";
import assert from "node:assert/strict";
import { checkResources } from "../mcp/resources.ts";

// A fake CDN: status per URL, plus redirects; records every request it gets.
function fakeFetch(routes: Record<string, number | { redirect: string } | "network-error">) {
  const requested: string[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    requested.push(`${init?.method ?? "GET"} ${href}`);
    const route = routes[href] ?? 200;
    if (route === "network-error") throw new TypeError("fetch failed");
    if (typeof route === "object") return new Response(null, { status: 302, headers: { location: route.redirect } });
    return new Response(null, { status: route });
  };
  return { impl: impl as typeof fetch, requested };
}

test("warns about CDN resources that do not exist, following redirects on allowed hosts", async () => {
  const html = `<!doctype html>
<script src="https://cdnjs.cloudflare.com/ajax/libs/echarts/5.5.9/echarts.min.js"></script>
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/missing@1/x.css">
<script type="module">import * as d3 from "https://esm.sh/d3@7";</script>`;
  const { impl, requested } = fakeFetch({
    "https://cdnjs.cloudflare.com/ajax/libs/echarts/5.5.9/echarts.min.js": 404,
    "https://unpkg.com/react@18/umd/react.production.min.js": { redirect: "/react@18.3.1/umd/react.production.min.js" },
    "https://unpkg.com/react@18.3.1/umd/react.production.min.js": 200,
    "https://cdn.jsdelivr.net/npm/missing@1/x.css": 404,
  });
  const warnings = await checkResources(html, impl);
  assert.deepEqual(warnings, [
    "CDN resource returned 404: https://cdnjs.cloudflare.com/ajax/libs/echarts/5.5.9/echarts.min.js",
    "CDN resource returned 404: https://cdn.jsdelivr.net/npm/missing@1/x.css",
  ]);
  assert.ok(requested.every((r) => r.startsWith("HEAD ")));
  assert.ok(requested.includes("HEAD https://esm.sh/d3@7"), "ES module imports are checked too");
});

test("flags resources on hosts the viewer's CSP blocks, without any request", async () => {
  const html = `<img src="https://example.com/logo.png">
<script src="http://cdn.jsdelivr.net/npm/x@1/x.js"></script>
<script>fetch("https://api.example.com/prices"); fetch(\`https://api.example.com/\${id}\`);</script>
<style>@import url("https://evil.example/theme.css"); .a { background: url(https://img.example/bg.jpg) }</style>
<a href="https://docs.example.com">Docs</a>
<link rel="preconnect" href="https://fonts.gstatic.com">
<link href="https://fonts.googleapis.com/css2?family=Inter&display=swap" rel="stylesheet">`;
  const { impl, requested } = fakeFetch({});
  const warnings = await checkResources(html, impl);
  assert.deepEqual(warnings, [
    "Blocked by the viewer's CSP (host not allowed): https://example.com/logo.png",
    "Blocked by the viewer's CSP (host not allowed): http://cdn.jsdelivr.net/npm/x@1/x.js",
    "Blocked by the viewer's CSP (host not allowed): https://api.example.com/prices",
    "Blocked by the viewer's CSP (host not allowed): https://evil.example/theme.css",
    "Blocked by the viewer's CSP (host not allowed): https://img.example/bg.jpg",
  ]);
  // Links are not resources, template URLs are built at runtime, a bare origin (preconnect) has nothing to check.
  assert.deepEqual(requested, ["HEAD https://fonts.googleapis.com/css2?family=Inter&display=swap"]);
});

test("never warns when a check is inconclusive", async () => {
  const html = `<script src="https://unpkg.com/a@1/a.js"></script>
<script src="https://esm.sh/b@1"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/c/1/c.js"></script>
<script src="https://cdn.jsdelivr.net/npm/d@1/d.js"></script>`;
  const { impl, requested } = fakeFetch({
    "https://unpkg.com/a@1/a.js": { redirect: "https://elsewhere.example/a.js" },
    "https://esm.sh/b@1": "network-error",
    "https://cdnjs.cloudflare.com/ajax/libs/c/1/c.js": 405,
    "https://cdn.jsdelivr.net/npm/d@1/d.js": 429,
  });
  assert.deepEqual(await checkResources(html, impl), []);
  // The redirect off the allowed hosts is not followed.
  assert.ok(!requested.some((r) => r.includes("elsewhere.example")));
});

test("resources that were fine once are not checked again", async () => {
  const html = `<script src="https://cdn.jsdelivr.net/npm/cached@1/c.js"></script>`;
  const first = fakeFetch({});
  await checkResources(html, first.impl);
  const second = fakeFetch({});
  await checkResources(html, second.impl);
  assert.equal(first.requested.length, 1);
  assert.equal(second.requested.length, 0);
});
