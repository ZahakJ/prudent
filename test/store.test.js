'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempHome, addSampleReview } = require('./helpers');

const home = tempHome();
const store = require('../src/store');

test('safeJoin refuses anything outside its base', () => {
  const base = path.join(home, 'reviews');
  assert.equal(store.safeJoin(base, 'a', 'b'), path.join(base, 'a', 'b'));
  for (const bad of ['..', '../x', 'a/../../x', '/etc/passwd', 'a\0b', '']) {
    assert.equal(store.safeJoin(base, bad), null, bad);
  }
  assert.equal(store.safeJoin(base, 'a', '..', '..', 'etc'), null);
});

test('review ids are validated', () => {
  for (const ok of ['a', 'droid-1', 'x.y_z', 'A1']) assert.ok(store.validId(ok), ok);
  for (const bad of ['', '..', '.hidden', '-x', 'a/b', 'a\\b', 'a..b', 'x'.repeat(81), 'a b', '%2e%2e']) {
    assert.ok(!store.validId(bad), bad);
  }
  assert.throws(() => store.reviewDir('../etc'), store.UserError);
  assert.throws(() => store.loadMeta('nope'), /no review/);
});

test('submit, decide, reload: decision.json round trip', () => {
  addSampleReview('round-trip', store);
  assert.throws(() => store.addRevision('round-trip', {}, { create: true }), /already exists/);
  let d = store.loadDecision('round-trip');
  assert.equal(d.status, 'pending');
  assert.equal(d.schema, 1);

  const c1 = store.addComment('round-trip', { kind: 'general', body: '  Looks fine overall.  ' });
  assert.equal(c1.body, 'Looks fine overall.');
  const c2 = store.addComment('round-trip', { kind: 'line', file: 'kestrel/cli.py', side: 'new', line: 10, lineText: 'x', hunk: '@@', body: 'why 3?' });
  assert.throws(() => store.addComment('round-trip', { kind: 'general', body: '   ' }), /empty/);
  store.setChecklist('round-trip', 'understand', true);
  assert.throws(() => store.setChecklist('round-trip', 'bogus', true), /unknown checklist/);
  assert.throws(() => store.setDecision('round-trip', 'pending'), /approved/);
  store.setDecision('round-trip', 'changes_requested', 'Please cap the wait.');

  d = store.loadDecision('round-trip');
  assert.equal(d.status, 'changes_requested');
  assert.equal(d.message, 'Please cap the wait.');
  assert.equal(d.revision, 1);
  assert.ok(!Number.isNaN(Date.parse(d.decidedAt)));
  assert.equal(d.comments.length, 2);
  assert.equal(d.comments[1].file, 'kestrel/cli.py');
  assert.ok(Date.parse(d.comments[0].at));
  assert.equal(store.checklistState(d, 1).find((c) => c.key === 'understand').checked, true);

  const raw = JSON.parse(fs.readFileSync(path.join(home, 'reviews', 'round-trip', 'decision.json'), 'utf8'));
  assert.equal(raw.history.at(-1).status, 'changes_requested');

  store.deleteComment('round-trip', c2.id);
  assert.equal(store.loadDecision('round-trip').comments.length, 1);
  assert.throws(() => store.deleteComment('round-trip', c2.id), /no such comment/);
});

test('resubmit: new revision resets status and checklist, keeps history', () => {
  addSampleReview('resub', store, 'v1');
  store.markSeen('resub', 1);
  store.setChecklist('resub', 'scope', true);
  store.setDecision('resub', 'changes_requested', 'cap it');
  addSampleReview('resub', store, 'v2');
  const meta = store.loadMeta('resub');
  assert.equal(meta.revision, 2);
  const d = store.loadDecision('resub');
  assert.equal(d.status, 'pending');
  assert.deepEqual(d.history.map((h) => h.status), ['changes_requested', 'resubmitted']);
  assert.equal(store.checklistState(d, 2).find((c) => c.key === 'scope').checked, false);
  assert.equal(store.lastSeenBefore(d, 2), 1);
  assert.equal(store.listRevisions('resub').length, 2);
  assert.match(store.loadRevision('resub', 1).notes, /Should there be a cap/);
  assert.throws(() => store.loadRevision('resub', 3), /no revision 3/);
  assert.throws(() => store.markSeen('resub', 9), /bad revision/);
});

test('listReviews skips broken folders', () => {
  fs.mkdirSync(path.join(home, 'reviews', 'broken'), { recursive: true });
  fs.writeFileSync(path.join(home, 'reviews', 'broken', 'meta.json'), '{not json');
  const ids = store.listReviews().map((r) => r.meta.id);
  assert.ok(ids.includes('round-trip'));
  assert.ok(!ids.includes('broken'));
});
