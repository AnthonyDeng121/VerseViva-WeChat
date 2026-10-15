const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkPackage } = require('../scripts/check-package.cjs');

function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'verseviva-package-');
  const root = fs.mkdtempSync(prefix);
  t.after(() => { assert.ok(path.resolve(root).startsWith(prefix)); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (name, value = 'content') => {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
  };
  return { root, write, complete() {
    write('app.json', JSON.stringify({ pages: ['pages/index/index'] }));
    for (const file of ['app.js', 'app.wxss', 'project.config.json', 'pages/index/index.js', 'pages/index/index.json', 'pages/index/index.wxml']) write(file);
  } };
}
test('config-only dist is rejected with the missing app.json and rebuild instruction', (t) => {
  const f = fixture(t); f.write('project.config.json', '{}');
  assert.throws(() => checkPackage(f.root), /缺少 app.json.*npm run build:weapp/);
});
test('all declared page outputs must exist before a package is accepted', (t) => {
  const f = fixture(t); f.complete();
  f.write('app.json', JSON.stringify({ pages: ['pages/index/index', 'pages/missing/index'] }));
  assert.throws(() => checkPackage(f.root), /缺少 pages\/missing\/index.js/);
});
test('a complete package passes while unsafe paths and forbidden assets remain rejected', (t) => {
  const f = fixture(t); f.complete(); assert.equal(checkPackage(f.root).files, 7);
  f.write('app.json', JSON.stringify({ pages: ['../outside'] }));
  assert.throws(() => checkPackage(f.root), /非法产物路径/);
  f.complete(); f.write('private.mp3');
  assert.throws(() => checkPackage(f.root), /不允许包含音频/);
});
