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

In the feedback loop, the comment panel shows whether the agent is currently waiting for your feedback. Comments you write in a row reach it together: it waits until you pause for 5 seconds. For decisions, the agent can put buttons or inputs into the page: your choices collect next to the comment box, and you send them together with your comment.

**Pointing at an element:** click "Point at element" at the bottom right of the preview, then an element in the page (Esc cancels). The comment then carries that element, so "make this bigger" is unambiguous for the agent. Clicking the element reference in a comment highlights it in the page again.

**Errors in the page:** while you look at a page, the viewer notices JavaScript errors, failed loads and requests blocked by the CSP. It shows them in the top bar and reports them to the agent: a waiting agent returns at once, other tools mention them, and `read_artifact` lists them.

**Resource checks on publish:** before anyone looks at a page, `publish_artifact` checks its external resources. Files on the allowed CDNs get a `HEAD` request (redirects are followed only within those hosts), so a guessed library version that does not exist shows up as "CDN resource returned 404". URLs on any other host are reported as blocked by the CSP, without a request. The warnings come with the tool result; publishing still succeeds.

**Picking up an artifact in another session:** click "⧉ Copy for agent" in the viewer and paste the reference into the session. The id is also the last path segment of every viewer URL (`/a/<id>`). Or just describe it ("the architecture diagram from last week"): the agent finds it with `search_artifacts`.

**Projects:** every artifact belongs to the project the agent works in: the name of its git repository, else of its working directory. Agents over HTTP, or started in the home or root directory, publish without a project. The gallery filters by project and title, 100 artifacts per page; `list_artifacts` and `search_artifacts` stay within the agent's current project unless asked for all.

**Choices from the page:** artifact code can call `parent.postMessage({ type: "web-artefacts:choice", key: "draft", text: "Draft B" }, "*")`. The viewer shows each choice as a removable chip next to the comment box and sends all of them with the user's next comment; nothing is sent without the user. A choice with the same `key` replaces the previous one, choices without a key add up.

MCP tools cannot notify the agent on their own. Every tool result therefore ends with a note when any artifact has open comments or browser errors on its latest version.

Every artifact page loads a small script from the raw origin first (`/_wa/frame.js`). It reports errors and handles pointing, and talks to the viewer only through `postMessage`. The stored HTML is not changed, and the script tag is inserted without adding a line, so line numbers in error messages match the source.

## Tools

| Tool | Purpose |
|---|---|
| `publish_artifact(path \| html, title, id?)` | Without `id` a new artifact, with `id` a new version of the same URL. Identical HTML and title return the existing version instead of creating a new one. Warns about missing CDN files and blocked hosts. `path` is preferred: the agent edits its file and a revision costs only the edit |
| `list_artifacts(all_projects?)` | The 100 most recently updated artifacts of the current project (the agent's git repository or working directory), or of all projects, including open comment and browser error counts |
| `search_artifacts(query, all_projects?)` | Full-text search (BM25) over titles and visible page text, also inside longer words; the 10 best matches with a snippet |
| `read_artifact(id, version?)` | HTML source of a version, plus the browser errors reported for it |
| `read_comments(id, include_resolved?)` | Comments (default: open ones only), with the element each one points at |
| `wait_for_comments(id, timeout_seconds?)` | Waits until you comment in the viewer (default 300 s, max 600 s), then until you pause for 5 s, and returns all new comments. Returns early when the page reports browser errors |
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

Release:

1. Describe the changes under "## Unreleased" in `CHANGELOG.md` (can happen along the way, with each change).
2. `npm version patch|minor|major`, then `git push --follow-tags`. `npm version` turns "Unreleased" into the new version's section, dated today, and commits it with the version bump; it refuses to run while "Unreleased" is empty.
3. `.github/workflows/release.yml` tests, builds and stages the version via npm trusted publishing, then creates the GitHub release with the version's changelog section as notes. The trusted publisher may only stage, so nothing goes live on npm without you.
4. Approve it with 2FA on the package page on npmjs.com. Alternatively run `npm stage approve <id>` (needs npm ≥ 11.15.0 and `npm login`); the id is in the workflow log (`staged with id …`).

The very first version is published once by hand with `npm publish --access public`.

`src/store.ts` depends on two small interfaces only (`Sql`, `Blobs`), so running on Cloudflare (D1 and R2) would need just two more adapters.

## License

MIT
