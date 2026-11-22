'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { samplePath } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'prudent');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prudent-cli-'));

function prudent(...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, PRUDENT_HOME: home }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function hasGit() {
  return spawnSync('git', ['--version']).status === 0;
}

test('help and misuse give clear messages', () => {
  assert.match(prudent('--help').out, /Agent commands/);
  assert.match(prudent('help', 'submit').out, /--repo/);
  assert.match(prudent('status', '--help').out, /prudent\.status\/v1/);
  let r = prudent('frobnicate');
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command "frobnicate"/);
  r = prudent('submit', '--bogus');
  assert.equal(r.code, 2);
  assert.match(r.err, /Unknown option '--bogus'[\s\S]*prudent help submit/);
  r = prudent('submit', '--title', 'x');
  assert.match(r.err, /--repo <path>.*or --patch/);
  r = prudent('submit', '--patch', 'nope.patch');
  assert.match(r.err, /cannot read patch "nope.patch": no such file/);
  r = prudent('status', 'nope');
  assert.match(r.err, /no review "nope"/);
  r = prudent('submit', '--patch', samplePath('v1.patch'), '--upstream', 'ftp://x');
  assert.match(r.err, /--upstream must be an http/);
});

test('submit a patch, status text and JSON, resubmit', () => {
  let r = prudent('submit', '--patch', samplePath('v1.patch'), '--notes', samplePath('notes-v1.md'), '--project', 'Kestrel', '--id', 'k1');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Submitted k1 revision 1: 7 file\(s\), \+75 -7/);
  assert.doesNotMatch(r.out, /Notes warnings/);
  r = prudent('submit', '--patch', samplePath('v1.patch'), '--id', 'k1');
  assert.match(r.err, /already exists; use: prudent resubmit k1/);

  r = prudent('status', 'k1');
  assert.equal(r.code, 11);
  assert.match(r.out, /Status: PENDING \(revision 1\)/);

  r = prudent('status', 'k1', '--json');
  const s = JSON.parse(r.out);
  assert.equal(s.schema, 'prudent.status/v1');
  assert.equal(s.title, 'fetch: retry transient failures with exponential backoff');
  assert.deepEqual(Object.keys(s), ['schema', 'id', 'title', 'project', 'upstream', 'revision', 'status', 'decidedRevision', 'decidedAt', 'message', 'seenRevision', 'checklist', 'comments', 'history', 'url']);

  process.env.PRUDENT_HOME = home;
  const store = require('../src/store');
  store.addComment('k1', { kind: 'line', file: 'kestrel/cli.py', side: 'new', line: 10, lineText: '    parser.add_argument("--retries")', body: 'Default of 3?' });
  store.setDecision('k1', 'changes_requested', 'Cap the wait.');
  r = prudent('status', 'k1');
  assert.equal(r.code, 10);
  assert.match(r.out, /CHANGES REQUESTED/);
  assert.match(r.out, /kestrel\/cli\.py:10/);
  assert.match(r.out, /> {5}parser\.add_argument/);
  assert.match(r.out, /Cap the wait\./);

  r = prudent('resubmit', 'k1', '--patch', samplePath('v2.patch'), '--notes', samplePath('notes-v2.md'), '-m', 'capped');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Resubmitted k1 revision 2/);
  r = prudent('status', 'k1', '--json');
  const s2 = JSON.parse(r.out);
  assert.equal(s2.status, 'pending');
  assert.equal(s2.revision, 2);
  assert.equal(s2.comments[0].revision, 1);

  r = prudent('resubmit', 'k1');
  assert.match(r.err, /came from a patch file; pass --patch/);

  r = prudent('list', '--json');
  assert.equal(JSON.parse(r.out)[0].id, 'k1');
});

test('check reports bad anchors with exit code 1', () => {
  const notes = path.join(home, 'bad-notes.md');
  fs.writeFileSync(notes, '# Summary\n\nx\n\n# Walkthrough\n\n## nowhere.py\n\ny\n');
  const r = prudent('check', '--notes', notes, '--patch', samplePath('v1.patch'));
  assert.equal(r.code, 1);
  assert.match(r.out, /walkthrough file not in the diff: ## nowhere\.py/);
  assert.match(r.out, /missing or empty section: # Risks/);
});

test('demo creates a two-revision review', () => {
  const r = prudent('demo');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /demo-kestrel-retries/);
  const s = JSON.parse(prudent('status', 'demo-kestrel-retries', '--json').out);
  assert.equal(s.revision, 2);
  assert.equal(s.history[0].status, 'changes_requested');
});

test('submit from a git repository', { skip: !hasGit() && 'git not installed' }, () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prudent-repo-'));
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  git('checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n2\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
  git('add', '.');
  git('commit', '-qm', 'feature: change a, add b', '-m', 'Body line.');
  git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'c.txt'), 'main moved on\n');
  git('add', '.');
  git('commit', '-qm', 'unrelated');

  let r = prudent('submit', '--repo', repo, '--base', 'main', '--head', 'feature', '--id', 'g1', '--json');
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.deepEqual(out.stats, { files: 2, additions: 2, deletions: 1 });
  process.env.PRUDENT_HOME = home;
  const store = require('../src/store');
  const rev = store.loadRevision('g1', 1);
  assert.equal(rev.info.branch, 'feature');
  assert.equal(rev.commits.length, 1);
  assert.equal(rev.commits[0].subject, 'feature: change a, add b');
  assert.equal(rev.commits[0].body, 'Body line.');
  assert.doesNotMatch(rev.patch, /c\.txt/, 'diff is from the merge-base, so main\'s own commits are left out');

  r = prudent('submit', '--repo', repo, '--base', 'main', '--head', 'nope');
  assert.match(r.err, /"nope" is not a commit/);
  r = prudent('submit', '--repo', home);
  assert.match(r.err, /not a git repository/);
});
