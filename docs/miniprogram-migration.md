# 小程序工程与复用边界（2026-10-14）

## 当前范围

首项实现建立 `miniprogram/`，采用 Taro 4.3.0、React 18.3.1、TypeScript 5.7.3 和 Webpack 5.91.0。
Taro 包统一版本，按 npm peerDependencies 选择 React 18 与 Webpack 5，不复制 Web 依赖。
2026-10-15 npm 安装完成并生成 `miniprogram/package-lock.json`，直接和传递依赖均已锁定。首次构建发现 Babel React preset 缺失，已显式补齐 `@babel/preset-react@7.25.9` 和 `react-refresh@0.14.2`；React preset 在 `babel-preset-taro` 中属于可选 peer，npm 安装成功不意味着所选 React 框架的编译依赖自动完整。
配置依据 [Taro 编译配置](https://docs.taro.zone/docs/config/)；独立安装，不修改 Web 的依赖锁。

首页、逐句练习、练习记忆三个页面已声明路由，首页通过 `Taro.navigateTo` 打开后两页。
练习和记忆页当前只有空状态，没有接入歌曲、录音、分析或历史数据，不能作为完整产品验收。
工程最初未填写 AppID；用户现已通过开发者工具填写本地配置，其账号能力未核验，也不默认连接原 Web 生产入口。
`project.config.json` 保留域名检查；微信开发者工具导入 `miniprogram/`，构建目录是 `dist/`。
真实账号、基础库版本和真机运行仍待后续验证。

## 代码盘点

| 原入口 | 浏览器依赖/职责 | 小程序处理边界 |
| --- | --- | --- |
| `web/src/main.tsx` | ReactDOM、document、HTML 表单/文件选择、fetch/FormData、localStorage、window.confirm、HTMLAudioElement、DOM 滚动 | 小程序页面与 View/Text/Button 等组件重新实现；后续用微信存储、弹窗、网络和音频服务替代 |
| `web/src/RecordingStudio.tsx` | getUserMedia、MediaRecorder、MediaStream、Blob/Object URL、HTMLAudioElement、浏览器安全上下文、下载链接、fetch 和轮询 | 稳定的录音管理服务、临时文件上传/受控下载、生命周期恢复；属于清单第 2–6 项，当前未实现 |
| `web/src/MixTimeline.tsx` | AudioContext、AudioBufferSourceNode、共享时钟、PointerEvent、pointer capture、HTML 滑块 | 时间计算共享；拖动与尺寸查询重写；服务端混音和微信 WebAudio 能力另验，不直接复用组件 |
| `web/src/PracticeFeedback.tsx` | HTML/React 反馈布局，类型来自录音组件 | 反馈 Schema 可后续提取；卡片用小程序组件重建，保留失败与证据不足区别 |
| `web/src/styles.css` | HTML 选择器、Web 布局与交互样式 | 不整体导入；当前小程序使用独立 CSS，经 Taro 转换设计尺寸 |
| `web/src/songTypes.ts` | 无浏览器依赖的 Song/Job/Hint/Vocal 类型 | 已提取至 `shared/songTypes.ts`，Web 保留原导入入口 |
| `web/src/audioTimeline.ts` | 时间放置、偏移、句循环、lane 文本投影、声部行对齐、练习预估、录音状态转换 | 已提取至 `shared/audioTimeline.ts`，两端通过再导出复用同一实现 |

`main.tsx` 中 `projectSentence`、`crossesParentheticalLane` 等更复杂的标记投影仍在 Web 内。
移植技巧页时需独立提取并验证字符索引、日韩罗马音与跨 lane 边界，不把当前文字 lane 投影等同于完整标记移植。
现有录音状态机只是 Web 基线，尚未包含微信倒计时/后台中断事件，不代表第 5 项完成。

## 共享层规则

```text
shared/（纯类型和纯函数）
  ↑ web/src 的兼容导出
  ↑ miniprogram/src/domain 的统一导出
```

共享层不引用 React、DOM、Taro、网络、存储和播放器；平台服务和 UI 留在各自客户端。
Web 现有导入与测试入口保留，后端 API、数据库及原始录音不变。
共享函数保留偏移方向：正补偿令录音更早，单位从 ms 转为秒；不把 Web 默认 500 ms 写成微信已校准值。
Node 的纯逻辑回归与 Web 的 Vitest 回归分别用于共享层和原调用链验证。

## 资源与包预算

- 当前工程不复制 Hero、模型、用户音频、数据库或密钥；后续音频通过独立配置的 HTTPS 后端获取。
- 当前三个页面放在主包，没有在未测量前引入分包。
- `npm run check:package` 遍历构建产物，报告文件数与字节数，拦截音频/模型/数据库/PEM，并使用 2 MiB 保守工程预算。
- 该预算不是官方压缩包测量结果；开发者工具包分析和正式平台限制仍需发布前核对。超预算后依据真实模块体积拆分练习/记忆子包。
- 依赖、dist、Taro 缓存及开发者工具私有配置均已忽略；项目内不保存供应商 Key。

## 本地命令

```powershell
cd miniprogram
npm.cmd install --no-audit --no-fund
npm.cmd run typecheck
npm.cmd run build:weapp
npm.cmd run check:package
npm.cmd run test:shared
```

`test:shared` 使用 Node 内置 TypeScript 类型擦除与测试运行器，建议 Node 22.18+ 或 24。
本轮实际使用 Node 24.19.0。类型检查、小程序构建、包大小检查、共享回归 3 项及 `git diff --check` 通过。
三个页面 JS/JSON/WXML 均已生成，未分包产物 23 文件、312206 bytes（304.9 KiB），未检测到包检查脚本禁止的资源；当前无需分包。修复后的 Webpack 编译耗时约 1.35 分钟，首次 CLI 启动另有明显耗时，后续构建先预估 1–3 分钟并根据实际进展更新。
共享代码与原 Web 实现逐文件比对一致（忽略换行）；Web 依赖未安装，本轮未运行 Web test/lint/build。未做开发者工具、真机、页面跳转交互和视觉验收。
构建通过不等于开发者工具/真机验证；第一项也不包含第 2 项网络与第 3 项微信登录实现。
