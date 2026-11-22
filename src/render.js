'use strict';

// Server-side HTML. Everything user- or agent-supplied goes through html``
// (escaped) or renderMarkdown (escaped, no raw HTML).

const { html, raw, fmtDate } = require('./util');
const { renderMarkdown } = require('./markdown');
const { SECTIONS } = require('./notes');
const { commentKey } = require('./review');

const STATUS_LABEL = { pending: 'Pending', approved: 'Approved', changes_requested: 'Changes requested' };
const FILE_STATUS = { added: 'A', deleted: 'D', modified: 'M', renamed: 'R', copied: 'C' };

const md = (s, offset = 1) => raw(renderMarkdown(s, { headingOffset: offset }));

function layout({ title, token, body, bodyAttrs = '' }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="prudent-token" content="${token}">
<title>${title}</title>
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/app.css">
</head>
<body ${raw(bodyAttrs)}>
${body}
<div id="toast" role="status" aria-live="polite"></div>
<script src="/static/app.js"></script>
</body>
</html>
`.toString();
}

function statusPill(status) {
  return html`<span class="pill pill-${status}">${STATUS_LABEL[status] || status}</span>`;
}

function sizeBar(add, del) {
  const total = add + del;
  const blocks = 5;
  const a = total ? Math.round((add / total) * blocks) : 0;
  const cells = [];
  for (let i = 0; i < blocks; i++) cells.push(html`<i class="${!total ? 'z' : i < a ? 'a' : 'd'}"></i>`);
  return html`<span class="sizebar" aria-hidden="true">${cells}</span>`;
}

function counts(add, del) {
  return html`<span class="counts"><span class="plus">+${add}</span> <span class="minus">−${del}</span></span>`;
}

function brand() {
  return html`<a class="brand" href="/"><svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><rect x="1" y="1" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5.5 10.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>prudent</a>`;
}

// ---------- home ----------

function homePage({ reviews, token }) {
  const rows = reviews.map(({ meta, decision, info }) => {
    const unseen = !decision.seen.some((s) => s.revision === meta.revision);
    const comments = decision.comments.filter((c) => c.revision === meta.revision).length;
    const st = info.stats || { additions: 0, deletions: 0, files: 0 };
    return html`<tr>
      <td class="h-project">${meta.project || '—'}</td>
      <td class="h-title"><a href="/r/${encodeURIComponent(meta.id)}">${meta.title}</a>${unseen ? html` <span class="dot" title="Not opened yet">new</span>` : ''}
        <div class="sub">${meta.id}${info.branch ? html` · ${info.branch}` : ''}</div></td>
      <td>${statusPill(decision.status)}</td>
      <td class="num">${meta.revision}</td>
      <td class="num">${counts(st.additions, st.deletions)}<div class="sub">${st.files} file${st.files === 1 ? '' : 's'}</div></td>
      <td class="num">${comments || ''}</td>
      <td class="date">${fmtDate(meta.updatedAt)}</td>
    </tr>`;
  });
  const pending = reviews.filter((r) => r.decision.status === 'pending').length;
  const body = html`
<header class="topbar">${brand()}<span class="spacer"></span><span class="muted">${pending} waiting for you</span></header>
<main class="home">
  <h1>Reviews</h1>
  ${reviews.length ? html`<table class="reviews">
    <thead><tr><th>Project</th><th>Title</th><th>Status</th><th class="num">Rev</th><th class="num">Size</th><th class="num">Comments</th><th>Updated</th></tr></thead>
    <tbody>${rows}</tbody></table>`
    : html`<div class="empty">
      <p>No reviews yet. An agent submits one with:</p>
      <pre>prudent submit --repo path/to/repo --base origin/main --head my-branch \\
  --title "Short title" --project "Project" --notes notes.md</pre>
      <p>Or try the sample: <code>prudent demo</code></p>
    </div>`}
</main>`;
  return layout({ title: 'prudent', token, body });
}

// ---------- review ----------

function overviewTab(m) {
  const { notes, meta } = m;
  const shown = SECTIONS.filter((s) => !['walkthrough', 'prDescription'].includes(s.key));
  const parts = [];
  if (notes.preamble) parts.push(html`<section class="prose">${md(notes.preamble)}</section>`);
  for (const s of shown) {
    const sec = notes.sections[s.key];
    parts.push(html`<section class="prose sec-${s.key}">
      <h2>${s.title}</h2>
      ${sec && sec.body.trim() ? md(sec.body) : html`<p class="missing">The agent did not write this section.</p>`}
    </section>`);
  }
  for (const x of notes.extras) parts.push(html`<section class="prose"><h2>${x.title}</h2>${md(x.body)}</section>`);
  const fileList = m.files.map((f, i) => html`<li><a href="#f-${i}" data-goto-file="${i}"><span class="st st-${f.status}">${FILE_STATUS[f.status] || 'M'}</span> ${f.path}</a> ${counts(f.additions, f.deletions)}</li>`);
  return html`<div class="overview">
    ${newRevisionBanner(m)}
    ${parts}
    <section class="prose"><h2>Files</h2><ul class="filelist-plain">${fileList}</ul>
    <p class="muted">Upstream: ${meta.upstream ? html`<a href="${safeHref(meta.upstream)}" rel="noopener noreferrer" target="_blank">${meta.upstream}</a>` : 'not given'}</p></section>
  </div>`;
}

function safeHref(u) {
  return /^https?:\/\//i.test(String(u || '')) ? u : '#';
}

function newRevisionBanner(m) {
  const cur = m.meta.revision;
  if (cur < 2) return '';
  const info = m.current.info;
  const seen = m.seenBefore;
  const text = seen
    ? `Revision ${cur} arrived since you last looked (you saw revision ${seen}).`
    : `This is revision ${cur}.`;
  return html`<div class="banner">
    <strong>${text}</strong>${info.message ? html` <span>${info.message}</span>` : ''}
    <a href="#revisions" data-tab-link="revisions">See what changed →</a>
  </div>`;
}

function noteBox(item, extraClass = '') {
  return html`<div class="note ${extraClass}" id="${item.id}" tabindex="-1">
    ${item.label ? html`<div class="note-label">${item.label}</div>` : ''}
    <div class="prose small">${md(item.body, 3)}</div>
  </div>`;
}

function noteRow(items) {
  if (!items.length) return '';
  return html`<tr class="note-row"><td colspan="4">${items.map((it) => noteBox(it))}</td></tr>`;
}

function commentBox(c, current) {
  return html`<div class="comment" data-cid="${c.id}">
    <div class="c-meta"><span class="who">You</span> · ${fmtDate(c.at)}${c.revision !== current ? html` · on revision ${c.revision}` : ''}
      <button type="button" class="link c-del" data-cid="${c.id}">Delete</button></div>
    <div class="c-body">${c.body}</div>
  </div>`;
}

function diffTable(m, f, fi) {
  const slot = m.anchored.files[fi];
  const rows = [];
  f.hunks.forEach((h, hi) => {
    const spots = slot.spots.filter((s) => s.hunk === hi);
    rows.push(noteRow(spots.filter((s) => s.line === -1)));
    rows.push(html`<tr class="hunk-head"><td class="no"></td><td class="no"></td><td colspan="2"><span>${h.header}</span></td></tr>`);
    h.lines.forEach((l, li) => {
      rows.push(noteRow(spots.filter((s) => s.line === li)));
      if (l.t === 'meta') {
        rows.push(html`<tr class="l meta"><td class="no"></td><td class="no"></td><td class="sg"></td><td class="code">${l.text}</td></tr>`);
        return;
      }
      const side = l.t === 'del' ? 'old' : 'new';
      const no = l.t === 'del' ? l.oldNo : l.newNo;
      const sign = l.t === 'add' ? '+' : l.t === 'del' ? '−' : '';
      rows.push(html`<tr class="l ${l.t}" data-side="${side}" data-line="${no}">
<td class="no" data-n="${l.oldNo == null ? '' : l.oldNo}"></td><td class="no" data-n="${l.newNo == null ? '' : l.newNo}"></td><td class="sg">${sign}</td><td class="code">${l.text}</td></tr>`);
      const cs = m.inlineComments.get(commentKey(f.path, side, no));
      if (cs) rows.push(html`<tr class="cm-row"><td colspan="4">${cs.map((c) => commentBox(c, m.meta.revision))}</td></tr>`);
    });
  });
  return html`<table class="diff" data-file="${f.path}"><colgroup><col class="c-no"><col class="c-no"><col class="c-sg"><col></colgroup><tbody>${rows}</tbody></table>`;
}

function fileBlock(m, f, i) {
  const slot = m.anchored.files[i];
  const label = f.status === 'renamed' || f.status === 'copied'
    ? html`${f.oldPath} <span class="arrow">→</span> ${f.newPath}`
    : html`${f.path}`;
  const extras = [];
  if (f.similarity != null && f.status !== 'modified') extras.push(`${f.similarity}% similar`);
  if (f.modeChanged) extras.push(`mode ${f.oldMode} → ${f.newMode}`);
  const hasNotes = slot.intro.length || slot.spots.length || slot.loose.length;
  return html`<section class="file" id="f-${i}" data-path="${f.path}">
  <header class="file-head">
    <button type="button" class="fold" aria-expanded="true" title="Collapse (o)">▾</button>
    <span class="st st-${f.status}" title="${f.status}">${FILE_STATUS[f.status] || 'M'}</span>
    <span class="path">${label}</span>
    ${extras.length ? html`<span class="muted small">${extras.join(' · ')}</span>` : ''}
    <span class="spacer"></span>
    ${hasNotes ? html`<span class="has-notes" title="Has walkthrough notes">notes</span>` : ''}
    ${counts(f.additions, f.deletions)}
  </header>
  <div class="file-body">
    ${slot.intro.map((it) => noteBox(it, 'file-note'))}
    ${slot.loose.map((it) => noteBox({ ...it, label: `${it.label} (anchor not found in the diff)` }, 'file-note loose'))}
    ${f.binary ? html`<div class="binary">Binary file${f.status === 'added' ? ' added' : f.status === 'deleted' ? ' deleted' : ' changed'}; no text diff.</div>` : ''}
    ${!f.binary && !f.hunks.length ? html`<div class="binary">No content changes${f.status === 'renamed' ? ' (pure rename)' : ''}.</div>` : ''}
    ${f.hunks.length ? diffTable(m, f, i) : ''}
  </div>
</section>`;
}

function changesTab(m) {
  const side = m.files.map((f, i) => {
    const slash = f.path.lastIndexOf('/');
    const dir = slash >= 0 ? f.path.slice(0, slash + 1) : '';
    const base = f.path.slice(slash + 1);
    return html`<a class="fl" href="#f-${i}" data-goto-file="${i}" title="${f.path}">
      <span class="st st-${f.status}">${FILE_STATUS[f.status] || 'M'}</span>
      <span class="fp"><span class="dir">${dir}</span><span class="base">${base}</span></span>
      <span class="fc"><span class="plus">+${f.additions}</span><span class="minus">−${f.deletions}</span></span>
    </a>`;
  });
  const { general, unplaced } = m.anchored;
  return html`<div class="changes">
  <nav class="filenav" aria-label="Files">
    <div class="filenav-head">${m.files.length} file${m.files.length === 1 ? '' : 's'} ${counts(m.totals.additions, m.totals.deletions)}</div>
    ${side}
  </nav>
  <div class="diffs">
    <div class="toolbar">
      <label class="switch"><input type="checkbox" id="toggle-notes" checked> Walkthrough notes <kbd>t</kbd></label>
      <button type="button" class="btn ghost small" id="collapse-all">Collapse all</button>
      <button type="button" class="btn ghost small" id="expand-all">Expand all</button>
      <span class="spacer"></span>
      <span class="muted small">Click a line to comment · <kbd>j</kbd>/<kbd>k</kbd> files · <kbd>n</kbd> next note · <kbd>?</kbd> keys</span>
    </div>
    ${general ? noteBox({ id: 'note-general', label: 'Walkthrough', body: general }, 'file-note') : ''}
    ${unplaced.map((u) => noteBox({ id: u.id, label: `${u.path} (not in this diff)`, body: u.body }, 'file-note loose'))}
    ${m.files.map((f, i) => fileBlock(m, f, i))}
    ${!m.files.length ? html`<p class="muted">The patch has no file changes.</p>` : ''}
  </div>
</div>`;
}

function commitsTab(m) {
  const commits = m.current.commits;
  if (!commits.length) return html`<p class="muted pad">No commit messages: this was submitted as a plain diff.</p>`;
  return html`<div class="commits">${commits.map((c) => html`<article class="commit">
    <h3>${c.subject}</h3>
    <div class="muted small"><code>${(c.sha || '').slice(0, 12)}</code> · ${c.author} · ${c.date ? fmtDate(c.date) || c.date : ''}</div>
    ${c.body ? html`<pre class="commit-body">${c.body}</pre>` : ''}
  </article>`)}</div>`;
}

function prTab(m) {
  const sec = m.notes.sections.prDescription;
  if (!sec || !sec.body.trim()) return html`<p class="muted pad">The agent did not include a <code># PR description</code> section.</p>`;
  return html`<div class="prdesc">
    <div class="toolbar"><span class="muted small">The text that would be posted upstream.</span><span class="spacer"></span>
      <button type="button" class="btn small" id="copy-pr">Copy Markdown</button></div>
    <div class="prose">${md(sec.body, 0)}</div>
    <details class="raw-md"><summary>Raw Markdown</summary><textarea id="pr-raw" readonly rows="16">${sec.body}</textarea></details>
  </div>`;
}

