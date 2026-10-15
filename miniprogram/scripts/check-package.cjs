const fs = require('node:fs');
const path = require('node:path');
function checkPackage(root = path.resolve(__dirname, '../dist')) {
root = path.resolve(root);
if (!fs.existsSync(root)) throw new Error('请先运行 npm run build:weapp');
function requireFile(name) {
  const file = path.resolve(root, name);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`非法产物路径：${name}`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
    throw new Error(`构建产物不完整，缺少 ${name}；请重新运行 npm run build:weapp 并等待成功后再启动模拟器。`);
  }
  return file;
}
for (const file of ['app.json', 'app.js', 'app.wxss', 'project.config.json']) requireFile(file);
const app = JSON.parse(fs.readFileSync(requireFile('app.json'), 'utf8'));
if (!Array.isArray(app.pages) || !app.pages.length) throw new Error('app.json 缺少页面入口，请重新构建。');
const pages = [...app.pages];
for (const group of app.subPackages ?? app.subpackages ?? []) {
  for (const page of group.pages ?? []) pages.push(`${group.root}/${page}`);
}
for (const page of pages) {
  if (typeof page !== 'string') throw new Error('app.json 页面入口格式错误。');
  for (const extension of ['js', 'json', 'wxml']) requireFile(`${page}.${extension}`);
}
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
return { files, bytes };
}
if (require.main === module) {
  const { files, bytes } = checkPackage();
  console.log(`入口及页面完整；未分包产物：${files} 文件，${bytes} bytes（${(bytes / 1024).toFixed(1)} KiB），无音频/模型/私有数据。`);
}
module.exports = { checkPackage };
