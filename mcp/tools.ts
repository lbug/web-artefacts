// MCP tool definitions, shared by the stdio server (mcp/stdio.ts) and the
// Streamable HTTP endpoint (/mcp). Tools talk to the artifact service through
// its HTTP API, so the same code works in and out of process.

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { VERSION } from "../src/version.ts";
import { checkResources } from "./resources.ts";

export type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

export const SERVER_INSTRUCTIONS = `web-artefacts publishes self-contained HTML pages to a local viewer, where the user looks at them in the browser and can leave comments.

HTML: inline CSS/JS. External scripts, styles and images only from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com or esm.sh; fonts from Google Fonts; your own images as data: URLs or inline SVG. fetch() to other hosts, form targets, cookies and localStorage are blocked. Use library versions you know exist rather than guessing; publish_artifact checks CDN URLs and warns about missing files and blocked hosts.

Saving tokens: write the page to a local file, revise it with small edits and publish it with path. A new version then costs only your edit, not the whole page. Pass html only for one-off pages. Call read_artifact only when you have no local file (e.g. in another session), then save the source to a file and continue with path.

Two ways to use it – pick one based on the request:
A) Show (default): the user wants something explained, visualized or summarized. → publish_artifact, give the URL, done. Do not wait for comments; follow-up questions come through the chat.
B) Feedback loop: you present alternatives or a draft for a decision, or the user explicitly wants to iterate in the viewer. → publish_artifact, give the URL, say that you are waiting for comments in the viewer (replying in the chat works too), then wait_for_comments. Apply the comments, republish with the same id, call resolve_comments with a short note, wait again – until the user is satisfied or continues in the chat.
If the user explicitly says otherwise ("just show it", "wait for my feedback"), follow that.

Comments can carry an anchor { selector, text }: the element the user pointed at in the version the comment was written on.

While the viewer shows a page, it reports JavaScript errors, failed loads and requests blocked by the CSP. They end wait_for_comments, show up in notes and in read_artifact. Fix them in a new version; the user may not notice them.

Letting the user answer with clicks: when you ask for choices or values (pick a draft, tune a color), give the page buttons or inputs that call parent.postMessage({ type: "web-artefacts:choice", key: "draft", text: "Draft B" }, "*"). Choices collect next to the comment box in the viewer and go out together with the user's next comment, as "- <text>" lines. Give each question its own key: a new choice with the same key replaces the earlier answer, so the user can change their mind and still answer several questions in one message. Make each text self-explanatory, since it is all you receive.

Rules:
- After EVERY publish – including new versions – state the URL and the version number in your reply.
- Always publish revisions with the same id: the URL stays the same and open viewers reload live.
- When the user refers to an artifact (URL, title or a reference copied from the viewer): the id is the last path segment of the URL (…/a/<id>); otherwise find it by title with list_artifacts. Then read_comments first.
- Tool results may end with a note about open comments. Address it before you continue working on that artifact.
- Talk to the user in their language; the viewer is language-neutral.`;

/** wait_for_comments returns once the user has not written a new comment for this long. */
const SETTLE_SECONDS = 5;

/** read_artifact returns at most this much source, to protect the agent's context. */
const MAX_READ_CHARS = 200_000;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const text = (value: string, structuredContent?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: value }],
  ...(structuredContent ? { structuredContent } : {}),
});

const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

async function api<T>(fetchApi: Fetch, path: string, init?: RequestInit): Promise<T> {
  const res = await fetchApi(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.text();
  if (!res.ok) {
    let message = body;
    try {
      message = JSON.parse(body).error ?? body;
    } catch {}
    throw new Error(`${res.status}: ${message}`);
  }
  return (res.headers.get("content-type")?.includes("json") ? JSON.parse(body) : body) as T;
}

interface Comment {
  id: number;
  version: number;
  author: string;
  source: "user" | "agent";
  body: string;
  created_at: string;
  resolved_at: string | null;
  anchor: { selector: string; text: string } | null;
}

interface BrowserError {
  id: number;
  version: number;
  message: string;
  count: number;
}

const formatErrors = (errors: BrowserError[]) => errors.map((e) => `- ${e.message}${e.count > 1 ? ` (×${e.count})` : ""}`).join("\n");

interface ArtifactSummary {
  id: string;
  title: string;
  latest_version: number;
  updated_at: string;
  latest_agent: string | null;
  open_comments: number;
  latest_errors: number;
  url: string;
}

const idParam = z.string().describe("Artifact id: the last path segment of the viewer URL …/a/<id>");

// Some clients (e.g. Claude Code) show the model only structuredContent when a
// tool declares an outputSchema, so every instruction that lives in the text
// result is repeated here as `next_step` / `note`.
const PublishedSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  title: z.string(),
  url: z.string(),
  next_step: z.string(),
  warnings: z.array(z.string()).optional().describe("Resources the page will fail to load; fix them in a new version"),
  note: z.string().optional(),
});

