# Changelog

Notable changes per release. `npm version` turns "Unreleased" into the new version's section, and the release workflow publishes that section as the GitHub release notes.

## Unreleased

### Added
- Projects: every artifact belongs to the project the agent works in (the name of its git repository, else of its working directory), detected by the stdio MCP server. Existing artifacts get a project with their next version.
- Gallery: filter by title and project, 100 artifacts per page. Filters and page live in the URL.
- `search_artifacts(query, all_projects?)`: full-text search (SQLite FTS5, BM25) over titles and visible page text, also inside longer words ("filter" finds "Projektfilter"). Returns the 10 best matches with a snippet. Existing artifacts are indexed on the next start.
- API: `GET /api/search?q=`, and `project` and `limit` parameters for `GET /api/artifacts`.
- `CHANGELOG.md`; every GitHub release carries its version's section as release notes.

### Changed
- `list_artifacts` lists the current project unless `all_projects` is set, and says when it cut the list off at 100.
- `GET /api/artifacts` returns all artifacts instead of the 100 most recently updated, in a stable order.

## 0.3.0 - 2026-09-29

### Added
- Point at elements: comments can carry the element they refer to, and clicking the reference highlights it in the page again.
- The viewer reports JavaScript errors, failed loads and CSP violations to the agent. They end `wait_for_comments`, appear in tool notes and in `read_artifact`.
- `publish_artifact` checks external resources: files missing on the allowed CDNs and hosts blocked by the CSP come back as warnings.

### Fixed
- A comments long-poll lasts at most `wait` + `settle` seconds.
- Pending browser errors are flushed before another version loads, so they never land on the wrong version.
- Known errors keep counting once a version has 20 distinct ones.
- The frame script's CSP source covers every host the raw origin accepts.
- The cache of checked CDN URLs is capped.

## 0.2.0 - 2026-09-28

### Added
- `wait_for_comments` waits until the user pauses for 5 seconds and returns all new comments together.
- The comment panel shows whether an agent is waiting for feedback.
- Choices from the page: artifacts send `web-artefacts:choice` messages, which collect as chips next to the comment box and go out with the next comment.

## 0.1.2 - 2026-09-27

### Changed
- Releases are staged on npm and go live only after a maintainer approves them with 2FA.

## 0.1.1 - 2026-09-27

### Changed
- Republishing identical HTML and title returns the existing version instead of creating a new one.

## 0.1.0 - 2026-09-24

### Added
- First release: agents publish HTML pages over MCP (stdio or Streamable HTTP), users view them in a sandboxed viewer with versions, diff, live reload and comments, and agents read the feedback to publish the next version.
