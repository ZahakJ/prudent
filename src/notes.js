'use strict';

// Notes are Markdown with fixed top-level sections (see WRITING-NOTES.md).
// The Walkthrough section is split per file (## path) and per anchor
// (### @@ hunk header, ### lines A-B), then matched to the parsed diff.

const SECTIONS = [
  { key: 'summary', title: 'Summary', required: true },
  { key: 'background', title: 'How the project works (just enough)', required: true },
  { key: 'walkthrough', title: 'Walkthrough', required: true },
  { key: 'risks', title: 'Risks', required: true },
  { key: 'tested', title: 'What was tested', required: true },
  { key: 'questions', title: 'Questions for the reviewer', required: true },
  { key: 'rules', title: 'Upstream rules checked', required: true },
  { key: 'prDescription', title: 'PR description', required: false },
];

function sectionKey(title) {
  const t = title.toLowerCase().replace(/[`*_:]/g, '').replace(/\s+/g, ' ').trim();
  if (t.startsWith('summary')) return 'summary';
  if (t.startsWith('how the project works') || t === 'background') return 'background';
  if (t.startsWith('walkthrough')) return 'walkthrough';
  if (t.startsWith('risk')) return 'risks';
  if (t.startsWith('what was tested') || t === 'testing' || t === 'tests') return 'tested';
  if (t.startsWith('questions')) return 'questions';
  if (t.startsWith('upstream rules')) return 'rules';
  if (t.startsWith('pr description')) return 'prDescription';
  return null;
}

function splitByHeading(md, level) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const re = new RegExp(`^ {0,3}#{${level}}(?!#)[ \\t]+(.*?)[ \\t]*$`);
  let fence = null;
  const pre = [];
  const parts = [];
  let cur = null;
  for (const line of lines) {
    const fm = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fm) {
      if (!fence) fence = fm[1];
      else if (fm[1][0] === fence[0] && fm[1].length >= fence.length && !fm[2].trim()) fence = null;
    } else if (!fence) {
      const m = line.match(re);
      if (m) {
        cur = { title: m[1].replace(/[ \t]+#+$/, '').trim(), lines: [] };
        parts.push(cur);
        continue;
      }
    }
    (cur ? cur.lines : pre).push(line);
  }
  return {
    preamble: pre.join('\n').trim(),
    parts: parts.map((p) => ({ title: p.title, body: p.lines.join('\n').trim() })),
  };
}

function parseAnchor(title) {
  const t = title.replace(/`/g, '').trim();
  let m = t.match(/^lines?\s+(\d+)\s*(?:-|–|—|to|\.\.)\s*(\d+)/i);
  if (m) return { kind: 'lines', from: +m[1], to: Math.max(+m[1], +m[2]) };
  m = t.match(/^lines?\s+(\d+)\b/i);
  if (m) return { kind: 'lines', from: +m[1], to: +m[1] };
  if (t.startsWith('@@')) {
    const inner = t.replace(/^@@\s*/, '');
    const r = inner.match(/^-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*(?:@@)?\s*(.*)$/);
    if (r) return { kind: 'hunk', oldStart: +r[1], newStart: +r[2], text: r[3].trim() };
    return { kind: 'hunk', text: inner.replace(/\s*@@\s*/, ' ').trim() };
  }
  return { kind: 'text' };
}

function cleanPath(heading) {
  return heading
    .replace(/`/g, '')
    .trim()
    .replace(/\s+\((?:new|added|deleted|removed|renamed|moved|modified|binary)[^)]*\)$/i, '')
    .replace(/^\.\//, '')
    .trim();
}

function parseWalkthrough(body) {
  const { preamble, parts } = splitByHeading(body, 2);
  const files = parts.map((p) => {
    const sub = splitByHeading(p.body, 3);
    const intro = [sub.preamble];
    const anchors = [];
    for (const a of sub.parts) {
      const anchor = parseAnchor(a.title);
      if (anchor.kind === 'text') intro.push(`### ${a.title}\n\n${a.body}`);
      else anchors.push({ ...anchor, title: a.title, body: a.body });
    }
    return { heading: p.title, path: cleanPath(p.title), intro: intro.filter((s) => s.trim()).join('\n\n'), anchors };
  });
  return { preamble, files };
}

function parseNotes(md) {
  const { preamble, parts } = splitByHeading(md, 1);
  const sections = {};
  const extras = [];
  for (const p of parts) {
    const key = sectionKey(p.title);
    if (key && !(key in sections)) sections[key] = { title: p.title, body: p.body };
    else extras.push(p);
  }
  const missing = SECTIONS.filter((s) => s.required && !(sections[s.key] && sections[s.key].body.trim())).map((s) => s.title);
  return {
    preamble, sections, extras, missing,
    walkthrough: parseWalkthrough(sections.walkthrough ? sections.walkthrough.body : ''),
  };
}

function matchFile(p, files) {
  if (!p) return -1;
  const exact = files.findIndex((f) => f.path === p || f.newPath === p || f.oldPath === p);
  if (exact >= 0) return exact;
  const bySuffix = files.map((f, i) => (f.path.endsWith('/' + p) ? i : -1)).filter((i) => i >= 0);
  if (bySuffix.length === 1) return bySuffix[0];
  return -1;
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

function hunkRange(file, h) {
  return file.status === 'deleted'
    ? [h.oldStart, h.oldStart + Math.max(h.oldLines, 1) - 1]
    : [h.newStart, h.newStart + Math.max(h.newLines, 1) - 1];
}

// Returns { hunk, line } where line is the index inside hunk.lines the note
// goes above, or -1 for above the hunk header. hunk -1 means no match.
function matchAnchor(a, file, claimed) {
  const pick = (cands) => cands.find((c) => !claimed.has(c.hunk)) || cands[0];
  if (a.kind === 'hunk') {
    if (a.newStart != null) {
      const i = file.hunks.findIndex((h) => h.oldStart === a.oldStart && h.newStart === a.newStart);
      if (i >= 0) return { hunk: i, line: -1 };
    }
    const t = norm(a.text);
    if (!t) return { hunk: -1 };
    const bySection = [];
    file.hunks.forEach((h, i) => {
      const s = norm(h.section);
      if (s && (s.includes(t) || t.includes(s))) bySection.push({ hunk: i, line: -1 });
    });
    if (bySection.length) return pick(bySection);
    const byLine = [];
    file.hunks.forEach((h, i) => {
      const li = h.lines.findIndex((l) => l.t !== 'meta' && norm(l.text).includes(t));
      if (li >= 0) byLine.push({ hunk: i, line: li });
    });
    if (byLine.length) return pick(byLine);
    return { hunk: -1 };
  }
  if (a.kind === 'lines') {
    const side = file.status === 'deleted' ? 'oldNo' : 'newNo';
    for (let i = 0; i < file.hunks.length; i++) {
      const [lo, hi] = hunkRange(file, file.hunks[i]);
      if (a.to < lo || a.from > hi) continue;
      const lines = file.hunks[i].lines;
      let li = lines.findIndex((l) => l[side] != null && l[side] >= a.from);
      if (li <= 0) li = -1;
      else while (li > 0 && lines[li - 1][side] == null && lines[li - 1].t !== 'meta') li--;
      return { hunk: i, line: li };
    }
  }
  return { hunk: -1 };
}

// Places walkthrough notes onto files and hunks.
// Result: { general, files: [{ intro: [md], spots: [{hunk, line, label, body, id}], loose: [...] }], unplaced: [...] }
function anchorNotes(notes, files) {
  const placed = files.map(() => ({ intro: [], spots: [], loose: [] }));
  const unplaced = [];
  let n = 0;
  for (const wf of notes.walkthrough.files) {
    const fi = matchFile(wf.path, files);
    if (fi < 0) {
      const body = [wf.intro, ...wf.anchors.map((a) => `### ${a.title}\n\n${a.body}`)].filter(Boolean).join('\n\n');
      unplaced.push({ path: wf.path, body, id: `note-${n++}` });
      continue;
    }
    const slot = placed[fi];
    if (wf.intro) slot.intro.push({ body: wf.intro, id: `note-${n++}` });
    const claimed = new Set();
    for (const a of wf.anchors) {
      const at = matchAnchor(a, files[fi], claimed);
      const item = { label: a.title, body: a.body, id: `note-${n++}` };
      if (at.hunk < 0) slot.loose.push(item);
      else {
        claimed.add(at.hunk);
        slot.spots.push({ ...item, hunk: at.hunk, line: at.line });
      }
    }
  }
  return { general: notes.walkthrough.preamble, files: placed, unplaced };
}

function lintNotes(notes, files) {
  const warnings = [];
  for (const m of notes.missing) warnings.push(`missing or empty section: # ${m}`);
  const anchored = anchorNotes(notes, files);
  for (const u of anchored.unplaced) warnings.push(`walkthrough file not in the diff: ## ${u.path}`);
  anchored.files.forEach((slot, i) => {
    for (const l of slot.loose) warnings.push(`anchor not found in ${files[i].path}: ### ${l.label}`);
  });
  const covered = anchored.files.filter((s) => s.intro.length || s.spots.length || s.loose.length).length;
  if (files.length && covered < files.length) {
    const without = files.filter((_, i) => !anchored.files[i].intro.length && !anchored.files[i].spots.length && !anchored.files[i].loose.length);
    warnings.push(`no walkthrough notes for ${without.length} file(s): ${without.map((f) => f.path).join(', ')}`);
  }
  return warnings;
}

module.exports = { SECTIONS, parseNotes, anchorNotes, lintNotes, splitByHeading, parseAnchor, matchFile };
