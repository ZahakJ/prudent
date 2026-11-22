'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const store = require('./store');
const { UserError } = store;
const { parsePatch, parseMbox, totals } = require('./patch');
const { parseNotes, lintNotes } = require('./notes');
const { slugify } = require('./util');
const pkg = require('../package.json');

const DEFAULT_PORT = 4477;
const STATUS_SCHEMA = 'prudent.status/v1';
const STATUS_TEXT = { pending: 'PENDING', approved: 'APPROVED', changes_requested: 'CHANGES REQUESTED' };

const CAPTURE_OPTS = {
  repo: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, patch: { type: 'string' },
  notes: { type: 'string' }, title: { type: 'string' }, project: { type: 'string' }, upstream: { type: 'string' },
  message: { type: 'string', short: 'm' }, json: { type: 'boolean' },
};

const HELP = {
  main: `prudent ${pkg.version}: a local review desk for patches written by AI agents.

Usage: prudent <command> [options]

Agent commands
  submit      Submit a branch (--repo) or a patch file (--patch) with notes for review
  resubmit    Add a new revision to an existing review
  status      Print the reviewer's decision and comments (--json for agents)
  wait        Block until the reviewer approves or requests changes
  check       Check a notes file against a diff without submitting
  guide       Print the notes format (WRITING-NOTES.md) for agents
  list        List reviews

Reviewer commands
  serve       Start the review web app on http://127.0.0.1:${DEFAULT_PORT}
  demo        Create a sample review to look at

Run "prudent help <command>" or "prudent <command> --help" for details.
Data lives in $PRUDENT_HOME (default ~/.local/share/prudent).`,

  submit: `Usage:
  prudent submit --repo <path> [--base <ref>] [--head <ref>] --notes <notes.md>
                --title "..." [--project "..."] [--upstream <url>] [--id <slug>]
  prudent submit --patch <file.patch> --notes <notes.md> --title "..." [...]

Captures the diff of base...head (from their merge-base, like a pull request),
the commit messages and the notes, and creates a review.

  --repo      Path to a git repository
  --base      Base ref (default: merge-base with origin/HEAD, origin/main or main)
  --head      Head ref (default: HEAD)
  --patch     A patch file instead of a repository (git diff or format-patch output)
  --notes     Notes in the format described in WRITING-NOTES.md (strongly recommended)
  --title     One-line title (default: first commit subject)
  --project   Project name shown to the reviewer
  --upstream  Link to the upstream project or PR target
  --id        Review id (default: derived from project and title)
  -m, --message  A line about this revision
  --json      Print the result as JSON`,

  resubmit: `Usage: prudent resubmit <id> [--repo <path>] [--base <ref>] [--head <ref>] [--patch <file>]
                       [--notes <notes.md>] [--title ...] [-m "what changed"]

Adds a new revision. Options you leave out are taken from the previous
revision (same repo, base and head refs, notes file contents if --notes is
omitted). The status goes back to pending; earlier revisions and comments are
kept, and the reviewer sees what changed since the revision they last opened.`,

  status: `Usage: prudent status <id> [--json]

Prints the decision (pending, approved, changes_requested), the reviewer's
message, checklist and comments. Line comments include the file, line and the
text of that line. --json prints the stable "${STATUS_SCHEMA}" object
documented in the README.
Exit code: 0 approved, 10 changes requested, 11 pending.`,

  wait: `Usage: prudent wait <id> [--timeout <seconds>] [--json]

Waits until the current revision is approved or has changes requested, then
prints the same output as "prudent status". Exit codes as for status; 12 on timeout.`,

  check: `Usage: prudent check --notes <notes.md> (--repo <path> [--base] [--head] | --patch <file>)

Reports missing sections and walkthrough anchors that do not match the diff.`,

  list: `Usage: prudent list [--json]`,

  guide: `Usage: prudent guide\n\nPrints WRITING-NOTES.md: how to write notes.md, with a complete example.`,

  serve: `Usage: prudent serve [--port <n>]

Serves the review app on 127.0.0.1 only (default port ${DEFAULT_PORT}).
Writes $PRUDENT_HOME/server.json with the URL so other commands can print links.`,

  demo: `Usage: prudent demo

Creates a sample review (two revisions of a made-up project) so you can try
the review page. Then run "prudent serve" and open the printed URL.`,
};