const ListSchema = z.object({
  artifacts: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      latest_version: z.number().int(),
      updated_at: z.string(),
      latest_agent: z.string().nullable(),
      open_comments: z.number().int(),
      browser_errors: z.number().int().describe("Distinct browser errors the viewer reported for the latest version"),
      url: z.string(),
    }),
  ),
  note: z.string().optional(),
});

// Every tool here only touches the local artifact service.
const LOCAL = { openWorldHint: false } as const;

export function createMcpServer(opts: { fetchApi: Fetch; cwd?: string; fallbackAgent?: string }): McpServer {
  const { fetchApi } = opts;
  const server = new McpServer({ name: "web-artefacts", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  // 2026-07-28 connections carry the client's identity per request; 2025-era
  // connections only announce it once, in the initialize handshake.
  const agentName = (ctx: ServerContext): string | undefined => {
    const envelope = ctx.mcpReq.envelope as Record<string, { name?: string } | undefined> | undefined;
    return envelope?.["io.modelcontextprotocol/clientInfo"]?.name ?? server.server.getClientVersion()?.name ?? opts.fallbackAgent;
  };

  // Tools cannot push to the agent, so every tool response carries a note
  // about open user comments and browser errors. `skip` excludes the artifact
  // whose comments and errors the tool has just returned.
  async function openCommentsHint(skip?: string): Promise<string> {
    try {
      const list = (await api<ArtifactSummary[]>(fetchApi, "/api/artifacts")).filter((a) => a.id !== skip);
      const items = (artifacts: ArtifactSummary[], label: (a: ArtifactSummary) => string) => {
        const shown = artifacts.slice(0, 5).map(label);
        if (artifacts.length > 5) shown.push(`and ${artifacts.length - 5} more`);
        return shown.join("; ");
      };
      const notes: string[] = [];
      const open = list.filter((a) => a.open_comments > 0);
      if (open.length > 0) {
        notes.push(`Note: open user comments – ${items(open, (a) => `"${a.title}" (id ${a.id}): ${a.open_comments}`)}. Read them with read_comments before you continue working on these artifacts.`);
      }
      const broken = list.filter((a) => a.latest_errors > 0);
      if (broken.length > 0) {
        notes.push(`Note: browser errors on the latest version – ${items(broken, (a) => `"${a.title}" (id ${a.id}) v${a.latest_version}: ${a.latest_errors}`)}. Read them with read_artifact and fix them in a new version.`);
      }
      return notes.length ? `\n\n---\n${notes.join("\n")}` : "";
    } catch {
      return "";
    }
  }

  function tool<A>(
    fn: (args: A, ctx: ServerContext) => Promise<ToolResult>,
    hint: "all" | "except-self" | "none" = "all",
  ) {
    return async (args: A, ctx: ServerContext): Promise<ToolResult> => {
      try {
        const result = await fn(args, ctx);
        if (hint !== "none") {
          const skip = hint === "except-self" ? (args as { id?: string }).id : undefined;
          const note = await openCommentsHint(skip);
          result.content[0].text += note;
          if (note && result.structuredContent) result.structuredContent.note = note.replace(/^\s*---\s*/, "");
        }
        return result;
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    };
  }

  server.registerTool(
    "publish_artifact",
    {
      title: "Publish artifact",
      description:
        "Publishes an HTML page to the artifact viewer and returns its URL. Without id a new artifact is created; with id a new version of the same URL is published (open viewers reload it live). Pass either path (a local .html file; preferred, so revisions only need small edits to the file) or html. Warns about CDN files that do not exist and resources on hosts the viewer blocks.",
      inputSchema: z.object({
        path: z.string().optional().describe("Path to a local HTML file (absolute, or relative to the working directory)"),
        html: z.string().optional().describe("HTML content, if there is no file"),
        title: z.string().optional().describe("Title, 2–5 words. Required for new artifacts, optional for new versions"),
        id: z.string().optional().describe("Id of an existing artifact (last path segment of its URL …/a/<id>) to publish a new version"),
      }),
      outputSchema: PublishedSchema,
      annotations: { ...LOCAL, readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    tool(async ({ path, html, title, id }, ctx) => {
      if (!!path === !!html) return fail("Pass exactly one of path or html.");
      let content = html!;
      if (path) {
        if (!isAbsolute(path) && !opts.cwd) return fail("path must be absolute.");
        content = await readFile(isAbsolute(path) ? path : resolve(opts.cwd!, path), "utf8");
      }
      // Runs while the version is saved, so it adds little or no latency.
      const checking = checkResources(content);
      const res = await api<z.infer<typeof PublishedSchema> & { unchanged?: boolean }>(
        fetchApi,
        id ? `/api/artifacts/${encodeURIComponent(id)}/versions` : "/api/artifacts",
        { method: "POST", body: JSON.stringify({ html: content, title, agent: agentName(ctx) }) },
      );
      const warnings = await checking;
      const next_step = res.unchanged
        ? `Unchanged: the HTML and title are identical to v${res.version}, so no new version was created. Change the content before publishing again with id "${res.id}".`
        : `Give the user this URL in your reply (also for new versions). For revisions call publish_artifact with id "${res.id}".`;
      const published = { id: res.id, version: res.version, title: res.title, url: res.url, next_step, ...(warnings.length ? { warnings } : {}) };
      const heading = res.unchanged ? "Unchanged" : "Published";
      const warningText = warnings.length ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
      return text(`${heading}: "${res.title}" v${res.version}\nURL: ${res.url}\nid: ${res.id}\n\n${next_step}${warningText}`, published);
    }),
  );

  server.registerTool(
    "list_artifacts",
    {
      title: "List artifacts",
      description: "Lists all artifacts with id, title, latest version, agent and number of open comments.",
      outputSchema: ListSchema,
      annotations: { ...LOCAL, readOnlyHint: true },
    },
    tool(async () => {
      const list = await api<ArtifactSummary[]>(fetchApi, "/api/artifacts");
      const artifacts = list.map(({ id, title, latest_version, updated_at, latest_agent, open_comments, latest_errors, url }) => ({
        id, title, latest_version, updated_at, latest_agent, open_comments, browser_errors: latest_errors, url,
      }));
      return text(JSON.stringify(artifacts, null, 2), { artifacts });
    }, "none"),
  );

  server.registerTool(
    "read_artifact",
    {
      title: "Read artifact",
      description: "Returns the HTML source of a version (default: latest) plus metadata and the browser errors the viewer reported for it. The full source can be large: prefer your local file if you have one.",
      inputSchema: z.object({
        id: idParam,
        version: z.number().int().positive().optional(),
      }),
      annotations: { ...LOCAL, readOnlyHint: true },
    },
    tool(async ({ id, version }) => {
      const meta = await api<ArtifactSummary>(fetchApi, `/api/artifacts/${encodeURIComponent(id)}`);
      const v = version ?? meta.latest_version;
      let html = await api<string>(fetchApi, `/api/artifacts/${encodeURIComponent(id)}/versions/${v}`);
      if (html.length > MAX_READ_CHARS) {
        html = `${html.slice(0, MAX_READ_CHARS)}\n\n[… truncated: ${html.length - MAX_READ_CHARS} of ${html.length} characters omitted]`;
      }
      const { errors } = await api<{ errors: BrowserError[] }>(fetchApi, `/api/artifacts/${encodeURIComponent(id)}/errors?version=${v}`);
      const errorSection = errors.length ? `\nBrowser errors the viewer reported for this version:\n${formatErrors(errors)}\n` : "";
      return text(`# ${meta.title} — version ${v} of ${meta.latest_version}\nURL: ${meta.url}\n${errorSection}\n${html}`);
    }),
  );

  const formatComments = (comments: Comment[]) =>
    JSON.stringify(
      comments.map(({ id, version, author, body, created_at, resolved_at, anchor }) => ({
        id, version, author, body, created_at, ...(resolved_at ? { resolved_at } : {}), ...(anchor ? { anchor } : {}),
      })),
      null,
      2,
    );

  server.registerTool(
    "read_comments",
    {
      title: "Read comments",
      description: "Reads the user's comments on an artifact. Default: only open (unresolved) ones.",
      inputSchema: z.object({
        id: idParam,
        include_resolved: z.boolean().optional(),
      }),
      annotations: { ...LOCAL, readOnlyHint: true },
    },
    tool(async ({ id, include_resolved }) => {
      const { comments } = await api<{ comments: Comment[] }>(
        fetchApi,
        `/api/artifacts/${encodeURIComponent(id)}/comments?include_resolved=${include_resolved ? "true" : "false"}`,
      );
      return text(comments.length ? formatComments(comments) : "No open comments.");
    }, "except-self"),
  );

  server.registerTool(
    "wait_for_comments",
    {
      title: "Wait for feedback",
      description:
        "Waits until the user writes new comments in the viewer and returns them; after the first comment it waits until the user pauses for a few seconds, so comments written in a row arrive together. It also returns early when the page reports browser errors in the viewer. Only use it in the feedback loop, after you published a version and asked the user for feedback. On timeout, call it again or ask the user.",
      inputSchema: z.object({
        id: idParam,
        after_comment_id: z.number().int().optional().describe("Only comments with a greater id. Default: only comments written from now on"),
        timeout_seconds: z.number().int().min(1).max(600).optional().describe("Default 300"),
      }),
      annotations: { ...LOCAL, readOnlyHint: true },
    },
    tool(async ({ id, after_comment_id, timeout_seconds }, ctx) => {
      const base = `/api/artifacts/${encodeURIComponent(id)}/comments`;
      const signal = ctx.mcpReq.signal;
      let after = after_comment_id;
      if (after === undefined) {
        const { comments } = await api<{ comments: Comment[] }>(fetchApi, `${base}?include_resolved=true`, { signal });
        after = comments.at(-1)?.id ?? 0;
      }
      // Only errors reported from now on end the wait; known ones are in the notes.
      const known = await api<{ errors: BrowserError[] }>(fetchApi, `/api/artifacts/${encodeURIComponent(id)}/errors`, { signal });
      const errorsAfter = Math.max(0, ...known.errors.map((e) => e.id));

      // Long-poll in short chunks: that keeps us responsive to cancellation,
      // lets clients that asked for progress see a heartbeat (which also
      // resets their timeout), and stays below fetch's 300 s header timeout.
      const total = timeout_seconds ?? 300;
      const started = Date.now();
      const deadline = started + total * 1000;
      const progressToken = ctx.mcpReq._meta?.progressToken;
      let comments: Comment[] = [];
      let errors: BrowserError[] = [];
      while (comments.length === 0 && errors.length === 0 && Date.now() < deadline && !signal.aborted) {
        const chunk = Math.max(1, Math.min(30, Math.round((deadline - Date.now()) / 1000)));
        ({ comments, errors } = await api<{ comments: Comment[]; errors: BrowserError[] }>(
          fetchApi,
          `${base}?after=${after}&wait=${chunk}&settle=${SETTLE_SECONDS}&errors_after=${errorsAfter}`,
          { signal },
        ));
        if (comments.length === 0 && errors.length === 0 && progressToken !== undefined) {
          const elapsed = Math.round((Date.now() - started) / 1000);
          await ctx.mcpReq
            .notify({
              method: "notifications/progress",
              params: { progressToken, progress: elapsed, total, message: `Waiting for comments in the viewer (${elapsed}/${total} s)` },
            })
            .catch(() => {});
        }
      }
      const errorNote = errors.length
        ? `The page reported errors in the viewer on v${errors[0].version}:\n${formatErrors(errors)}\nFix them in a new version.`
        : "";
      if (comments.length > 0) return text(errorNote ? `${formatComments(comments)}\n\n${errorNote}` : formatComments(comments));
      if (errorNote) return text(`No new comment yet, but ${errorNote.charAt(0).toLowerCase()}${errorNote.slice(1)}`);
      return text(`No new comment within ${total} s (after_comment_id=${after}).`);
    }, "except-self"),
  );

  server.registerTool(
    "resolve_comments",
    {
      title: "Resolve comments",
      description:
        "Marks comments as resolved after you addressed them in a new version. With note you leave a visible reply in the viewer (e.g. \"Done in v4: …\").",
      inputSchema: z.object({
        id: idParam,
        comment_ids: z.array(z.number().int()).min(1),
        note: z.string().optional(),
      }),
      annotations: { ...LOCAL, readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    tool(async ({ id, comment_ids, note }, ctx) => {
      const base = `/api/artifacts/${encodeURIComponent(id)}/comments`;
      await api(fetchApi, `${base}/resolve`, { method: "POST", body: JSON.stringify({ ids: comment_ids }) });
      if (note) {
        // The agent's note is informational, so it is created already resolved.
        await api(fetchApi, base, {
          method: "POST",
          body: JSON.stringify({ body: note, author: agentName(ctx) ?? "Agent", source: "agent", resolved: true }),
        });
      }
      return text(`Resolved ${comment_ids.length} comment(s).`);
    }, "except-self"),
  );

  return server;
}