function opsTable(hunks, cls) {
  return html`<table class="diff ${cls}"><colgroup><col class="c-no"><col class="c-no"><col class="c-sg"><col></colgroup><tbody>${hunks.map((h, i) => html`
    ${i ? html`<tr class="hunk-head"><td class="no"></td><td class="no"></td><td colspan="2"><span>⋯</span></td></tr>` : ''}
    ${h.map((o) => html`<tr class="l ${o.t === 'eq' ? 'ctx' : o.t}"><td class="no" data-n="${o.aNo == null ? '' : o.aNo}"></td><td class="no" data-n="${o.bNo == null ? '' : o.bNo}"></td><td class="sg">${o.t === 'add' ? '+' : o.t === 'del' ? '−' : ''}</td><td class="code">${o.text}</td></tr>`)}`)}</tbody></table>`;
}

function revisionsTab(m) {
  const revs = m.revisions.slice().reverse().map((r) => {
    const st = r.stats || { additions: 0, deletions: 0, files: 0 };
    const seen = m.decision.seen.some((s) => s.revision === r.revision);
    return html`<li><strong>Revision ${r.revision}</strong> <span class="muted">${fmtDate(r.createdAt)}</span> ${counts(st.additions, st.deletions)}
      ${r.headSha ? html`<code class="small">${r.headSha.slice(0, 10)}</code>` : ''}
      ${seen ? '' : html`<span class="dot">not opened</span>`}
      <a class="small" href="/r/${encodeURIComponent(m.id)}/raw/${r.revision}/patch.diff">patch</a>
      ${r.message ? html`<div class="rev-msg">${r.message}</div>` : ''}</li>`;
  });
  let cmp = '';
  if (m.compare) {
    const c = m.compare;
    const opts = (sel) => m.revisions.map((r) => html`<option value="${r.revision}"${r.revision === sel ? raw(' selected') : ''}>${r.revision}</option>`);
    const changed = c.files.filter((f) => f.kind !== 'same');
    cmp = html`<form class="compare-form" method="get" action="/r/${encodeURIComponent(m.id)}">
      <input type="hidden" name="tab" value="revisions">
      Compare revision <select name="from">${opts(c.from)}</select> with <select name="to">${opts(c.to)}</select>
      <button class="btn small" type="submit">Compare</button></form>
      <p class="muted">Green lines were added in revision ${c.to}, red lines were in revision ${c.from} and are gone. The <code>+</code>/<code>−</code> inside a line is the patch's own diff.</p>
      ${!changed.length ? html`<p>The code changes are identical.</p>` : ''}
      ${changed.map((f) => html`<section class="file rd"><header class="file-head"><span class="path">${f.path}</span><span class="spacer"></span><span class="muted small">${f.kind}</span></header>
        <div class="file-body">${opsTable(f.hunks, 'interdiff')}</div></section>`)}
      ${c.notes.length ? html`<section class="file rd"><header class="file-head"><span class="path">notes.md</span><span class="spacer"></span><span class="muted small">notes changed</span></header>
        <div class="file-body">${opsTable(c.notes, 'notesdiff')}</div></section>` : html`<p class="muted">Notes unchanged.</p>`}`;
  }
  return html`<div class="revisions">
    <ul class="revlist">${revs}</ul>
    ${m.revisions.length < 2 ? html`<p class="muted">Only one revision so far. When the agent resubmits, this tab shows what changed since the revision you last opened.</p>` : cmp}
  </div>`;
}

