'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parsePatch, parseMbox, totals, unquote } = require('../src/patch');

const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'demo', 'v1.patch'), 'utf8');

test('multi-file format-patch: statuses, counts, line numbers', () => {
  const files = parsePatch(sample);
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.deepEqual(files.map((f) => f.path), [
    'README.md', 'docs/NOTES.txt', 'docs/retry-diagram.png', 'kestrel/cli.py', 'kestrel/fetch.py',
    'tests/test_feed_parse.py', 'tests/test_fetch.py',
  ]);
  assert.equal(by['README.md'].status, 'modified');
  assert.equal(by['README.md'].additions, 5);
  assert.equal(by['docs/NOTES.txt'].status, 'deleted');
  assert.equal(by['docs/NOTES.txt'].newPath, null);
  assert.equal(by['docs/NOTES.txt'].deletions, 1);
  assert.equal(by['tests/test_fetch.py'].status, 'added');
  assert.equal(by['tests/test_fetch.py'].oldPath, null);
  assert.equal(by['tests/test_fetch.py'].hunks[0].lines[0].newNo, 1);

  const cli = by['kestrel/cli.py'];
  assert.equal(cli.hunks.length, 1);
  const h = cli.hunks[0];
  assert.equal(h.oldStart, 7);
  assert.equal(h.newStart, 7);
  assert.equal(h.section, 'from .parse import parse_feed');
  const added = h.lines.find((l) => l.t === 'add');
  assert.equal(added.newNo, 10);
  const removed = h.lines.find((l) => l.t === 'del');
  assert.equal(removed.oldNo, 11);
  assert.deepEqual(totals(files), { files: 7, additions: 75, deletions: 7 });
});

test('renames without content change', () => {
  const r = parsePatch(sample).find((f) => f.status === 'renamed');
  assert.equal(r.oldPath, 'tests/test_parse.py');
  assert.equal(r.newPath, 'tests/test_feed_parse.py');
  assert.equal(r.similarity, 100);
  assert.equal(r.hunks.length, 0);
});

test('rename with edits keeps hunks', () => {
  const diff = [
    'diff --git a/old/name.js b/new/name.js',
    'similarity index 80%',
    'rename from old/name.js',
    'rename to new/name.js',
    'index 1111111..2222222 100644',
    '--- a/old/name.js',
    '+++ b/new/name.js',
    '@@ -1,2 +1,2 @@',
    ' a',
    '-b',
    '+c',
  ].join('\n');
  const [f] = parsePatch(diff);
  assert.equal(f.status, 'renamed');
  assert.equal(f.path, 'new/name.js');
  assert.equal(f.oldPath, 'old/name.js');
  assert.equal(f.similarity, 80);
  assert.equal(f.additions, 1);
  assert.equal(f.deletions, 1);
});

test('binary files: GIT binary patch and "Binary files differ"', () => {
  const png = parsePatch(sample).find((f) => f.path === 'docs/retry-diagram.png');
  assert.equal(png.binary, true);
  assert.equal(png.status, 'added');
  assert.equal(png.hunks.length, 0);

  const diff = [
    'diff --git a/img/logo.png b/img/logo.png',
    'index 1111111..2222222 100644',
    'Binary files a/img/logo.png and b/img/logo.png differ',
    'diff --git a/x.txt b/x.txt',
    'index 1..2 100644',
    '--- a/x.txt',
    '+++ b/x.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n');
  const files = parsePatch(diff);
  assert.equal(files.length, 2);
  assert.equal(files[0].binary, true);
  assert.equal(files[0].status, 'modified');
  assert.equal(files[1].hunks[0].oldLines, 1);
  assert.equal(files[1].additions, 1);

  const deleted = parsePatch('Binary files a/gone.bin and /dev/null differ\n');
  assert.equal(deleted[0].status, 'deleted');
  assert.equal(deleted[0].path, 'gone.bin');
});

test('lines that look like headers inside a hunk stay content', () => {
  const diff = [
    'diff --git a/notes.txt b/notes.txt',
    '--- a/notes.txt',
    '+++ b/notes.txt',
    '@@ -1,3 +1,3 @@',
    '--- a/not-a-header',
    '+++ b/not-a-header',
    ' diff --git looks like a header',
    '-x',
    '+y',
  ].join('\n');
  // Counts say 3 old (two "-" lines and the context) and 3 new.
  const files = parsePatch(diff.replace('@@ -1,3 +1,3 @@', '@@ -1,3 +1,3 @@'));
  assert.equal(files.length, 1);
  const lines = files[0].hunks[0].lines;
  assert.equal(lines[0].t, 'del');
  assert.equal(lines[0].text, '-- a/not-a-header');
  assert.equal(lines[1].t, 'add');
  assert.equal(lines[2].t, 'ctx');
});

test('no newline at end of file, mode changes, plain diff -u', () => {
  const diff = [
    'diff --git a/run.sh b/run.sh',
    'old mode 100644',
    'new mode 100755',
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-one',
    '\\ No newline at end of file',
    '+two',
    '\\ No newline at end of file',
  ].join('\n');
  const files = parsePatch(diff);
  assert.equal(files[0].modeChanged, true);
  assert.equal(files[0].newMode, '100755');
  assert.deepEqual(files[1].hunks[0].lines.map((l) => l.t), ['del', 'meta', 'add', 'meta']);

  const plain = parsePatch('--- src/a.c\t2026-01-01\n+++ src/a.c\t2026-01-02\n@@ -1,1 +1,2 @@\n x\n+y\n');
  assert.equal(plain[0].path, 'src/a.c');
  assert.equal(plain[0].additions, 1);
});

test('quoted paths with spaces and UTF-8', () => {
  assert.equal(unquote('"caf\\303\\251 menu.txt"'), 'café menu.txt');
  const diff = [
    'diff --git "a/my file.txt" "b/my file.txt"',
    'new file mode 100644',
    '--- /dev/null',
    '+++ "b/my file.txt"',
    '@@ -0,0 +1 @@',
    '+hi',
  ].join('\n');
  const [f] = parsePatch(diff);
  assert.equal(f.path, 'my file.txt');
  assert.equal(f.status, 'added');
});

test('CRLF input and empty input', () => {
  assert.deepEqual(parsePatch(''), []);
  const [f] = parsePatch('--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n');
  assert.equal(f.hunks[0].lines[1].text, 'b');
});

test('mbox commit messages', () => {
  const [c] = parseMbox(sample);
  assert.equal(c.subject, 'fetch: retry transient failures with exponential backoff');
  assert.match(c.author, /Sample Agent/);
  assert.match(c.body, /^Busy feed servers/);
  assert.doesNotMatch(c.body, /README\.md/);
  assert.deepEqual(parseMbox('diff --git a/x b/x\n'), []);
});
