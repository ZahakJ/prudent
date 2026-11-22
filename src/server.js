'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { loadReviewModel, lineContext } = require('./review');
const render = require('./render');

const STATIC_DIR = path.join(__dirname, '..', 'static');
const STATIC = {
  'app.css': 'text/css; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'icon.svg': 'image/svg+xml',
};
const RAW_FILES = { 'patch.diff': 'text/plain; charset=utf-8', 'notes.md': 'text/plain; charset=utf-8', 'commits.patch': 'text/plain; charset=utf-8' };
const MAX_BODY = 256 * 1024;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

function send(res, status, type, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function tokensEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createServer({ token = crypto.randomBytes(24).toString('base64url') } = {}) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = e.status || (e instanceof store.UserError ? 400 : 500);
      if (status === 500) console.error(e);
      if (res.headersSent) return res.end();
      if (req.method === 'POST' || (req.url || '').startsWith('/api/')) sendJson(res, status, { error: status === 500 ? 'internal error' : e.message });
      else send(res, status, 'text/html; charset=utf-8', render.errorPage(status, status === 500 ? 'Something went wrong; see the server log.' : e.message, token));
    });
  });

  function allowedHost(host) {
    const port = server.address() && server.address().port;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }

  function fail(status, message) {
    throw Object.assign(new Error(message), { status });
  }

  async function handle(req, res) {
    const host = req.headers.host || '';
    // Refusing unknown Host headers blocks DNS-rebinding pages from reading or posting.
    if (!allowedHost(host)) fail(421, 'unexpected Host header');
    // Dot segments are refused before URL parsing would quietly normalise them.
    if (/(^|\/)(\.|%2e){1,2}(\/|\?|$)/i.test(req.url || "")) fail(404, "not found");
    let url;
    let parts;
    try {
      url = new URL(req.url, `http://${host}`);
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      fail(400, 'bad URL');
    }
    if (parts.some((p) => p === '.' || p === '..' || p.includes('/') || p.includes('\\') || p.includes('\0'))) fail(404, 'not found');

    if (req.method === 'GET' || req.method === 'HEAD') return get(req, res, url, parts);
    if (req.method === 'POST') return post(req, res, parts);
    res.setHeader('Allow', 'GET, HEAD, POST');
    fail(405, 'method not allowed');
  }

  function get(req, res, url, parts) {
    if (parts.length === 0) {
      return send(res, 200, 'text/html; charset=utf-8', render.homePage({ reviews: store.listReviews(), token }));
    }
    if (parts[0] === 'static' && parts.length === 2 && Object.hasOwn(STATIC, parts[1])) {
      const file = store.safeJoin(STATIC_DIR, parts[1]);
      return send(res, 200, STATIC[parts[1]], fs.readFileSync(file));
    }
    if (parts[0] === 'r' && parts.length >= 2) {
      const id = parts[1];
      if (!store.validId(id) || !store.exists(id)) fail(404, 'no such review');
      if (parts.length === 2) {
        const m = loadReviewModel(id, { from: url.searchParams.get('from'), to: url.searchParams.get('to') });
        return send(res, 200, 'text/html; charset=utf-8', render.reviewPage(m, { token, tab: url.searchParams.get('tab') }));
      }
      if (parts.length === 5 && parts[2] === 'raw' && /^\d{1,6}$/.test(parts[3]) && Object.hasOwn(RAW_FILES, parts[4])) {
        const file = store.safeJoin(store.reviewsDir(), id, 'revs', parts[3], parts[4]);
        if (!file || !fs.existsSync(file)) fail(404, 'not found');
        res.setHeader('Content-Disposition', `inline; filename="${id}-r${parts[3]}-${parts[4]}"`);
        return send(res, 200, RAW_FILES[parts[4]], fs.readFileSync(file));
      }
    }
    if (parts[0] === 'api' && parts[1] === 'r' && parts.length === 3) {
      const id = parts[2];
      if (!store.validId(id) || !store.exists(id)) fail(404, 'no such review');
      return sendJson(res, 200, { meta: store.loadMeta(id), decision: store.loadDecision(id) });
    }
    fail(404, 'not found');
  }

  async function post(req, res, parts) {
    // Decisions may only come from our own pages: they carry the per-run token,
    // which other sites cannot read, and browsers mark their origin.
    if (!tokensEqual(req.headers['x-prudent-token'], token)) fail(403, 'missing or wrong token; reload the page');
    const origin = req.headers.origin;
    if (origin && !allowedHost(origin.replace(/^http:\/\//, ''))) fail(403, 'cross-origin request refused');
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') fail(403, 'cross-site request refused');
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) fail(415, 'expected application/json');
    if (parts[0] !== 'api' || parts[1] !== 'r' || parts.length !== 4) fail(404, 'not found');
    const id = parts[2];
    if (!store.validId(id) || !store.exists(id)) fail(404, 'no such review');
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch (e) {
      if (e.status) throw e;
      fail(400, 'invalid JSON');
    }
    if (!body || typeof body !== 'object') fail(400, 'invalid JSON');

    switch (parts[3]) {
      case 'comment': {
        if (body.kind === 'line') {
          const side = body.side === 'old' ? 'old' : 'new';
          const line = Number(body.line);
          if (typeof body.file !== 'string' || !Number.isInteger(line)) fail(400, 'line comments need file and line');
          const ctx = lineContext(id, body.file, side, line);
          if (!ctx) fail(400, 'that line is not in the current revision');
          const c = store.addComment(id, { kind: 'line', file: body.file, side, line, body: body.body, ...ctx });
          return sendJson(res, 200, { comment: c });
        }
        return sendJson(res, 200, { comment: store.addComment(id, { kind: 'general', body: body.body }) });
      }
      case 'comment-delete':
        store.deleteComment(id, String(body.id || ''));
        return sendJson(res, 200, { ok: true });
      case 'checklist':
        return sendJson(res, 200, { item: store.setChecklist(id, String(body.key || ''), !!body.checked) });
      case 'decision': {
        const d = store.setDecision(id, String(body.status || ''), body.message);
        return sendJson(res, 200, { status: d.status, revision: d.revision });
      }
      case 'seen':
        store.markSeen(id, body.revision);
        return sendJson(res, 200, { ok: true });
      default:
        fail(404, 'not found');
    }
  }

  server.token = token;
  return server;
}

module.exports = { createServer };
