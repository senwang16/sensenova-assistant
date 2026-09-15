# Agnes 文本 / 图片 / 视频能力接入修改方案

> 状态：**待审核**（尚未改任何代码）
> 目标：为 SenseNova Assistant 扩展新增 Agnes 供应商的文本、图片、视频三种生成能力。
> 涉及文件：`popup.js`（主）、`manifest.json`（主机权限）、`popup.html`（视频参数/冷却提示 UI）、`popup.css`（视频消息样式）。

---

## 一、背景与结论

Agnes 提供 OpenAI 兼容 API，端点与本扩展现有架构完全对得上：

| 能力 | 端点 | 模型示例 | 是否需新写流程 |
|---|---|---|---|
| 文本 | `POST /v1/chat/completions` | `agnes-2.5-flash`、`agnes-2.5-pro-beta` | 否（复用 `doChat`） |
| 图片 | `POST /v1/images/generations` | `agnes-image-2.0-flash`、`agnes-image-2.1-flash` | 否（复用 `doImageGeneration`，仅尺寸参数需调整） |
| 视频 | `POST /v1/videos`（建任务）+ `GET /agnesapi?video_id=`（轮询结果） | `agnes-video-v2.0`、`agnes-video-2.5-flash` | **是**（异步任务轮询，新写 `doVideoGeneration`） |

Base URL（国际版）：`https://apihub.agnes-ai.com/v1`

**分层实施**（便于回滚）：
- **第一阶段**：Agnes 预设 + 关键词分类 + 图片尺寸适配 → 文本/图片立即可用。
- **第二阶段**：视频生成流程（任务创建 + 轮询 + Base64 缓存 + 1RPM 冷却提示 + UI 参数）。

---

## 二、Agnes 官方限额（免费 / Default Key，供 UI 提示参考）

来源：Agnes 官方 Token Plan 文档（2026-06-28 版）。

| 能力 | 有效 RPM（每分钟） | 每日配额 |
|---|---|---|
| 文本 | 20 | 无（免费 Key 无每日上限） |
| 图片 1K / 2K / 3K / 4K | 20 / 10 / 1 / 1 | 无 |
| 视频 | **1** | 无（但 1 RPM 实际卡死频率） |

要点：
- 免费 Key **没有**订阅配额，仅受 RPM 约束；500 秒/天 等配额是 Token Plan 订阅才有。
- 视频 **1 RPM**：每分钟只能发起 1 个视频任务，必须做冷却倒计时提示，避免连点 429。
- 轮询 `GET /agnesapi?video_id=` 不计入视频生成 RPM，但仍建议 3~5s 一次。

---

## 三、第一阶段改动（文本 + 图片）

### 1. 新增 Agnes 供应商预设
文件：`popup.js` → `PROVIDER_PRESETS`（约 43 行）
```js
{ name: 'Agnes', baseUrl: 'https://apihub.agnes-ai.com/v1',
  chatEndpoint: '/chat/completions', imageEndpoint: '/images/generations', modelsEndpoint: '/models' }
```
效果：用户在"设置 → 从预设新增"可直接选 Agnes，文本走 `doChat`，无需新逻辑。

### 2. 模型类型关键词
文件：`popup.js` → `CHAT_KEYWORDS` / `IMAGE_KEYWORDS`（约 88~91 行）
```js
const CHAT_KEYWORDS    = [ ... , 'agnes'];        // agnes-2.5-flash 归文本
const IMAGE_KEYWORDS   = [ ... , 'agnes-image' ];  // agnes-image-2.0-flash 归绘图
const VIDEO_KEYWORDS   = [ ... , 'agnes-video' ];  // agnes-video-v2.0 归视频（第二阶段启用）
```
说明：`classifyModel` 里 image 判定在 chat 之前，`agnes-image` 会先命中 image，不会误归文本。

### 3. 图片尺寸参数适配
文件：`popup.js` → `doImageGeneration`（约 1363 行）
- 现状：固定发 `size`（商汤白名单 `2048x2048`）+ `watermark`。
- Agnes 图片端点用 `size` + `ratio` 分层（如 `size:"2K", ratio:"16:9"`），且**没有 `watermark` 字段**，也没商汤那种精确像素白名单。
- 改法：当 `curProvider().name === 'Agnes'` 时，body 改为 `{ model, prompt, size: 档位, ratio }`，不传 `watermark`；档位从 1K/2K/3K/4K 下拉选，ratio 从 `1:1/16:9/9:16/4:3/3:4` 选。
- 落地：`DEFAULTS.imageConfig` 增加 `{ tier: '2K', ratio: '16:9' }`，UI 增加 Agnes 分支下拉（非 Agnes 仍用原 `size`）。

### 4. manifest 主机权限
文件：`manifest.json` → `host_permissions`
- 新增 `https://apihub.agnes-ai.com/*` 与 `https://*.agnes-ai.com/*`（覆盖视频轮询域）。
- Edge 认证说明补一句：视频生成任务创建与结果轮询（`/v1/videos`、`/agnesapi`）。

---

## 四、第二阶段改动（视频）

### 5. 视频从"不支持"变"可支持"
- `DEFAULTS` 增加 `videoEnabled: false`（供应商可覆盖；Agnes 预设下默认 `true`）。
- `projectProvider` / `absorbProvider`（约 245~274 行）增 `videoEnabled` 字段投影。
- 模型下拉（`popup.js` 约 1828~1833 行）：🎬 项在 `videoEnabled` 为真时**可点击**，否则保持 `pointer-events:none`。
- 发消息拦截（`popup.js` 约 1451 行）：由"视频不支持"改为条件判断（`videoEnabled` 为真则放行）。

