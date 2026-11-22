'use strict';

// HTML escaping and an auto-escaping template tag. Every interpolated value is
// escaped unless it is a Safe produced by html`` or raw().

class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);
}

function raw(s) {
  return new Safe(String(s));
}

function interp(v) {
  if (v == null || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(interp).join('');
  return esc(v);
}

function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += interp(vals[i]) + strings[i + 1];
  return new Safe(out);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

module.exports = { Safe, esc, raw, html, fmtDate, slugify };
