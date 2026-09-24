import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// Random high ports so the test never touches a running instance.
const port = 20000 + Math.floor(Math.random() * 20000);
const dataDir = mkdtempSync(join(tmpdir(), "artefacts-mcp-"));
const env = {
  ...(process.env as Record<string, string>),
  ARTIFACTS_PORT: String(port),
  ARTIFACTS_DATA_DIR: dataDir,
  NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
};
const base = `http://127.0.0.1:${port}`;

after(async () => {
  // The stdio server autostarted the service detached; stop it.
  const { pid } = await (await fetch(`${base}/healthz`)).json();
  process.kill(pid);
});

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
const textOf = (r: unknown) => (r as TextResult).content[0].text;
const parsePublished = (t: string) => ({
  id: t.match(/^id: (\S+)$/m)![1],
  version: Number(t.match(/ v(\d+)$/m)![1]),
});

test("stdio MCP: autostart, publish, revise, comment loop", async (t) => {
  const client = new Client({ name: "test-agent", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "mcp"], env, cwd: dataDir, stderr: "pipe" }),
  );

  assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
  const listed = (await client.listTools()).tools;
  assert.deepEqual(listed.map((t) => t.name).sort(), ["list_artifacts", "publish_artifact", "read_artifact", "read_comments", "resolve_comments", "wait_for_comments"]);
  for (const t of listed) assert.equal(t.annotations?.openWorldHint, false, t.name);
  assert.equal(listed.find((t) => t.name === "read_comments")!.annotations?.readOnlyHint, true);
  assert.ok(listed.find((t) => t.name === "publish_artifact")!.outputSchema);

  // Relative path resolves against the agent's working directory.
  writeFileSync(join(dataDir, "page.html"), "<h1>v1</h1>");
  const publishedResult = await client.callTool({ name: "publish_artifact", arguments: { path: "page.html", title: "Demo" } });
  const publishedText = textOf(publishedResult);
  const structured = publishedResult.structuredContent as { id: string; version: number; url: string; next_step: string };
  assert.equal(structured.version, 1);
  assert.match(structured.next_step, /Give the user this URL/);
  assert.equal(structured.url, `${base}/a/${structured.id}`);
  const published = parsePublished(publishedText);
  assert.equal(published.version, 1);
  assert.match(publishedText, new RegExp(`URL: ${base}/a/${published.id}`));
  assert.match(publishedText, /Give the user this URL/);

  const meta = await (await fetch(`${base}/api/artifacts/${published.id}`)).json();
  assert.equal(meta.versions[0].agent, "test-agent");

  const bad = (await client.callTool({ name: "publish_artifact", arguments: { title: "x" } })) as TextResult;
  assert.equal(bad.isError, true);
  const missing = (await client.callTool({ name: "publish_artifact", arguments: { path: "/nope.html" } })) as TextResult;
  assert.equal(missing.isError, true);

  // The user comments while the agent waits.
  const waiting = client.callTool({ name: "wait_for_comments", arguments: { id: published.id, timeout_seconds: 10 } });
  await new Promise((r) => setTimeout(r, 300));
  await fetch(`${base}/api/artifacts/${published.id}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "Make the heading red", author: "Lukas" }),
  });
  const feedbackText = textOf(await waiting);
  // wait_for_comments does not repeat its own artifact in the hint.
  assert.doesNotMatch(feedbackText, /open user comments/);
  const feedback = JSON.parse(feedbackText);
  assert.equal(feedback[0].body, "Make the heading red");

  const v2Result = await client.callTool({ name: "publish_artifact", arguments: { id: published.id, html: "<h1 style=color:red>v2</h1>" } });
  const v2Text = textOf(v2Result);
  // The note must also reach clients that only show structuredContent.
  assert.match((v2Result.structuredContent as { note?: string }).note ?? "", /^Note: open user comments/);
  const v2 = parsePublished(v2Text);
  // The comment is still open, so the response points the agent to it.
  assert.match(v2Text, /Note: open user comments – "Demo" \(id \w+\): 1/);
  assert.equal(v2.version, 2);
  assert.equal(v2.id, published.id);

  await client.callTool({ name: "resolve_comments", arguments: { id: published.id, comment_ids: [feedback[0].id], note: "Made it red in v2" } });
  assert.equal(textOf(await client.callTool({ name: "read_comments", arguments: { id: published.id } })), "No open comments.");
  const all = JSON.parse(textOf(await client.callTool({ name: "read_comments", arguments: { id: published.id, include_resolved: true } })));
  assert.equal(all.length, 2);
  assert.equal(all[1].body, "Made it red in v2");

  const read = textOf(await client.callTool({ name: "read_artifact", arguments: { id: published.id, version: 1 } }));
  assert.doesNotMatch(read, /open user comments/);
  assert.match(read, /version 1 of 2/);
  assert.match(read, /<h1>v1<\/h1>/);

  const listResult = await client.callTool({ name: "list_artifacts", arguments: {} });
  assert.equal(JSON.parse(textOf(listResult))[0].latest_version, 2);
  assert.equal((listResult.structuredContent as { artifacts: Array<{ latest_version: number }> }).artifacts[0].latest_version, 2);

  const timeout = textOf(await client.callTool({ name: "wait_for_comments", arguments: { id: published.id, timeout_seconds: 1 } }));
  assert.match(timeout, /No new comment/);

  await client.close();
});

test("stdio MCP serves 2025-era clients too", async (t) => {
  const client = new Client({ name: "legacy-agent", version: "1.0.0" }); // default: plain initialize handshake
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "mcp"], env, cwd: dataDir, stderr: "pipe" }),
  );
  assert.match(client.getNegotiatedProtocolVersion() ?? "", /^2025-/);
  const res = await client.callTool({ name: "publish_artifact", arguments: { html: "<p>alt</p>", title: "Legacy" } });
  const { id } = res.structuredContent as { id: string };
  const meta = await (await fetch(`${base}/api/artifacts/${id}`)).json();
  assert.equal(meta.versions[0].agent, "legacy-agent");
  await client.close();
});

test("HTTP MCP endpoint (2026-07-28 client)", async (t) => {
  const client = new Client({ name: "http-agent", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
  const res = parsePublished(textOf(await client.callTool({ name: "publish_artifact", arguments: { html: "<p>über HTTP</p>", title: "HTTP" } })));
  assert.equal(res.version, 1);
  const rel = (await client.callTool({ name: "publish_artifact", arguments: { path: "relativ.html" } })) as TextResult;
  assert.equal(rel.isError, true);
  assert.match(rel.content[0].text, /absolute/);
  await client.close();
});

test("HTTP MCP endpoint serves 2025-era clients (initialize handshake)", async () => {
  const post = (body: unknown) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    });
  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "1" } },
  });
  assert.equal(init.status, 200);
  const initBody = await init.text();
  assert.match(initBody, /"protocolVersion":"2025-06-18"/);
  assert.match(initBody, /Two ways to use it/);
  const list = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).text();
  assert.match(list, /publish_artifact/);
});

test("HTTP MCP endpoint rejects foreign origins", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(res.status, 403);
});
