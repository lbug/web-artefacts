import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus, createRawApp, createViewerApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { fileBlobs, openSql } from "../src/storage-node.ts";
import { Store } from "../src/store.ts";

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "artefacts-test-"));
  const cfg: Config = { host: "127.0.0.1", viewerPort: 4400, rawPort: 4401, dataDir };
  const store = new Store(openSql(dataDir), fileBlobs(dataDir));
  const bus = new Bus();
  const viewer = createViewerApp(cfg, store, bus);
  const raw = createRawApp(cfg, store);
  const call = async (path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (!headers.has("host")) headers.set("host", "127.0.0.1:4400");
    if (init.json !== undefined) headers.set("content-type", "application/json");
    return viewer.request(`http://127.0.0.1:4400${path}`, {
      ...init,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
  };
  return { cfg, store, bus, viewer, raw, call };
}

test("publish, new version, read back", async () => {
  const { call } = setup();
  const res = await call("/api/artifacts", { method: "POST", json: { html: "<h1>eins</h1>", title: "Test", agent: "claude-code" } });
  assert.equal(res.status, 201);
  const a = await res.json();
  assert.equal(a.version, 1);
  assert.equal(a.url, `http://127.0.0.1:4400/a/${a.id}`);

  const res2 = await call(`/api/artifacts/${a.id}/versions`, { method: "POST", json: { html: "<h1>zwei</h1>", agent: "opencode" } });
  assert.equal((await res2.json()).version, 2);

  const meta = await (await call(`/api/artifacts/${a.id}`)).json();
  assert.equal(meta.title, "Test");
  assert.equal(meta.latest_version, 2);
  assert.equal(meta.latest_agent, "opencode");
  assert.deepEqual(meta.versions.map((v: { version: number }) => v.version), [2, 1]);
  assert.equal(meta.versions[0].raw_url, `http://127.0.0.1:4401/raw/${a.id}/2`);

  assert.equal(await (await call(`/api/artifacts/${a.id}/versions/1`)).text(), "<h1>eins</h1>");
  const latest = await call(`/api/artifacts/${a.id}/latest`);
  assert.equal(latest.headers.get("x-artifact-version"), "2");

  const list = await (await call("/api/artifacts")).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].raw_url, `http://127.0.0.1:4401/raw/${a.id}/2`);
});

test("title update with new version", async () => {
  const { call } = setup();
  const a = await (await call("/api/artifacts", { method: "POST", json: { html: "x", title: "Alt" } })).json();
  await call(`/api/artifacts/${a.id}/versions`, { method: "POST", json: { html: "y", title: "Neu" } });
  assert.equal((await (await call(`/api/artifacts/${a.id}`)).json()).title, "Neu");
});

