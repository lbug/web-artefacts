// Line diff (Myers O(ND)) with common prefix/suffix trimming.
// Returns [{ op: "=" | "-" | "+", text, a?: lineNo, b?: lineNo }].

const MAX_EDIT_DISTANCE = 3000;

export function diffLines(oldText, newText) {
  const a = oldText.split("\n");
  const b = newText.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const middle = myers(a.slice(start, endA), b.slice(start, endB));
  const ops = [
    ...a.slice(0, start).map((text) => ({ op: "=", text })),
    ...middle,
    ...a.slice(endA).map((text) => ({ op: "=", text })),
  ];

  let ia = 1, ib = 1;
  for (const o of ops) {
    if (o.op !== "+") o.a = ia++;
    if (o.op !== "-") o.b = ib++;
  }
  return ops;
}

function myers(a, b) {
  const n = a.length, m = b.length;
  if (n === 0) return b.map((text) => ({ op: "+", text }));
  if (m === 0) return a.map((text) => ({ op: "-", text }));

  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v for k in [-d-1, d+1] as it was before step d.
  const trace = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  // Too different to diff cheaply: show as full replacement.
  return [...a.map((text) => ({ op: "-", text })), ...b.map((text) => ({ op: "+", text }))];
}

function backtrack(trace, a, b, dEnd) {
  const out = [];
  let x = a.length, y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const t = trace[d];
    const at = (k) => t[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--; y--;
      out.push({ op: "=", text: a[x] });
    }
    if (x === prevX) out.push({ op: "+", text: b[--y] });
    else out.push({ op: "-", text: a[--x] });
  }
  while (x > 0 && y > 0) {
    x--; y--;
    out.push({ op: "=", text: a[x] });
  }
  return out.reverse();
}

/** Groups ops into hunks with `context` unchanged lines around each change. */
export function hunks(ops, context = 3) {
  const changed = ops.map((o) => o.op !== "=");
  const keep = new Array(ops.length).fill(false);
  changed.forEach((c, i) => {
    if (!c) return;
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = true;
  });
  const out = [];
  let current = null, skipped = 0;
  ops.forEach((o, i) => {
    if (keep[i]) {
      if (!current) { current = { skippedBefore: skipped, lines: [] }; out.push(current); skipped = 0; }
      current.lines.push(o);
    } else {
      current = null;
      skipped++;
    }
  });
  return { hunks: out, skippedAfter: skipped };
}
