'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parsePatch } = require('../src/patch');
const { parseNotes, anchorNotes, lintNotes, parseAnchor } = require('../src/notes');

const dir = path.join(__dirname, '..', 'samples', 'demo');
const files = parsePatch(fs.readFileSync(path.join(dir, 'v2.patch'), 'utf8'));
const notesMd = fs.readFileSync(path.join(dir, 'notes-v2.md'), 'utf8');

test('sections are found by title, case and wording tolerant', () => {
  const n = parseNotes(notesMd);
  for (const k of ['summary', 'background', 'walkthrough', 'risks', 'tested', 'questions', 'rules', 'prDescription']) {
    assert.ok(n.sections[k], `missing ${k}`);
  }
  assert.deepEqual(n.missing, []);
  const loose = parseNotes('# summary:\n\nx\n\n# Testing\n\ny\n\n# Extra thoughts\n\nz');
  assert.equal(loose.sections.summary.body, 'x');
  assert.equal(loose.sections.tested.body, 'y');
  assert.equal(loose.extras[0].title, 'Extra thoughts');
  assert.ok(loose.missing.includes('Risks'));
});

test('headings inside code fences do not split sections', () => {
  const n = parseNotes('# Summary\n\n```sh\n# not a heading\n```\n\nafter\n\n# Risks\n\nnone');
  assert.match(n.sections.summary.body, /# not a heading/);
  assert.match(n.sections.summary.body, /after/);
  assert.equal(n.sections.risks.body, 'none');
});

test('anchor syntax', () => {
  assert.deepEqual(parseAnchor('@@ -1,12 +1,46 @@'), { kind: 'hunk', oldStart: 1, newStart: 1, text: '' });
  assert.deepEqual(parseAnchor('@@ -10,6 +12,8 @@ def main():'), { kind: 'hunk', oldStart: 10, newStart: 12, text: 'def main():' });
  assert.deepEqual(parseAnchor('@@ class Item'), { kind: 'hunk', text: 'class Item' });
  assert.deepEqual(parseAnchor('lines 120-140'), { kind: 'lines', from: 120, to: 140 });
  assert.deepEqual(parseAnchor('lines 5–9'), { kind: 'lines', from: 5, to: 9 });
  assert.deepEqual(parseAnchor('line 7'), { kind: 'lines', from: 7, to: 7 });
  assert.equal(parseAnchor('Why a loop').kind, 'text');
});

test('walkthrough notes land on the right files, hunks and lines', () => {
  const a = anchorNotes(parseNotes(notesMd), files);
  assert.match(a.general, /heart of the change/);
  assert.deepEqual(a.unplaced, []);
  const fi = files.findIndex((f) => f.path === 'kestrel/fetch.py');
  const slot = a.files[fi];
  assert.equal(slot.loose.length, 0);
  assert.equal(slot.spots.length, 3);
  const [byHeader, retryAfter, loop] = slot.spots;
  assert.equal(byHeader.hunk, 0);
  assert.equal(byHeader.line, -1);
  const lines = files[fi].hunks[0].lines;
  // "lines 15-21": the note sits above the first line numbered 15 or more on the new side.
  assert.equal(lines[retryAfter.line].newNo, 15);
  assert.equal(lines[loop.line].newNo, 31);
  // Files with only an intro.
  const cli = files.findIndex((f) => f.path === 'kestrel/cli.py');
  assert.match(a.files[cli].intro[0].body, /--retries/);
  // Note ids are unique.
  const ids = a.files.flatMap((s) => [...s.intro, ...s.spots, ...s.loose]).map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('section-text and content anchors, suffix paths, unmatched anchors', () => {
  const diff = [
    'diff --git a/src/app/Main.kt b/src/app/Main.kt',
    '--- a/src/app/Main.kt',
    '+++ b/src/app/Main.kt',
    '@@ -10,3 +10,4 @@ class Main {',
    ' a',
    '+b',
    ' c',
    ' d',
    '@@ -40,2 +41,3 @@ fun helper() {',
    ' x',
    '+val retries = 3',
    ' y',
  ].join('\n');
  const f = parsePatch(diff);
  const md = [
    '# Walkthrough', '',
    '## `Main.kt`', '', 'intro', '',
    '### @@ fun helper', '', 'on helper', '',
    '### @@ val retries', '', 'on a line', '',
    '### @@ nothing like this', '', 'lost', '',
    '### lines 900-910', '', 'out of range', '',
    '## src/Other.kt', '', 'not in diff',
  ].join('\n');
  const a = anchorNotes(parseNotes(md), f);
  const s = a.files[0];
  assert.equal(s.intro[0].body, 'intro');
  assert.equal(s.spots[0].hunk, 1);
  assert.equal(s.spots[0].line, -1);
  assert.equal(s.spots[1].hunk, 1);
  assert.equal(f[0].hunks[1].lines[s.spots[1].line].text, 'val retries = 3');
  assert.deepEqual(s.loose.map((l) => l.body), ['lost', 'out of range']);
  assert.equal(a.unplaced[0].path, 'src/Other.kt');

  const warnings = lintNotes(parseNotes(md), f);
  assert.ok(warnings.some((w) => w.includes('nothing like this')));
  assert.ok(warnings.some((w) => w.includes('src/Other.kt')));
  assert.ok(warnings.some((w) => w.startsWith('missing or empty section: # Summary')));
});

test('the bundled sample notes lint clean', () => {
  assert.deepEqual(lintNotes(parseNotes(notesMd), files), []);
});

test('the example in WRITING-NOTES.md is the bundled sample', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'WRITING-NOTES.md'), 'utf8');
  const example = doc.split('````markdown\n')[1].split('\n````')[0];
  assert.equal(example.trim(), notesMd.trim());
});
