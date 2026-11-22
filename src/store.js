'use strict';

// On-disk layout, under $PRDESK_HOME (default ~/.local/share/prdesk):
//   reviews/<id>/meta.json        title, project, upstream, current revision
//   reviews/<id>/decision.json    the reviewer's status, comments, checklist
//   reviews/<id>/revs/<n>/        info.json, patch.diff, notes.md, commits.json, commits.patch

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const REV_FILES = ['patch.diff', 'notes.md', 'commits.json', 'commits.patch', 'info.json'];
const STATUSES = ['pending', 'approved', 'changes_requested'];
const CHECKLIST = [
  { key: 'understand', label: 'I understand what it does' },
  { key: 'scope', label: 'Scope is right' },
  { key: 'tests', label: 'Tests are believable' },
  { key: 'safe', label: 'Safe to post' },
];
const SCHEMA_VERSION = 1;

class UserError extends Error {}

function home() {
  return path.resolve(process.env.PRDESK_HOME || path.join(os.homedir(), '.local', 'share', 'prdesk'));
}

function reviewsDir() {
  return path.join(home(), 'reviews');
}

function validId(id) {
  return typeof id === 'string' && ID_RE.test(id) && !id.includes('..');
}

// Joins parts under base and refuses anything that resolves outside it.
function safeJoin(base, ...parts) {
  const root = path.resolve(base);
  for (const p of parts) {
    if (typeof p !== 'string' || p === '' || p.includes('\0') || path.isAbsolute(p)) return null;
  }
  const target = path.resolve(root, ...parts);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

function reviewDir(id) {
  if (!validId(id)) throw new UserError(`invalid review id "${id}": use letters, digits, ".", "_" and "-" (max 80)`);
  return safeJoin(reviewsDir(), id);
}

function exists(id) {
  return validId(id) && fs.existsSync(path.join(reviewDir(id), 'meta.json'));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function writeJson(file, obj) {
  writeAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

function now() {
  return new Date().toISOString();
}

function emptyDecision() {
  return {
    schema: SCHEMA_VERSION, status: 'pending', revision: null, decidedAt: null, message: '',
    checklist: {}, comments: [], history: [], seen: [],
  };
}

function loadMeta(id) {
  if (!exists(id)) throw new UserError(`no review "${id}" (see: prdesk list)`);
  return readJson(path.join(reviewDir(id), 'meta.json'));
}

function loadDecision(id) {
  const d = readJson(path.join(reviewDir(id), 'decision.json'), null);
  return d ? { ...emptyDecision(), ...d } : emptyDecision();
}

function saveDecision(id, d) {
  writeJson(path.join(reviewDir(id), 'decision.json'), d);
}

function revDir(id, n) {
  return safeJoin(reviewDir(id), 'revs', String(n));
}

function loadRevision(id, n) {
  const dir = revDir(id, n);
  if (!Number.isInteger(n) || n < 1 || !fs.existsSync(path.join(dir, 'info.json'))) {
    throw new UserError(`review "${id}" has no revision ${n}`);
  }
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
  return {
    info: readJson(path.join(dir, 'info.json')),
    patch: read('patch.diff'),
    notes: read('notes.md'),
    commits: readJson(path.join(dir, 'commits.json'), []),
  };
}

function listRevisions(id) {
  const meta = loadMeta(id);
  const out = [];
  for (let n = 1; n <= meta.revision; n++) {
    const f = path.join(revDir(id, n), 'info.json');
    if (fs.existsSync(f)) out.push(readJson(f));
  }
  return out;
}

// data: { title, project, upstream, patch, notes, commits, commitsPatch, info }
function addRevision(id, data, { create }) {
  const dir = reviewDir(id);
  const metaFile = path.join(dir, 'meta.json');
  let meta;
  if (create) {
    if (fs.existsSync(metaFile)) throw new UserError(`review "${id}" already exists; use: prdesk resubmit ${id} ...`);
    meta = { schema: SCHEMA_VERSION, id, createdAt: now(), revision: 0 };
  } else {
    meta = loadMeta(id);
  }
  const n = meta.revision + 1;
  const rdir = revDir(id, n);
  fs.mkdirSync(rdir, { recursive: true, mode: 0o700 });
  const info = { ...data.info, revision: n, createdAt: now() };
  writeAtomic(path.join(rdir, 'patch.diff'), data.patch);
  writeAtomic(path.join(rdir, 'notes.md'), data.notes || '');
  writeJson(path.join(rdir, 'commits.json'), data.commits || []);
  if (data.commitsPatch) writeAtomic(path.join(rdir, 'commits.patch'), data.commitsPatch);
  writeJson(path.join(rdir, 'info.json'), info);
  for (const k of ['title', 'project', 'upstream']) if (data[k] != null && data[k] !== '') meta[k] = data[k];
  meta.title = meta.title || id;
  meta.revision = n;
  meta.updatedAt = info.createdAt;
  writeJson(metaFile, meta);

  const d = loadDecision(id);
  if (!create || d.history.length) {
    d.history.push({ status: 'resubmitted', revision: n, at: info.createdAt, message: info.message || '' });
  }
  d.status = 'pending';
  d.revision = n;
  d.decidedAt = null;
  d.message = '';
  saveDecision(id, d);
  return { meta, info };
}

function listReviews() {
  const dir = reviewsDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!exists(name)) continue;
    try {
      const meta = loadMeta(name);
      const decision = loadDecision(name);
      const info = readJson(path.join(revDir(name, meta.revision), 'info.json'), {});
      out.push({ meta, decision, info });
    } catch {
      // A half-written or hand-edited review should not hide the others.
    }
  }
  return out.sort((a, b) => String(b.meta.updatedAt).localeCompare(String(a.meta.updatedAt)));
}

function newCommentId() {
  return crypto.randomBytes(6).toString('hex');
}

function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/\r\n?/g, '\n').slice(0, max).trim();
}

