import { diffLines, hunks } from "./diff.js";

const root = document.getElementById("app");

// ---------- tiny DOM helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(path, init) {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function ago(iso) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  const units = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [u, sec] of units) if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), u);
  return "just now";
}
const fullDate = (iso) => new Date(iso).toLocaleString();

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let toastTimer;
function toast(message, action) {
  document.querySelector(".toast")?.remove();
  const el = h("div", { class: "toast", role: "status" }, message,
    action && h("button", { class: "btn", onclick: () => { action.run(); el.remove(); } }, action.label));
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), action ? 10000 : 3500);
}

// ---------- index ----------

// Thumbnails are live, scaled-down renders of the latest version, rendered
// at a fixed desktop size so every tile shows the same "camera" view.
const THUMB_W = 1280, THUMB_H = 800;
const thumbResize = new ResizeObserver((entries) => {
  for (const e of entries) e.target.firstElementChild?.style.setProperty("transform", `scale(${e.contentRect.width / THUMB_W})`);
});

function thumbFrame(src) {
  return h("iframe", {
    src,
    sandbox: "allow-scripts", // no modals, downloads or popups from a thumbnail
    loading: "lazy",
    tabindex: "-1",
    "aria-hidden": "true",
    referrerpolicy: "no-referrer",
    width: THUMB_W,
    height: THUMB_H,
  });
}

// Project filter values: all projects, artifacts without a project, or one project.
const ALL = "all", NONE = "none", projectKey = (p) => (p == null ? NONE : `p:${p}`);
const PAGE_SIZE = 100;

