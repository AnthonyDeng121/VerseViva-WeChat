const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../dist');
if (!fs.existsSync(root)) throw new Error('请先运行 npm run build:weapp');
let bytes = 0;
let files = 0;
function inspect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) inspect(file);
    else {
      if (/\.(mp3|wav|flac|m4a|ogg|webm|aac|pt|pth|onnx|sqlite3|pem)$/i.test(file)) {
        throw new Error(`小程序包不允许包含音频、模型、数据库或密钥：${path.relative(root, file)}`);
      }
      bytes += fs.statSync(file).size;
      files += 1;
    }
  }
}
inspect(root);
// Conservative engineering budget, not a substitute for DevTools package analysis.
if (bytes > 2 * 1024 * 1024) throw new Error(`未分包产物超过工程预算 2 MiB：${bytes} bytes`);
console.log(`未分包产物：${files} 文件，${bytes} bytes（${(bytes / 1024).toFixed(1)} KiB），无音频/模型/私有数据。`);
