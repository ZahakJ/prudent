'use strict';

const store = require('./store');
const { parsePatch, totals } = require('./patch');
const { parseNotes, anchorNotes } = require('./notes');
const { diffLines, hunks } = require('./linediff');

function compareLines(f) {
  const out = [];
  if (f.binary) out.push('(binary file)');
  for (const h of f.hunks) {
    out.push(`@@ ${h.section}`.trimEnd());
    for (const l of h.lines) out.push((l.t === 'add' ? '+' : l.t === 'del' ? '-' : l.t === 'ctx' ? ' ' : '') + l.text);
  }
  return out;
}

// What changed between two revisions: per file, a diff of the two diffs.
function compareRevisions(a, b) {
  const fa = new Map(parsePatch(a.patch).map((f) => [f.path, f]));
  const fb = new Map(parsePatch(b.patch).map((f) => [f.path, f]));
  const paths = [...fb.keys(), ...[...fa.keys()].filter((p) => !fb.has(p))];
  const files = paths.map((p) => {
    const la = fa.has(p) ? compareLines(fa.get(p)) : [];
    const lb = fb.has(p) ? compareLines(fb.get(p)) : [];
    const ops = diffLines(la, lb);
    const changed = ops.some((o) => o.t !== 'eq');
    const kind = !fa.has(p) ? 'new in this revision' : !fb.has(p) ? 'no longer changed' : changed ? 'changed' : 'same';
    return { path: p, kind, hunks: changed ? hunks(ops, 3) : [] };
  });
  const notesOps = diffLines(a.notes.split('\n'), b.notes.split('\n'));
  return {
    from: a.info.revision, to: b.info.revision, files,
    notes: notesOps.some((o) => o.t !== 'eq') ? hunks(notesOps, 2) : [],
  };
}

function commentKey(file, side, line) {
  return `${file}\u0000${side}\u0000${line}`;
}

function loadReviewModel(id, opts = {}) {
  const meta = store.loadMeta(id);
  const decision = store.loadDecision(id);
  const revisions = store.listRevisions(id);
  const current = store.loadRevision(id, meta.revision);
  const files = parsePatch(current.patch);
  const notes = parseNotes(current.notes);
  const anchored = anchorNotes(notes, files);
  const seenBefore = store.lastSeenBefore(decision, meta.revision);

  let compare = null;
  if (revisions.length > 1) {
    let to = Number(opts.to) || meta.revision;
    let from = Number(opts.from) || seenBefore || meta.revision - 1;
    to = Math.min(Math.max(to, 1), meta.revision);
    from = Math.min(Math.max(from, 1), meta.revision);
    if (from === to) from = Math.max(1, to - 1);
    if (from !== to) compare = compareRevisions(store.loadRevision(id, from), store.loadRevision(id, to));
  }

  const lineKeys = new Set();
  files.forEach((f) => f.hunks.forEach((h) => h.lines.forEach((l) => {
    if (l.t === 'del') lineKeys.add(commentKey(f.path, 'old', l.oldNo));
    else if (l.t !== 'meta') lineKeys.add(commentKey(f.path, 'new', l.newNo));
  })));
  const inline = new Map();
  const elsewhere = [];
  for (const c of decision.comments) {
    if (c.kind !== 'line') continue;
    const key = commentKey(c.file, c.side, c.line);
    if (c.revision === meta.revision && lineKeys.has(key)) {
      if (!inline.has(key)) inline.set(key, []);
      inline.get(key).push(c);
    } else elsewhere.push(c);
  }

  return {
    id, meta, decision, revisions, current, files, notes, anchored, compare, seenBefore,
    totals: totals(files), inlineComments: inline, otherLineComments: elsewhere,
    checklist: store.checklistState(decision, meta.revision),
  };
}

// Finds the text of a diff line, so comments keep their context for agents.
function lineContext(id, file, side, line) {
  const meta = store.loadMeta(id);
  const rev = store.loadRevision(id, meta.revision);
  const f = parsePatch(rev.patch).find((x) => x.path === file);
  if (!f) return null;
  for (const h of f.hunks) {
    for (const l of h.lines) {
      if (side === 'old' && l.t === 'del' && l.oldNo === line) return { lineText: l.text, hunk: h.header };
      if (side === 'new' && (l.t === 'add' || l.t === 'ctx') && l.newNo === line) return { lineText: l.text, hunk: h.header };
    }
  }
  return null;
}

module.exports = { loadReviewModel, compareRevisions, commentKey, lineContext };
