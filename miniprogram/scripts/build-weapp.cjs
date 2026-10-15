const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const child = spawn(process.execPath, [path.join(root, 'node_modules/@tarojs/cli/bin/taro'),
  'build', '--type', 'weapp'], { cwd: root, stdio: 'inherit', windowsHide: true });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  process.stderr.write('构建超过 4 分钟，按长命令限制停止；当前构建尚未通过验收。\n');
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}, 240000);
child.on('error', (error) => { clearTimeout(timer); process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on('close', (code) => { clearTimeout(timer); process.exitCode = timedOut ? 124 : (code ?? 1); });
