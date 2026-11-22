'use strict';

// Parser for unified diffs as produced by `git diff`, `git format-patch` and
// plain `diff -u`. Handles several files, renames, copies, mode changes,
// binary files, new and deleted files, quoted paths and "\ No newline".

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function unquote(s) {
  if (!(s.length >= 2 && s[0] === '"' && s.endsWith('"'))) return s;
  const chars = Array.from(s.slice(1, -1));
  const bytes = [];
  const named = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c !== '\\') {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
      continue;
    }
    const n = chars[++i];
    if (n === undefined) break;
    if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(chars[i + 1] || '')) oct += chars[++i];
      bytes.push(parseInt(oct, 8) & 0xff);
    } else if (n in named) bytes.push(named[n]);
    else for (const b of Buffer.from(n, 'utf8')) bytes.push(b);
  }
  return Buffer.from(bytes).toString('utf8');
}

function quoteEnd(s) {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '"') return i;
  }
  return s.length - 1;
}

function stripPrefix(p) {
  if (p == null || p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

function headerPath(rest) {
  if (rest.startsWith('"')) return unquote(rest.slice(0, quoteEnd(rest) + 1));
  const tab = rest.indexOf('\t');
  return tab >= 0 ? rest.slice(0, tab) : rest;
}

function gitHeaderPaths(rest) {
  if (rest.startsWith('"')) {
    const e = quoteEnd(rest);
    const b = rest.slice(e + 1).trim();
    return [unquote(rest.slice(0, e + 1)), b.startsWith('"') ? unquote(b) : b];
  }
  const qi = rest.indexOf(' "');
  if (qi >= 0 && rest.endsWith('"')) return [rest.slice(0, qi), unquote(rest.slice(qi + 1))];
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === ' ') {
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (a.slice(2) === b.slice(2)) return [a, b];
  }
  const k = rest.lastIndexOf(' b/');
  if (k >= 0) return [rest.slice(0, k), rest.slice(k + 1)];
  const sp = rest.indexOf(' ');
  return sp >= 0 ? [rest.slice(0, sp), rest.slice(sp + 1)] : [rest, rest];
}

function newFile(oldPath, newPath, fromGit) {
  return {
    oldPath, newPath, path: newPath || oldPath, status: 'modified', binary: false,
    oldMode: null, newMode: null, similarity: null, additions: 0, deletions: 0, hunks: [],
    _git: fromGit, _paths: false,
  };
}

function parsePatch(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const files = [];
  let f = null;
  let h = null;
  let remOld = 0;
  let remNew = 0;
  let oldNo = 0;
  let newNo = 0;
  let inBinary = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (h && (remOld > 0 || remNew > 0)) {
      const c = line[0];
      if (c === '+' && remNew > 0) {
        h.lines.push({ t: 'add', text: line.slice(1), newNo: newNo++ });
        remNew--; f.additions++;
        continue;
      }
      if (c === '-' && remOld > 0) {
        h.lines.push({ t: 'del', text: line.slice(1), oldNo: oldNo++ });
        remOld--; f.deletions++;
        continue;
      }
      if ((c === ' ' || line === '') && remOld > 0 && remNew > 0) {
        h.lines.push({ t: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
        remOld--; remNew--;
        continue;
      }
      if (c === '\\') { h.lines.push({ t: 'meta', text: line }); continue; }
      h = null;
    }
    if (h && line.startsWith('\\')) { h.lines.push({ t: 'meta', text: line }); continue; }
    h = null;
    if (inBinary) {
      if (!line.startsWith('diff --git ')) continue;
      inBinary = false;
    }
    let m;
    if (line.startsWith('diff --git ')) {
      const [a, b] = gitHeaderPaths(line.slice(11));
      f = newFile(stripPrefix(a), stripPrefix(b), true);
      files.push(f);
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const a = stripPrefix(headerPath(lines[i].slice(4)));
      const b = stripPrefix(headerPath(lines[i + 1].slice(4)));
      if (!f || !f._git || f.hunks.length || f._paths) {
        f = newFile(a, b, false);
        files.push(f);
      }
      f._paths = true;
      if (a === null) { f.status = 'added'; f.oldPath = null; } else f.oldPath = a;
      if (b === null) { f.status = 'deleted'; f.newPath = null; } else f.newPath = b;
      i++;
      continue;
    }
    if ((m = line.match(/^Binary files (.+) and (.+) differ$/))) {
      const a = stripPrefix(headerPath(m[1]));
      const b = stripPrefix(headerPath(m[2]));
      if (!f || !f._git || f.hunks.length || f.binary) {
        f = newFile(a, b, false);
        files.push(f);
      }
      f.binary = true;
      if (a === null) { f.status = 'added'; f.oldPath = null; }
      if (b === null) { f.status = 'deleted'; f.newPath = null; }
      continue;
    }
    if (!f) continue;
    if ((m = line.match(HUNK))) {
      h = {
        header: line, oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], section: (m[5] || '').trim(), lines: [],
      };
      f.hunks.push(h);
      remOld = h.oldLines; remNew = h.newLines; oldNo = h.oldStart; newNo = h.newStart;
      continue;
    }
    if (f.hunks.length || !f._git) continue;
    if ((m = line.match(/^new file mode (\d+)/))) { f.status = 'added'; f.newMode = m[1]; f.oldPath = null; }
    else if ((m = line.match(/^deleted file mode (\d+)/))) { f.status = 'deleted'; f.oldMode = m[1]; f.newPath = null; }
    else if ((m = line.match(/^old mode (\d+)/))) f.oldMode = m[1];
    else if ((m = line.match(/^new mode (\d+)/))) f.newMode = m[1];
    else if ((m = line.match(/^similarity index (\d+)%/))) f.similarity = +m[1];
    else if ((m = line.match(/^rename from (.+)$/))) { f.oldPath = unquote(m[1]); f.status = 'renamed'; }
    else if ((m = line.match(/^rename to (.+)$/))) { f.newPath = unquote(m[1]); f.status = 'renamed'; }
    else if ((m = line.match(/^copy from (.+)$/))) { f.oldPath = unquote(m[1]); f.status = 'copied'; }
    else if ((m = line.match(/^copy to (.+)$/))) { f.newPath = unquote(m[1]); f.status = 'copied'; }
    else if (line === 'GIT binary patch') { f.binary = true; inBinary = true; }
  }

  for (const file of files) {
    if (file.status === 'modified' && file.oldPath && file.newPath && file.oldPath !== file.newPath) file.status = 'renamed';
    file.path = file.status === 'deleted' ? file.oldPath : (file.newPath || file.oldPath);
    file.modeChanged = !!(file.oldMode && file.newMode && file.oldMode !== file.newMode);
    delete file._git;
    delete file._paths;
  }
  return files;
}

function totals(files) {
  return files.reduce(
    (t, f) => ({ files: t.files + 1, additions: t.additions + f.additions, deletions: t.deletions + f.deletions }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

// Commits from `git format-patch --stdout` (mbox). Returns [] for a plain diff.
function parseMbox(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const commits = [];
  let c = null;
  let state = 'none';
  for (const line of lines) {
    const m = line.match(/^From ([0-9a-f]{7,64}) /);
    if (m) {
      c = { sha: m[1], author: '', date: '', subject: '', body: '' };
      commits.push(c);
      state = 'headers';
      continue;
    }
    if (!c) continue;
    if (state === 'headers') {
      if (line === '') { state = 'body'; continue; }
      let hm;
      if ((hm = line.match(/^From: (.*)$/))) c.author = hm[1];
      else if ((hm = line.match(/^Date: (.*)$/))) c.date = hm[1];
      else if ((hm = line.match(/^Subject: (.*)$/))) { c.subject = hm[1]; state = 'subject'; }
      continue;
    }
    if (state === 'subject') {
      if (/^[ \t]/.test(line)) { c.subject += ' ' + line.trim(); continue; }
      state = 'headers';
      if (line === '') { state = 'body'; }
      continue;
    }
    if (state === 'body') {
      if (line === '---' || line.startsWith('diff --git ')) { state = 'done'; continue; }
      c.body += line + '\n';
    }
  }
  for (const k of commits) {
    k.subject = k.subject.replace(/^\[PATCH[^\]]*\]\s*/, '');
    k.body = k.body.trim();
  }
  return commits;
}

module.exports = { parsePatch, parseMbox, totals, unquote };