function out(s) {
  process.stdout.write(s.endsWith('\n') ? s : s + '\n');
}

function parse(cmd, argv, options, positionals = 0) {
  let r;
  try {
    r = parseArgs({ args: argv, options: { ...options, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UserError(`${e.message.replace(/\. To specify.*$/s, '')}\nRun "prudent help ${cmd}" for usage.`);
  }
  if (r.values.help) {
    out(HELP[cmd]);
    process.exit(0);
  }
  if (r.positionals.length > positionals) {
    throw new UserError(`unexpected argument "${r.positionals[positionals]}"\nRun "prudent help ${cmd}" for usage.`);
  }
  return r;
}

function readFileArg(file, what) {
  const p = path.resolve(file);
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new UserError(`cannot read ${what} "${file}": ${e.code === 'ENOENT' ? 'no such file' : e.message}`);
  }
}

function serverUrl() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(store.home(), 'server.json'), 'utf8'));
    return s.url || null;
  } catch {
    return null;
  }
}

function reviewUrl(id) {
  const base = serverUrl() || `http://127.0.0.1:${DEFAULT_PORT}/`;
  return `${base.replace(/\/$/, '')}/r/${encodeURIComponent(id)}`;
}

// Builds the revision data from --repo or --patch. `prev` is the previous info.json for resubmit.
function captureFrom(v, prev = {}) {
  const repo = v.repo || (!v.patch && prev.source === 'repo' ? prev.repo : null);
  if (v.repo && v.patch) throw new UserError('use either --repo or --patch, not both');
  if (repo) {
    const { capture } = require('./git');
    const abs = path.resolve(repo);
    if (!fs.existsSync(abs)) throw new UserError(`--repo: ${repo} does not exist`);
    const c = capture(abs, v.base || prev.base, v.head || prev.head);
    if (!c.patch.trim()) throw new UserError(`no changes between ${c.base} and ${c.head}`);
    return {
      patch: c.patch, commits: c.commits, commitsPatch: c.commitsPatch,
      info: { source: 'repo', repo: abs, base: c.base, head: c.head, baseSha: c.baseSha, headSha: c.headSha, mergeBase: c.mergeBase, branch: c.branch },
    };
  }
  if (v.patch) {
    const text = readFileArg(v.patch, 'patch');
    if (!parsePatch(text).length) throw new UserError(`${v.patch} does not look like a diff (no file changes found)`);
    const commits = parseMbox(text);
    return { patch: text, commits, commitsPatch: commits.length ? text : null, info: { source: 'patch', patchFile: path.resolve(v.patch) } };
  }
  if (prev.source === 'patch') throw new UserError('this review came from a patch file; pass --patch <file> with the new version');
  throw new UserError('pass --repo <path> (a git repository) or --patch <file>');
}

function finishData(v, cap, notes, fallbackTitle) {
  const files = parsePatch(cap.patch);
  const t = totals(files);
  const title = v.title || fallbackTitle || (cap.commits[0] && cap.commits[0].subject) || (v.patch ? path.basename(v.patch) : '');
  return {
    title, project: v.project, upstream: v.upstream, patch: cap.patch, notes, commits: cap.commits, commitsPatch: cap.commitsPatch,
    info: { ...cap.info, message: v.message || '', stats: t },
    files,
  };
}

function report(v, id, data, rev, warnings, action) {
  const t = data.info.stats;
  if (v.json) {
    out(JSON.stringify({ id, revision: rev, url: reviewUrl(id), stats: t, warnings }, null, 2));
    return;
  }
  out(`${action} ${id} revision ${rev}: ${t.files} file(s), +${t.additions} -${t.deletions}`);
  out(`Review page: ${reviewUrl(id)}${serverUrl() ? '' : '  (start the server with: prudent serve)'}`);
  if (warnings.length) {
    out(`\nNotes warnings (fix them and resubmit if they matter):`);
    for (const w of warnings) out(`  - ${w}`);
  }
  out(`\nRead the decision with: prudent status ${id}`);
}

