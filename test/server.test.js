'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { tempHome, addSampleReview } = require('./helpers');

tempHome();
const store = require('../src/store');
const { createServer } = require('../src/server');

const TOKEN = 'test-token-0123456789';
let server;
let port;

function request(method, path, { headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { host: host || `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const json = { 'content-type': 'application/json', 'x-prdesk-token': TOKEN };

test.before(async () => {
  addSampleReview('evil', store);
  // Untrusted content: hostile notes, file names and diff lines.
  const patch = [
    'diff --git a/<img src=x onerror=alert(1)>.js b/<img src=x onerror=alert(1)>.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/<img src=x onerror=alert(1)>.js',
    '@@ -0,0 +1,2 @@ <script>alert("hunk")</script>',
    '+</td></tr><script>alert("line")</script>',
    '+const a = "<b>" && 1 < 2;',
  ].join('\n');
  store.addRevision('xss', {
    title: '<script>alert("title")</script>', project: '"><svg onload=alert(1)>', upstream: 'javascript:alert(1)',
    patch,
    notes: '# Summary\n\n<script>alert("notes")</script> [x](javascript:alert(1))\n\n# Walkthrough\n\n## <img src=x onerror=alert(1)>.js\n\n<iframe src=//evil></iframe>\n\n# PR description\n\n</textarea><script>alert("pr")</script>',
    commits: [{ sha: 'abc', author: '<b>me</b>', date: '', subject: '<script>alert("subject")</script>', body: '</pre><script>x</script>' }],
    info: { source: 'patch', branch: '<script>b</script>', stats: { files: 1, additions: 2, deletions: 0 } },
  }, { create: true });
  server = createServer({ token: TOKEN });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

test.after(() => server.close());

test('pages render with security headers', async () => {
  const home = await request('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(home.headers['x-content-type-options'], 'nosniff');
  const page = await request('GET', '/r/evil');
  assert.equal(page.status, 200);
  assert.match(page.body, /Retry feed downloads|Sample/);
  assert.match(page.body, new RegExp(`content="${TOKEN}"`));
  const css = await request('GET', '/static/app.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);
});

test('hostile titles, paths, notes, diff lines and commits are escaped', async () => {
  const page = await request('GET', '/r/xss');
  assert.equal(page.status, 200);
  const b = page.body;
  // The only script tag is our own.
  assert.deepEqual(b.match(/<script[^>]*>/g), ['<script src="/static/app.js">']);
  assert.doesNotMatch(b, /<img|<iframe|<svg onload/i);
  // Event handlers outside quoted (escaped) attribute values would be live.
  assert.doesNotMatch(b.replace(/"[^"]*"/g, "\"\""), /<[a-z][^>]*\son[a-z]+=/i);
  assert.doesNotMatch(b, /href="javascript:/i);
  assert.match(b, /&lt;\/td&gt;&lt;\/tr&gt;&lt;script&gt;alert\(&quot;line&quot;\)&lt;\/script&gt;/);
  assert.match(b, /&lt;\/textarea&gt;&lt;script&gt;/);
  const home = await request('GET', '/');
  assert.deepEqual(home.body.match(/<script[^>]*>/g), ['<script src="/static/app.js">']);
});

test('POST without the token is refused and nothing is saved', async () => {
  const before = store.loadDecision('evil').comments.length;
  const r = await request('POST', '/api/r/evil/comment', { headers: { 'content-type': 'application/json' }, body: { kind: 'general', body: 'hi' } });
  assert.equal(r.status, 403);
  const wrong = await request('POST', '/api/r/evil/decision', { headers: { ...json, 'x-prdesk-token': 'nope' }, body: { status: 'approved' } });
  assert.equal(wrong.status, 403);
  assert.equal(store.loadDecision('evil').comments.length, before);
  assert.equal(store.loadDecision('evil').status, 'pending');
});

test('cross-origin and form posts are refused even with a token', async () => {
  const cross = await request('POST', '/api/r/evil/decision', { headers: { ...json, origin: 'https://evil.example' }, body: { status: 'approved' } });
  assert.equal(cross.status, 403);
  const site = await request('POST', '/api/r/evil/decision', { headers: { ...json, 'sec-fetch-site': 'cross-site' }, body: { status: 'approved' } });
  assert.equal(site.status, 403);
  const form = await request('POST', '/api/r/evil/decision', { headers: { 'x-prdesk-token': TOKEN, 'content-type': 'application/x-www-form-urlencoded' }, body: 'status=approved' });
  assert.equal(form.status, 415);
  assert.equal(store.loadDecision('evil').status, 'pending');
});

test('DNS rebinding: unknown Host headers are refused', async () => {
  const r = await request('GET', '/', { host: `evil.example:${port}` });
  assert.equal(r.status, 421);
  const ok = await request('GET', '/', { host: `localhost:${port}` });
  assert.equal(ok.status, 200);
});

test('path traversal is refused', async () => {
  for (const p of [
    '/static/../package.json', '/static/..%2Fpackage.json', '/static/%2e%2e/package.json', '/static/app.js%00',
    '/r/..%2F..%2Fetc/raw/1/patch.diff', '/r/evil/raw/1/..%2F..%2Fmeta.json', '/r/evil/raw/1/decision.json',
    '/r/evil/raw/..%2F1/patch.diff', '/r/%2e%2e', '/r/evil/raw/1/%2e%2e%2f%2e%2e%2fmeta.json', '/static/server.js',
  ]) {
    const r = await request('GET', p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.doesNotMatch(r.body, /"schema"|"name": "prdesk"/);
  }
  const ok = await request('GET', '/r/evil/raw/1/patch.diff');
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /text\/plain/);
});

test('comments, checklist and decision through the API', async () => {
  const general = await request('POST', '/api/r/evil/comment', { headers: json, body: { kind: 'general', body: 'Overall fine' } });
  assert.equal(general.status, 200);
  const line = await request('POST', '/api/r/evil/comment', { headers: json, body: { kind: 'line', file: 'kestrel/cli.py', side: 'new', line: 10, body: 'Why 3?' } });
  assert.equal(line.status, 200);
  assert.match(JSON.parse(line.body).comment.lineText, /--retries/);
  const badLine = await request('POST', '/api/r/evil/comment', { headers: json, body: { kind: 'line', file: 'kestrel/cli.py', side: 'new', line: 999, body: 'x' } });
  assert.equal(badLine.status, 400);
  assert.equal((await request('POST', '/api/r/evil/checklist', { headers: json, body: { key: 'scope', checked: true } })).status, 200);
  assert.equal((await request('POST', '/api/r/evil/seen', { headers: json, body: { revision: 1 } })).status, 200);
  assert.equal((await request('POST', '/api/r/evil/decision', { headers: json, body: { status: 'maybe' } })).status, 400);
  assert.equal((await request('POST', '/api/r/evil/comment', { headers: json, body: '{bad json' })).status, 400);
  const dec = await request('POST', '/api/r/evil/decision', { headers: json, body: { status: 'approved', message: 'Ship it' } });
  assert.equal(dec.status, 200);
  const d = store.loadDecision('evil');
  assert.equal(d.status, 'approved');
  assert.equal(d.message, 'Ship it');
  assert.equal(d.comments.length, 2);
  const page = await request('GET', '/r/evil');
  assert.match(page.body, /Why 3\?/);
});

test('unknown review and oversized bodies', async () => {
  assert.equal((await request('GET', '/r/missing')).status, 404);
  assert.equal((await request('POST', '/api/r/missing/comment', { headers: json, body: { body: 'x' } })).status, 404);
  const big = await request('POST', '/api/r/evil/comment', { headers: json, body: JSON.stringify({ kind: 'general', body: 'x'.repeat(400 * 1024) }) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
});
