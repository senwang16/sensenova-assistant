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

### 媒体缓存
图片/视频一律抓取转 Base64 落地（商汤图片 URL 仅 1 小时有效）。
限额：图片 20 张 / 10MB；视频 10 段 / 300MB，超出删最旧。

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

## 可复用的验证手段
`~/.workbuddy/skills/chrome-ext-offline-smoke/` —— 用 Node `vm` sandbox stub `chrome`/`document`/`fetch`
后直接调纯函数做断言。骨架见该技能 `examples/sensenova-assistant.harness.mjs`。
**注意**：sandbox 必须显式注入 `URL` / `TextDecoder` / `AbortController` 等宿主全局，
否则代码里的 `catch` 会吞掉异常导致「假通过」。
