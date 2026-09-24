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

async function renderIndex() {
  document.title = "Artifacts";
  const list = h("div", { class: "gallery" });
  root.replaceChildren(h("main", { class: "index" },
    h("h1", {}, "Artifacts"),
    h("p", { class: "sub muted" }, "Pages published by your coding agents. New versions show up live."),
    list));

  const cards = new Map(); // id -> { el, version, thumb, meta, badge }

  function card(a) {
    const thumb = h("div", { class: "thumb" }, thumbFrame(a.raw_url));
    thumbResize.observe(thumb);
    const meta = h("div", { class: "meta" });
    const badge = h("span", { class: "badge", title: "Open comments" });
    const title = h("a", { class: "title", href: `/a/${a.id}` });
    const el = h("div", { class: "tile" }, thumb, h("div", { class: "info" }, h("div", { class: "row" }, title, badge), meta));
    return { el, thumb, meta, badge, title, version: a.latest_version };
  }

  async function refresh() {
    let items;
    try { items = await api("/api/artifacts"); } catch (e) { list.replaceChildren(h("div", { class: "error" }, e.message)); return; }
    if (items.length === 0) {
      cards.clear();
      list.replaceChildren(h("div", { class: "empty" },
        h("p", {}, "No artifacts yet."),
        h("p", { class: "muted" }, "Ask your agent to publish a page with ", h("code", {}, "publish_artifact"), ".")));
      return;
    }
    list.querySelector(".empty, .error")?.remove();

    const seen = new Set();
    items.forEach((a, i) => {
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
        a.latest_agent ? ` · ${a.latest_agent}` : "",
        h("span", { title: fullDate(a.updated_at) }, ` · ${ago(a.updated_at)}`));
      c.badge.textContent = a.open_comments;
      c.badge.hidden = !(a.open_comments > 0);
      // Move only cards that are out of place: moving an iframe reloads it.
      if (list.children[i] !== c.el) list.insertBefore(c.el, list.children[i] ?? null);
    });
    for (const [id, c] of cards) if (!seen.has(id)) { thumbResize.unobserve(c.thumb); c.el.remove(); cards.delete(id); }
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
  const sendBtn = h("button", { class: "btn primary", onclick: send }, "Send");
  textarea.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });

  const panel = h("aside", { class: "panel" },
    h("header", {}, h("h2", {}, "Comments"), h("label", { class: "toggle" }, resolvedToggle, "Show resolved")),
    commentsList,
    h("div", { class: "composer" }, textarea, h("div", { class: "row" }, "As", nameInput, forVersion, sendBtn)));

  const body = h("div", { class: "body" }, stage, panel);
  root.replaceChildren(h("div", { class: "viewer" },
    h("div", { class: "topbar" },
      h("a", { class: "btn ghost", href: "/", title: "All artifacts" }, "←"),
      liveDot, titleEl, versionSelect,
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
    if (!text) return;
    sendBtn.disabled = true;
    try {
      await api(`/api/artifacts/${id}/comments`, { method: "POST", body: JSON.stringify({ body: text, version: current(), author: nameInput.value.trim() || "User" }) });
      textarea.value = "";
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
      commentsList.replaceChildren(h("div", { class: "none" }, all.length ? "All resolved." : "No comments yet. Write below what the agent should change."));
      return;
    }
    const atBottom = commentsList.scrollHeight - commentsList.scrollTop - commentsList.clientHeight < 40;
    commentsList.replaceChildren(...shown.map((c) => h("div", { class: `comment${c.source === "agent" ? " agent" : ""}${c.resolved_at ? " resolved" : ""}` },
      h("div", { class: "head" },
        h("span", { class: "who" }, c.author),
        h("button", { class: "ver", title: "View this version", onclick: () => { state.version = c.version === state.meta.latest_version ? null : c.version; update(); } }, `v${c.version}`),
        h("span", { title: fullDate(c.created_at) }, ago(c.created_at)),
        c.source !== "agent" && h("button", { class: "btn ghost sm act", onclick: () => setResolved(c.id, !c.resolved_at) }, c.resolved_at ? "Reopen" : "✓ Resolve")),
      h("div", { class: "text" }, c.body))));
    if (atBottom) commentsList.scrollTop = commentsList.scrollHeight;
  }

  let frameSrc = null;
  function loadFrame(force = false) {
    const v = state.meta.versions.find((x) => x.version === current());
    if (!v || (!force && frameSrc === v.raw_url)) return;
    frameSrc = v.raw_url;
    // A fresh element per load keeps the browser history free of iframe entries.
    const frame = iframe.cloneNode();
    frame.src = v.raw_url;
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

    if (state.mode === "diff" && m.versions.length > 1) renderDiff();
    else { state.mode = "preview"; loadFrame(); }
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
  events.addEventListener("hello", () => loadMeta().catch(() => {})); // resync after reconnects
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