test("concurrent publishes get distinct version numbers", async () => {
  const { call } = setup();
  const a = await (await call("/api/artifacts", { method: "POST", json: { html: "0", title: "T" } })).json();
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => call(`/api/artifacts/${a.id}/versions`, { method: "POST", json: { html: String(i) } }).then((r) => r.json())),
  );
  assert.deepEqual(results.map((r) => r.version).sort((x, y) => x - y), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("validation and not-found", async () => {
  const { call } = setup();
  assert.equal((await call("/api/artifacts", { method: "POST", json: { title: "leer" } })).status, 400);
  assert.equal((await call("/api/artifacts", { method: "POST", body: "kein json", headers: { "content-type": "application/json" } })).status, 400);
  assert.equal((await call("/api/artifacts/unbekannt123/versions", { method: "POST", json: { html: "x" } })).status, 404);
  assert.equal((await call("/api/artifacts/../etc")).status, 404);
  assert.equal((await call("/api/artifacts/UPPER")).status, 404);
});

test("host and origin guards", async () => {
  const { call } = setup();
  // DNS rebinding: foreign Host header is rejected.
  assert.equal((await call("/api/artifacts", { headers: { host: "evil.example:4400" } })).status, 421);
  // CSRF: foreign Origin on POST is rejected, own Origin and no Origin are fine.
  assert.equal((await call("/api/artifacts", { method: "POST", json: { html: "x" }, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("/api/artifacts", { method: "POST", json: { html: "x" }, headers: { origin: "http://127.0.0.1:4400" } })).status, 201);
  assert.equal((await call("/api/artifacts", { method: "POST", json: { html: "x" }, headers: { origin: "http://127.0.0.1:4401" } })).status, 403);
  assert.equal((await call("/api/artifacts", { method: "POST", json: { html: "x" } })).status, 201);
});

test("raw origin serves sandboxed HTML with strict CSP", async () => {
  const { call, raw } = setup();
  const a = await (await call("/api/artifacts", { method: "POST", json: { html: "<p>hi</p>", title: "T" } })).json();
  const res = await raw.request(`http://127.0.0.1:4401/raw/${a.id}/1`, { headers: { host: "127.0.0.1:4401" } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<p>hi</p>");
  const csp = res.headers.get("content-security-policy")!;
  assert.match(csp, /^sandbox allow-scripts/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-ancestors http:\/\/127\.0\.0\.1:4400/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");

  // The API is not reachable on the raw origin, and the viewer does not serve raw HTML.
  assert.equal((await raw.request("http://127.0.0.1:4401/api/artifacts", { headers: { host: "127.0.0.1:4401" } })).status, 404);
  assert.equal((await call(`/raw/${a.id}/1`)).status, 404);
  assert.equal((await raw.request(`http://127.0.0.1:4401/raw/${a.id}/9`, { headers: { host: "127.0.0.1:4401" } })).status, 404);
});

test("viewer shell has CSP that only frames the raw origin", async () => {
  const { call } = setup();
  const res = await call("/a/abcdef");
  const csp = res.headers.get("content-security-policy")!;
  assert.match(csp, /frame-src http:\/\/127\.0\.0\.1:4401/);
  assert.match(csp, /default-src 'self'/);
  assert.equal((await call("/static/app.js")).status, 200);
  assert.equal((await call("/static/../package.json")).status, 404);
});

test("comments: add, filter, resolve, agent notes", async () => {
  const { call } = setup();
  const a = await (await call("/api/artifacts", { method: "POST", json: { html: "x", title: "T" } })).json();
  const c1 = await (await call(`/api/artifacts/${a.id}/comments`, { method: "POST", json: { body: "Button größer" } })).json();
  assert.equal(c1.version, 1);
  assert.equal(c1.author, "User");
  assert.equal(c1.source, "user");
  assert.equal((await call(`/api/artifacts/${a.id}/comments`, { method: "POST", json: { body: "  " } })).status, 400);

  await call(`/api/artifacts/${a.id}/comments`, { method: "POST", json: { body: "Erledigt", source: "agent", author: "claude-code", resolved: true } });
  let open = (await (await call(`/api/artifacts/${a.id}/comments`)).json()).comments;
  assert.deepEqual(open.map((c: { body: string }) => c.body), ["Button größer"]);

  await call(`/api/artifacts/${a.id}/comments/resolve`, { method: "POST", json: { ids: [c1.id] } });
  open = (await (await call(`/api/artifacts/${a.id}/comments`)).json()).comments;
  assert.equal(open.length, 0);
  const all = (await (await call(`/api/artifacts/${a.id}/comments?include_resolved=true`)).json()).comments;
  assert.equal(all.length, 2);
  assert.equal(all[1].source, "agent");

  const listed = (await (await call("/api/artifacts")).json())[0];
  assert.equal(listed.open_comments, 0);
});

test("long-poll returns as soon as a user comment arrives, ignores agent notes", async () => {
  const { call } = setup();
  const a = await (await call("/api/artifacts", { method: "POST", json: { html: "x", title: "T" } })).json();
  const started = Date.now();
  const waiting = call(`/api/artifacts/${a.id}/comments?after=0&wait=5`).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 100));
  await call(`/api/artifacts/${a.id}/comments`, { method: "POST", json: { body: "Notiz", source: "agent", resolved: true } });
  await new Promise((r) => setTimeout(r, 100));
  await call(`/api/artifacts/${a.id}/comments`, { method: "POST", json: { body: "Farbe dunkler" } });
  const res = await waiting;
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(res.comments.map((c: { body: string }) => c.body), ["Farbe dunkler"]);
});

test("long-poll times out", async () => {
  const { call } = setup();
  const a = await (await call("/api/artifacts", { method: "POST", json: { html: "x", title: "T" } })).json();
  const res = await (await call(`/api/artifacts/${a.id}/comments?after=0&wait=1`)).json();
  assert.equal(res.timed_out, true);
  assert.equal(res.comments.length, 0);
});

test("SSE announces new versions", async () => {
  const { call } = setup();
  const a = await (await call("/api/artifacts", { method: "POST", json: { html: "x", title: "T" } })).json();
  const ac = new AbortController();
  const res = await call(`/api/artifacts/${a.id}/events`, { signal: ac.signal });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const readUntil = async (needle: string) => {
    while (!buf.includes(needle)) buf += decoder.decode((await reader.read()).value);
  };
  await readUntil("event: hello");
  await call(`/api/artifacts/${a.id}/versions`, { method: "POST", json: { html: "y" } });
  await readUntil("event: version");
  assert.match(buf, /"version":2/);
  ac.abort();
  await reader.cancel().catch(() => {});
});

test("migrations are versioned and idempotent", async () => {
  const { cfg } = setup();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(cfg.dataDir, "artifacts.db"));
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
  db.close();
  openSql(cfg.dataDir); // reopening must not fail or re-run migrations
});

test("list skips artifacts without a stored version", async () => {
  const { cfg, call } = setup();
  const sql = openSql(cfg.dataDir);
  await sql.run("INSERT INTO artifacts (id, title, created_at, updated_at) VALUES ('orphan1', 'kaputt', 'x', 'x')");
  assert.deepEqual(await (await call("/api/artifacts")).json(), []);
});

test("oversized bodies are rejected", async () => {
  const { call } = setup();
  const res = await call("/api/artifacts", { method: "POST", json: { html: "x".repeat(13 * 1024 * 1024), title: "groß" } });
  assert.equal(res.status, 413);
});

test("version comparison", async () => {
  const { compareVersions } = await import("../src/service.ts");
  assert.ok(compareVersions("0.2.0", "0.1.9") > 0);
  assert.ok(compareVersions("0.1.0", "0.1.0") === 0);
  assert.ok(compareVersions("0.1.0", "0.10.0") < 0);
  assert.ok(compareVersions("0", "0.1.0") < 0);
});
