# 微信身份与数据隔离（2026-10-15）

## 实现范围

本项建立 `wx.login → FastAPI code2Session → 自有业务 Token` 链路，保留浏览器匿名 Cookie。
代码和模拟上游回归不等于真实微信登录成功：当前后端微信开关关闭、AppID/AppSecret 未配置，独立微信版 HTTPS 入口和合法域名也尚未联调。
没有调用微信真实身份接口，没有部署服务器，没有读取或迁移原 Web 用户数据。

## 服务端链路

1. 客户端仅提交 `code`；拒绝额外的 openid、ownerId、session_id、appid 等身份声明。
2. `server/services/wechat_login.py` 固定向 `https://api.weixin.qq.com/sns/jscode2session` 发出 HTTPS 请求，使用服务端配置的 AppID/AppSecret。
3. 一次性 code 不自动重试，不跟随重定向。无效/已用 code、上游限频、超时、损坏响应等统一返回安全错误；不回传供应商原始 payload，也不打印携带 AppSecret/code 的 httpx URL。
4. 返回的 session_key 在服务器校验后直接丢弃，因为本项目不需要解密微信用户资料；不存库、不下发。只将经微信验证的 openid 用于身份映射。
5. `WeChatIdentityStore` 按 `SHA-256(appid + 分隔符 + openid)` 映射一个随机稳定的 `wxuser_...` 所有者。相同微信身份重复登录保持同一所有者，不同 AppID 不共用身份。不存明文 openid，也不关联/认领旧匿名 Cookie 数据。
6. 签发 `vwx1.` 前缀的高熵随机业务 Token；SQLite 仅保存 Token 的 SHA-256 摘要、所有者、AppID 和过期时间。它不是微信 session_key，也不是包含用户资料的 JWT。

身份和 Token 表存放在当前数据目录的 `verseviva.sqlite3`，与现有 Take/Attempt 表共存，不改变旧表归属。
映射与 Token 都是持久数据；重启不丢失，数据库应随独立微信版数据卷备份。过期 Token 在签发时清理；退出可立即撤销当前 Token。其他设备的 Token 独立，到期或各自退出后失效。

