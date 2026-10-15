# VerseViva 声声不息

**VerseViva 是一个 AI 外语歌曲演唱与分轨练习教练。**

它帮助用户看见原唱在真实演唱中具体省略、合并或改变了哪些声音，也把一遍无法同时唱完的主唱、和声、回应与重叠句拆成可练习的 Vocal 层。用户可以分别录制，再同步叠成一段完整演唱。

> 听懂每一句，唱活每一首。

## 微信小程序改造入口

本目录是原 TME AI Hackathon 项目的微信小程序改造副本，目标为「与 AI 共生」2026 微信小程序开发大赛。
新对话请先阅读 [AGENTS.md 第 0 节](./AGENTS.md#0-当前工作迁移为微信小程序交接基线-2026-10-14)：其中保存了赛事背景、用户已确认的信息、仓库/部署隔离要求、建议技术方向和待办验收清单，无需让用户重新说明背景。

本目录独立 Git 的 origin 指向 `https://github.com/AnthonyDeng121/VerseViva-WeChat.git`；用户已在开发者工具填写本地 AppID，但账号能力未核验、后端 AppID/AppSecret 未配置、备案未确认，尚未部署微信版。
第一项已开始：新增 `miniprogram/`，使用 Taro 4.3.0 + React 18.3.1 + TypeScript 5.7.3 + Webpack 5.91.0，建立首页、逐句练习、练习记忆三个页面和路由。
练习与记忆常规入口仍为空状态，练习页另提供后台任务状态入口；没有歌曲选择/录音/完整分析闭环。`shared/` 保存两端共用的纯类型、时间轴、lane 文本投影和录音状态转换，Web 保留兼容导出。
2026-10-15 依赖安装与锁定完成，并补齐 React Babel 可选依赖；类型检查、小程序构建、包检查、共享逻辑回归 3 项及 `git diff --check` 均通过。三个页面产物已生成，未分包产物为 23 文件、312206 bytes（304.9 KiB），未检测到包检查脚本禁止的音频/模型/数据库/PEM，当前无需分包。修复后的 Webpack 编译约 1.35 分钟。
共享实现已与原 Web 代码逐文件比对一致；Web 依赖尚未安装，本轮未跑 Web test/lint/build。开发者工具与真实微信运行、视觉验收仍待完成，构建通过不等于平台验收。
本地命令、浏览器依赖盘点、资源及分包边界见 [小程序迁移说明](docs/miniprogram-migration.md)。用户已通过开发者工具填写本地 AppID，其账号能力和真实登录未核验；不默认连接原 Web 生产入口。
第二项已新增 `miniprogram/src/network/`：同源 HTTPS 请求、临时文件上传/下载、统一错误、并发续期，以及 Job/Attempt 串行轮询。App/页面隐藏暂停，返回恢复，待处理 ID 按后端与所有者隔离保存；练习页支持任务参数、失败重试与歌曲取消。没有可信登录时私有操作不发送；第三项已接入微信会话管理。
网络配置见 [网络与后台任务说明](docs/miniprogram-network.md)：复制 `miniprogram/.env.example` 为 `.env.local`，填写微信版独立 HTTPS origin；不要填原 Web 生产域名。公众平台 request/upload/download 合法域名尚未配置或真机验证。
Take 上传已补齐 MP3、AAC ADTS 与无标准扩展名的微信临时文件，按真实文件头规范化扩展名和 MIME，保留大小限制、原音频和会话隔离。微信录音生命周期尚未实现，服务端格式兼容不等于真机录音验收。
第二项验证：网络测试 16 项、共享逻辑 3 项、类型检查、小程序构建与包检查、Ruff 和差异格式检查通过；最新包为 25 文件、334635 bytes（326.8 KiB）。后端排除缺少 Hero Profile 的两个旧测试文件后 135 项通过（含实际 MP3/AAC 编码上传）；全量首轮另有 10 项因缺少本地 Hero Profile 失败，未为此运行 Hero Pipeline。合法域名、真实微信身份和真机网络/录音仍待验，Web 回归本轮未跑。
第三项已新增微信登录/me/退出接口、SQLite 稳定身份与可撤销业务 Token，保留 Web Cookie；有效 Bearer 优先，错误 Bearer 不回退匿名身份。补齐 Take 上传/列表、Attempt 列表和混音的歌曲归属门禁，旧匿名记录不自动认领。首页提供微信登录/退出；业务 Token 只在内存，恢复登录会重新 wx.login 核验身份。
第三项验证：微信后端测试 25 项通过，排除上述缺资源测试后后端 160 项通过；客户端登录 9 项、网络 16 项、共享 3 项、类型检查、构建、包检查、Ruff/差异检查通过。最新包为 24 文件、342970 bytes（334.9 KiB）。当前未配置服务器微信凭证，测试使用模拟微信响应；真实换码、账号切换、合法域名和真机仍待验证。配置与安全边界见 [微信身份说明](docs/miniprogram-auth.md)，不能将本地回归当成真实微信登录验收。
第四项选择鉴权下载后本地播放：参考/Take/混音通过临时文件租约管理，退出/换号/过期清理，Token 不放入播放 URL。私有响应防缓存及 Range 隔离测试通过；客户端资源 4 项、相关后端 26 项、类型检查/Ruff 通过，独立构建初始化停滞后中止，待后续统一复验。见 [音频与录音说明](docs/miniprogram-audio.md)。
后续复用 FastAPI 分析后端，重大功能裁剪仍需明确说明。注册与参赛提交当前后置，技术开发可先独立推进。
下文描述的是继承的 Web Demo，不代表微信版已实现或部署；本项目不得写入原工作树、向原 VerseViva 远程推送，或自动覆盖原线上服务。

产品与实现边界以 [AGENTS.md](./AGENTS.md) 为准。主歌词界面只显示 `×`、`‿`、合并桥等字符标记，中文解释与发音动作放在句子展开详情中；重叠人声默认使用左右并列的主 Vocal / 次 Vocal 双轨歌词展示。双轨只是教学视图，底层允许多 Vocal Part、多 Take 叠录，且每条 Take 可独立调节前后偏移和音量。项目不提取或展示音高、音符、音域与音准评分。

当前产品闭环是：看懂发音处理 → 分清 Vocal 层次 → 逐句跟唱和诊断 → 分轨录制重叠人声 → 同步回放 → 记住真实改善。VerseViva 不承诺把任意混合人声自动分离成独立主唱与和声，也不做完整 DAW；Hero Song 的声部边界首先采用人工校对，自动模型结果必须标明为候选。

中文歌曲会根据歌词自动识别，并跳过语言现象 Gemini 核查和练唱 Gemini 诊断。Demucs、WhisperX 时间对齐、Song Profile、播放、纯唱录音、多 Take 对齐、混音和导出仍正常使用。

当前已接通的语言标注链路是：上传歌曲 → LRCLIB 自动查找歌词 → Demucs 人声分离 → WhisperX 词级对齐 → CMUdict/G2P 遍历全部相邻词边界 → Gemini 对候选逐项进行受限核查 → 程序映射为 `×`、`‿`、合并桥 → 点击标记查看中文证据与练习动作。文件名使用 `歌手 - 歌名.mp3` 时可自动推断查词条件，也可在页面补充歌手和歌名。手动歌词优先级最高；LRCLIB 查询失败、匹配不足或与 WhisperX 时间轴无法对上时，会回退到 ASR 歌词，不会让整个任务失败，技巧分析歌词框会明确提示自动识别可能存在较大误差。

这是“任意英文歌曲的候选标注流程”，不是母语级自动音素裁判；弱证据不会进入歌词主界面，Hero Song 仍需人工校对。

## 环境要求

当前已验证开发环境是 Windows 11 + WSL2 Ubuntu：

- WSL Python 3.11（后端和模型工具）
- Node.js 22 / npm 10（前端）
- ffmpeg / ffprobe 4.4+

仓库可以位于 Windows 盘，但所有 Python 虚拟环境都应从 WSL 创建。不要复制旧项目的虚拟环境；虚拟环境中的解释器路径不可迁移。

## 首次安装

在 PowerShell 中进入项目，再打开 WSL：

```powershell
Set-Location 'D:\0Desktop2\项目\VerseViva-Wechat'
wsl -d Ubuntu
```

以下命令在 WSL 中执行：

```bash
cd '/mnt/d/0Desktop2/项目/VerseViva-Wechat'

python3.11 -m venv .venv
.venv/bin/python -m pip install --upgrade pip setuptools wheel
.venv/bin/python -m pip install -e '.[dev]'

python3.11 -m venv .venv-demucs
.venv-demucs/bin/python -m pip install -r requirements-demucs.txt

python3.11 -m venv .venv-whisperx
.venv-whisperx/bin/python -m pip install -r requirements-whisperx.txt

cp -n .env.example .env

cd web
npm install
```

两个模型工具使用隔离环境，因为各自的 NumPy 和 Torch 约束可能冲突。模型权重使用工具自身的公共缓存，不放入 Git。

## 配置

应用只读取 `VERSEVIVA_*` 环境变量。默认配置把 data、jobs、songs 和模型输出都放在仓库的 `./data` 下；模型可执行文件也使用仓库相对路径。

`.env` 是本地文件，不会提交。修改 `.env.example` 时不要加入密钥、本机绝对路径或用户音频路径。

启用 Gemini 语言核查时，在本地 `.env` 设置：

```dotenv
VERSEVIVA_LANGUAGE_ANALYSIS_PROVIDER=gemini
VERSEVIVA_GEMINI_API_KEY=你的本地密钥
VERSEVIVA_GEMINI_MODEL=gemini-3.8-flash
```

默认 provider 是 `disabled`，因此没有密钥时仍可运行 Demucs、WhisperX 和 Profile 流程，但不会自动生成语言标记。密钥不得写入 `.env.example` 或提交到 Git。

LRCLIB 默认启用且不需要 API Key。可通过 `VERSEVIVA_LYRICS_PROVIDER=disabled` 关闭，或用 `VERSEVIVA_LRCLIB_MIN_MATCH_SCORE` 调整自动采用阈值。

分析任务支持断点恢复。Demucs、WhisperX、LRCLIB 和语言模型的完整产物会保存在对应 job 目录；失败后可在前端查看真实阶段与错误详情，并点击“从失败处重试”。重试会校验已有产物的存在性和非空完整性，只重新执行缺失或未成功的阶段。Gemini 的 `429` / `5xx` / 超时等短暂错误会先自动退避重试，仍失败才转为可手动恢复状态。

若 Gemini 明确返回当前服务器区域不支持，歌曲分析不会丢弃已经完成的 Demucs、WhisperX 和歌词产物，而会记录 warning、跳过语言技巧核查并继续生成 Profile。练唱分析仍记录为模型服务 `failed`，但界面只显示一次友好说明，不展示供应商原始错误，也不生成逐句建议或计入 Memory。

歌曲上传进入单 FastAPI 进程内的 FIFO 分析队列。当前 Docker 只启动一个 Uvicorn worker，因此任意时刻最多运行一个 Demucs/WhisperX Pipeline，后续上传保持 `queued`，并向用户显示实时排队位次，避免低配比赛服务器因多个 PyTorch 任务并发而耗尽内存。用户可以取消等待中或正在执行的分析；取消会终止当前模型子进程、继续处理下一项，并清理该歌曲的 Job、输入、中间产物和关联会话数据。该队列不是跨进程队列；若未来增加 Uvicorn worker 或拆分多实例，必须先迁移到 Redis/Celery 等持久任务系统。

## 启动

后端（WSL，仓库根目录）：

```bash
.venv/bin/uvicorn server.main:app --reload
```

### Hero 部署资源包

三首人工校验 Hero 使用独立 ZIP 部署，不在比赛服务器上重新运行整条 Pipeline。
构建包：

```bash
.venv/bin/python scripts/hero_assets.py build
```

默认产物为 `artifacts/verseviva-hero-assets.zip`，包含三首 Hero 的 Profile、网页/模型用 MP3 与
可回退的 WAV 母文件，不包含密钥、SQLite、用户录音或历史 Job。部署到服务器数据卷前恢复：

```bash
.venv/bin/python scripts/hero_assets.py restore artifacts/verseviva-hero-assets.zip \
  --data-dir /app/data
```

恢复时会校验 Hero ID、路径和 SHA-256，防止不完整资源进入演示环境。

使用 Docker Compose 时，在首次启动前把资源直接恢复到命名数据卷：

```bash
docker compose --env-file .env.production run --rm \
  -v "$PWD/artifacts:/artifacts:ro" \
  app python scripts/hero_assets.py restore \
  /artifacts/verseviva-hero-assets.zip --data-dir /app/data
```

- API 文档：http://127.0.0.1:8000/docs
- 健康检查：http://127.0.0.1:8000/api/v1/health

前端（另一个 WSL 终端）：

```bash
cd web
npm run dev
```

前端地址为 http://localhost:5173。Vite 会把 `/api` 代理到 `http://127.0.0.1:8000`。

## 手机公网预发布测试

比赛交付不依赖校园网 IP、同一 Wi-Fi、WSL 或开发者电脑上的 Vite 地址。当前开发阶段使用两层部署：

1. 预发布：在本机构建 H5，由 FastAPI 同源提供页面和 `/api`，再通过临时 HTTPS Tunnel 供手机跨网络测试。
2. 正式比赛：使用同一个 Docker 镜像部署到公网云服务器，绑定固定域名并保留持久数据卷。

先构建前端：

```powershell
cd D:\0Desktop2\项目\VerseViva-Wechat\web
npm.cmd install
npm.cmd run build
```

然后从仓库根目录启动统一 Web 服务：

```powershell
cd D:\0Desktop2\项目\VerseViva-Wechat
python -m uvicorn server.main:app --host 0.0.0.0 --port 8000
```

此时以下内容使用同一个 origin：

```text
/                     React H5
/api/v1/health        健康检查
/api/v1/songs/...     歌曲与 Profile API
/api/v1/takes/...     用户录音 Take API
```

不要再将 Vite 的 `5173` 地址作为比赛或跨网络交付地址。Vite 只用于日常热更新开发。

临时 Tunnel 只用于手机联调，地址会变化且依赖本机在线；比赛提交必须换为固定云服务器和域名。

Windows 上可用一个命令完成前端构建、统一服务启动和临时 Tunnel：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_public_preview.ps1
```

脚本默认等待 WSL/Uvicorn 最多 60 秒；Windows 挂载盘或 WSL 冷启动较慢时可显式延长：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_public_preview.ps1 -StartupTimeoutSeconds 120
```

保持该窗口打开，并使用输出中的最新 `https://...trycloudflare.com` 地址。关闭窗口、按 Ctrl+C、电脑休眠或校园网断线后，临时地址都会失效；重新运行会生成新地址。脚本固定使用 HTTP/2，以绕开校园网常见的 QUIC/UDP 7844 限制。

## Docker 与正式域名

复制生产环境模板，但不要提交密钥：

```powershell
Copy-Item .env.production.example .env.production
```

构建并启动：

```powershell
docker compose --env-file .env.production up --build -d
```

正式部署时把 `SITE_ADDRESS` 改为实际域名，例如 `demo.example.com`，并将域名解析到云服务器公网 IP。Caddy 会作为统一入口将 H5、API 和音频请求转发给 FastAPI。

临时容器 Tunnel 可使用：

```powershell
docker compose --env-file .env.production -f compose.yaml -f compose.tunnel.yaml up --build
```

完整模型镜像包含 Demucs、WhisperX 和 ffmpeg，因此第一次构建时间和镜像体积仍然较大。Dockerfile 会先从 PyTorch 官方 CPU 仓库安装 CPU-only Torch/Torchaudio/Torchvision，避免纯 CPU 比赛服务器下载无用的 CUDA/NVIDIA 运行库。Hero Song 应继续使用预缓存；临时上传应限制为短片段。

### 当前比赛部署（2026-10-11）

- 正式链接：`https://verseviva.top`，跳转到 `https://www.verseviva.top`。
- DNS A 记录目标：`verseviva.top` 与 `www.verseviva.top` 均只指向 `43.160.230.111`。2026-10-11 迁移验收时公共解析仍同时返回旧香港地址 `43.161.219.71`；需在 DNSPod 删除两处旧 A 记录并等待缓存过期。
- 主机：腾讯云轻量应用服务器（新加坡），Ubuntu 24.04 LTS、x86_64、2 vCPU、约 8 GB RAM、80 GB 系统盘，并配置约 6 GB 额外 swap。2026-10-11 已从原中国香港实例原样迁移，以使服务器出口位于 Gemini Developer API 支持区域。
- 入口：Caddy 自动管理 Let's Encrypt HTTPS，80/TCP 自动跳转 443/TCP；443/UDP 仅用于可选 HTTP/3。腾讯云防火墙必须保留 22/TCP、80/TCP、443/TCP 放行。迁移后已使用生产环境文件强制重建 Caddy，定向新加坡 IP 验收为 `www` HTTPS 200、根域名 HTTPS 301、健康接口 `ok`；最小 Gemini 真实生成请求返回 HTTP 200。
- 运行方式：Docker Compose 单 Uvicorn worker；`app` 不直接发布 8000 端口，只通过 Caddy 同源提供 H5、API 与音频。
- 数据：三首 Hero 已恢复到 `verseviva-data`；SQLite、Take 音频与匿名会话密钥均位于持久卷。Caddy 证书状态位于独立持久卷，Hugging Face/Torch 运行期模型缓存位于 `verseviva-model-cache`，重建应用容器时不再重新下载。
- 镜像：完整 CPU 模型基础镜像约 6.51 GB。线上已验证健康接口、Hero Profile/音频、HTTPS 证书、HTTP 跳转和匿名会话隔离。
- 恢复：会话隔离发布前已使用 SQLite backup API 留存数据库快照，并保留发布前镜像标签作为短期回滚点。不得把这些临时回滚点视为自动备份方案。

本次会话隔离首次上线时，服务器下载 Python 包的速度一度只有约 50 KB/s，因此先以已经验证的完整
镜像为基础增加 Python 代码覆盖层。2026-10-10 已从当前仓库完成自包含完整镜像重建、临时容器验收
和生产切换；当前生产镜像不再依赖临时 `pre-*` 镜像标签，旧标签只作为短期回滚点保留。

后续所说的“完整镜像重建”是指：使用已经把稳定系统/模型依赖层放在应用源码层之前的 Dockerfile，
从当前仓库和锁定依赖重新执行正式 Docker 构建，生成一个不依赖临时 `pre-*` 镜像标签、自身即可迁移
和恢复的 `verseviva-app` 镜像。它不要求每次禁用 Docker 缓存，也不要求重新运行三首 Hero Pipeline；
Hero 仍从独立 ZIP 恢复。以后执行同类发布时仍需先验收健康接口、Hero、录音与会话隔离，再按保留策略删除旧覆盖层和回滚标签。

本次完整构建后的重复构建实测约 2 秒，Demucs/WhisperX 模型依赖层、应用层与前端层均命中 Docker
缓存。仅修改 `server/` 或 `scripts/` 时会重建较小的应用安装层，不会重新下载模型依赖；只有模型
requirements、基础镜像或相关安装命令变化时才会使模型层失效。

该公网实例当前适合受控比赛评审，不是已完成全部防滥用能力的公共 SaaS。大范围公开前仍需增加上传与
Gemini 调用限频、每会话配额、监控告警、自动备份/恢复演练和隐私数据保留期清理。

`VERSEVIVA_LANGUAGE_WORKER_URL` 与 `VERSEVIVA_LANGUAGE_WORKER_TOKEN` 已为后续独立 Gemini Worker 预留。当前版本尚未将 Gemini 请求改为远程 Worker；迁移时保持现有 LanguageObservation / VocalCueTiming Schema，不改变前端合同。

## 开发检查

```bash
# 仓库根目录
.venv/bin/pytest
.venv/bin/ruff check server tests

# web/
npm test
npm run build
npm run lint
```

模型工具轻量验证：

```bash
.venv-demucs/bin/demucs --help
.venv-whisperx/bin/whisperx --help
ffmpeg -version
ffprobe -version
```

不要仅为环境验证重复运行完整音频链路。Hero Song 应优先读取 `data/` 中的缓存产物。

## 当前 API

```text
POST /api/v1/songs/analyze
POST /api/v1/auth/wechat/login
GET  /api/v1/auth/me
POST /api/v1/auth/logout
GET  /api/v1/songs/jobs/{job_id}
GET  /api/v1/songs/jobs/latest
POST /api/v1/songs/jobs/{job_id}/retry
DELETE /api/v1/songs/jobs/{job_id}
POST /api/v1/songs/{song_id}/reanalyze
DELETE /api/v1/songs/{song_id}
GET  /api/v1/songs/{song_id}
GET  /api/v1/songs/{song_id}/audio/source
GET  /api/v1/songs/{song_id}/audio/vocals
GET  /api/v1/songs/{song_id}/audio/accompaniment

POST /api/v1/songs/{song_id}/takes
GET  /api/v1/songs/{song_id}/takes?session_id=...
GET  /api/v1/songs/{song_id}/mixdown?session_id=...
GET  /api/v1/takes/{take_id}
PATCH /api/v1/takes/{take_id}
GET  /api/v1/takes/{take_id}/audio
POST /api/v1/takes/{take_id}/analyze
POST /api/v1/takes/{take_id}/analysis-jobs?force=...
GET  /api/v1/takes/{take_id}/attempt
DELETE /api/v1/takes/{take_id}?preserve_attempt=...

GET  /api/v1/songs/{song_id}/attempts?session_id=...
GET  /api/v1/practice/memory?session_id=...
```

公网版本会在首次请求时签发带签名的匿名会话 Cookie（`HttpOnly`、`Secure`、
`SameSite=Lax`）。Hero Profile 和参考音频保持公共只读；用户上传歌曲的 Job/Profile、Take、
录音、Attempt、Memory、混音与删除操作均按 Cookie 会话隔离，跨会话统一返回 404。URL 或表单中的
`session_id` 只为兼容现有前端请求形状，后端不会将其用作身份或授权依据。清理 Cookie、无痕窗口、
更换浏览器或设备都会创建新的匿名会话，因此不会恢复原会话记录。

Take 上传接受浏览器常见的 WebM、MP4/M4A、OGG 和 WAV。Hero 网页播放与下载优先使用 MP3，
内部仍保留 WAV 母文件用于音频分析和降级，不应把所有内部音频描述成 MP3。

## Demo 定型状态

已缓存的用户上传歌曲支持删除和基于原始上传文件重新分析；删除会同时清理该会话下的歌曲派生产物、录音与练唱记录，Hero 示例不允许删除。歌曲分析阶段预估采用当前公网 CPU 实测基准，实际耗时仍会随片段内容和外部模型响应变化。

当前已经完成歌曲分析、三首 Hero 预缓存、语言标记、双轨歌词、用户录音、多 Take、共享音频时钟、
拖拽对齐、音量/静音、PracticeAttempt 前后比较、Memory 聚合、SQLite 持久化、结构化阶段耗时和
API 调用计数。前端已开始按职责拆分，并为多轨时间计算、偏移方向、循环边界与录音状态机增加测试。
多轨窗口支持拖动播放起点和实时总增益；新录音默认应用 500 ms 隐式延迟补偿。浏览器录音保留原格式，
送入 Gemini 前只生成临时的 16 kHz、64 kbps 单声道 MP3 兼容副本。
Take 上传会依据文件头识别实际容器；例如内容实际为 M4A/MP4、但文件名误写成 `.webm` 时，后端会规范化为 `.m4a` 和 `audio/mp4` 后继续处理。
WhisperX 词级时间继续用于内部语言分析，但歌词播放界面只按整句高亮。自行上传建议控制在 60 秒以内，
以减少模型计算成本和用户等待时间；开始录音后页面会切到技巧分析，录音结束后返回演唱页。
麦克风授权完成后会切到技巧分析页倒计时 3 秒，再同步启动录音和参考音频。Gemini Files 偶发处理失败会自动有限重试，
最终失败时会区分用户录音与参考人声文件，便于定位问题。
练唱请求会为每个语言目标显式传递符号、参考动作、标准/实际读音、结构变换和人工解释；提示词明确区分
`×` 吞音、`‿` 改音式连读与 `└─┘` 二合一，不依赖 Gemini 自行猜测符号含义。
可用录音若被 Gemini 返回为空或全部“不确定”，后端会将其视为临时模型异常并有限重试，避免产生没有反馈的假成功。
已保存音轨摘要和练习反馈会按 Take 的主/次轨分别投影歌词，主轨不会显示括号中的副轨文本。
近数字静音的录音会在调用 Gemini 前由 ffmpeg 峰值检查拦截，不会生成“没有发现差异”的假结论。
前后比较按同一句、同一主/次轨查找最近可靠记录，即使两次选择的句子范围不同也能延续记忆；界面的 Memory 数字明确表示本会话累计。
录音预览支持“仅分析”和“分析并保存”：两者都保存 PracticeAttempt 并更新长期 Memory；前者分析完成后只删除临时录音和 Take，不进入正式音轨列表。已保存音轨也可由用户删除。
次轨多句分析一次覆盖全部所选 Vocal Part，并以对应主轨句首作为各次轨时间锚点；Gemini 不得否定歌词提供方确认的括号声部文本。
次轨核查目标直接取自 Song Profile 已确认的具体标记、目标词和发音动作；若混合 vocals 参考让所有目标都无法判断，会自动切换 Plan B，仅根据用户录音和这些确定目标核查。
练唱分析使用短请求启动后端任务，前端每 2 秒轮询 Attempt；长录音的 Gemini 请求不会再因单个长连接中断而直接显示分析失败。分析期间界面按“仅分析”或“分析并保存”分别显示按钮状态、已等待时间和基于录音时长的粗略预估；用户界面不暴露内部降级方案名称。开发期热重载若终止任务，会提示“分析任务已中断”并允许重分析。
`trackSlotId` 统一使用固定长度的 lane、起始句、结束句与句数；它仅用于后端识别相同练习范围，不在用户界面展示。选择13句乃至整首歌都不会因标识随句数增长而在 Take 入库前返回500。
已保存音轨区域可下载 192 kbps MP3 整体混音，合成会应用静音、单轨音量、整体音量和时间偏移。
日韩歌曲的标记只显示在罗马音行，详情卡继续显示原文、辅助读音与演唱提示。三首 Hero 的人工校正可通过
`python scripts/curate_hero_hints.py` 幂等重放，校正后需重新构建 Hero 部署包。

截至 2026-10-09，Demo 代码链路已经冻结：后端 117 项与前端 12 项测试通过，Ruff、ESLint、生产构建通过；
Hero ZIP 已在空数据目录完成恢复验收，三首 Profile、H5 入口与音频 Range 请求正常。代码审计未发现仍可稳定
复现的核心链路阻塞。

部署不是只执行 `docker compose up`：先填写 `.env.production` 中的 Gemini Key（GLM Key 可选），再将
`artifacts/verseviva-hero-assets.zip` 恢复到 `/app/data` 对应持久卷，并配置固定域名与 HTTPS。缺少 Key 时
服务仍能启动，但上传歌曲的语言核查和用户练唱诊断不构成完整 Demo。

复赛优化集中在真实 iOS/Android 与弱网验收、录音延迟校准、Gemini 成本/限流监控、浏览器端到端测试、
前端大组件拆分，以及服务器备份与数据保留策略。远程模型 Worker 和持久任务队列等真实并发需要时再部署。

## 数据与版本控制

`data/`、`.env`、虚拟环境、`web/node_modules/`、前端构建产物、模型权重和用户音频均被忽略，不得提交。现有 `data/` 使用仓库内相对布局，历史审计字段可以保留，但运行时配置不得访问旧项目路径。

## 从 VocalCompass 迁移

VerseViva 复用了 VocalCompass 阶段验证过的 Demucs、WhisperX 和 Song Profile 底座，但已经删除音高分析与旧 Difference Engine。旧目录只可作为只读迁移来源；日常启动、测试、模型命令与数据读取均不得依赖旧目录，也不得向旧仓库远端推送。
