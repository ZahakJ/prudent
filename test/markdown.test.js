'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown, renderInline } = require('../src/markdown');

// No tag may appear in output that the renderer did not build itself.
const ALLOWED = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'pre', 'a', 'blockquote', 'hr']);
function assertOnlyOurTags(out) {
  for (const m of out.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)) {
    assert.ok(ALLOWED.has(m[1].toLowerCase()), `unexpected tag <${m[1]}> in ${out}`);
    if (m[0].startsWith("</")) continue;
    const attrs = m[2];
    assert.doesNotMatch(attrs, /\son\w+=/i, `event handler in ${out}`);
    if (m[1] === 'a') assert.match(attrs, /^ href="(https?:\/\/|mailto:|#)[^"]*" rel="noopener noreferrer" target="_blank"$/);
  }
}

test('basic formatting', () => {
  assert.equal(renderMarkdown('# Title'), '<h1>Title</h1>\n');
  assert.equal(renderMarkdown('## Sub', { headingOffset: 1 }), '<h3>Sub</h3>\n');
  assert.equal(renderInline('**bold** and *it* and _it_ and `x < y`'), '<strong>bold</strong> and <em>it</em> and <em>it</em> and <code>x &lt; y</code>');
  assert.equal(renderInline('snake_case_name stays'), 'snake_case_name stays');
  assert.equal(renderInline('[docs](https://example.org/a?b=1&c=2)'), '<a href="https://example.org/a?b=1&amp;c=2" rel="noopener noreferrer" target="_blank">docs</a>');
  assert.equal(renderInline('see https://example.org/x.'), 'see <a href="https://example.org/x" rel="noopener noreferrer" target="_blank">https://example.org/x</a>.');
});

test('lists, nesting, code blocks, quotes', () => {
  const out = renderMarkdown('- a\n- b\n  - c\n  - d\n- e\n\n1. one\n2. two\n\n```kotlin\nval x = "<b>"\n```\n\n> quoted\n\n---');
  assert.match(out, /<ul>\n<li>a<\/li>\n<li>b\n<ul>/);
  assert.match(out, /<li>c<\/li>\n<li>d<\/li>/);
  assert.match(out, /<ol>\n<li>one<\/li>/);
  assert.match(out, /<pre class="md-code" data-lang="kotlin"><code>val x = &quot;&lt;b&gt;&quot;<\/code><\/pre>/);
  assert.match(out, /<blockquote>\n<p>quoted<\/p>/);
  assert.match(out, /<hr>/);
  assertOnlyOurTags(out);
});

const ATTACKS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '[click](javascript:alert(1))',
  '[click](JaVaScRiPt:alert(1))',
  '[click](&#106;avascript:alert(1))',
  '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[click](vbscript:msgbox)',
  '[x](https://ok.example" onmouseover="alert(1))',
  '[x](https://ok.example/"><script>alert(1)</script>)',
  '`<script>`',
  '**<b onclick=alert(1)>bold</b>**',
  '```\n</code></pre><script>alert(1)</script>\n```',
  '# <svg onload=alert(1)>',
  '- <iframe src=//evil>',
  '> <style>body{display:none}</style>',
  'https://example.org/"onmouseover="alert(1)',
  '<!-- comment --> <![CDATA[x]]>',
  '\\<script\\>',
  '[a](<javascript:alert(1)>)',
];

for (const attack of ATTACKS) {
  test(`XSS attempt is inert: ${attack.slice(0, 40)}`, () => {
    const out = renderMarkdown(attack);
    assertOnlyOurTags(out);
    assert.doesNotMatch(out, /<script|<img|<iframe|<svg|<style/i);
    assert.doesNotMatch(out, /href="(?!https?:|mailto:|#)/i);
  });
}

test('unsafe links keep their text but lose the link', () => {
  assert.equal(renderInline('[click](javascript:alert(1))'), 'click');
});