async function renderIndex() {
  document.title = "Artifacts";
  // Filters live in the URL, so they survive going to an artifact and back.
  const params = new URLSearchParams(location.search);
  const filter = {
    q: params.get("q") ?? "",
    project: params.has("project") ? projectKey(params.get("project") || null) : ALL,
    page: Math.max(1, Math.floor(Number(params.get("page"))) || 1),
  };
  const search = h("input", { type: "search", class: "btn search", placeholder: "Filter by title", value: filter.q, "aria-label": "Filter by title" });
  const projects = h("select", { class: "btn", "aria-label": "Project" });
  const toolbar = h("div", { class: "toolbar", hidden: true }, search, projects);
  const list = h("div", { class: "gallery" });
  const noMatch = h("div", { class: "empty", hidden: true }, h("p", { class: "muted" }, "No artifacts match the filter."));
  // Built once and only updated, so the 5 s refresh never swaps a button out from under a click.
  const go = (step) => { filter.page += step; render(); updateUrl(); window.scrollTo(0, 0); };
  const prev = h("button", { class: "btn", onclick: () => go(-1) }, "‹ Previous");
  const next = h("button", { class: "btn", onclick: () => go(1) }, "Next ›");
  const range = h("span", { class: "muted" });
  const pager = h("nav", { class: "pager", hidden: true, "aria-label": "Pages" }, prev, range, next);
  root.replaceChildren(h("main", { class: "index" },
    h("h1", {}, "Artifacts"),
    h("p", { class: "sub muted" }, "Pages published by your coding agents. New versions show up live."),
    toolbar, list, noMatch, pager));

  let items = []; // all artifacts, most recently updated first
  const cards = new Map(); // id -> { el, version, thumb, meta, badge, title }, for the current page only

  function card(a) {
    const thumb = h("div", { class: "thumb" }, thumbFrame(a.raw_url));
    thumbResize.observe(thumb);
    const meta = h("div", { class: "meta" });
    const badge = h("span", { class: "badge", title: "Open comments" });
    const title = h("a", { class: "title", href: `/a/${a.id}` });
    const el = h("div", { class: "tile" }, thumb, h("div", { class: "info" }, h("div", { class: "row" }, title, badge), meta));
    return { el, thumb, meta, badge, title, version: a.latest_version };
  }

  // Filters all artifacts and shows one page of the matches. Only that page
  // has cards, so thousands of artifacts do not mean thousands of iframes.
  function render() {
    const q = filter.q.trim().toLowerCase();
    const found = items.filter((a) => (filter.project === ALL || projectKey(a.project) === filter.project) && a.title.toLowerCase().includes(q));
    const pages = Math.max(1, Math.ceil(found.length / PAGE_SIZE));
    filter.page = Math.min(filter.page, pages);
    const shown = found.slice((filter.page - 1) * PAGE_SIZE, filter.page * PAGE_SIZE);

    const seen = new Set();
    shown.forEach((a, i) => {
      seen.add(a.id);
      let c = cards.get(a.id);
      if (!c) cards.set(a.id, (c = card(a)));
      else if (c.version !== a.latest_version) {
        c.version = a.latest_version;
        c.thumb.firstElementChild.src = a.raw_url;
      }
      c.title.textContent = a.title;
      c.title.title = a.title;
      c.meta.replaceChildren(
        h("span", { class: "ver" }, `v${a.latest_version}`),
        a.project ? ` · ${a.project}` : "",
        a.latest_agent ? ` · ${a.latest_agent}` : "",
        h("span", { title: fullDate(a.updated_at) }, ` · ${ago(a.updated_at)}`));
      c.badge.textContent = a.open_comments;
      c.badge.hidden = !(a.open_comments > 0);
      // Move only cards that are out of place: moving an iframe reloads it.
      if (list.children[i] !== c.el) list.insertBefore(c.el, list.children[i] ?? null);
    });
    for (const [id, c] of cards) if (!seen.has(id)) { thumbResize.unobserve(c.thumb); c.el.remove(); cards.delete(id); }

    noMatch.hidden = items.length === 0 || found.length > 0;
    pager.hidden = pages === 1;
    prev.disabled = filter.page === 1;
    next.disabled = filter.page === pages;
    const start = (filter.page - 1) * PAGE_SIZE;
    range.textContent = `${start + 1}–${start + shown.length} of ${found.length}`;
  }

  function updateUrl() {
    const url = new URL(location.href);
    filter.q ? url.searchParams.set("q", filter.q) : url.searchParams.delete("q");
    if (filter.project === ALL) url.searchParams.delete("project");
    else url.searchParams.set("project", filter.project === NONE ? "" : filter.project.slice(2));
    filter.page > 1 ? url.searchParams.set("page", filter.page) : url.searchParams.delete("page");
    history.replaceState(null, "", url);
  }

  // A new filter starts on the first page.
  search.addEventListener("input", () => { filter.q = search.value; filter.page = 1; render(); updateUrl(); });
  projects.addEventListener("change", () => { filter.project = projects.value; filter.page = 1; render(); updateUrl(); });

  // Rebuilds the project options only when the set of projects changed, so an open dropdown is left alone.
  function renderProjects(items) {
    const names = [...new Set(items.map((a) => a.project).filter((p) => p != null))].sort((a, b) => a.localeCompare(b));
    const options = [[ALL, "All projects"], ...names.map((p) => [projectKey(p), p])];
    if (items.some((a) => a.project == null)) options.push([NONE, "No project"]);
    // Keep a selected project from the URL visible even when it has no artifacts (any more).
    if (!options.some(([key]) => key === filter.project)) options.push([filter.project, filter.project === NONE ? "No project" : filter.project.slice(2)]);
    const signature = JSON.stringify(options);
    if (projects.dataset.signature === signature) return;
    projects.dataset.signature = signature;
    projects.replaceChildren(...options.map(([key, label]) => h("option", { value: key }, label)));
    projects.value = filter.project;
  }

  async function refresh() {
    try { items = await api("/api/artifacts"); } catch (e) { list.replaceChildren(h("div", { class: "error" }, e.message)); return; }
    toolbar.hidden = items.length === 0;
    if (items.length === 0) {
      cards.clear();
      noMatch.hidden = true;
      pager.hidden = true;
      list.replaceChildren(h("div", { class: "empty" },
        h("p", {}, "No artifacts yet."),
        h("p", { class: "muted" }, "Ask your agent to publish a page with ", h("code", {}, "publish_artifact"), ".")));
      return;
    }
    list.querySelector(".empty, .error")?.remove();
    renderProjects(items);
    render();
  }
  await refresh();
  setInterval(() => document.visibilityState === "visible" && refresh(), 5000);
}

