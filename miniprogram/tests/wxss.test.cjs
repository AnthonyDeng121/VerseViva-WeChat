const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compileWxss, checkWxss } = require('../scripts/check-wxss.cjs');
const compiler = process.env.VERSEVIVA_WCSC;
test('native WXSS compiler rejects the original universal selectors and accepts native component replacements', { skip: !compiler }, (t) => {
  const prefix = path.join(os.tmpdir(), 'verseviva-wxss-');
  const root = fs.mkdtempSync(prefix);
  t.after(() => { assert.ok(path.resolve(root).startsWith(prefix)); fs.rmSync(root, { recursive: true, force: true }); });
  for (const selector of ['*', '.recording-studio > *']) {
    fs.writeFileSync(path.join(root, 'app.wxss'), `${selector} { box-sizing: border-box; }`);
    assert.throws(() => compileWxss(compiler, root, 'app.wxss'), /(?:unexpected token|error at token).*\*/);
  }
  fs.writeFileSync(path.join(root, 'app.wxss'), 'view, text, button { box-sizing: border-box; } .recording-studio > view, .recording-studio > text { order: 10; }');
  assert.equal(checkWxss(compiler, root), 1);
});
