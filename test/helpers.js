'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Points PRUDENT_HOME at a fresh temporary folder and returns it.
function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prudent-test-'));
  process.env.PRUDENT_HOME = dir;
  return dir;
}

function samplePath(name) {
  return path.join(__dirname, '..', 'samples', 'demo', name);
}

function addSampleReview(id, store, rev = 'v1') {
  const { parsePatch, parseMbox, totals } = require('../src/patch');
  const patch = fs.readFileSync(samplePath(`${rev}.patch`), 'utf8');
  return store.addRevision(id, {
    title: 'Sample', project: 'Sample project', upstream: 'https://example.org/sample',
    patch, notes: fs.readFileSync(samplePath(`notes-${rev}.md`), 'utf8'), commits: parseMbox(patch),
    info: { source: 'patch', stats: totals(parsePatch(patch)) },
  }, { create: !store.exists(id) });
}

module.exports = { tempHome, samplePath, addSampleReview };