function reviewPanel(m) {
  const { decision, meta } = m;
  const general = decision.comments.filter((c) => c.kind === 'general').slice().reverse();
  const lineHere = decision.comments.filter((c) => c.kind === 'line' && c.revision === meta.revision).length;
  const history = decision.history.slice().reverse().slice(0, 8);
  return html`<aside class="panel" id="panel" aria-label="Your review">
  <div class="panel-head"><h2>Your review</h2><button type="button" class="link panel-close" aria-label="Close">✕</button></div>
  <div class="panel-status">${statusPill(decision.status)}${decision.decidedAt ? html` <span class="muted small">on revision ${decision.revision}, ${fmtDate(decision.decidedAt)}</span>` : ''}</div>
  <fieldset class="checklist"><legend>Checklist (revision ${meta.revision})</legend>
    ${m.checklist.map((c) => html`<label><input type="checkbox" data-check="${c.key}"${c.checked ? raw(' checked') : ''}> ${c.label}</label>`)}
  </fieldset>
  <div class="actions">
    <button type="button" class="btn approve" data-decide="approved">Approve <kbd>a</kbd></button>
    <button type="button" class="btn reject" data-decide="changes_requested">Request changes <kbd>r</kbd></button>
  </div>
  <div class="general">
    <h3>General comments</h3>
    <textarea id="general-input" rows="3" placeholder="A comment about the whole change…"></textarea>
    <div class="row"><span class="muted small">Ctrl+Enter to save</span><span class="spacer"></span><button type="button" class="btn small" id="general-save">Add comment</button></div>
    <div id="general-list">${general.map((c) => commentBox(c, meta.revision))}</div>
  </div>
  <div class="muted small">${lineHere} line comment${lineHere === 1 ? '' : 's'} on this revision.</div>
  ${m.otherLineComments.length ? html`<div class="older"><h3>Line comments from earlier revisions</h3>
    ${m.otherLineComments.map((c) => html`<div class="comment old"><div class="c-meta">${c.file}:${c.line} · revision ${c.revision}</div>
      ${c.lineText != null ? html`<pre class="ctx">${c.lineText}</pre>` : ''}<div class="c-body">${c.body}</div></div>`)}</div>` : ''}
  ${history.length ? html`<div class="history"><h3>History</h3><ul>${history.map((h) => html`<li><span class="muted">${fmtDate(h.at)}</span> rev ${h.revision}: ${STATUS_LABEL[h.status] || h.status}${h.message ? html` — <span class="hmsg">${h.message}</span>` : ''}</li>`)}</ul></div>` : ''}
</aside>`;
}

