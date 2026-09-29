import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus, createRawApp, createViewerApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { fileBlobs, openSql } from "../src/storage-node.ts";
import { Store } from "../src/store.ts";

const FRAME_TAG = '<script src="/_wa/frame.js"></script>';

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

test("republishing identical html keeps the latest version", async () => {
  const { call, bus } = setup();
  const a = await (await call("/api/artifacts", { method: "POST", json: { html: "<p>same</p>", title: "T" } })).json();
  const events: unknown[] = [];
  bus.on(a.id, (e) => events.push(e));

  const res = await call(`/api/artifacts/${a.id}/versions`, { method: "POST", json: { html: "<p>same</p>" } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).version, 1);
  assert.deepEqual(events, []);

  // A new title is a real change.
  const renamed = await (await call(`/api/artifacts/${a.id}/versions`, { method: "POST", json: { html: "<p>same</p>", title: "T2" } })).json();
  assert.equal(renamed.version, 2);
});

test("concurrent publishes get distinct version numbers", async () => {
  const { call } = setup();
  const a = await (await call("/api/artifacts", { method: "POST", json: { html: "start", title: "T" } })).json();
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
  assert.equal(await res.text(), `${FRAME_TAG}<p>hi</p>`);
  const csp = res.headers.get("content-security-policy")!;
  assert.match(csp, /script-src [^;]*http:\/\/127\.0\.0\.1:4401\/_wa\/frame\.js/);
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

test("raw pages load the frame script right after the doctype, the stored source stays unchanged", async () => {
  const { call, raw } = setup();
  const html = "<!DOCTYPE html>\n<html><body><script>boom()</script></body></html>";
  const a = await (await call("/api/artifacts", { method: "POST", json: { html, title: "T" } })).json();
  const served = await (await raw.request(`http://127.0.0.1:4401/raw/${a.id}/1`, { headers: { host: "127.0.0.1:4401" } })).text();
  // Same line count as the source, so error line numbers still match it.
  assert.equal(served, `<!DOCTYPE html>${FRAME_TAG}\n<html><body><script>boom()</script></body></html>`);
  assert.equal(await (await call(`/api/artifacts/${a.id}/versions/1`)).text(), html);

  const script = await raw.request("http://127.0.0.1:4401/_wa/frame.js", { headers: { host: "127.0.0.1:4401" } });
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type")!, /javascript/);
  assert.match(await script.text(), /web-artefacts:error/);
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

test("comments keep the element the user pointed at", async () => {
  const { call } = setup();
  const a = await (await call("/api/artifacts", { method: "POST", json: { html: "x", title: "T" } })).json();
  const anchor = { selector: "main > section:nth-of-type(2) > h2", text: "Pricing" };
  const c = await (await call(`/api/artifacts/${a.id}/comments`, { method: "POST", json: { body: "Größer", anchor } })).json();
  assert.deepEqual(c.anchor, anchor);
  const plain = await (await call(`/api/artifacts/${a.id}/comments`, { method: "POST", json: { body: "Ohne", anchor: { text: "no selector" } } })).json();
  assert.equal(plain.anchor, null);
  const { comments } = await (await call(`/api/artifacts/${a.id}/comments`)).json();
  assert.deepEqual(comments.map((x: { anchor: unknown }) => x.anchor), [anchor, null]);
});

test("browser errors are deduplicated, capped and counted for the latest version", async () => {
  const { call } = setup();
  const a = await (await call("/api/artifacts", { method: "POST", json: { html: "x", title: "T" } })).json();
  const report = (version: number, messages: unknown) =>
    call(`/api/artifacts/${a.id}/versions/${version}/errors`, { method: "POST", json: { messages } });
  assert.equal((await report(1, ["TypeError: a is undefined", "TypeError: a is undefined", "Blocked"])).status, 200);
  await report(1, ["Blocked"]);
  let res = await (await call(`/api/artifacts/${a.id}/errors`)).json();
  assert.equal(res.version, 1);
  assert.deepEqual(res.errors.map((e: { message: string; count: number }) => [e.message, e.count]), [["TypeError: a is undefined", 2], ["Blocked", 2]]);
  assert.equal((await (await call("/api/artifacts")).json())[0].latest_errors, 2);

  await report(1, Array.from({ length: 30 }, (_, i) => `error ${i}`));
  res = await (await call(`/api/artifacts/${a.id}/errors?version=1`)).json();
  assert.equal(res.errors.length, 20);
  // At the cap, known messages in the same batch still count.
  await report(1, ["one more new error", "Blocked"]);
  res = await (await call(`/api/artifacts/${a.id}/errors?version=1`)).json();
  assert.equal(res.errors.length, 20);
  assert.equal(res.errors.find((e: { message: string }) => e.message === "Blocked").count, 3);
  assert.equal((await report(1, "not a list")).status, 400);
  assert.equal((await report(7, ["x"])).status, 404);

  // A new version starts without errors.
  await call(`/api/artifacts/${a.id}/versions`, { method: "POST", json: { html: "y" } });
  assert.equal((await (await call("/api/artifacts")).json())[0].latest_errors, 0);
});

test("long-poll with errors_after also returns when the latest version reports errors", async () => {
  const { call } = setup();
  const a = await (await call("/api/artifacts", { method: "POST", json: { html: "x", title: "T" } })).json();
  await call(`/api/artifacts/${a.id}/versions/1/errors`, { method: "POST", json: { messages: ["old"] } });
  const { errors: known } = await (await call(`/api/artifacts/${a.id}/errors`)).json();
  const started = Date.now();
  const waiting = call(`/api/artifacts/${a.id}/comments?after=0&wait=5&settle=5&errors_after=${known[0].id}`).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 100));
  await call(`/api/artifacts/${a.id}/versions/1/errors`, { method: "POST", json: { messages: ["ReferenceError: x is not defined"] } });
  const res = await waiting;
  assert.ok(Date.now() - started < 2000, "errors do not wait for the settle window");
  assert.deepEqual(res.comments, []);
  assert.deepEqual(res.errors.map((e: { message: string }) => e.message), ["ReferenceError: x is not defined"]);
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

test("long-poll with settle waits for the user to pause and returns all comments", async () => {
  const { call } = setup();
  const a = await (await call("/api/artifacts", { method: "POST", json: { html: "x", title: "T" } })).json();
  const started = Date.now();
  const waiting = call(`/api/artifacts/${a.id}/comments?after=0&wait=5&settle=1`).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 100));
  await call(`/api/artifacts/${a.id}/comments`, { method: "POST", json: { body: "eins" } });
  await new Promise((r) => setTimeout(r, 500));
  await call(`/api/artifacts/${a.id}/comments`, { method: "POST", json: { body: "zwei" } });
  const res = await waiting;
  const elapsed = Date.now() - started;
  assert.deepEqual(res.comments.map((c: { body: string }) => c.body), ["eins", "zwei"]);
  // Returns one quiet second after the last comment, not at the 5 s deadline.
  assert.ok(elapsed >= 1500 && elapsed < 3000, `elapsed ${elapsed} ms`);
});

test("the settle window exceeds the wait budget by at most one quiet period", async () => {
  const { call } = setup();
  const a = await (await call("/api/artifacts", { method: "POST", json: { html: "x", title: "T" } })).json();
  const post = (body: string) => call(`/api/artifacts/${a.id}/comments`, { method: "POST", json: { body } });
  const started = Date.now();
  const waiting = call(`/api/artifacts/${a.id}/comments?after=0&wait=1&settle=1`).then((r) => r.json());
  // The user keeps commenting every 0.4 s, long past the 1 s budget.
  const timers = [200, 600, 1000, 1400, 1800, 2200, 2600].map((ms, i) => setTimeout(() => post(`c${i}`), ms));
  const res = await waiting;
  const elapsed = Date.now() - started;
  timers.forEach(clearTimeout);
  // First comment at 0.2 s: it may settle until max(1 s budget, 0.2 s + 1 s) = 1.2 s.
  assert.ok(elapsed < 1700, `elapsed ${elapsed} ms`);
  assert.deepEqual(res.comments.map((c: { body: string }) => c.body).slice(0, 3), ["c0", "c1", "c2"]);
});

test("long-poll marks the agent as listening while it waits", async () => {
  const { call, bus } = setup();
  const a = await (await call("/api/artifacts", { method: "POST", json: { html: "x", title: "T" } })).json();
  const events: unknown[] = [];
  bus.on(a.id, (e) => e.type === "listening" && events.push(e));
  const waiting = call(`/api/artifacts/${a.id}/comments?after=0&wait=1`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(bus.isListening(a.id), true);
  assert.deepEqual(events, [{ type: "listening", listening: true }]);
  await waiting;
  assert.equal(bus.isListening(a.id), false);
  assert.deepEqual(events, [{ type: "listening", listening: true }, { type: "listening", listening: false }]);
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
  assert.match(buf, /data: \{"listening":false\}/);
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
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
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
