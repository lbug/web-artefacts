// HTTP layer: one Hono app for the viewer + API, one for raw artifact HTML.

import { readFile } from "node:fs/promises";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer } from "../mcp/tools.ts";
import { VERSION } from "./version.ts";
import { rawOrigin, viewerOrigin, type Config } from "./config.ts";
import { isValidId, NotFound, type Store } from "./store.ts";

export const MAX_HTML_BYTES = 10 * 1024 * 1024;
const MAX_WAIT_SECONDS = 600;

// Where artifact HTML may load scripts, styles and fonts from. Everything else
// (including arbitrary fetch targets) is blocked, so artifact code cannot send
// data anywhere.
const CDNS = ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://esm.sh"];

export const RAW_CSP = [
  // Applies the sandbox even when the raw URL is opened directly in a tab.
  "sandbox allow-scripts allow-modals allow-downloads",
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' blob: ${CDNS.join(" ")}`,
  `style-src 'unsafe-inline' https://fonts.googleapis.com ${CDNS.join(" ")}`,
  `font-src data: https://fonts.gstatic.com ${CDNS.join(" ")}`,
  `img-src data: blob: ${CDNS.join(" ")}`,
  "media-src data: blob:",
  `connect-src ${CDNS.join(" ")}`,
  "worker-src blob:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

// --- Change notifications (SSE for viewers, long-poll for agents) ----------

export type ChangeEvent = { type: "version"; version: number } | { type: "comment"; commentId: number } | { type: "resolved" };
type Listener = (e: ChangeEvent) => void;

export class Bus {
  private listeners = new Map<string, Set<Listener>>();
  on(id: string, fn: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(id);
    };
  }
  emit(id: string, e: ChangeEvent) {
    for (const fn of this.listeners.get(id) ?? []) fn(e);
  }
}

// --- Helpers ----------------------------------------------------------------

function paramId(c: Context): string {
  const id = c.req.param("id") ?? "";
  if (!isValidId(id)) throw new HTTPException(404, { message: "Unknown artifact id" });
  return id;
}

function paramVersion(c: Context): number {
  const v = Number(c.req.param("version"));
  if (!Number.isInteger(v) || v < 1) throw new HTTPException(404, { message: "Invalid version" });
  return v;
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch {}
  throw new HTTPException(400, { message: "Expected a JSON object" });
}

function requireHtml(body: Record<string, unknown>): string {
  const html = body.html;
  if (typeof html !== "string" || html.trim() === "") throw new HTTPException(400, { message: "Field 'html' is missing" });
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) throw new HTTPException(413, { message: "HTML is larger than 10 MB" });
  return html;
}

const optString = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

function onError(err: Error, c: Context) {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  if (err instanceof NotFound) return c.json({ error: err.message }, 404);
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
}

// --- Viewer + API -----------------------------------------------------------

const PUBLIC_FILES: Record<string, string> = {
  "app.js": "text/javascript; charset=utf-8",
  "app.css": "text/css; charset=utf-8",
  "diff.js": "text/javascript; charset=utf-8",
};