function decideDialog(m) {
  return html`<dialog id="decide">
  <form method="dialog" id="decide-form">
    <h2 id="decide-title">Approve</h2>
    <div class="radio-row">
      <label><input type="radio" name="status" value="approved"> Approve</label>
      <label><input type="radio" name="status" value="changes_requested"> Request changes</label>
    </div>
    <div class="dialog-checks">${m.checklist.map((c) => html`<label><input type="checkbox" data-check="${c.key}"${c.checked ? raw(' checked') : ''}> ${c.label}</label>`)}</div>
    <p class="warn" id="decide-warn" hidden>Some checklist items are not ticked.</p>
    <label class="block">Message for the agent (optional)
      <textarea name="message" rows="4" placeholder="What to change, or anything to keep in mind…"></textarea></label>
    <div class="row"><span class="spacer"></span>
      <button type="button" class="btn ghost" value="cancel" id="decide-cancel">Cancel</button>
      <button type="submit" class="btn primary" id="decide-ok">Confirm</button></div>
  </form>
</dialog>`;
}

function helpDialog() {
  const keys = [
    ['1 – 5', 'Overview, Changes, Commits, PR description, Revisions'],
    ['j / k', 'Next / previous file'], ['n / N', 'Next / previous note'], ['o', 'Fold the current file'],
    ['t', 'Show or hide walkthrough notes'], ['c', 'Comment on the whole change'], ['v', 'Open the review panel'],
    ['a', 'Approve'], ['r', 'Request changes'], ['Ctrl+Enter', 'Save a comment'], ['Esc', 'Close / cancel'],
  ];
  return html`<dialog id="help"><h2>Keyboard</h2><table class="keys">${keys.map(([k, v]) => html`<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`)}</table>
  <form method="dialog"><div class="row"><span class="spacer"></span><button class="btn">Close</button></div></form></dialog>`;
}

