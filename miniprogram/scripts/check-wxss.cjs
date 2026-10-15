const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function compileWxss(compiler, root, file) {
  const result = spawnSync(compiler, ['-lc', file, '-o', process.platform === 'win32' ? 'NUL' : '/dev/null'], {
    cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  if (result.error) throw new Error(`WXSS 编译器启动失败：${result.error.message}`);
  if (result.status !== 0) throw new Error(`WXSS 编译失败：${file}\n${result.stderr || result.stdout || `退出码 ${result.status}`}`);
}
function checkWxss(compiler, root = path.resolve(__dirname, '../dist')) {
  if (!compiler || !fs.existsSync(compiler)) throw new Error('请通过 --compiler 参数或 VERSEVIVA_WCSC 指定微信开发者工具内的 wcsc 可执行文件。');
  if (!fs.existsSync(path.join(root, 'app.wxss'))) throw new Error('缺少 dist/app.wxss，请先成功构建小程序。');
  let files = 0;
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && file.endsWith('.wxss')) {
        compileWxss(compiler, root, path.relative(root, file)); files++;
      }
    }
  }
  visit(root); return files;
}
if (require.main === module) {
  const flag = process.argv.indexOf('--compiler');
  const compiler = flag >= 0 ? process.argv[flag + 1] : process.env.VERSEVIVA_WCSC;
  console.log(`微信 WXSS 编译通过：${checkWxss(compiler)} 个样式文件。`);
}
module.exports = { compileWxss, checkWxss };