// ---------- viewer ----------

async function renderViewer(id) {
  const params = new URLSearchParams(location.search);
  const state = {
    meta: null,
    version: Number(params.get("v")) || null, // null = follow latest
    mode: params.get("mode") === "diff" ? "diff" : "preview",
    compareTo: null,
    showResolved: store.get("showResolved", "0") === "1",
    panelOpen: store.get("panelOpen", "1") === "1",
  };

  const current = () => state.version ?? state.meta.latest_version;
  const following = () => state.version == null;

  // Layout skeleton (built once, updated in place so the iframe is not recreated needlessly).
  const titleEl = h("div", { class: "title" });
  const liveDot = h("span", { class: "live", title: "Live connection" });
  const versionSelect = h("select", { class: "btn", "aria-label": "Version", onchange: () => {
    const v = Number(versionSelect.value);
    state.version = v === state.meta.latest_version ? null : v;
    update();
  } });
  const previewBtn = h("button", { class: "btn", onclick: () => { state.mode = "preview"; update(); } }, "Preview");
  const diffBtn = h("button", { class: "btn", onclick: () => { state.mode = "diff"; update(); } }, "Diff");
  const reloadBtn = h("button", { class: "btn ghost hide-sm", title: "Reload preview", onclick: () => loadFrame(true) }, "↻");
  const copyBtn = h("button", { class: "btn", title: "Copy a reference to hand to an agent – also in another session", onclick: copyReference }, "⧉ Copy for agent");
  const openBtn = h("a", { class: "btn ghost hide-sm", target: "_blank", rel: "noopener", title: "Open only the artifact in a new tab" }, "↗ Tab");
  const commentsBadge = h("span", { class: "badge" });
  const panelBtn = h("button", { class: "btn", onclick: () => {
    state.panelOpen = !state.panelOpen;
    store.set("panelOpen", state.panelOpen ? "1" : "0");
    update();
  } }, "Comments ", commentsBadge);

  const stage = h("div", { class: "stage" });
  const iframe = h("iframe", {
    sandbox: "allow-scripts allow-modals allow-downloads",
    allow: "fullscreen; clipboard-write",
    referrerpolicy: "no-referrer",
    title: "Artifact",
  });

  const commentsList = h("div", { class: "comments", "aria-live": "polite" });
  const resolvedToggle = h("input", { type: "checkbox", onchange: () => {
    state.showResolved = resolvedToggle.checked;
    store.set("showResolved", state.showResolved ? "1" : "0");
    renderComments();
  } });
  resolvedToggle.checked = state.showResolved;

  const textarea = h("textarea", { placeholder: `Feedback for the agent … (${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"}+Enter sends)`, "aria-label": "Comment" });
  const nameInput = h("input", { value: store.get("author", "User"), "aria-label": "Your name", onchange: () => store.set("author", nameInput.value.trim() || "User") });
  const forVersion = h("span");
  const agentStatus = h("div", { class: "agent-status" });
  const choicesEl = h("div", { class: "choices", "aria-label": "Choices from the page", hidden: true });
  const sendBtn = h("button", { class: "btn primary", onclick: send }, "Send");
  // Sits on the preview, where the user wants to point.
  const pickBtn = h("button", { class: "pick", "aria-pressed": "false", title: "Attach a part of the page to your comment", onclick: togglePicking }, "Point at element");
  const errorsEl = h("span", { class: "errors", hidden: true });
  textarea.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });

  const panel = h("aside", { class: "panel" },
    h("header", {}, h("h2", {}, "Comments"), h("label", { class: "toggle" }, resolvedToggle, "Show resolved")),
    commentsList,
    h("div", { class: "composer" }, agentStatus, choicesEl, textarea, h("div", { class: "row" }, "As", nameInput, forVersion, sendBtn)));

  const body = h("div", { class: "body" }, h("div", { class: "stage-wrap" }, stage, pickBtn), panel);
  root.replaceChildren(h("div", { class: "viewer" },
    h("div", { class: "topbar" },
      h("a", { class: "btn ghost", href: "/", title: "All artifacts" }, "←"),
      liveDot, titleEl, errorsEl, versionSelect,
      h("div", { class: "group" }, previewBtn, diffBtn),
      reloadBtn, openBtn, copyBtn, panelBtn),
    body));

  async function copyReference() {
    const v = current();
    const url = `${location.origin}/a/${id}${following() ? "" : `?v=${v}`}`;
    const ref = `Artifact "${state.meta.title}" v${v} (id: ${id}) – ${url}`;
    try {
      await navigator.clipboard.writeText(ref);
      toast("Reference copied – paste it into your agent session");
    } catch {
      window.prompt("Copy reference:", ref);
    }
  }

  async function send() {
    const text = textarea.value.trim();
    if (!text && choices.size === 0) return;
    // Choices and free text go out together, as one comment.
    const body = [[...choices.values()].map((c) => `- ${c}`).join("\n"), text].filter(Boolean).join("\n\n");
    sendBtn.disabled = true;
    try {
      await api(`/api/artifacts/${id}/comments`, { method: "POST", body: JSON.stringify({ body, anchor, version: current(), author: nameInput.value.trim() || "User" }) });
      textarea.value = "";
      choices.clear();
      anchor = null;
      renderChoices();
      await loadMeta();
    } catch (e) {
      toast(`Sending failed: ${e.message}`);
    } finally {
      sendBtn.disabled = false;
      textarea.focus();
    }
  }

  async function setResolved(cid, resolved) {
    await api(`/api/artifacts/${id}/comments/resolve`, { method: "POST", body: JSON.stringify({ ids: [cid], resolved }) });
    await loadMeta();
  }

  function renderComments() {
    const all = state.meta.comments;
    const shown = all.filter((c) => state.showResolved || !c.resolved_at);
    const open = all.filter((c) => !c.resolved_at && c.source !== "agent").length;
    commentsBadge.textContent = open;
    commentsBadge.hidden = open === 0;
    if (shown.length === 0) {
      commentsList.replaceChildren(all.length
        ? h("div", { class: "none" }, "All resolved.")
        : h("div", { class: "none" }, "No comments yet. Write below what the agent should change.",
          h("p", { class: "tip" }, "Tip: “Point at element” at the bottom right of the preview attaches a part of the page to your comment, so the agent knows what you mean.")));
      return;
    }
    const atBottom = commentsList.scrollHeight - commentsList.scrollTop - commentsList.clientHeight < 40;
    commentsList.replaceChildren(...shown.map((c) => h("div", { class: `comment${c.source === "agent" ? " agent" : ""}${c.resolved_at ? " resolved" : ""}` },
      h("div", { class: "head" },
        h("span", { class: "who" }, c.author),
        h("button", { class: "ver", title: "View this version", onclick: () => { state.version = c.version === state.meta.latest_version ? null : c.version; update(); } }, `v${c.version}`),
        h("span", { title: fullDate(c.created_at) }, ago(c.created_at)),
        c.source !== "agent" && h("button", { class: "btn ghost sm act", onclick: () => setResolved(c.id, !c.resolved_at) }, c.resolved_at ? "Reopen" : "✓ Resolve")),
      c.anchor && h("button", { class: "anchor", title: `Show in the page: ${c.anchor.selector}`, onclick: () => showAnchor(c) }, `⌖ ${anchorLabel(c.anchor)}`),
      h("div", { class: "text" }, c.body))));
    if (atBottom) commentsList.scrollTop = commentsList.scrollHeight;
  }

  // Whether an agent currently waits for comments (wait_for_comments).
  let listeningOff;
  function showListening(on) {
    clearTimeout(listeningOff);
    agentStatus.classList.toggle("on", on);
    agentStatus.textContent = on
      ? "Agent is waiting for your feedback"
      : "Agent isn't waiting right now – it sees new comments on its next step";
  }
  // Agents long-poll in chunks; ignore the short gaps between two requests.
  const setListening = (on) => {
    clearTimeout(listeningOff);
    if (on) showListening(true);
    else listeningOff = setTimeout(() => showListening(false), 2000);
  };
  showListening(false);

  // An artifact can report choices, e.g. from a "Choose this draft" button:
  // parent.postMessage({ type: "web-artefacts:choice", key: "draft", text: "Draft B" }, "*").
  // They collect as chips next to the composer and go out with the next
  // comment, so sending stays the user's decision. A choice with the same key
  // replaces the earlier answer to that question; without a key, choices add up.
  const choices = new Map(); // key -> text, in the order they were first made
  // The element the next comment points at: { selector, text } from the frame script.
  let anchor = null;
  const anchorLabel = (a) => (a.text ? `“${a.text.length > 40 ? `${a.text.slice(0, 40)}…` : a.text}”` : a.selector.split(" > ").pop());
  const chip = (label, attrs, onRemove) => h("span", { class: "chip", ...attrs }, label,
    h("button", { title: "Remove", "aria-label": `Remove "${label}"`, onclick: onRemove }, "×"));
  function renderChoices() {
    choicesEl.hidden = choices.size === 0 && !anchor;
    choicesEl.replaceChildren(
      ...(anchor ? [chip(`⌖ ${anchorLabel(anchor)}`, { class: "chip anchor", title: anchor.selector }, () => { anchor = null; renderChoices(); })] : []),
      ...[...choices].map(([key, text]) => chip(text, {}, () => { choices.delete(key); renderChoices(); })));
  }
  function openPanel() {
    if (state.panelOpen) return;
    state.panelOpen = true;
    store.set("panelOpen", "1");
    update();
  }

  // The preview frame and whether its page (and the frame script) finished loading.
  const frameEl = () => stage.querySelector("iframe");
  let frameReady = false;
  let frameVersion = null;
  function whenFrameReady(fn) {
    const frame = frameEl();
    if (!frame) return;
    if (frameReady) fn(frame.contentWindow);
    else frame.addEventListener("load", () => fn(frame.contentWindow), { once: true });
  }

  // Pointing: the frame script marks the element under the pointer and reports the clicked one.
  let picking = false;
  function setPicking(on) {
    picking = on;
    pickBtn.setAttribute("aria-pressed", String(on));
    pickBtn.textContent = on ? "Click an element · Esc cancels" : "Point at element";
  }
  function togglePicking() {
    if (picking) {
      frameEl()?.contentWindow.postMessage({ type: "web-artefacts:pick-cancel" }, "*");
      setPicking(false);
      return;
    }
    if (state.mode !== "preview") { state.mode = "preview"; update(); }
    setPicking(true);
    whenFrameReady((w) => w.postMessage({ type: "web-artefacts:pick" }, "*"));
  }
  // Esc in the viewer cancels too; the frame script handles it while the page has focus.
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && picking) togglePicking(); });
  function showAnchor(c) {
    const version = c.version === state.meta.latest_version ? null : c.version;
    if (state.version !== version || state.mode !== "preview") { state.version = version; state.mode = "preview"; update(); }
    whenFrameReady((w) => w.postMessage({ type: "web-artefacts:highlight", selector: c.anchor.selector }, "*"));
  }

  // Errors the frame script reports are shown here and sent to the API, where
  // the agent sees them. Sent in batches, since a broken page often throws several at once.
  let frameErrors = [];
  let pendingErrors = [];
  let pendingVersion = null;
  let errorsTimer;
  // Sends the batch now; loadFrame calls it before switching versions, so a
  // batch never mixes errors of two versions.
  function flushErrors() {
    clearTimeout(errorsTimer);
    if (pendingErrors.length === 0) return;
    const messages = pendingErrors;
    pendingErrors = [];
    api(`/api/artifacts/${id}/versions/${pendingVersion}/errors`, { method: "POST", body: JSON.stringify({ messages }) }).catch(() => {});
  }
  function renderErrors() {
    errorsEl.hidden = frameErrors.length === 0;
    errorsEl.textContent = `⚠ ${frameErrors.length} ${frameErrors.length === 1 ? "error" : "errors"}`;
    errorsEl.title = `Errors in this page – the agent sees them:\n${frameErrors.map((m) => `• ${m}`).join("\n")}`;
  }
  function reportError(message) {
    frameErrors.push(message);
    renderErrors();
    pendingErrors.push(message);
    pendingVersion = frameVersion;
    clearTimeout(errorsTimer);
    errorsTimer = setTimeout(flushErrors, 500);
  }

  window.addEventListener("message", (e) => {
    const frame = frameEl();
    if (!frame || e.source !== frame.contentWindow) return;
    const data = e.data ?? {};
    switch (data.type) {
      case "web-artefacts:choice": {
        if (typeof data.text !== "string" || !data.text.trim()) return;
        const choice = data.text.trim().slice(0, 2000);
        const mapKey = typeof data.key === "string" && data.key ? `key:${data.key}` : `text:${choice}`;
        if (!choices.has(mapKey) && choices.size >= 50) return;
        choices.set(mapKey, choice);
        renderChoices();
        openPanel();
        break;
      }
      case "web-artefacts:anchor": {
        const { selector, text } = data.anchor ?? {};
        if (!picking || typeof selector !== "string" || !selector) return;
        anchor = { selector: selector.slice(0, 500), text: typeof text === "string" ? text.slice(0, 200) : "" };
        setPicking(false);
        renderChoices();
        openPanel();
        textarea.focus();
        break;
      }
      case "web-artefacts:pick-cancelled":
        setPicking(false);
        break;
      case "web-artefacts:highlighted":
        if (!data.found) toast("This element is not in the version shown");
        break;
      case "web-artefacts:error":
        if (typeof data.message === "string" && data.message && frameErrors.length < 20) reportError(data.message.slice(0, 500));
        break;
    }
  });

  let frameSrc = null;
  function loadFrame(force = false) {
    const v = state.meta.versions.find((x) => x.version === current());
    if (!v || (!force && frameSrc === v.raw_url)) return;
    frameSrc = v.raw_url;
    // A fresh element per load keeps the browser history free of iframe entries.
    const frame = iframe.cloneNode();
    frame.src = v.raw_url;
    frameReady = false;
    flushErrors();
    frameVersion = v.version;
    frame.addEventListener("load", () => { frameReady = true; }, { once: true });
    frameErrors = [];
    renderErrors();
    setPicking(false);
    stage.replaceChildren(frame);
  }

  const sourceCache = new Map();
  const source = (v) => {
    if (!sourceCache.has(v)) sourceCache.set(v, api(`/api/artifacts/${id}/versions/${v}`).catch((e) => { sourceCache.delete(v); throw e; }));
    return sourceCache.get(v);
  };

  async function renderDiff() {
    const newV = current();
    const versions = state.meta.versions.map((x) => x.version);
    const oldV = state.compareTo && state.compareTo < newV ? state.compareTo : versions.find((x) => x < newV);
    const compareSelect = h("select", { class: "btn", onchange: () => { state.compareTo = Number(compareSelect.value); renderDiff(); } },
      versions.filter((x) => x < newV).map((x) => h("option", { value: x, selected: x === oldV }, `v${x}`)));
    const wrap = h("div", { class: "diff" });
    stage.replaceChildren(wrap);
    frameSrc = null;
    if (!oldV) {
      wrap.append(h("div", { class: "same" }, `v${newV} is the first version – nothing to compare.`));
      return;
    }
    wrap.append(h("div", { class: "bar" }, "Compare", compareSelect, "→", h("strong", {}, `v${newV}`), h("span", { class: "muted", id: "diffstat" })));
    const [a, b] = await Promise.all([source(oldV), source(newV)]);
    if (state.mode !== "diff" || current() !== newV) return;
    const ops = diffLines(a, b);
    const added = ops.filter((o) => o.op === "+").length, removed = ops.filter((o) => o.op === "-").length;
    wrap.querySelector("#diffstat").textContent = `+${added} −${removed} lines`;
    if (!added && !removed) { wrap.append(h("div", { class: "same" }, "No differences.")); return; }
    const { hunks: hs, skippedAfter } = hunks(ops);
    const rows = [];
    const skipRow = (n) => h("tr", { class: "skip" }, h("td", { colspan: 3 }, `⋯ ${n} unchanged lines`));
    for (const hk of hs) {
      if (hk.skippedBefore) rows.push(skipRow(hk.skippedBefore));
      for (const o of hk.lines) rows.push(h("tr", { class: o.op === "+" ? "add" : o.op === "-" ? "del" : "" },
        h("td", { class: "ln" }, o.a ?? ""), h("td", { class: "ln" }, o.b ?? ""), h("td", {}, `${o.op === "=" ? " " : o.op} ${o.text}`)));
    }
    if (skippedAfter) rows.push(skipRow(skippedAfter));
    wrap.append(h("table", {}, h("tbody", {}, rows)));
  }

  function update() {
    const m = state.meta;
    document.title = `${m.title} · Artifacts`;
    titleEl.textContent = m.title;
    titleEl.title = m.title;
    versionSelect.replaceChildren(...m.versions.map((v) =>
      h("option", { value: v.version, selected: v.version === current() },
        `v${v.version}${v.version === m.latest_version ? " (latest)" : ""} · ${ago(v.created_at)}${v.agent ? ` · ${v.agent}` : ""}`)));
    previewBtn.setAttribute("aria-pressed", String(state.mode === "preview"));
    diffBtn.setAttribute("aria-pressed", String(state.mode === "diff"));
    diffBtn.disabled = m.versions.length < 2;
    const v = m.versions.find((x) => x.version === current());
    openBtn.href = v?.raw_url ?? "#";
    forVersion.textContent = `on v${current()}`;
    body.classList.toggle("no-panel", !state.panelOpen);
    panelBtn.setAttribute("aria-pressed", String(state.panelOpen));

    const url = new URL(location.href);
    following() ? url.searchParams.delete("v") : url.searchParams.set("v", current());
    state.mode === "diff" ? url.searchParams.set("mode", "diff") : url.searchParams.delete("mode");
    history.replaceState(null, "", url);

    if (state.mode === "diff" && m.versions.length > 1) {
      if (picking) setPicking(false);
      renderDiff();
    } else { state.mode = "preview"; loadFrame(); }
    pickBtn.hidden = state.mode !== "preview";
    renderComments();
  }

  async function loadMeta() {
    state.meta = await api(`/api/artifacts/${id}`);
    if (state.version && !state.meta.versions.some((v) => v.version === state.version)) state.version = null;
    update();
  }

  try {
    await loadMeta();
  } catch (e) {
    root.replaceChildren(h("div", { class: "error" }, h("h2", {}, "Not found"), h("p", { class: "muted" }, e.message), h("a", { class: "btn", href: "/" }, "Back to overview")));
    return;
  }

  // Live updates.
  const events = new EventSource(`/api/artifacts/${id}/events`);
  events.addEventListener("open", () => liveDot.classList.add("on"));
  events.addEventListener("error", () => liveDot.classList.remove("on"));
  events.addEventListener("hello", (e) => { // resync after reconnects
    showListening(JSON.parse(e.data).listening === true);
    loadMeta().catch(() => {});
  });
  events.addEventListener("listening", (e) => setListening(JSON.parse(e.data).listening));
  events.addEventListener("version", async (e) => {
    const { version } = JSON.parse(e.data);
    const wasFollowing = following();
    await loadMeta();
    const agent = state.meta.versions.find((v) => v.version === version)?.agent;
    const label = `v${version} published${agent ? ` by ${agent}` : ""}`;
    if (wasFollowing) toast(label);
    else toast(label, { label: "Show", run: () => { state.version = null; update(); } });
  });
  events.addEventListener("comment", () => loadMeta().catch(() => {}));
  events.addEventListener("resolved", () => loadMeta().catch(() => {}));

  // Keep relative timestamps fresh.
  setInterval(() => { if (document.visibilityState === "visible") renderComments(); }, 60000);
}

// ---------- router ----------

const match = location.pathname.match(/^\/a\/([a-z0-9]+)\/?$/);
if (match) renderViewer(match[1]);
else renderIndex();