function addComment(id, c) {
  const meta = loadMeta(id);
  const d = loadDecision(id);
  const body = cleanText(c.body, 20000);
  if (!body) throw new UserError('comment is empty');
  const comment = { id: newCommentId(), kind: c.kind === 'line' ? 'line' : 'general', revision: meta.revision, at: now(), body };
  if (comment.kind === 'line') {
    for (const k of ['file', 'side', 'line', 'lineText', 'hunk']) if (c[k] != null) comment[k] = c[k];
  }
  d.comments.push(comment);
  saveDecision(id, d);
  return comment;
}

function deleteComment(id, commentId) {
  const d = loadDecision(id);
  const before = d.comments.length;
  d.comments = d.comments.filter((c) => c.id !== commentId);
  if (d.comments.length === before) throw new UserError('no such comment');
  saveDecision(id, d);
}

function setChecklist(id, key, checked) {
  if (!CHECKLIST.some((c) => c.key === key)) throw new UserError(`unknown checklist item "${key}"`);
  const meta = loadMeta(id);
  const d = loadDecision(id);
  d.checklist[key] = { checked: !!checked, at: now(), revision: meta.revision };
  saveDecision(id, d);
  return d.checklist[key];
}

function setDecision(id, status, message) {
  if (!STATUSES.includes(status) || status === 'pending') throw new UserError(`status must be "approved" or "changes_requested"`);
  const meta = loadMeta(id);
  const d = loadDecision(id);
  const at = now();
  d.status = status;
  d.revision = meta.revision;
  d.decidedAt = at;
  d.message = cleanText(message, 20000);
  d.history.push({ status, revision: meta.revision, at, message: d.message });
  saveDecision(id, d);
  return d;
}

function markSeen(id, revision) {
  const meta = loadMeta(id);
  const n = Number(revision);
  if (!Number.isInteger(n) || n < 1 || n > meta.revision) throw new UserError('bad revision');
  const d = loadDecision(id);
  const last = d.seen[d.seen.length - 1];
  if (!last || last.revision !== n) {
    d.seen.push({ revision: n, at: now() });
    saveDecision(id, d);
  }
}

// Highest revision the reviewer had opened before the current one.
function lastSeenBefore(decision, current) {
  const seen = decision.seen.map((s) => s.revision).filter((r) => r < current);
  return seen.length ? Math.max(...seen) : null;
}

function checklistState(decision, revision) {
  return CHECKLIST.map((c) => {
    const s = decision.checklist[c.key];
    return { ...c, checked: !!(s && s.checked && s.revision === revision), at: s && s.revision === revision ? s.at : null };
  });
}

module.exports = {
  SCHEMA_VERSION, CHECKLIST, STATUSES, REV_FILES, UserError,
  home, reviewsDir, reviewDir, revDir, safeJoin, validId, exists,
  loadMeta, loadDecision, saveDecision, loadRevision, listRevisions, addRevision, listReviews,
  addComment, deleteComment, setChecklist, setDecision, markSeen, lastSeenBefore, checklistState,
  writeJson, readJson,
};
