// Loaded first by every artifact page (see withFrameScript in src/app.ts).
// It reports errors to the viewer and lets the user point at an element for a
// comment. It talks to the viewer only through postMessage; the page stays
// sandboxed and cannot reach the viewer or the API.
(() => {
  if (window.parent === window) return; // opened on its own, not in the viewer
  const send = (message) => window.parent.postMessage(message, "*");

  // ---------- errors ----------

  let reported = 0;
  const report = (message) => {
    if (reported++ < 20) send({ type: "web-artefacts:error", message: String(message).slice(0, 500) });
  };
  const where = (url, line) => (!url || url === location.href ? `line ${line}` : `${url}:${line}`);

  // Capture phase: also sees failed loads of scripts, images and styles, which do not bubble.
  window.addEventListener("error", (e) => {
    if (e instanceof ErrorEvent) {
      report(`${e.message} (${where(e.filename, e.lineno)})`);
      return;
    }
    const el = e.target;
    if (el instanceof Element) report(`Failed to load <${el.localName}> ${el.getAttribute("src") ?? el.getAttribute("href") ?? ""}`.trim());
  }, true);

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason instanceof Error ? `${e.reason.name}: ${e.reason.message}` : String(e.reason);
    report(`Unhandled promise rejection: ${reason}`);
  });

  document.addEventListener("securitypolicyviolation", (e) => {
    const what = e.blockedURI && e.blockedURI !== "inline" ? e.blockedURI : "inline code";
    report(`Blocked by the viewer's Content Security Policy (${e.effectiveDirective}): ${what}. Allowed are inline code and the CDNs cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com and esm.sh; fetch() to other hosts is not possible.`);
  });

  // ---------- pointing at elements ----------

  // One box, drawn above the page, marks the element under the pointer (while
  // picking) or the element a comment refers to (highlight).
  let box = null;
  function mark(el) {
    if (!el) {
      box?.remove();
      box = null;
      return;
    }
    if (!box) {
      box = document.createElement("div");
      box.setAttribute("aria-hidden", "true");
    }
    const r = el.getBoundingClientRect();
    box.style.cssText = `all: initial; position: fixed; z-index: 2147483647; pointer-events: none; box-sizing: border-box;
      left: ${r.left - 2}px; top: ${r.top - 2}px; width: ${r.width + 4}px; height: ${r.height + 4}px;
      border: 2px solid #4f6bed; border-radius: 4px; background: rgb(79 107 237 / 0.12);`;
    if (!box.isConnected) document.documentElement.append(box);
  }

  function selectorFor(el) {
    const parts = [];
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let part = node.localName;
      const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.localName === node.localName) : [];
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      parts.unshift(part);
      if (node.localName === "body") break;
    }
    return parts.join(" > ");
  }

  // A short description of the element for the agent: a container is best
  // described by its heading; otherwise its text, with separate text nodes
  // (e.g. SVG labels, which innerText runs together) joined by spaces.
  function textOf(el) {
    const heading = el.matches("h1, h2, h3, h4, h5, h6") ? null : el.querySelector("h1, h2, h3, h4, h5, h6");
    const walker = document.createTreeWalker(heading ?? el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest("script, style, template") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const parts = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.data);
    const label = parts.join(" ").trim() || el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || "";
    return label.replace(/\s+/g, " ").trim().slice(0, 120);
  }

  let picking = false;
  let hovered = null;
  const pickTarget = (e) => (e.target instanceof Element && e.target !== box ? e.target : null);

  function onMove(e) {
    hovered = pickTarget(e);
    mark(hovered);
  }
  // While picking, a click selects the element instead of triggering the page.
  function onPress(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== "click") return;
    const el = pickTarget(e);
    stopPicking();
    if (el) send({ type: "web-artefacts:anchor", anchor: { selector: selectorFor(el), text: textOf(el) } });
  }
  function onKey(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    stopPicking();
    send({ type: "web-artefacts:pick-cancelled" });
  }
  const onScroll = () => hovered && mark(hovered);
  const pressEvents = ["pointerdown", "mousedown", "mouseup", "click"];

  function startPicking() {
    if (picking) return;
    picking = true;
    window.addEventListener("mousemove", onMove, true);
    for (const t of pressEvents) window.addEventListener(t, onPress, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    document.documentElement.style.setProperty("cursor", "crosshair", "important");
  }
  function stopPicking() {
    if (!picking) return;
    picking = false;
    window.removeEventListener("mousemove", onMove, true);
    for (const t of pressEvents) window.removeEventListener(t, onPress, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onScroll, true);
    document.documentElement.style.removeProperty("cursor");
    hovered = null;
    mark(null);
  }

  let highlightTimer;
  function highlight(selector) {
    let el = null;
    try {
      el = document.querySelector(selector);
    } catch {}
    send({ type: "web-artefacts:highlighted", found: !!el });
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    // Follow the element while the page scrolls to it, then fade out.
    const until = Date.now() + 1600;
    cancelAnimationFrame(highlightTimer);
    const step = () => {
      if (picking) return;
      if (Date.now() > until) return mark(null);
      mark(el);
      highlightTimer = requestAnimationFrame(step);
    };
    step();
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return;
    const { type, selector } = e.data ?? {};
    if (type === "web-artefacts:pick") startPicking();
    else if (type === "web-artefacts:pick-cancel") stopPicking();
    else if (type === "web-artefacts:highlight" && typeof selector === "string") highlight(selector);
  });
})();
