'use strict';

const { execFileSync } = require('child_process');
const { UserError } = require('./store');

function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e.code === 'ENOENT') throw new UserError('git is not installed or not on PATH');
    const msg = String(e.stderr || e.message).trim().split('\n').slice(-3).join('\n');
    throw new UserError(`git ${args[0]} failed in ${repo}:\n${msg}`);
  }
}

function tryGit(repo, args) {
  try {
    return git(repo, args).trim();
  } catch {
    return null;
  }
}

function revParse(repo, ref) {
  const sha = tryGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!sha) throw new UserError(`"${ref}" is not a commit in ${repo}`);
  return sha;
}

function defaultBase(repo, head) {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
    const sha = tryGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (!sha) continue;
    const mb = tryGit(repo, ['merge-base', sha, head]);
    if (mb) return { ref, mergeBase: mb };
  }
  throw new UserError('could not guess the base; pass --base <ref> (for example origin/main)');
}

// Everything prdesk needs from a repository for base...head.
function capture(repo, base, head) {
  if (!tryGit(repo, ['rev-parse', '--git-dir'])) throw new UserError(`${repo} is not a git repository`);
  const headRef = head || 'HEAD';
  const headSha = revParse(repo, headRef);
  let baseRef = base;
  let mergeBase;
  if (!baseRef) {
    const d = defaultBase(repo, headSha);
    baseRef = d.ref;
    mergeBase = d.mergeBase;
  } else {
    revParse(repo, baseRef);
    mergeBase = tryGit(repo, ['merge-base', baseRef, headSha]);
    if (!mergeBase) throw new UserError(`${baseRef} and ${headRef} have no common ancestor`);
  }
  const range = `${mergeBase}..${headSha}`;
  const patch = git(repo, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', range]);
  const commitsPatch = git(repo, ['-c', 'core.quotePath=false', 'format-patch', '--stdout', '--no-color', '--no-signature', '-M', range]);
  const log = git(repo, ['log', '--reverse', '--format=%H%x00%an <%ae>%x00%aI%x00%s%x00%b%x1e', range]);
  const commits = log.split('\x1e').map((s) => s.replace(/^\n/, '')).filter((s) => s.trim()).map((s) => {
    const [sha, author, date, subject, body] = s.split('\x00');
    return { sha, author, date, subject, body: (body || '').trim() };
  });
  let branch = null;
  if (head && !/^[0-9a-f]{7,64}$/.test(head)) branch = head;
  else branch = tryGit(repo, ['rev-parse', '--abbrev-ref', headRef]);
  if (branch === 'HEAD') branch = null;
  return { patch, commitsPatch, commits, base: baseRef, head: headRef, baseSha: revParse(repo, baseRef), headSha, mergeBase, branch };
}

module.exports = { capture };