### 6. 新增 `doVideoGeneration(prompt, signal)`
位置：`doImageGeneration` 之后（约 1410 行）。流程：
```
1. POST {baseUrl}/videos  { model, prompt, seconds: '4', size: 档位, ratio }
   （注意：官方要求 seconds 必须传字符串，否则 400）
   → 返回 { video_id }
2. 轮询 GET {baseUrl}/agnesapi?video_id=<id>（3~5s 间隔，总上限 5min）
   → status=success 时拿到视频 URL
3. 视频 URL 有时效 → 转 Base64 落地（复用 fetchImageAsBase64 思路，新建 fetchMediaAsBase64 支持 video/mp4）
4. msg.type='video'，写入会话并受独立缓存限额约束
```
注意：**不走** `requestWithRotation` 的文本退避流（那是给 chat 用的）；视频 429 单独冷却。

### 7. 发消息三分支路由
文件：`popup.js` → 约 1481 行
```js
if (modelType === 'image')                       await doImageGeneration(text, ctrl.signal);
else if (modelType === 'video' && videoEnabled)  await doVideoGeneration(text, ctrl.signal);
else                                             await doChat(text, ctrl.signal);
```

### 8. 视频 1RPM 冷却
- `DEFAULTS` 增加 `lastVideoTs: 0`。
- 发视频请求前检查 `Date.now() - lastVideoTs < 60000`：若未到，UI 显示"⏱ 距离下次可生成视频还需 Ns"并禁用发送。
- 生成成功/失败后更新 `lastVideoTs`。
- 收到 429 时额外提示"视频限频 1/分钟，请稍候"。

### 9. 视频独立缓存限额
文件：`popup.js` 常量区（约 98 行）
```js
const MAX_VIDEO_COUNT = 10;             // 本地最多缓存 10 段视频
const MAX_VIDEO_BYTES = 300 * 1024 * 1024; // 视频缓存总量 300MB（免费 Key 一天也生成不了几段，绰绰有余）
```
- 新增 `enforceVideoLimitsAndSave(msgs)`，仿 `enforceImageLimitsAndSave`（1413 行），判 `m.type==='video' && isDataUrl(m.content)`。

### 10. 视频消息渲染
- `popup.html` / `popup.css`：新增 `.bubble-video` 容器，`<video controls>` 播放 Base64。
- `buildMessageEl` 增加 video 分支（仿 image 分支）。

### 11. UI 参数（可选，先做最小集）
- 视频时长 `seconds`：先写死 `'4'`（或加 4/8 二选一）。
- 档位 + ratio 复用第 3 步的 Agnes 档位下拉。
- 后续可扩展：图生视频（`image` 字段传公开图 URL）。

---

## 五、改动清单速查

| # | 文件 | 位置 | 改动 | 阶段 |
|---|---|---|---|---|
| 1 | popup.js | `PROVIDER_PRESETS` ~43 | 加 Agnes 预设 | 一 |
| 2 | popup.js | 关键词 ~88 | agnes / agnes-image / agnes-video | 一 |
| 3 | popup.js | `doImageGeneration` ~1363 | Agnes 尺寸/比例分支 | 一 |
| 4 | manifest.json | `host_permissions` | 加 agnes-ai 域名 | 一 |
| 5 | popup.js | `DEFAULTS`/`project`/`absorb` | `videoEnabled` 开关 | 二 |
| 6 | popup.js | ~1410 | 新 `doVideoGeneration`（创建+轮询+Base64） | 二 |
| 7 | popup.js | ~1481 | 发消息三分支 | 二 |
| 8 | popup.js | `DEFAULTS`+发送前 | 视频 1RPM 冷却 | 二 |
| 9 | popup.js | ~98 | 视频缓存限额 | 二 |
| 10 | popup.html/css | 消息渲染 | `.bubble-video` | 二 |
| 11 | popup.html | 输入区 | 视频时长/档位参数 | 二（最小集可先写死） |

---

## 六、风险与取舍

1. **视频 1RPM + 无每日配额**：免费 Key 下视频功能低频，务必做冷却倒计时，避免用户连点触发 429。
2. **`seconds` 必须字符串**：官方明确，传数字会 400，代码里固定 `'4'` 并注释。
3. **视频体积**：单段可能数 MB~数十 MB，Base64 落地会放大 ~33%；`300MB` 上限足够，但 IndexedDB 仍受限，超出自动删最旧。
4. **权限面扩大**：新增视频/轮询域，Edge 审核需在认证说明里解释"视频生成与结果轮询"用途。
5. **可回滚性**：一、二阶段独立提交；视频相关字段全部走 `videoEnabled` 开关，关闭即完全不影响现有文本/图片。

---

## 七、待你确认

- [ ] 视频时长 `seconds` 用固定 `'4'` 还是给 4/8 两档？
- [ ] 是否启用图生视频（`image` 传参考图）？还是先只做文生视频？
- [ ] 视频缓存上限 10 段 / 300MB 是否 OK？
- [ ] 第一阶段（文本+图片）是否可以**先合入**，第二阶段单独提交？

确认无误后我按"第一阶段 → 第二阶段"顺序实施，每阶段独立 `git commit` + 打包。