export function createViewerApp(cfg: Config, store: Store, bus: Bus) {
  const app = new Hono();
  const origin = viewerOrigin(cfg);
  const allowedHosts = new Set([`127.0.0.1:${cfg.viewerPort}`, `localhost:${cfg.viewerPort}`, `${cfg.host}:${cfg.viewerPort}`]);

  app.onError(onError);

  // Guard against DNS rebinding (foreign Host header) and CSRF from other
  // sites (foreign Origin on state-changing requests). Agents and curl send
  // no Origin header at all.
  app.use("*", async (c, next) => {
    if (!allowedHosts.has(c.req.header("host") ?? "")) return c.text("Unknown host", 421);
    const reqOrigin = c.req.header("origin");
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && reqOrigin && reqOrigin !== origin && reqOrigin !== origin.replace(cfg.host, "localhost")) {
      return c.json({ error: "Foreign origin" }, 403);
    }
    await next();
  });

  const tooLarge = (c: Context) => c.json({ error: "Request too large" }, 413);
  app.use("/api/*", bodyLimit({ maxSize: Math.ceil(MAX_HTML_BYTES * 1.2), onError: tooLarge }));
  app.use("/mcp", bodyLimit({ maxSize: Math.ceil(MAX_HTML_BYTES * 1.2), onError: tooLarge }));

  const shell = (c: Context) => {
    c.header(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        `frame-src ${rawOrigin(cfg)}`,
        "img-src 'self' data:",
        "style-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    c.header("Referrer-Policy", "no-referrer");
    return c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artifacts</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect x='1' y='1' width='14' height='14' rx='3' fill='%234f6bed'/%3E%3C/svg%3E">
<link rel="stylesheet" href="/static/app.css">
<script type="module" src="/static/app.js"></script>
</head>
<body><div id="app"></div></body>
</html>`);
  };

  app.get("/", shell);
  app.get("/a/:id", shell);

  app.get("/static/:file", async (c) => {
    const file = c.req.param("file");
    const type = PUBLIC_FILES[file];
    if (!type) return c.notFound();
    const body = await readFile(new URL(`../public/${file}`, import.meta.url), "utf8");
    return c.body(body, 200, { "Content-Type": type, "Cache-Control": "no-cache" });
  });

  app.get("/healthz", (c) => c.json({ ok: true, service: "web-artefacts", version: VERSION, pid: process.pid }));

  // --- API ---

  const withUrls = <T extends { id: string }>(a: T) => ({ ...a, url: `${origin}/a/${a.id}` });

  app.get("/api/artifacts", async (c) =>
    c.json((await store.list()).map((a) => ({ ...withUrls(a), raw_url: `${rawOrigin(cfg)}/raw/${a.id}/${a.latest_version}` }))),
  );

  app.post("/api/artifacts", async (c) => {
    const body = await jsonBody(c);
    const res = await store.publish({ html: requireHtml(body), title: optString(body.title), agent: optString(body.agent, 80) });
    return c.json(withUrls(res), 201);
  });

  app.post("/api/artifacts/:id/versions", async (c) => {
    const id = paramId(c);
    const body = await jsonBody(c);
    const res = await store.publish({ id, html: requireHtml(body), title: optString(body.title), agent: optString(body.agent, 80) });
    bus.emit(id, { type: "version", version: res.version });
    return c.json(withUrls(res), 201);
  });

  app.get("/api/artifacts/:id", async (c) => {
    const id = paramId(c);
    const [artifact, versions, comments] = await Promise.all([store.get(id), store.versions(id), store.comments(id)]);
    return c.json({
      ...withUrls(artifact),
      versions: versions.map((v) => ({ ...v, raw_url: `${rawOrigin(cfg)}/raw/${id}/${v.version}` })),
      comments,
    });
  });

  // Source of one version as plain text (used by the diff view and read_artifact).
  app.get("/api/artifacts/:id/versions/:version", async (c) => {
    const { html } = await store.html(paramId(c), paramVersion(c));
    return c.body(html, 200, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
  });

  app.get("/api/artifacts/:id/latest", async (c) => {
    const { html, version } = await store.html(paramId(c));
    return c.body(html, 200, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "X-Artifact-Version": String(version) });
  });

  // Comments. `after` returns only newer comments; `wait` (seconds) long-polls
  // until at least one arrives, which lets an agent block on user feedback.
  app.get("/api/artifacts/:id/comments", async (c) => {
    const id = paramId(c);
    await store.get(id);
    const includeResolved = c.req.query("include_resolved") === "true";
    const after = Number(c.req.query("after") ?? 0) || 0;
    const wait = Math.min(Math.max(Number(c.req.query("wait") ?? 0) || 0, 0), MAX_WAIT_SECONDS);

    const fetchNew = async () => (await store.comments(id, includeResolved)).filter((cm) => cm.id > after);
    let comments = await fetchNew();
    const deadline = Date.now() + wait * 1000;
    while (comments.length === 0 && Date.now() < deadline && !c.req.raw.signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          off();
          clearTimeout(timer);
          c.req.raw.signal.removeEventListener("abort", done);
          resolve();
        };
        const off = bus.on(id, (e) => e.type === "comment" && done());
        const timer = setTimeout(done, deadline - Date.now());
        c.req.raw.signal.addEventListener("abort", done);
      });
      comments = await fetchNew();
    }
    return c.json({ comments, timed_out: comments.length === 0 && wait > 0 });
  });

  app.post("/api/artifacts/:id/comments", async (c) => {
    const id = paramId(c);
    const body = await jsonBody(c);
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!text) throw new HTTPException(400, { message: "Comment is empty" });
    if (text.length > 20_000) throw new HTTPException(413, { message: "Comment is too long" });
    const artifact = await store.get(id);
    const version = Number.isInteger(body.version) ? (body.version as number) : artifact.latest_version;
    const source = body.source === "agent" ? "agent" : "user";
    const comment = await store.addComment(id, {
      version,
      author: optString(body.author, 80) ?? (source === "agent" ? "Agent" : "User"),
      body: text,
      source,
      resolved: body.resolved === true,
    });
    bus.emit(id, { type: "comment", commentId: comment.id });
    return c.json(comment, 201);
  });

  app.post("/api/artifacts/:id/comments/resolve", async (c) => {
    const id = paramId(c);
    const body = await jsonBody(c);
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is number => Number.isInteger(x)) : [];
    await store.setResolved(id, ids, body.resolved !== false);
    bus.emit(id, { type: "resolved" });
    return c.json({ ok: true });
  });

  // Live updates for open viewers.
  app.get("/api/artifacts/:id/events", async (c) => {
    const id = paramId(c);
    await store.get(id);
    return streamSSE(c, async (stream) => {
      const queue: ChangeEvent[] = [];
      let wake: (() => void) | null = null;
      const off = bus.on(id, (e) => {
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        off();
        wake?.();
      });
      await stream.writeSSE({ event: "hello", data: "{}" });
      while (!stream.aborted) {
        const e = queue.shift();
        if (e) {
          await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
          continue;
        }
        // Wait for the next event or send a keep-alive every 25 s.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 25_000);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        wake = null;
        if (queue.length === 0 && !stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
      }
      off();
    });
  });

  // MCP over Streamable HTTP for agents that prefer a URL over spawning a
  // process. Serves protocol 2026-07-28 and falls back to stateless 2025-era
  // serving for older clients. Host/Origin are validated by the guard above;
  // tools call the API in-process.
  const host = `127.0.0.1:${cfg.viewerPort}`;
  const mcp = createMcpHandler(() =>
    createMcpServer({
      fetchApi: async (path, init) => app.request(`http://${host}${path}`, { ...init, headers: { ...(init?.headers as Record<string, string>), host } }),
      fallbackAgent: "mcp-http",
    }),
  );
  app.all("/mcp", (c) => mcp.fetch(c.req.raw));

  return app;
}

// --- Raw artifact origin ----------------------------------------------------

export function createRawApp(cfg: Config, store: Store) {
  const app = new Hono();
  const allowedHosts = new Set([`127.0.0.1:${cfg.rawPort}`, `localhost:${cfg.rawPort}`, `${cfg.host}:${cfg.rawPort}`]);
  app.onError(onError);

  app.get("/raw/:id/:version", async (c) => {
    if (!allowedHosts.has(c.req.header("host") ?? "")) return c.text("Unknown host", 421);
    const { html } = await store.html(paramId(c), paramVersion(c));
    return c.body(html, 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `${RAW_CSP}; frame-ancestors ${viewerOrigin(cfg)} http://localhost:${cfg.viewerPort}`,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      // Versions are immutable.
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });

  app.notFound((c) => c.text("Not found", 404));
  return app;
}
