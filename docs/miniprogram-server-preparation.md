# 同机服务器配置准备（2026-10-15）

## 2026-10-16 最新核对与 HTTPS 准备

- 用户最新要求覆盖此前不启用 GLM 的决定：沿用原网页版有效 GLM 配置。已在服务器内部读取旧容器实际 Settings，复制并比对 Key、model、base_url、timeout 四项，确认一致；不打印值，AppSecret 保留，发布检查不变。隐私草稿重新加入 GLM 文字建议的数据说明，GLM 提供者/区域/条款仍需真实核对，不能因有 Key 即记作已审核。
- Docker 首次构建暴露 Web 引用 shared 而 Dockerfile 未 COPY 的遗漏，已补 `COPY shared/ /app/shared/` 并传入共享源码后重新构建。未改界面；完整镜像构建与旧站镜像独立，不修改原站运行容器。
- 安装阶段发现 Triton 大包后一度主动停止检查；核对原镜像确认 triton 3.8.0 是 WhisperX 声明的依赖，不据其存在推断 CUDA PyTorch 被安装。保留该依赖，新增 requirements-whisperx-cpu.txt 固定 CPU wheel，并在 Docker 构建中断言 torch.version.cuda is None 后重新构建，不静默删除原版能力。
- 最终本轮验证：隐私/发布定向测试 25 项通过（3.74 秒）、Ruff、JSON 与 diff 检查通过；隐私 TXT 为有效 UTF-8 且小于 100 KB。第三次完整构建的 Web、模型环境安装、CPU 断言及应用安装步骤全部完成，但卡在 exporting layers，数次检查无日志进展且镜像标签未生成。一次 SSH 检查连接关闭，随后重连原站健康返回 200。按用户对异常长时间无进展命令的约束，已向本次微信 docker build 发送 SIGINT 停止，不无限重试，等待用户手动继续。没有启动微信服务、没有将 503 路由改为 API 转发，不能称镜像完整构建成功或部署完成。服务器保留 `build-wechat.log` 供后续定位，不重跑 Hero Pipeline。
- 用户随后确认已取得素材授权，因授权人隐私要求不披露证明，并要求按已授权继续。以最新陈述覆盖此前无授权状态；记录为 operator attestation、私人保管、未独立核验，不索要私人文件。`deploy/wechat-operator-attestations.json` 仅记录确认事实，实际授权文件不进仓库。服务器单独 `release-review.operator.json` 的素材条目按用户授权声明记录实际项目用途，标记 independentlyVerified=false；其余审核条目仍 pending，样例清单未改为通过。
- 三首 Hero 的 18 个指定文件已从旧容器只读复制到微信版 `hero-staging`，38427386 bytes，生成 SHA-256 清单；没有复制原站数据库、用户录音或会话密钥，尚未公开这些文件。用户另确认微信三个合法域名已保存成功，真机访问尚待测。
- Docker 构建忽略新增 `.env.*`、PEM、临时目录、客户端产物及准备资源/操作记录，防止密钥或无关资源进入构建上下文。
- AppSecret 已由用户在服务器隐藏输入；复查仅输出存在性，确认已配置，GLM 为空，发布检查仍开启。
- 用户确认 Google AI Studio 已关联有效计费账户、美区 Google 账户。此为用户提供的信息；付款方式不写入公开隐私文档，不据此推断实际服务主体、处理区域或大陆/未成年人适用性。
- 用户明确三首歌曲片段没有授权，不能把旧站缓存当作公开发布许可，素材审核继续未通过；未复制歌曲或运行 Hero Pipeline。
- 实测子域名 HTTPS 握手失败，原因是原 Caddy 未包含该站点。已将原配置备份到微信版独立目录，验证合并配置后热重载，保留原站点块，追加 `deploy/Caddyfile.wechat-pending` 对应的临时 503 响应。它只用于 HTTPS 可达性检查，不是后台已上线或健康接口，不转发请求、不开放音频、不关闭发布检查。后台正式就绪后再替换为反向代理路由。
- 微信服务仍未启动；腾讯云 DNS 解析添加成功不等于微信公众平台三个合法域名已保存，后者尚需确认。
- 最终实测：子域名正常验证 TLS 并返回预期 HTTP 503 及明确未启用文本；原站 `/api/v1/health` 返回 200。首次从 `/etc/caddy/Caddyfile` reload 被 Caddy 判为 unchanged：现有容器的单文件 bind mount 仍看到旧文件内容，随后将完整候选配置复制到容器 `/tmp/wechat-ingress-candidate` 并从该文件 reload 成功。宿主机原路径已保存合并版本；后续 reload 须显式复制并使用完整新配置，避免读取旧挂载内容。本轮没有重启原站容器。

