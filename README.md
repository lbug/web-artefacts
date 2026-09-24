# web-artefacts

A local artifact viewer for coding agents. Your agent publishes HTML pages through MCP, you look at them in the browser and leave comments, and the agent reads your feedback and publishes the next version under the same URL.

```
Agent (OpenCode, Claude Code, Codex, …)
   │  MCP: publish_artifact · wait_for_comments · resolve_comments · …
   ▼
web-artefacts (Node, 127.0.0.1 only)
   ├─ :4400  viewer + API + /mcp   → gallery, versions, diff, comments, live reload
   └─ :4401  /raw/<id>/<v>         → artifact HTML on its own origin, sandboxed, strict CSP
```

- Node.js ≥ 22.13.
- Tested on Linux and macOS. **Windows is untested.**
- MCP: speaks protocol revision 2026-07-28 as well as 2025-era clients (with `initialize`), over stdio and Streamable HTTP.

## Setup

One entry in your agent is enough. On its first tool call, the MCP server starts the viewer service in the background.

| Agent | Command |
|---|---|
| OpenCode | `opencode mcp add --global web-artefacts -- npx -y web-artefacts mcp` |
| Claude Code | `claude mcp add --scope user web-artefacts -- npx -y web-artefacts mcp` |
| Codex | in `~/.codex/config.toml`: `[mcp_servers.web-artefacts]`, `command = "npx"`, `args = ["-y", "web-artefacts", "mcp"]` |
| Others (Cursor, Claude Desktop, LibreChat, …) | stdio server `npx -y web-artefacts mcp` |

Agents that prefer a URL can use `http://127.0.0.1:4400/mcp` once the service runs (`npx web-artefacts start`). Over HTTP, `path` must be absolute.

## Usage

Just talk to your agent, e.g. "explain this as a diagram" or "show me three drafts for the landing page". Based on the request, the agent picks one of two modes:

- **Show (default):** publish, give you the URL, done. Follow-up questions go through the chat.
- **Feedback loop:** for alternatives, drafts that need a decision, or when you ask for it. The agent waits for your comments in the viewer, applies them, publishes the next version and resolves your comments with a short note.

What you say explicitly wins, e.g. "just show it" or "wait for my feedback". The agent talks to you in your language.

**Picking up an artifact in another session:** click "⧉ Copy for agent" in the viewer and paste the reference into the session. The id is also the last path segment of every viewer URL (`/a/<id>`).

MCP tools cannot notify the agent on their own. Every tool result therefore ends with a note when any artifact has open comments.

## Tools

| Tool | Purpose |
|---|---|
| `publish_artifact(path \| html, title, id?)` | Without `id` a new artifact, with `id` a new version of the same URL |
| `list_artifacts()` | All artifacts, including open comment counts |
| `read_artifact(id, version?)` | HTML source of a version |
| `read_comments(id, include_resolved?)` | Comments (default: open ones only) |
| `wait_for_comments(id, timeout_seconds?)` | Waits until you comment in the viewer (default 300 s, max 600 s) |
| `resolve_comments(id, comment_ids, note?)` | Mark as resolved, optionally with a reply shown in the viewer |

## Commands

```
npx web-artefacts status     # is the service running? URLs, data directory, log
npx web-artefacts open [id]  # open the gallery or one artifact in the browser
npx web-artefacts start      # start the service in the background
npx web-artefacts stop       # stop the service
npx web-artefacts serve      # run the service in the foreground (e.g. under systemd)
```

Data lives in `~/.local/share/web-artefacts` (SQLite plus HTML files). Settings via environment variables: `ARTIFACTS_PORT` (4400), `ARTIFACTS_RAW_PORT` (port + 1), `ARTIFACTS_DATA_DIR`, `ARTIFACTS_AUTOSTART=0`.

If the viewer should be reachable right after a reboot, before any agent starts it, run `web-artefacts serve` as a service. A systemd example is in `deploy/web-artefacts.service`.

When `npx` picks up a newer version, the MCP server replaces an older background service automatically.

## Security

- Artifact HTML runs in `<iframe sandbox="allow-scripts">` on its own origin (port 4401). It cannot reach the viewer, the API, cookies or localStorage.
- CSP on raw responses: scripts and styles inline or from cdnjs, jsDelivr, unpkg and esm.sh; fonts from Google Fonts; network access only to these CDNs; no form targets.
- The service binds to 127.0.0.1 only, checks the `Host` header (DNS rebinding) and rejects state-changing requests from foreign origins (CSRF). There is no further authentication: any local process can use the API.

## Development

```sh
npm install
npm test               # API, isolation and MCP end-to-end tests
npm run typecheck
npm run dev            # service from src/ with --watch
npm run build          # bundles everything into dist/cli.js (also runs before npm pack/publish)
```

To point an agent at the source during development (Node ≥ 22.18):
`node --disable-warning=ExperimentalWarning <repo>/src/cli.ts mcp`

Release: `npm version patch|minor|major`, then `git push --follow-tags`. `.github/workflows/release.yml` publishes via npm trusted publishing. The very first version is published once by hand with `npm publish --access public`.

`src/store.ts` depends on two small interfaces only (`Sql`, `Blobs`), so running on Cloudflare (D1 and R2) would need just two more adapters.

## License

MIT