参考：[微信 code2Session 官方入口](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html)、[腾讯云 CloudBase 登录说明](https://docs.cloudbase.net/recipes/add-auth-wechat-miniprogram)。官方入口本轮工具未能直接读取，调用行为同时依据已能读取的腾讯云说明和本地回归验证，未声称真实微信验收通过。

## 新增 API

| 方法/路径 | 请求 | 响应 |
| --- | --- | --- |
| `POST /api/v1/auth/wechat/login` | JSON `{ "code": "wx.login 返回值" }` | `{ ownerId, accessToken, expiresAtMs, tokenType: "Bearer" }` |
| `GET /api/v1/auth/me` | `Authorization: Bearer <业务 Token>` | `{ ownerId }` |
| `POST /api/v1/auth/logout` | 相同 Bearer 请求头 | 204，撤销当前 Token |

登录响应和已验证 Bearer 响应使用 `Cache-Control: no-store`；登录/me/退出接口不额外创建匿名 Cookie。
`expiresAtMs` 是毫秒 Unix 时间；服务端 TTL 配置单位是秒，默认两小时。

## 兼容与隔离

`AnonymousSessionMiddleware` 先判断 Authorization：

- 有合法 Bearer：验证数据库、过期时间与当前 AppID，将微信所有者写入现有 `request.state.session_id`；不读 Cookie、不重新签发 Cookie。
- 有 Authorization 但格式错误、Token 不存在/篡改/过期/撤销、微信入口已停用：401，不回退 Cookie 或匿名身份。
- 无 Authorization：继续现有签名 HttpOnly Cookie 路径，保留原 Web 行为。

内部字段名仍叫 session_id，只是兼容存储/API 形状；客户端传入的同名字段始终不参与授权。
`server/services/song_access.py` 将公共 Hero 与私有歌曲的门禁集中管理。
本项补上 Take 上传、Take 列表、歌曲 Attempt 列表和混音入口的歌曲级归属检查；先确认歌曲可访问，再操作派生资源。
直接 Take/音频/Attempt/分析/修改/删除继续要求 Take 归属；Job 查询/重试/取消、私有 Profile/参考音频、重分析和歌曲删除继续要求 Job/歌曲归属。
Memory 从可信所有者聚合，不采纳查询中的 session_id；Hero 参考保持公共，只能读取自己的录音和混音。

旧录音测试的共享参考夹具改为公共 Hero ID，使“两个用户对同一个参考练习”与真实产品边界一致。
新增专项测试独立覆盖私有歌曲、无归属歌曲、Cookie/微信互不认领和跨用户攻击；不是通过放松门禁保留旧测试。

## 小程序会话

`miniprogram/src/auth/session.ts` 实现独立可测试的会话状态机，`auth/index.ts` 对接 Taro.login 和第二项 ApiClient。
首页提供微信登录、进度/失败说明和退出；不请求昵称、头像或手机号。

- 首次访客启动不静默登录；用户点击后获得新 code，再发给自建后端。
- 业务 Token 只保留在内存。持久化仅保存按后端 origin 隔离的所有者提示，用于判断是否恢复登录，不是授权凭证。
- App 再次启动时若有提示，重新调用 wx.login 验证实际身份，不直接信任缓存的 ownerId。若身份变化，清除登录态，要求用户显式登录，再切换到新所有者的任务记录。
- 自动续期与并发请求共享一次换码；同一 code 不重复使用。只有得到同一所有者的新凭证才允许续期后重放旧请求。
- 登录失败、退出、账号变化会通知 React 页面；任务轮询随可信 ownerId 变化清理和恢复。
- 退出先清内存/提示，再撤销捕获的旧 Token，不为退出而触发新登录。若网络阻断，明确提示只在本机退出，服务端旧 Token 到期失效。
- 退出与再次登录会使旧请求代次失效；即使重新登录的是同一用户，迟到结果也不能恢复旧登录态或更新旧任务页面。

录音、保存/删除、Memory 和完整私有播放器 UI 仍按后续清单实现；登录接通不表示这些产品闭环已验收。

## 配置

只在微信版独立后端的本地 `.env` 或部署环境填写：

```dotenv
VERSEVIVA_WECHAT_LOGIN_ENABLED=true
VERSEVIVA_WECHAT_APP_ID=你的真实小程序AppID
VERSEVIVA_WECHAT_APP_SECRET=仅放在服务器的AppSecret
VERSEVIVA_WECHAT_TOKEN_TTL_SECONDS=7200
VERSEVIVA_WECHAT_LOGIN_TIMEOUT_SECONDS=10
```

模板默认 `false`，无配置时登录返回 503，不生成假身份。TTL 允许 60–86400 秒，上游超时允许 0–30 秒（不含 0）。
AppID 必须与开发者工具中实际用于 wx.login 的 AppID 一致；测试号/账号能力限制不能靠假 code 绕过。
小程序只配置 `TARO_APP_API_ORIGIN`；AppSecret/session_key 不能出现在小程序环境变量、代码或构建产物中。
不要对原 Web 服务器直接启用这些配置，不共享可写数据库、录音或 Token 表。

## 验证

```powershell
python -m pytest -q tests/test_wechat_auth.py tests/test_recording_takes.py tests/test_wechat_recording_formats.py --basetemp=.pytest-tmp-wechat-auth
python -m ruff check server tests scripts
cd miniprogram
npm.cmd run test:auth
npm.cmd run test:network
npm.cmd run test:shared
npm.cmd run typecheck
npm.cmd run build:weapp
npm.cmd run check:package
```

测试用 httpx MockTransport/模拟身份提供者，不消耗真实微信 code、模型额度或用户音频。
本轮结果：微信后端 25 项、客户端登录 9 项/网络 16 项/共享 3 项通过；扩大后端回归排除两个既有资源依赖文件后 160 项通过。Ruff、类型检查、生产构建、包检查和 `git diff --check` 通过；产物 24 文件、342970 bytes（334.9 KiB）。Web 代码未修改，Web test/lint/build 本轮未跑。
真实微信换码、合法域名、开发者工具/真机登录、切换微信账号、弱网续期和私有播放仍需独立环境联调。
此前两个 Hero 资源相关旧测试文件因本目录缺少 Profile 继续列为未验，不复制原数据或重跑完整 Pipeline。