用户本轮明确授权配置并推进微信版部署；原站保护、禁止改界面和不 push 继续有效。实际尚未启动微信服务、修改现有 Caddy 或签发子域名证书，不称部署完成。

## 实际核对与已完成准备

- SSH 只读核对现有服务器：公网 43.160.230.111，子域名 wechat-api.verseviva.top 解析一致；内存约 7685 MiB，当时 available 6641 MiB，磁盘余量约 43 GiB。此为检查时快照，不承诺双 Pipeline 并行容量。
- 原容器 verseviva-app-1 健康，verseviva-caddy-1 占用 80/443，网络 verseviva_default。未修改原应用文件或用户卷。
- 只输出配置存在性：原站 Gemini Key 与 GLM Key 均配置；没有微信 AppSecret。不能由配置存在推断历史每次调用成功。微信版明确不启用 GLM。
- 新建 /home/ubuntu/verseviva-wechat（权限 0700），上传并校验源码归档 SHA-256。未复制原站数据库、用户录音、身份密钥或商业 Hero 素材。
- 新目录 .env.wechat 权限 0600；仅在服务器内部复用原站 Gemini Key 及已配置模型参数，不打印密钥；GLM 为空，AppSecret 留待操作者填写；发布检查、资源门禁保持开启。未复制旧 .env 文件。账户配额/计费仍可能共享。
- compose.wechat.samehost.yaml 为同机部署替代入口，不能与原 compose.wechat.yaml 合并使用。微信 app 使用全新卷、单 worker，限 3 GiB 内存/1 CPU，Docker 日志最多 3×10 MB；无宿主机端口发布，通过已有网络的唯一别名 verseviva-wechat-api 接入 Caddy。该网络与原站共享，不宣称网络完全隔离。
- 服务器 .env.compose 已设置 WECHAT_INGRESS_NETWORK=verseviva_default；docker compose config --quiet 通过。没有运行 up/build，也没有新建运行时数据卷。
- deploy/Caddyfile.wechat-route 是拟追加路由；尚未写入旧站 Caddyfile。实际执行前须备份、验证合并配置、reload，再核验原域名与子域名；旧站站点块保留。
- 本地忽略文件 miniprogram/.env.local 已配置独立 HTTPS origin，生产构建成功（Webpack 9.08 秒）；包检查 24 文件/491481 bytes/480.0 KiB，原生 WXSS 1 文件通过。客户端源码与界面未改。未执行无关整套回归。

## 需要操作者提供的信息

1. 在腾讯云服务器的交互终端运行：

   ```text
   python3 /home/ubuntu/verseviva-wechat/deploy/configure_wechat_secret.py
   ```

   输入 wx18a40d3837dc23ff 对应的 AppSecret 两次，输入隐藏且不进入命令行参数。不要粘贴到聊天。脚本仅更新新目录 .env.wechat，不启动服务；非交互终端会拒绝。填好后只告知“已填写”。

2. 核对 Google AI Studio 中现有 API Key 对应项目是否关联有效计费账户；提供服务方案名称及必要的脱敏证据即可，不提供 Key。代码和服务器配置不能证明计费方案或数据处理合同。还需核对 Gemini 条款对实际地区和用户年龄的适用性；新加坡服务器不解决终端用户地区限制。
3. 确认三首 Hero 是否有公开音频、歌词展示、衍生产物及发送模型处理的授权证据。若无，需要选择有授权/自制素材方案；不能把旧站已有缓存当授权，也不擅自换歌改界面。
4. 告知微信后台三个合法域名是否保存成功、隐私指引最终状态；录音授权与 AI 告知仍需真机核验。正式隐私文档还需确定实际供应商、日志/备份保留安排及申请删除/注销的执行流程。

## 当前启动阻碍

样例 server.release_audit 按预期拒绝：隐私合同、录音同意、AI 提示、处理区域、供应商受众条款、删除/备份、微信平台、Gemini 证据及三首素材授权尚缺。没有修改 pending 为 reviewed，没有关闭检查绕过启动。供应商核对参考：

- https://ai.google.dev/gemini-api/terms
- https://ai.google.dev/gemini-api/docs/available-regions

现有隐私 TXT 仍为草稿；配置准备不替代真实证据，未执行实际模型请求、真实微信登录或设备验收。上述事实核实后继续镜像构建、独立服务启动、Caddy 转发/HTTPS、健康与身份联调，再形成与真实部署一致的隐私说明上传版。
