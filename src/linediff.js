'use strict';

// Myers line diff, used to compare revisions (a diff of diffs) and notes.

const MAX_D = 4000;

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((text) => ({ t: 'add', text }));
  if (!m) return a.map((text) => ({ t: 'del', text }));
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let done = false;
  for (let d = 0; d <= max && !done; d++) {
    if (d > MAX_D) return null;
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { done = true; break; }
    }
  }
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    if (d === 0) {
      while (x > 0 && y > 0) { ops.push({ t: 'eq', text: a[x - 1] }); x--; y--; }
      break;
    }
    const tv = trace[d];
    const get = (k) => tv[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ t: 'eq', text: a[x - 1] }); x--; y--; }
    if (x === prevX) ops.push({ t: 'add', text: b[prevY] });
    else ops.push({ t: 'del', text: a[prevX] });
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

function diffLines(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const midA = a.slice(s, ea);
  const midB = b.slice(s, eb);
  const mid = myers(midA, midB) || [
    ...midA.map((text) => ({ t: 'del', text })),
    ...midB.map((text) => ({ t: 'add', text })),
  ];
  const eq = (text) => ({ t: 'eq', text });
  return [...a.slice(0, s).map(eq), ...mid, ...a.slice(ea).map(eq)];
}

// Groups ops into hunks with `context` unchanged lines around changes.
function hunks(ops, context = 3) {
  let aNo = 1;
  let bNo = 1;
  const numbered = ops.map((o) => {
    const r = { ...o, aNo: o.t === 'add' ? null : aNo, bNo: o.t === 'del' ? null : bNo };
    if (o.t !== 'add') aNo++;
    if (o.t !== 'del') bNo++;
    return r;
  });
  const ranges = [];
  numbered.forEach((o, i) => {
    if (o.t === 'eq') return;
    const s = Math.max(0, i - context);
    const e = Math.min(numbered.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1] + 1) last[1] = e;
    else ranges.push([s, e]);
  });
  return ranges.map(([s, e]) => numbered.slice(s, e + 1));
}

module.exports = { diffLines, hunks };
