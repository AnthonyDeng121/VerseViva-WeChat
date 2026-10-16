# V1.0.0 部署记录（2026-10-16）

## 最新：切换已完成

2026-10-16 14:43（Asia/Shanghai）已切换至 `verseviva-wechat-app:v1.0.0`，容器 `0607fa6ecaf4` healthy。镜像 ID 与原 Demo 相同（`1a5ded1a4877`），没有重建或修改业务代码、界面。`.env.wechat.v1` 与 Demo 配置逐字相同，权限 0600，原微信数据/模型卷保留。原站及 Caddy 未重启。

本机及服务器公网检查均通过：新旧健康接口 200，三首 Hero Profile 200、伴奏 Range 206，无效 Bearer 401。内部发布检查仍关闭，正式配置与审核记录未改；不代表微信公众平台已审核发布。真机登录、录音、模型闭环待用户扫码验证。以下部署准备状态与步骤为切换前记录，回滚命令继续有效。

用户要求现有代码和界面保持不变，将当前版本作为第一版并进行真机联调。新增 `compose.wechat.v1.yaml`，固定镜像标签 `verseviva-wechat-app:v1.0.0`，保留原微信版独立卷、网络、资源配额及单 worker。

当前状态：**尚未切换 V1**。首次 SSH 检查确认微信容器 healthy、原站 healthy；后续 SSH 握手多次被断开，未执行镜像打标、配置复制或容器重建。公网微信与原站健康接口复查均返回 200。客户端类型检查和包检查通过，现有产物 24 文件 / 492332 bytes。

## 恢复连接后执行

先将仓库 `compose.wechat.v1.yaml` 上传至 `/home/ubuntu/verseviva-wechat/`。在服务器该目录执行以下命令；使用当前运行镜像，不重新构建代码：

```sh
cd /home/ubuntu/verseviva-wechat
docker inspect verseviva-wechat-app-1 --format '{{.Image}}'
docker image inspect verseviva-wechat-app:demo-20261016 --format '{{.Id}}'
# 确认以上镜像 ID 相同后继续。
docker tag verseviva-wechat-app:demo-20261016 verseviva-wechat-app:v1.0.0
test ! -e .env.wechat.v1
install -m 600 .env.wechat.demo .env.wechat.v1
docker compose --env-file .env.compose -f compose.wechat.v1.yaml config --quiet
docker compose --env-file .env.compose -f compose.wechat.v1.yaml up -d --no-build app
docker ps --filter name=verseviva-wechat-app-1
curl --fail https://wechat-api.verseviva.top/api/v1/health
curl --fail --location https://verseviva.top/api/v1/health
```

需等待微信容器 healthy，并复查三首 Hero Profile/伴奏 Range、无效 Bearer 返回 401。若失败，使用原配置回滚（保留数据卷）：

```sh
docker compose --env-file .env.compose -f compose.wechat.demo.yaml up -d --no-build app
```

`.env.wechat.v1` 延用当前运行配置，内部发布检查仍关闭；正式 `.env.wechat` 与审核证据不改。V1 标签不代表审核通过：供应商受众/地区适用、注销后清理机制及平台验收等仍有未完成项，不得将 pending 改成 reviewed。微信公众平台审核发布与服务器部署分别完成。

## 现在即可真机联调

微信开发者工具导入本仓库 `miniprogram/`，AppID 为 `wx18a40d3837dc23ff`，重新编译后点击“预览”，使用有权限的微信扫码。现有 dist 对应 API `https://wechat-api.verseviva.top`，保持域名校验开启。多人测试可在开发者工具上传版本号 `1.0.0`，再由管理员在公众平台设置体验版并添加体验成员；本轮未上传或发布小程序。

依次检查登录、Hero 参考播放、麦克风/隐私授权、短句录音、提交分析、反馈及保存后回放。真实微信登录、录音和模型闭环仍需手机完成，不能由健康接口检查替代。
