# 第十项：独立部署与资源成本

本项只改服务端、配置、测试与文档，客户端界面完全不动。没有部署、连接旧服务器、复制原用户数据或调用收费模型。

## 独立运行边界

`compose.wechat.yaml` 是独立配置，项目名 `verseviva-wechat`，数据、模型缓存和 Caddy 均使用本项目的新卷；不继承原 compose 的可写数据卷。沿用既有 CPU-only Dockerfile，显式 `--workers 1`。独立 Caddy 文件不带原站域名跳转。实际启用前仍需确定独立 HTTPS 域名、端口和服务资源，配置公众平台合法域名、后端凭证与小程序 API origin；当前没有执行启动或发布命令。

将 `.env.wechat.example` 复制为本地 `.env.wechat` 后填写服务器密钥，该文件已忽略。模板开启微信登录与资源门禁；空密钥不是可运行的完整配置。不要把 AppSecret、模型 Key 放入客户端或聊天。`WECHAT_SITE_ADDRESS` 是 Compose 插值变量，需由运行环境显式提供，使用独立域名；模板不替用户选择实际域名。端口已被其他服务占用时，先确定独立反向代理方案再启动。

现有 Web 默认不启用新资源门禁，避免自动改变继承项目行为。微信模板启用 `VERSEVIVA_RESOURCE_LIMITS_ENABLED=true` 后，数据卷运行锁会拒绝同卷第二个服务进程。该锁只约束新版且开启门禁的进程，不是跨主机分布式队列；旧版服务或关闭门禁的进程仍需运维保证隔离。增加 worker 前必须迁移任务调度与资源状态，不能只改参数。

## 服务端门禁

默认值均可通过 `VERSEVIVA_` 环境变量调整：

| 配置后缀 | 默认值 | 实际含义 |
| --- | --- | --- |
| RESOURCE_WECHAT_ONLY | true | 高成本入口要求可信微信身份，防止更换匿名 Cookie 绕开用户预算 |
| RESOURCE_UPLOADS_PER_MINUTE / PER_DAY | 5 / 30 | 每用户上传请求准入次数 |
| RESOURCE_AI_PER_MINUTE / PER_DAY | 3 / 30 | 每用户分析及混音请求准入次数，共用预算 |
| RESOURCE_OWNER_BYTES | 1073741824 | 上传前检查用户已存 Take、所属 Job 和私有 Song 目录，预留单文件完整上限 |
| RESOURCE_MIN_FREE_BYTES | 1073741824 | 上传前额外预留两份文件空间（请求暂存和目标文件），其他高成本请求检查最低空闲空间 |
| RESOURCE_MAX_PENDING_ANALYSIS | 8 | 歌曲排队/运行任务与后台练唱任务合计准入上限 |
| RESOURCE_MAX_SONG_SECONDS / MAX_TAKE_SECONDS | 600 / 600 | ffprobe 实测最大时长，不能使用客户端自报时长代替 |
| MAX_UPLOAD_SIZE_BYTES / MAX_RECORDING_SIZE_BYTES | 104857600 | 保留既有单文件字节上限 |

SQLite `resource-budgets.sqlite3` 使用 `BEGIN IMMEDIATE` 原子检查并写入分钟/UTC 自然日计数，重启不清零；只保留近两天记录。超频返回 429，空间不足 507，大小/时长超限 413，时长不可验证 415。错误不包含凭证或上游原始错误。

门禁在身份中间件内部、FastAPI multipart 解析之前运行。分块上传也累计检查整个请求体（文件上限另加 1 MiB 表单开销），暂存超过 1 MiB 后落盘；单次读取等待最多 15 秒、持续接收约 120 秒。高成本 HTTP 请求准入阶段互斥，忙时返回 429，避免同进程上传存储预留竞态；同步分析/旧混音 HTTP 执行期间也占用此门禁。上传实际入库前用 ffprobe 核验时长，15 秒超时或非法结果拒绝并清理本次文件。

**计数代表准入请求，不代表模型 API 次数或账单。** 无效参数、后续失败、缓存命中、重复任务查询式启动也可能消耗次数；失败不退还，前端不会自动重发写操作。一次分析可能分批和有限重试，真实账单仍须查看供应商控制台。身份验证通过后、资源归属路由校验前计数，因此越权尝试只消耗发起者预算，不能读取其他用户数据。

当前门禁是准入保护，不是完整 CPU/磁盘硬配额：不为进行中的模型输出预留所有磁盘；混音成品未计入用户存储预算；后台任务完成期间仍可能增长。新预览原有单 ffmpeg / 最大 8 个任务限制仍在；旧同步混音与后台预览没有共用渲染信号量，不宣称全局 ffmpeg 并发为 1。需要按本机磁盘观察结果和供应商费用调整预算；公开上线前还需验证容器资源限制及真实负载。

## 离线运维工具

入口：`python -m server.maintenance`。以下路径只是示例，必须换成微信版独立数据目录与受保护的备份目录。先停止该独立服务；工具取得同卷运行锁后工作，未启用门禁的旧进程不能被自动识别。

```text
python -m server.maintenance report --data <微信版数据目录>
python -m server.maintenance cleanup --data <微信版数据目录>
python -m server.maintenance cleanup --data <微信版数据目录> --apply
python -m server.maintenance backup --data <微信版数据目录> --archive <数据目录外的新备份.zip>
python -m server.maintenance restore --data <尚不存在的新目录> --archive <备份.zip>
python -m server.maintenance restore --data <尚不存在的新目录> --archive <备份.zip> --apply
```

- `report`：总空间/空闲空间、分类字节和目录数、UTC 当日准入计数；不输出所有者身份、凭证或用户文件内容。不是实时公开管理接口，也没有自动告警或账单估算。
- `cleanup`：默认只列候选，`--apply` 才删除；仅清理最后修改超过 24 小时的混音产物、无 Take 元数据的录音目录、没有 job.json 的孤立上传目录。只接受规范 ID，拒绝链接/junction，递归删除前校验解析后的目标位于指定数据目录内。不会删除 Hero、已保存 Take、已持久化 Job/Song、Attempt/Memory；混音元数据仍保留，原下载检查会把缺失成品判为失效并要求重建。当前没有定时清理和已保存录音自动过期政策，需等第十一项隐私声明与用户用途确定后再实现，不自行缩短用户数据保留期。
- `backup`：备份整个独立数据目录，包括 SQLite、私有音频、Job/Song、会话密钥及 Token 摘要库；SQLite 用 backup API 生成一致快照，不直接打包 WAL/SHM。ZIP 有逐文件 SHA-256 清单，要求新文件且位于数据目录外；不自动上传。备份包含私有数据及服务端状态，需放在用户有权控制的存储中，Windows 仍需实际配置目录 ACL；没有内置加密、异地副本和自动轮换。
- `restore`：默认完整暂存校验后丢弃；`--apply` 才恢复到一个尚不存在的新目录。拒绝路径穿越、重复成员、符号链接、异常清单和超量归档；核对 SHA-256 与 SQLite quick_check，不覆盖现有目录。恢复后先在独立测试配置验证数量、播放和身份，再由用户决定切换数据卷。恢复备份也恢复当时的业务 Token 摘要，应在正式事故恢复时评估是否撤销存量 Token。

本地回归验证备份→校验→恢复与原始音频/SQLite 内容一致；不等于生产备份恢复演练。上线前仍需用户授权实际部署、设置备份介质/保留期/告警，并验证大陆真机上传下载、模型耗时、容量与费用。未跑 Web/小程序构建，因为其源码与依赖没有变化；不跑完整 Hero Pipeline。
