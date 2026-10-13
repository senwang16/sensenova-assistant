# SenseNova Assistant · 项目长期备忘

## 项目定位
Chrome MV3 扩展（原生 JS，零依赖，无构建步骤）。`popup.js` 单文件承载全部业务逻辑。
存储：`chrome.storage.local`（配置/会话）+ IndexedDB（向量库）。

## 关键架构约定

### 多供应商投影模型
顶层 `settings.baseUrl / keys / modelTypeOverrides / noStreamModels / lastModel / imageConfig /
videoConfig / videoEnabled / allowedModels / capabilityModels` **一律是「当前供应商」的活动投影**，
真实持久化在 `settings.providers[]`。
- `projectProvider(p)`：供应商 → 顶层（切换时）
- `absorbProvider()`：顶层 → 供应商（保存前，`saveSettings()` 内自动调用）
- 新增任何供应商级配置，**四处都要改**：`makeProvider` / `normalizeProvider` / `projectProvider` / `absorbProvider`

### 请求层
- 一切请求走 `requestWithRotation(url, init, { onNotice, signal, userSignal, onKeyUsed })`
  - 开头锁定 `settings.keys.slice()` 快照（**杜绝生成中切换供应商导致跨供应商串 Key**）
  - 429/401 → 冷却该 Key 换下一个；全 Key 429 → 轮级退避
  - 5xx → 指数退避 `SERVER_ERR_BACKOFF_MS = [2s, 6s, 15s]`
  - `onKeyUsed` 回调用于把「本次实际用的 Key」交回调用方（视频轮询必须复用创建任务的 Key）
- 视频轮询**不走** `requestWithRotation`（不计入视频 RPM，且需固定 Key）

### 媒体缓存（D1 方案 A，2026-09-30 起）
图片/视频 Blob 存 **IndexedDB `sensenova_memory` v2 的 `media` store**（{id, sessionId, mime, bytes, ts, blob}）；
消息只存轻量引用 `mediaId/mime/bytes`，`content` 仅留远端 URL 兜底。**双形态兼容是铁律**：
旧内嵌 data URL 的消息（未迁移/转存失败降级）必须继续可用——所有消费点走 `hasLocalMedia`/`mediaBytes`/
`ensureMediaUrl`/`releaseMedia` 助手，不要直接读 `msg.content` 当媒体。删除/裁剪媒体消息必须 `releaseMedia`。
`persistHistory` 全量写盘不再含媒体（这是当初改它的原因），旧数据由 `migrateInlineMedia()` 启动后台迁移。

限额（**每会话**，非全局）：图片 20 张 / 10MB；视频 10 段 / 300MB，超出删最旧。

## 供应商能力矩阵（截至 2026-09）
| 能力 | 商汤 SenseNova | Agnes |
|---|---|---|
| 文本 | ✅ | ✅ |
| 图片 | ✅ 精确像素白名单（`size`=2048x2048 等，带 `watermark`） | ✅ 档位+比例（`size`=1K/2K/3K/4K + `ratio`，`extra_body.response_format`） |
| 视频 | ❌ | ✅ `agnes-video-2.5-flash`（`mode`/`seconds`/`size:"720P"`/`aspect_ratio`，异步轮询） |

Agnes 免费白名单（`AGNES_FREE_MODELS`）：`agnes-3.0-flash`、`agnes-2.5-flash`、
`agnes-image-2.0/2.1/2.5-flash`、`agnes-video-2.5-flash`。其余（Pro 系列、`agnes-video-2.5` 标准版）收费，**不要选用**。
`agnes-video-v2.0` 官方 2026-09-25 已退役，**已从代码移除**。

Agnes 免费 Key 官方「实际可执行 RPM」（Token Plan FAQ 2026-09-23 更新）：文本 **10（由 20 下调 50%）**；
图片 1K=20 / 2K=10 / **3K=1 / 4K=1**；视频 **1（账号级，多 Key 不可突破）**。
**同类型 Key 共享同一限制池**（官方 FAQ 明确），多把免费 Key 不放大 RPM——acquireRate 不做 Key 数放大。
商汤 Token Plan（公测）：**每模型每 5h 1500 次**（≈5 RPM 均值），429 = 配额窗口耗尽 → 分钟级退避无意义，靠跨供应商转移。

## 供应商健康标记（✅ 2026-09-30）
`markProviderFailed/Ok` + `providerCooling`，冷却分级 rate=90s / server/network=30s（`requestWithRotation`
抛错带 `e.kind`）；`capabilityCandidates` 把冷却中供应商**追加到候选末尾**（兜底仍参与）；
下拉自动项副标题显示 ⏸冷却Ns。运行时内存态 `_providerHealth`，不持久化。

## 自动路由
模型下拉置顶伪模型 `__auto__`（`AUTO_MODEL_ID`）。`detectIntent()` 两级判定：
显式指令（`/img` `/video` `/chat`）→ 强模式正则。正则**锚定句首** + 允许礼貌前缀 +
媒体名词须在动词后 14 字符内 + 代码语境守卫。**兜底永远是 chat**（宁可聊天，绝不误触发生成）。
槽位 `capabilityModels{chat,image,video}` 按供应商保存；目标能力缺失时降级并提示。
**跨供应商失败转移（✅ 已实施）**：`capabilityCandidates(kind)` 生成候选序（当前供应商优先，
只纳有可用 Key 且具备该能力的供应商）；`runWithFailover` 按序尝试、失败 toast 后换下家（AbortError 不转移）；
`runUnderProvider` 执行期投影目标供应商、结束恢复原供应商（进入前先记 `origId`——
`projectProvider` 会改写 `currentProviderId`，恢复时不能读它）。

## 开发规范（用户要求）
- **改代码前先出方案**，等确认再动手；不接受「不审需求直接改代码」
- 报告要给 `file:line` 级别的可追溯证据，不要空泛结论
- 只改自己产出的文件，不得触碰其它 AI/工具生成的产物
- 严格区分「离线验证」与「真机联调」，不要把离线通过说成功能已可用
- popup 弹窗**不可用 window.prompt**（crbug 32883，返回 null）——需要用户输入一律行内输入框
  （参考 `startRename` / `renameSession` 的 done-guard 防blur 双提交）；confirm/alert 可用
- 记忆链路（综述/检索/改写/嵌入）全链路必须 `withTimeout` 限时，绝不阻塞发送；
  嵌入探测按供应商运行时缓存 `_embedModeByProvider`，禁止全局持久化降级
- 供应商切换/投影纪律：**先 absorb 再 project**（switchProvider、runUnderProvider 一致）

## 可复用的验证手段
`~/.workbuddy/skills/chrome-ext-offline-smoke/` —— 用 Node `vm` sandbox stub `chrome`/`document`/`fetch`
后直接调纯函数做断言。骨架见该技能 `examples/sensenova-assistant.harness.mjs`。
**注意**：sandbox 必须显式注入 `URL` / `TextDecoder` / `AbortController` 等宿主全局，
否则代码里的 `catch` 会吞掉异常导致「假通过」。

## 工具使用红线（2026-09-30 事故教训）
- **禁止用 PowerShell 文本管道改含中文的文件**（Set-Content/Get-Content 会 GBK↔UTF-8 乱码并吞引号，
  manifest.json 曾被改废）。改文件一律用 Write 工具或 python 二进制操作；Write 可能保留 BOM，JSON 文件用
  python 校验 `json.load(..., encoding='utf-8')` 并顺手去 BOM。
- PowerShell 与 Bash 工具间存在**执行时序错位**：打包/验证类操作放同一个 python 进程内闭环，不要跨工具链验证。
