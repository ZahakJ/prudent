// prdesk review page behaviour. No dependencies. All text from the server is
// inserted with textContent, never innerHTML.
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const token = ($('meta[name="prdesk-token"]') || {}).content || '';
  const reviewId = document.body.dataset.review;
  const revision = Number(document.body.dataset.revision || 0);

  function toast(msg, error) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'show' + (error ? ' error' : '');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.className = ''; }, error ? 5000 : 1800);
  }

  async function post(action, data) {
    const res = await fetch(`/api/r/${encodeURIComponent(reviewId)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-prdesk-token': token },
      body: JSON.stringify(data),
      credentials: 'same-origin',
    });
    let body = {};
    try { body = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
    return body;
  }

  const fail = (e) => toast(`Not saved: ${e.message}`, true);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmt(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function commentEl(c) {
    const box = el('div', 'comment');
    box.dataset.cid = c.id;
    const meta = el('div', 'c-meta');
    meta.append(el('span', 'who', 'You'), document.createTextNode(` · ${fmt(c.at)}`));
    const del = el('button', 'link c-del', 'Delete');
    del.type = 'button';
    del.dataset.cid = c.id;
    meta.append(del);
    box.append(meta, el('div', 'c-body', c.body));
    return box;
  }

  if (!reviewId) return; // home page: nothing interactive

  // ---------- tabs ----------
  const panes = $$('.tabpane');
  const tabNames = panes.map((p) => p.dataset.pane);
  function showTab(name, push = true) {
    if (!tabNames.includes(name)) return;
    for (const p of panes) p.hidden = p.dataset.pane !== name;
    for (const t of $$('.tab')) {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (push) history.replaceState(null, '', `${location.pathname}${location.search}#${name}`);
  }
  const currentTab = () => (panes.find((p) => !p.hidden) || {}).dataset?.pane;

  function fromHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (tabNames.includes(h)) { showTab(h, false); return; }
    if (/^f-\d+$/.test(h) || /^note-/.test(h)) {
      showTab('changes', false);
      const t = document.getElementById(h);
      if (t) requestAnimationFrame(() => t.scrollIntoView({ block: 'start' }));
    }
  }
  if (!document.body.dataset.initialTab) fromHash();
  window.addEventListener('hashchange', fromHash);

  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab], [data-tab-link]');
    if (tab) {
      e.preventDefault();
      showTab(tab.dataset.tab || tab.dataset.tabLink);
      window.scrollTo({ top: 0 });
      return;
    }
    const goto = e.target.closest('[data-goto-file]');
    if (goto) {
      e.preventDefault();
      showTab('changes');
      gotoFile(Number(goto.dataset.gotoFile));
    }
  });

  // ---------- files ----------
  const files = () => $$('.tabpane[data-pane="changes"] .file');
  const headerOffset = () => ($('.tabs') ? $('.tabs').getBoundingClientRect().height : 0) + 12;

  function currentFileIndex() {
    const list = files();
    let idx = -1;
    for (let i = 0; i < list.length; i++) {
      if (list[i].getBoundingClientRect().top <= headerOffset() + 2) idx = i;
      else break;
    }
    return idx;
  }

  function gotoFile(i) {
    const list = files();
    if (!list.length) return;
    const f = list[Math.max(0, Math.min(list.length - 1, i))];
    f.classList.remove('folded');
    f.scrollIntoView({ block: 'start' });
    highlightNav();
  }

  function highlightNav() {
    const i = currentFileIndex();
    $$('.fl').forEach((a, k) => a.classList.toggle('current', k === Math.max(0, i)));
  }
  let navTimer = null;
  window.addEventListener('scroll', () => {
    if (navTimer) return;
    navTimer = setTimeout(() => { navTimer = null; if (currentTab() === 'changes') highlightNav(); }, 80);
  }, { passive: true });

  function fold(file, folded) {
    file.classList.toggle('folded', folded);
    const b = $('.fold', file);
    if (b) b.setAttribute('aria-expanded', folded ? 'false' : 'true');
  }

  document.addEventListener('click', (e) => {
    const head = e.target.closest('.file-head');
    if (head && !e.target.closest('a') && head.closest('.tabpane[data-pane="changes"]')) {
      const file = head.closest('.file');
      fold(file, !file.classList.contains('folded'));
    }
  });
  const collapseAll = $('#collapse-all');
  const expandAll = $('#expand-all');
  if (collapseAll) collapseAll.addEventListener('click', () => files().forEach((f) => fold(f, true)));
  if (expandAll) expandAll.addEventListener('click', () => files().forEach((f) => fold(f, false)));

  // ---------- notes ----------
  const notesToggle = $('#toggle-notes');
  function setNotes(on) {
    document.body.classList.toggle('hide-notes', !on);
    if (notesToggle) notesToggle.checked = on;
    try { localStorage.setItem('prdesk.notes', on ? '1' : '0'); } catch { /* private mode */ }
  }
  try { if (localStorage.getItem('prdesk.notes') === '0') setNotes(false); } catch { /* private mode */ }
  if (notesToggle) notesToggle.addEventListener('change', () => setNotes(notesToggle.checked));

  function gotoNote(dir) {
    if (document.body.classList.contains('hide-notes')) setNotes(true);
    if (currentTab() !== 'changes') showTab('changes');
    const notes = $$('.tabpane[data-pane="changes"] .note').filter((n) => n.offsetParent !== null);
    if (!notes.length) return toast('No walkthrough notes');
    const y = headerOffset() + 60;
    let target;
    if (dir > 0) target = notes.find((n) => n.getBoundingClientRect().top > y + 4) || notes[0];
    else target = notes.slice().reverse().find((n) => n.getBoundingClientRect().top < y - 4) || notes[notes.length - 1];
    target.scrollIntoView({ block: 'start' });
    target.focus({ preventScroll: true });
  }

  // ---------- line comments ----------
  function closeForms() {
    $$('tr.form-row').forEach((r) => r.remove());
  }

  function openLineForm(row) {
    closeForms();
    const table = row.closest('table.diff');
    const file = table.dataset.file;
    const side = row.dataset.side;
    const line = Number(row.dataset.line);
    let after = row;
    while (after.nextElementSibling && after.nextElementSibling.classList.contains('cm-row')) after = after.nextElementSibling;
    const tr = el('tr', 'form-row');
    const td = el('td');
    td.colSpan = 4;
    const form = el('div', 'cform');
    const ta = el('textarea');
    ta.rows = 3;
    ta.placeholder = `Comment on ${file}:${line}  (Ctrl+Enter to save, Esc to cancel)`;
    const rowEl = el('div', 'row');
    const save = el('button', 'btn small primary', 'Comment');
    save.type = 'button';
    const cancel = el('button', 'btn small ghost', 'Cancel');
    cancel.type = 'button';
    rowEl.append(el('span', 'spacer'), cancel, save);
    form.append(ta, rowEl);
    td.append(form);
    tr.append(td);
    after.after(tr);
    ta.focus();

    const submit = async () => {
      const body = ta.value.trim();
      if (!body) return ta.focus();
      save.disabled = true;
      try {
        const { comment } = await post('comment', { kind: 'line', file, side, line, body });
        let cm = after.classList.contains('cm-row') ? after : null;
        if (!cm) {
          cm = el('tr', 'cm-row');
          const c = el('td');
          c.colSpan = 4;
          cm.append(c);
          row.after(cm);
        }
        cm.firstElementChild.append(commentEl(comment));
        tr.remove();
        toast('Comment saved');
      } catch (e) {
        save.disabled = false;
        fail(e);
      }
    };
    save.addEventListener('click', submit);
    cancel.addEventListener('click', () => tr.remove());
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { e.preventDefault(); tr.remove(); }
    });
  }

  document.addEventListener('click', (e) => {
    const row = e.target.closest('.tabpane[data-pane="changes"] tr.l[data-line]');
    if (!row || e.target.closest('a, button, textarea')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return; // selecting text, not commenting
    openLineForm(row);
  });

  document.addEventListener('click', async (e) => {
    const del = e.target.closest('.c-del');
    if (!del) return;
    if (!confirm('Delete this comment?')) return;
    try {
      await post('comment-delete', { id: del.dataset.cid });
      const box = del.closest('.comment');
      const cmRow = box.closest('tr.cm-row');
      box.remove();
      if (cmRow && !$('.comment', cmRow)) cmRow.remove();
      toast('Comment deleted');
    } catch (err) { fail(err); }
  });

  // ---------- general comments ----------
  const gInput = $('#general-input');
  const gSave = $('#general-save');
  async function saveGeneral() {
    const body = gInput.value.trim();
    if (!body) return gInput.focus();
    gSave.disabled = true;
    try {
      const { comment } = await post('comment', { kind: 'general', body });
      $('#general-list').prepend(commentEl(comment));
      gInput.value = '';
      toast('Comment saved');
    } catch (e) { fail(e); } finally { gSave.disabled = false; }
  }
  if (gSave) gSave.addEventListener('click', saveGeneral);
  if (gInput) gInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveGeneral(); }
  });

  // ---------- checklist (panel and dialog stay in sync) ----------
  document.addEventListener('change', async (e) => {
    const box = e.target.closest('input[data-check]');
    if (!box) return;
    const key = box.dataset.check;
    $$(`input[data-check="${key}"]`).forEach((b) => { b.checked = box.checked; });
    updateWarn();
    try { await post('checklist', { key, checked: box.checked }); } catch (err) { fail(err); }
  });

  // ---------- panel ----------
  const openPanel = () => document.body.classList.add('panel-visible');
  const closePanel = () => document.body.classList.remove('panel-visible');
  $$('.panel-open').forEach((b) => b.addEventListener('click', openPanel));
  $$('.panel-close').forEach((b) => b.addEventListener('click', closePanel));

  // ---------- decision ----------
  const dlg = $('#decide');
  function updateWarn() {
    const w = $('#decide-warn');
    if (!w || !dlg) return;
    const status = ($('input[name=status]:checked', dlg) || {}).value;
    w.hidden = status !== 'approved' || $$('.dialog-checks input', dlg).every((b) => b.checked);
  }
  function openDecide(status) {
    if (!dlg) return;
    $$('input[name=status]', dlg).forEach((r) => { r.checked = r.value === status; });
    $('#decide-title').textContent = status === 'approved' ? 'Approve' : 'Request changes';
    $('#decide-ok').textContent = status === 'approved' ? 'Approve' : 'Request changes';
    updateWarn();
    dlg.showModal();
    $('textarea', dlg).focus();
  }
  $$('[data-decide]').forEach((b) => b.addEventListener('click', () => openDecide(b.dataset.decide)));
  if (dlg) {
    $$('input[name=status]', dlg).forEach((r) => r.addEventListener('change', () => {
      $('#decide-title').textContent = r.value === 'approved' ? 'Approve' : 'Request changes';
      $('#decide-ok').textContent = $('#decide-title').textContent;
      updateWarn();
    }));
    $('#decide-cancel').addEventListener('click', () => dlg.close());
    $('textarea', dlg).addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#decide-form').requestSubmit(); }
    });
    $('#decide-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const status = ($('input[name=status]:checked', dlg) || {}).value;
      const message = $('textarea[name=message]', dlg).value;
      try {
        await post('decision', { status, message });
        dlg.close();
        toast(status === 'approved' ? 'Approved' : 'Changes requested');
        setTimeout(() => location.reload(), 500);
      } catch (err) { fail(err); }
    });
  }

  // ---------- PR description copy ----------
  const copy = $('#copy-pr');
  if (copy) copy.addEventListener('click', async () => {
    const text = $('#pr-raw').value;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = $('#pr-raw');
      ta.closest('details').open = true;
      ta.select();
      document.execCommand('copy');
    }
    toast('PR description copied');
  });

  // ---------- keyboard ----------
  const help = $('#help');
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
    if (document.querySelector('dialog[open]')) return;
    const k = e.key;
    if (/^[1-5]$/.test(k)) { showTab(tabNames[Number(k) - 1]); window.scrollTo({ top: 0 }); }
    else if (k === 'j' || k === 'k') {
      if (currentTab() !== 'changes') { showTab('changes'); gotoFile(0); }
      else gotoFile(currentFileIndex() + (k === 'j' ? 1 : -1));
    } else if (k === 'n') gotoNote(1);
    else if (k === 'N') gotoNote(-1);
    else if (k === 'o') {
      const i = currentFileIndex();
      const f = files()[Math.max(0, i)];
      if (f) { fold(f, !f.classList.contains('folded')); f.scrollIntoView({ block: 'start' }); }
    } else if (k === 't') setNotes(document.body.classList.contains('hide-notes'));
    else if (k === 'a') openDecide('approved');
    else if (k === 'r') openDecide('changes_requested');
    else if (k === 'v') document.body.classList.toggle('panel-visible');
    else if (k === 'c') { openPanel(); if (gInput) gInput.focus(); }
    else if (k === '?') { if (help) help.showModal(); }
    else if (k === 'Escape') { closePanel(); closeForms(); }
    else return;
    e.preventDefault();
  });

  // ---------- seen ----------
  post('seen', { revision }).catch(() => { /* not important */ });
})();
