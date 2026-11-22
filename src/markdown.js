'use strict';

// A deliberately small Markdown renderer for untrusted text. It supports
// headings, paragraphs, lists (nested), block quotes, fenced code, rules,
// bold, italic, inline code, links and bare URLs. Raw HTML is never passed
// through: every character of input ends up escaped or inside a tag we build.

const { esc } = require('./util');

const SAFE_URL = /^(https?:\/\/|mailto:|#)/i;

function safeUrl(u) {
  const url = String(u).trim();
  if (!SAFE_URL.test(url)) return null;
  if (/[\u0000- \u007f]/.test(url)) return null;
  return url;
}

function link(url, inner) {
  return `<a href="${esc(url)}" rel="noopener noreferrer" target="_blank">${inner}</a>`;
}

const BARE_URL = /https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]]/g;

function autolink(text, opts) {
  if (opts.noLinks) return esc(text);
  let out = '';
  let last = 0;
  for (const m of text.matchAll(BARE_URL)) {
    out += esc(text.slice(last, m.index));
    const url = safeUrl(m[0]);
    out += url ? link(url, esc(m[0])) : esc(m[0]);
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

function findBacktickRun(src, from, len) {
  let j = from;
  while (j < src.length) {
    if (src[j] === '`') {
      let r = 0;
      while (src[j + r] === '`') r++;
      if (r === len) return j;
      j += r;
    } else j++;
  }
  return -1;
}

function matchLink(src, i) {
  let depth = 0;
  let k = i;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '\\') { k++; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) break; }
  }
  if (k >= src.length || src[k + 1] !== '(') return null;
  let p = k + 2;
  let pd = 1;
  for (; p < src.length; p++) {
    const c = src[p];
    if (c === '\\') { p++; continue; }
    if (c === '(') pd++;
    else if (c === ')') { pd--; if (pd === 0) break; }
    else if (c === '\n') return null;
  }
  if (p >= src.length) return null;
  const target = src.slice(k + 2, p).trim();
  const url = target.split(/\s+/)[0].replace(/^<(.*)>$/, '$1');
  return { text: src.slice(i + 1, k), url, end: p + 1 };
}

function findClose(src, from, d, c) {
  let j = from;
  while (j < src.length) {
    j = src.indexOf(d, j);
    if (j < 0) return -1;
    if (src[j - 1] === '\\') { j += 1; continue; }
    if (d.length === 1 && (src[j + 1] === c || src[j - 1] === c)) { j += 2; continue; }
    if (/\s/.test(src[j - 1])) { j += d.length; continue; }
    if (c === '_' && /\w/.test(src[j + d.length] || '')) { j += d.length; continue; }
    return j;
  }
  return -1;
}

function inline(src, opts = {}) {
  let out = '';
  let text = '';
  const flush = () => {
    if (text) { out += autolink(text, opts); text = ''; }
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\\' && i + 1 < n && /[\\`*_{}[\]()#+\-.!<>|~]/.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      let run = 1;
      while (src[i + run] === '`') run++;
      const close = findBacktickRun(src, i + run, run);
      if (close >= 0) {
        flush();
        let code = src.slice(i + run, close).replace(/\n/g, ' ');
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        out += `<code>${esc(code)}</code>`;
        i = close + run;
        continue;
      }
      text += '`'.repeat(run);
      i += run;
      continue;
    }
    if (c === '[' && !opts.noLinks) {
      const m = matchLink(src, i);
      if (m) {
        flush();
        const inner = inline(m.text, { ...opts, noLinks: true });
        const url = safeUrl(m.url);
        out += url ? link(url, inner) : inner;
        i = m.end;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      const dbl = src[i + 1] === c;
      const d = dbl ? c + c : c;
      const prev = i > 0 ? src[i - 1] : ' ';
      const after = src[i + d.length];
      if (!(c === '_' && /\w/.test(prev)) && after && !/\s/.test(after)) {
        const close = findClose(src, i + d.length, d, c);
        if (close > i + d.length) {
          flush();
          const inner = inline(src.slice(i + d.length, close), opts);
          out += dbl ? `<strong>${inner}</strong>` : `<em>${inner}</em>`;
          i = close + d.length;
          continue;
        }
      }
      text += d;
      i += d.length;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const QUOTE = /^ {0,3}>[ ]?/;

function isBlockStart(line) {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line);
}

function parseList(lines, start, opts) {
  const first = lines[start].match(LIST);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let cur = null;
  let blank = false;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      blank = true;
      if (cur) cur.lines.push('');
      i++;
      continue;
    }
    const m = line.match(LIST);
    const indent = line.match(/^ */)[0].length;
    if (m && m[1].length === base) {
      if (/\d/.test(m[2]) !== ordered) break;
      cur = { lines: [line.slice(m[0].length)], indent: m[1].length + m[2].length + Math.max(1, m[3].length) };
      items.push(cur);
      blank = false;
      i++;
      continue;
    }
    if (m && m[1].length < base) break;
    if (indent > base) {
      cur.lines.push(line.slice(Math.min(indent, cur.indent)));
      blank = false;
      i++;
      continue;
    }
    if (blank || isBlockStart(line)) break;
    cur.lines.push(line.trim());
    i++;
  }
  const tag = ordered ? 'ol' : 'ul';
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
  let out = `<${tag}${startAttr}>\n`;
  for (const it of items) {
    while (it.lines.length && !it.lines[it.lines.length - 1].trim()) it.lines.pop();
    let inner = blocks(it.lines, opts).trim();
    inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
    out += `<li>${inner}</li>\n`;
  }
  out += `</${tag}>\n`;
  return { html: out, next: i };
}

function blocks(lines, opts) {
  let out = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(FENCE))) {
      const fence = m[1];
      const lang = (m[2] || '').trim().split(/\s+/)[0];
      const close = new RegExp(`^ {0,3}\\${fence[0]}{${fence.length},}[ \\t]*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++;
      const langAttr = lang ? ` data-lang="${esc(lang)}"` : '';
      out += `<pre class="md-code"${langAttr}><code>${esc(body.join('\n'))}</code></pre>\n`;
      continue;
    }
    if ((m = line.match(HEADING))) {
      const level = Math.min(6, Math.max(1, m[1].length + (opts.headingOffset || 0)));
      const text = (m[2] || '').replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+$/, '');
      out += `<h${level}>${inline(text, opts)}</h${level}>\n`;
      i++;
      continue;
    }
    if (HR.test(line)) { out += '<hr>\n'; i++; continue; }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && lines[i].trim() && !(body.length && !QUOTE.test(lines[i]) && isBlockStart(lines[i]))) {
        body.push(lines[i].replace(QUOTE, ''));
        i++;
      }
      out += `<blockquote>\n${blocks(body, opts)}</blockquote>\n`;
      continue;
    }
    if (LIST.test(line) && line.trim().length > 1) {
      const r = parseList(lines, i, opts);
      out += r.html;
      i = r.next;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && !(para.length && LIST.test(lines[i]) && lines[i].trim().length > 1)) {
      para.push(lines[i].trim());
      i++;
    }
    if (!para.length) para.push(lines[i++].trim());
    out += `<p>${inline(para.join('\n'), opts)}</p>\n`;
  }
  return out;
}

function renderMarkdown(src, opts = {}) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  return blocks(lines, opts);
}

module.exports = { renderMarkdown, renderInline: inline, safeUrl };
