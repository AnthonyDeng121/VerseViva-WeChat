# 小程序网络、文件与任务（2026-10-15）

## 已实现的接口与边界

`miniprogram/src/network/client.ts` 是不依赖微信运行时的请求核心；`taroTransport.ts` 将它适配为
Taro request/uploadFile/downloadFile，避免在页面复制 fetch、FormData、Cookie 和浏览器 Blob 代码。
`api.ts` 对接现有 Song Job、Take 上传、Practice 后台启动、Attempt 查询和 Take 下载端点。

- JSON 请求超时 20 秒；上传/下载 60 秒。所有接口只能请求配置的同一 HTTPS origin 下的 `/api/v1/`，拒绝任意外链和路径穿越。
- 没有默认后端域名，尤其不默认连接原 Web 生产服务。域名检查保持开启。
- Take 用微信临时 `filePath` 上传，multipart 字段名为 `audio`，额外参数是字符串表单；不手写 multipart Content-Type/boundary，不指定虚假的 WebM 文件名。
- 上传/下载均提供 `abort()`、进度回调；传输进度最高 99%，最终以成功响应为准。失败不会伪装成已上传或成功分析。
- HTTP 状态和 JSON 解析分开判断；失败提示不直接回显服务器 detail、平台 errMsg、URL 或 Token。空/损坏 JSON 和不匹配的任务状态不能算任务完成。
- 原始 Take 不转码、不覆盖；录音格式在后端按字节识别。MP3/AAC 接入不会改变既有 WebM/M4A/OGG/WAV 行为。
- 受控下载返回本地临时路径；下载失败、过期身份或账号切换后的文件会删除。成功文件由播放器/后续文件生命周期管理者释放，当前未实现完整私有音频缓存和播放器（清单第 4–6 项）。
- 网络超时/断线不自动重发 POST 或上传，因为服务端可能已写入；用户重试前应查询已知任务/Take，避免重复创建。只有明确 401 会在续期后重放一次。

参考：[Taro uploadFile](https://docs.taro.zone/en/docs/apis/network/upload/uploadFile)。微信端不依赖该 API 的 H5 专属 fileName 参数。

## 配置与合法域名

复制 `miniprogram/.env.example` 为被 Git 忽略的 `.env.local`，填写：

```dotenv
TARO_APP_API_ORIGIN=https://你的微信版独立后端域名
```

值只包含 HTTPS origin，不加 `/api`、查询参数或供应商密钥。该变量由 Taro 构建时注入；修改后重新构建。
开发者工具导入 `miniprogram/`，构建输出在 `dist/`；`project.config.json` 的现有 AppID 和用户配置保留。
在微信公众平台为真实后端配置 request、uploadFile、downloadFile 合法域名，直接使用最终域名，不依赖重定向。
本轮未获得微信版独立域名、未改公众平台配置、未部署服务器。开发工具关闭域名检查不能替代这项验收。

## 登录续期只是可接入的契约

`apiClient.configureAuth(provider)` 的 `current()` 返回可信登录流程产生的
`{ ownerId, accessToken, expiresAtMs }`；`refresh()` 应更新 provider 中的当前凭证后再返回。
提前 30 秒检查过期；多个同时失败的请求共用一个 refresh；迟到的旧 Token 401 复用已刷新的凭证。
账号变化会使旧响应失效，续期失败不会无限重试。Token 不写入任务记录，不输出日志，不发往第三方资源域名。

实际 `wx.login → code2Session → 业务 Token` 及后端 Bearer 鉴权属于清单第 3 项，**尚未实现**。
当前后端仍是 Web 匿名 Cookie 身份，不能直接设置一个客户端 Token 当作已登录，也不自动模拟或接管 Cookie。
默认没有 AuthProvider，所有私有操作在发送前拒绝。`session_id=miniprogram` 只满足旧表单要求，绝不是授权身份。
只有 health 和白名单中的公共 Hero Profile 可以匿名请求。

## 后台任务与恢复

`SerialPoller` 在上次 GET 完成后约 2 秒发起下一次，避免 interval 叠加请求；隐藏时清除定时器、取消当前请求，返回后立即查询。
App 前后台由 `app.tsx` 绑定；页面 show/hide/unload 通过 `useTask` 绑定，卸载后不再写入页面。
每次隐藏/取消增加代次，丢弃迟到结果；绑定的所有者变化后不继续发送旧任务查询。
网络/超时/429/5xx 最多自动重试三次，逐次退避；401、404、损坏响应停止自动轮询，保留明确的手动入口。

`PendingTasks` 仅持久化任务种类和 ID，按后端 origin 与登录所有者命名空间隔离，最多 20 条。
练习页支持 `?jobId=...` 或 `?takeId=...`；没有参数时，页面返回后查询当前所有者最近的待处理记录。
终态移除待处理记录；取消歌曲必须 DELETE 服务端 Job 后才移除，暂停本地轮询不等于取消服务端任务。
歌曲失败重试使用现有 retry；Practice 失败或任务失踪时，用户明确重试才发起 force 分析。
`failed`、`insufficient_data` 均是终态，但不是可靠成功，不在此层累加 Memory。

目前尚无登录入口、上传选歌入口和录音入口；页面进度路径在可信登录接入后才能做真实私有任务验收。
文件上传函数和后台短请求接口已备好，不代表录音/分析闭环完成。
歌曲分析上传仍沿用后端 MP3/WAV/FLAC 扩展名校验；任意歌曲选择入口的临时文件重命名/选择适配后续实现，本轮优先处理 Take 临时文件。

## 后端录音兼容

`server/api/routes/takes.py` 新增 MP3（ID3 或 MPEG Layer III 帧头）和 AAC ADTS 识别。
MP4/M4A 内部 AAC 仍按 M4A 容器保存；不能仅凭同步字节把 AAC 当成 MP3。
未知临时扩展名可在 MIME 属于允许集合时进入限量流式读取，实际内容必须通过文件头识别；最终规范化存储扩展名和 MIME。
未知内容仍返回 415 并清理临时目录，原 100 MB 上限和会话授权不变。
文件头识别是容器门禁，不等同于完整文件解码验证；后续解码故障应继续如实报告。
测试另用 ffmpeg 生成短 MP3/AAC，真实上传后由 ffprobe 确认 codec，未调用模型或完整 Hero Pipeline。
这些测试证明服务端接受对应编码，不能替代 iOS/Android 真实 RecorderManager 文件验证。

## 验证命令与待验项

```powershell
cd miniprogram
npm.cmd run test:network
npm.cmd run test:shared
npm.cmd run typecheck
npm.cmd run build:weapp
npm.cmd run check:package
```

`test:network` 使用 Node 24 内置测试及实验性的 TypeScript transform 支持，不需要新装测试框架。
本轮使用 Windows Python 3.12.10、Node 24.19.0：网络测试 16 项、共享测试 3 项、类型检查、构建和包检查通过；产物 25 文件、334635 bytes（326.8 KiB）。Ruff 与 `git diff --check` 通过。
后端全量首轮 133 通过、10 失败，均为本地缺少 Hero Profile 的旧测试；新增真实编码两项后，排除 `tests/test_day3_vocal_profile.py` 和 `tests/test_hero_hint_curation.py` 再运行，其余 135 项通过。没有重跑完整 Hero Pipeline、复制原数据或更改这些旧测试来掩盖缺失资源。Web 源码无改动，本轮未运行其 test/lint/build。
实际微信合法域名、弱网、真机临时文件、页面切换、Token 续期和私有文件授权仍待第三项及设备联调。