function reviewPage(m, { token, tab }) {
  const { meta, current, totals: t, decision } = m;
  const info = current.info;
  const tabs = [
    ['overview', 'Overview', ''],
    ['changes', 'Changes', String(t.files)],
    ['commits', 'Commits', String(current.commits.length)],
    ['pr', 'PR description', ''],
    ['revisions', 'Revisions', String(m.revisions.length)],
  ];
  const active = tabs.some(([k]) => k === tab) ? tab : 'overview';
  const branch = info.branch || info.head;
  const body = html`
<header class="topbar">
  ${brand()}<span class="crumb">/</span><span class="crumb">${meta.project || 'review'}</span>
  <span class="spacer"></span>
  <button type="button" class="btn ghost small panel-open" title="Your review (v)">Your review</button>
</header>
<header class="rhead">
  <div class="rhead-main">
    <h1>${meta.title}</h1>
    <div class="facts">
      ${statusPill(decision.status)}
      ${meta.project ? html`<span>${meta.project}</span>` : ''}
      ${meta.upstream ? html`<a href="${safeHref(meta.upstream)}" rel="noopener noreferrer" target="_blank">${meta.upstream.replace(/^https?:\/\//, '')}</a>` : ''}
      ${branch ? html`<span class="branch"><code>${info.base || 'base'}</code> ← <code>${branch}</code></span>` : ''}
      <span>${counts(t.additions, t.deletions)} ${sizeBar(t.additions, t.deletions)} in ${t.files} file${t.files === 1 ? '' : 's'}</span>
      <span>revision ${meta.revision}</span>
      <span class="muted">${fmtDate(info.createdAt)}</span>
    </div>
  </div>
  <div class="rhead-actions">
    <button type="button" class="btn reject" data-decide="changes_requested">Request changes</button>
    <button type="button" class="btn approve" data-decide="approved">Approve</button>
  </div>
</header>
<nav class="tabs" role="tablist">
  ${tabs.map(([k, label, n], i) => html`<a href="#${k}" role="tab" class="tab${k === active ? ' active' : ''}" data-tab="${k}" aria-selected="${k === active ? 'true' : 'false'}">${label}${n ? html` <span class="n">${n}</span>` : ''}<kbd>${i + 1}</kbd></a>`)}
</nav>
<div class="layout">
  <main class="content">
    <section class="tabpane" data-pane="overview"${active === 'overview' ? '' : raw(' hidden')}>${overviewTab(m)}</section>
    <section class="tabpane" data-pane="changes"${active === 'changes' ? '' : raw(' hidden')}>${changesTab(m)}</section>
    <section class="tabpane" data-pane="commits"${active === 'commits' ? '' : raw(' hidden')}>${commitsTab(m)}</section>
    <section class="tabpane" data-pane="pr"${active === 'pr' ? '' : raw(' hidden')}>${prTab(m)}</section>
    <section class="tabpane" data-pane="revisions"${active === 'revisions' ? '' : raw(' hidden')}>${revisionsTab(m)}</section>
  </main>
  ${reviewPanel(m)}
</div>
${decideDialog(m)}
${helpDialog()}`;
  const attrs = html`data-review="${m.id}" data-revision="${meta.revision}" data-initial-tab="${tab ? active : ''}"`;
  return layout({ title: `${meta.title} · prudent`, token, body, bodyAttrs: attrs.toString() });
}

function errorPage(status, message, token) {
  return layout({
    title: `${status} · prudent`, token,
    body: html`<header class="topbar">${brand()}</header><main class="home"><h1>${status}</h1><p>${message}</p><p><a href="/">Back to reviews</a></p></main>`,
  });
}

module.exports = { homePage, reviewPage, errorPage, layout };
