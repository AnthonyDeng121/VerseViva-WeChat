# 小程序多 Take 与服务端混音（2026-10-15）

采用服务端 ffmpeg 生成单个 192 kbps、44.1 kHz、立体声 MP3，小程序鉴权下载后交给唯一的 InnerAudioContext。
不依次启动多个播放器模拟共享时钟。Web 既有 AudioContext 回放和同步下载接口保持兼容。

## 使用与时间轴

逐句练习页保存录音后，在“已保存录音”调整各轨音量（0–200%）、静音与手动偏移（±2000 ms），设置经 PATCH 持久化。
“多录音合成”选择参与的当前 Take、伴奏音量（0–100%）、人声整体音量（0–100%）和输出增益（0–200%）。
点击生成，等待终态后主动下载试听；可以暂停、继续和停止。修改参数停止旧成品，需要重新生成；不承诺播放期间实时重新混音。
高增益可能削波，当前没有自动归一化/限幅器。页面提示降低增益，不擅自改变用户设定。

实际起点 = timelineStartSeconds − (latencyCompensationMs + manualOffsetMs) / 1000。
两种偏移都是正值提前、负值延后，原始音频不改写。录音早于混音范围时裁掉前段，晚于范围起点时延迟加入，完全在范围外不混入。
混音范围取参与 Take 的最早 selectionStart 和最晚 selectionEnd（包括静音轨），中间无录音仍持续播放伴奏。
客户端保留各轨 timeline/latency/manualOffset/gain/mute；服务端使用实际上报录音时长（旧记录缺失时回退选区时长）限制可混入片段。
成品本地第 0 秒映射到歌曲的 rangeStartSeconds，歌词高亮与跳转使用该映射；原始 Take 试听没有可靠歌曲时钟时不冒充参考播放。

## API 与持久化

- `PATCH /api/v1/takes/{takeId}`：既有 gain/muted/manualOffsetMs 更新接口，仍按可信所有者授权。
- `POST /api/v1/songs/{songId}/mix-jobs`：短请求，202 返回 MixJob。
- `GET /api/v1/mix-jobs/{jobId}`：查询 queued/processing/ready/failed/stale、范围与安全错误。
- `GET /api/v1/mix-jobs/{jobId}/audio`：仅当前所有者、当前有效 ready 结果可下载，支持 Range、no-store；未就绪/失效为 409，越权为 404。

请求示例（takeId 替换为当前用户实际 ID）：

```json
{
  "takeIds": ["take_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  "accompanimentVolume": 0.55,
  "voiceVolume": 1,
  "masterGain": 1
}
```

不接受客户端 session_id、所有者或文件路径。最多 32 条不重复且当前有效的 Take，单次伴奏范围最多 10 分钟，数值必须有限且在范围内。
SQLite 新增 mix_jobs 保存 job_id、可信 owner、fingerprint、请求与公开状态 JSON；成品只写 `data/mix-previews/mix_<id>/mix.mp3`，没有公开静态目录。
同参数重试命中相同 queued/processing/ready 任务；失败后显式重试生成新任务，不用长 HTTP 请求等待 ffmpeg。

缓存指纹包含算法版本、owner、songId、已排序 Take ID/完整元数据、原录音与伴奏的文件大小和修改时间、全部音量参数。
原录音按现有不可变约束管理，stat 用于检测意外替换，不把它描述成内容级 SHA 校验或防本地磁盘篡改。
查询、下载和发布结果前重新核验指纹；在其他设备修改/删除、文件消失、超出 24 小时均判 stale。
Take 修改/删除主动失效并清理相关已完成缓存；正在 ffmpeg 中的任务不再授权下载，返回后丢弃产物，最长受 180 秒进程超时限制。
每次创建新任务清理该 owner 过期缓存并保留至多两个旧终态，加上新任务最多三个记录/成品；此为按访问清理，不是定时全局磁盘保留策略。

本轮新预览队列单进程最多 8 个未完成任务，每个 owner 最多 1 个，只有 1 个 ffmpeg 渲染同时执行。
SQLite 持久化的是状态，不是跨进程分布式任务队列：重启将旧 queued/processing 标为 failed，保留仍有效 ready；退出时取消等待任务，等待当前有界渲染结束。
仍须单 Uvicorn worker；增加进程前迁移跨进程任务队列。旧 Web 同步 `/songs/{songId}/mixdown` 不走新队列，不能宣称新上限覆盖该兼容接口或全部歌曲 Pipeline。

## 客户端恢复与验证

MixController 使用串行轮询，页面隐藏暂停、返回恢复；下载和播放需主动点击，后台完成不自动出声。
任务 ID、参数和输入签名按 origin/owner/song 存本机，不存 Token 或音频路径；同范围重新进入时验证签名后恢复查询。
参数改变、换号/卸载或迟到响应不会复活旧结果。可选本机存储故障不阻断生成/播放，恢复记录不保证写入成功。
修改参数只取消本机查询/下载，已开始的旧服务端任务可能继续；新提交受每用户并发门禁限制，等其结束后重试。
临时下载沿用 AudioLease，退出/换号/凭证到期时停止播放并清理。

本地验证：新增后端 15 项（任务去重、归属/Range、参数失效、处理中修改、删除清理、失败/重启、缓存期限/数量、并发串行以及真实 ffmpeg 合成）；
客户端新增混音状态机 7 项及歌曲时钟映射 1 项。实际音频测试用自生成 WAV/MP3，不调用外部模型，不使用商业歌曲。
完整后端 183 项、客户端 52 项、Ruff、类型检查、生产构建与包检查通过；仍排除缺 Hero Profile 的两个历史测试文件（10 项资源依赖未验），Web test/lint/build 未跑。
独立 HTTPS/合法域名、微信凭证、真机弱网/前后台/多 Take 实际听感与 iOS/Android 延迟仍待联调；本轮未推送或部署。