function validateUpstream(u) {
  if (u && !/^https?:\/\//i.test(u)) throw new UserError('--upstream must be an http(s) URL');
}

function cmdSubmit(argv) {
  const { values: v } = parse('submit', argv, { ...CAPTURE_OPTS, id: { type: 'string' } });
  validateUpstream(v.upstream);
  const notes = v.notes ? readFileArg(v.notes, 'notes') : '';
  const cap = captureFrom(v);
  const data = finishData(v, cap, notes);
  if (!data.title) throw new UserError('pass --title "..."');
  const id = v.id || slugify([v.project, data.title].filter(Boolean).join(' ')) || `review-${Date.now()}`;
  if (!store.validId(id)) throw new UserError(`invalid --id "${id}": use letters, digits, ".", "_" and "-" (max 80)`);
  const warnings = v.notes ? lintNotes(parseNotes(notes), data.files) : ['no --notes given: the reviewer will see the diff without explanation'];
  const { info } = store.addRevision(id, data, { create: true });
  report(v, id, data, info.revision, warnings, 'Submitted');
}

function cmdResubmit(argv) {
  const { values: v, positionals } = parse('resubmit', argv, CAPTURE_OPTS, 1);
  const id = positionals[0];
  if (!id) throw new UserError('usage: prudent resubmit <id> [options]');
  validateUpstream(v.upstream);
  const meta = store.loadMeta(id);
  const prev = store.loadRevision(id, meta.revision);
  const notes = v.notes ? readFileArg(v.notes, 'notes') : prev.notes;
  const cap = captureFrom(v, prev.info);
  const data = finishData(v, cap, notes, meta.title);
  const warnings = lintNotes(parseNotes(notes), data.files);
  if (!v.notes) warnings.unshift('no --notes given: reusing the previous revision\'s notes');
  const { info } = store.addRevision(id, data, { create: false });
  report(v, id, data, info.revision, warnings, 'Resubmitted');
}

function statusObject(id) {
  const meta = store.loadMeta(id);
  const d = store.loadDecision(id);
  const seen = d.seen.length ? Math.max(...d.seen.map((s) => s.revision)) : null;
  return {
    schema: STATUS_SCHEMA,
    id,
    title: meta.title,
    project: meta.project || null,
    upstream: meta.upstream || null,
    revision: meta.revision,
    status: d.status,
    decidedRevision: d.status === 'pending' ? null : d.revision,
    decidedAt: d.status === 'pending' ? null : d.decidedAt,
    message: d.status === 'pending' ? '' : d.message,
    seenRevision: seen,
    checklist: store.checklistState(d, meta.revision).map(({ key, label, checked }) => ({ key, label, checked })),
    comments: d.comments.map((c) => {
      const o = { id: c.id, kind: c.kind, revision: c.revision, at: c.at, body: c.body };
      if (c.kind === 'line') Object.assign(o, { file: c.file, side: c.side, line: c.line, lineText: c.lineText ?? null, hunk: c.hunk ?? null });
      return o;
    }),
    history: d.history,
    url: reviewUrl(id),
  };
}

function statusText(s) {
  const lines = [];
  lines.push(`${s.id}: ${s.title}`);
  let head = `Status: ${STATUS_TEXT[s.status]} (revision ${s.revision}`;
  if (s.decidedAt) head += `, decided ${s.decidedAt}`;
  lines.push(head + ')');
  if (s.status === 'pending') {
    lines.push(s.seenRevision === s.revision ? 'The reviewer has opened this revision but not decided yet.' : 'The reviewer has not opened this revision yet.');
  }
  if (s.message) lines.push('', 'Message from the reviewer:', ...s.message.split('\n').map((l) => `  ${l}`));
  lines.push('', 'Checklist:', ...s.checklist.map((c) => `  [${c.checked ? 'x' : ' '}] ${c.label}`));
  const cur = s.comments.filter((c) => c.revision === s.revision);
  const old = s.comments.filter((c) => c.revision !== s.revision);
  const fmt = (c) => {
    const where = c.kind === 'line' ? `${c.file}:${c.line}${c.side === 'old' ? ' (removed line)' : ''}` : 'general';
    const block = [`- ${where}  [${c.at}, revision ${c.revision}]`];
    if (c.kind === 'line' && c.lineText != null) block.push(`    > ${c.lineText}`);
    block.push(...c.body.split('\n').map((l) => `    ${l}`));
    return block.join('\n');
  };
  lines.push('', `Comments on revision ${s.revision}: ${cur.length ? '' : 'none'}`);
  for (const c of cur) lines.push(fmt(c));
  if (old.length) {
    lines.push('', 'Comments on earlier revisions:');
    for (const c of old) lines.push(fmt(c));
  }
  const past = s.history.filter((h) => h.status !== 'resubmitted');
  if (past.length) {
    lines.push('', 'Earlier decisions:');
    for (const h of past) lines.push(`- revision ${h.revision}: ${STATUS_TEXT[h.status] || h.status} at ${h.at}${h.message ? `: ${h.message.split('\n')[0]}` : ''}`);
  }
  lines.push('', `Review page: ${s.url}`);
  return lines.join('\n');
}

const EXIT = { approved: 0, changes_requested: 10, pending: 11 };

function cmdStatus(argv) {
  const { values: v, positionals } = parse('status', argv, { json: { type: 'boolean' } }, 1);
  if (!positionals[0]) throw new UserError('usage: prudent status <id> [--json]');
  const s = statusObject(positionals[0]);
  out(v.json ? JSON.stringify(s, null, 2) : statusText(s));
  return EXIT[s.status];
}

async function cmdWait(argv) {
  const { values: v, positionals } = parse('wait', argv, { json: { type: 'boolean' }, timeout: { type: 'string' } }, 1);
  const id = positionals[0];
  if (!id) throw new UserError('usage: prudent wait <id> [--timeout <seconds>]');
  const timeout = v.timeout ? Number(v.timeout) : 0;
  if (v.timeout && !(timeout > 0)) throw new UserError('--timeout must be a positive number of seconds');
  const start = Date.now();
  for (;;) {
    const s = statusObject(id);
    if (s.status !== 'pending') {
      out(v.json ? JSON.stringify(s, null, 2) : statusText(s));
      return EXIT[s.status];
    }
    if (timeout && Date.now() - start > timeout * 1000) {
      out(v.json ? JSON.stringify(s, null, 2) : statusText(s));
      return 12;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function cmdCheck(argv) {
  const { values: v } = parse('check', argv, CAPTURE_OPTS);
  if (!v.notes) throw new UserError('pass --notes <notes.md>');
  const notes = readFileArg(v.notes, 'notes');
  const cap = captureFrom(v);
  const warnings = lintNotes(parseNotes(notes), parsePatch(cap.patch));
  if (v.json) out(JSON.stringify({ warnings }, null, 2));
  else out(warnings.length ? warnings.map((w) => `- ${w}`).join('\n') : 'Notes look complete: every section present and every anchor matches the diff.');
  return warnings.length ? 1 : 0;
}

function cmdGuide(argv) {
  parse('guide', argv, {});
  out(fs.readFileSync(path.join(__dirname, '..', 'WRITING-NOTES.md'), 'utf8'));
  return 0;
}

function cmdList(argv) {
  const { values: v } = parse('list', argv, { json: { type: 'boolean' } });
  const reviews = store.listReviews();
  if (v.json) {
    out(JSON.stringify(reviews.map(({ meta, decision, info }) => ({
      id: meta.id, title: meta.title, project: meta.project || null, status: decision.status,
      revision: meta.revision, updatedAt: meta.updatedAt, stats: info.stats || null,
    })), null, 2));
    return 0;
  }
  if (!reviews.length) {
    out('No reviews yet. Try: prudent demo');
    return 0;
  }
  const rows = reviews.map(({ meta, decision }) => [meta.id, STATUS_TEXT[decision.status].toLowerCase(), `r${meta.revision}`, (meta.updatedAt || '').slice(0, 16).replace('T', ' '), `${meta.project ? meta.project + ': ' : ''}${meta.title}`]);
  const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) out(r.map((c, i) => (i < 4 ? c.padEnd(w[i]) : c)).join('  '));
  return 0;
}

function cmdServe(argv) {
  const { values: v } = parse('serve', argv, { port: { type: 'string', short: 'p' } });
  const port = v.port ? Number(v.port) : Number(process.env.PRUDENT_PORT) || DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UserError(`--port must be a number from 0 to 65535`);
  const { createServer } = require('./server');
  const server = createServer();
  const info = path.join(store.home(), 'server.json');
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') process.stderr.write(`prudent: port ${port} is in use. Is prudent already running? Try: prudent serve --port ${port + 1}\n`);
    else process.stderr.write(`prudent: ${e.message}\n`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    fs.mkdirSync(store.reviewsDir(), { recursive: true, mode: 0o700 });
    store.writeJson(info, { url, port: server.address().port, pid: process.pid, startedAt: new Date().toISOString() });
    out(`prudent ${pkg.version} serving ${store.reviewsDir()}`);
    out(`Open ${url}`);
  });
  const stop = () => {
    try {
      const s = JSON.parse(fs.readFileSync(info, 'utf8'));
      if (s.pid === process.pid) fs.unlinkSync(info);
    } catch {
      // already gone
    }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return new Promise(() => {});
}

function cmdDemo(argv) {
  parse('demo', argv, {});
  const dir = path.join(__dirname, '..', 'samples', 'demo');
  let id = 'demo-kestrel-retries';
  for (let i = 2; store.exists(id); i++) id = `demo-kestrel-retries-${i}`;
  const base = { project: 'Kestrel (sample)', upstream: 'https://example.org/kestrel', title: 'Retry feed downloads with backoff' };
  const r1 = finishData({ ...base, patch: path.join(dir, 'v1.patch') }, captureFrom({ patch: path.join(dir, 'v1.patch') }), readFileArg(path.join(dir, 'notes-v1.md'), 'notes'));
  store.addRevision(id, r1, { create: true });
  const r2 = finishData({ ...base, patch: path.join(dir, 'v2.patch'), message: 'Cap the total wait and honour Retry-After, as asked' },
    captureFrom({ patch: path.join(dir, 'v2.patch') }), readFileArg(path.join(dir, 'notes-v2.md'), 'notes'));
  const d = store.loadDecision(id);
  d.seen.push({ revision: 1, at: new Date().toISOString() });
  store.saveDecision(id, d);
  store.addComment(id, { kind: 'general', body: 'What happens when the server keeps failing? This could retry for a long time.' });
  store.setDecision(id, 'changes_requested', 'Please cap the total wait and respect Retry-After.');
  store.addRevision(id, r2, { create: false });
  out(`Created sample review "${id}" with two revisions.`);
  out(serverUrl() ? `Open ${reviewUrl(id)}` : `Start the app with "prudent serve", then open ${reviewUrl(id)}`);
  return 0;
}

const COMMANDS = {
  submit: cmdSubmit, resubmit: cmdResubmit, status: cmdStatus, wait: cmdWait, check: cmdCheck, guide: cmdGuide,
  list: cmdList, serve: cmdServe, demo: cmdDemo,
};

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    out(HELP.main);
    return cmd ? 0 : 1;
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    out(pkg.version);
    return 0;
  }
  if (cmd === 'help') {
    const topic = rest[0];
    if (topic && !HELP[topic]) throw new UserError(`unknown command "${topic}"`);
    out(HELP[topic || 'main']);
    return 0;
  }
  const fn = COMMANDS[cmd];
  if (!fn) throw new UserError(`unknown command "${cmd}". Run "prudent --help" for the list.`);
  return (await fn(rest)) || 0;
}

function run(argv) {
  main(argv).then(
    (code) => { process.exitCode = code; },
    (e) => {
      if (e instanceof UserError) process.stderr.write(`prudent: ${e.message}\n`);
      else process.stderr.write(`prudent: unexpected error: ${e.stack || e}\n`);
      process.exitCode = e instanceof UserError ? 2 : 3;
    },
  );
}

module.exports = { run, main, statusObject, statusText, STATUS_SCHEMA };
