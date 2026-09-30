# Agnes 接入实施规格（免费模型白名单 + 限流 + 重试 + 自动路由）

> 更新时间：2026-09-30
> 基线：`popup.js` @ `04c552b` → 已实施
> 数据来源：Agnes 官方 MODEL_CATALOG（2026-07-30 版）、官方视频 2.5 / 2.5 Flash 文档、官方图片 2.1 Flash 文档
>
> **实施状态：全部完成 ✅**
> - ✅ **P0** 视频链路修复 + 限流预算 + 5xx 重试
> - ✅ **P1** 模型白名单过滤、Agnes 图片档位/画幅 UI、视频开关
> - ✅ **P2** `⚡ 自动` 意图路由 + 能力槽位 + `doXxx` 增 `model` 形参
> - ✅ `agnes-video-v2.0` 按决策**移除**（只保留 2.5-flash 一套参数）
> - 验证：`node --check` 通过 + 离线冒烟 **63 项断言全通过**（见第七节）

---

## 零、改动清单

| 文件 | 改动 |
|---|---|
| `popup.js` | **P0**：`videoConfig`、`normalizeVideoSeconds/Ratio`、`buildVideoBody`、`buildVideoPollUrl`、`acquireRate`、5xx 退避 + `onKeyUsed`、`doVideoGeneration` 重写<br>**P1**：`allowedModels` 白名单（`visibleModels()` 过滤）、`normalizeImgTier/Ratio`、`videoEnabled` 开关、按供应商切换图片参数控件<br>**P2**：`AUTO_MODEL_ID`、`detectIntent`、`stripIntentCommand`、`capabilityModel`、`resolveRoute`、`degradeTip`；`doChat/doImageGeneration/doVideoGeneration` 增 `model` 形参；`handleSend` 分流 |
| `popup.html` | `#videoParamsRow`（时长/画幅）、`#chkVideoEnabled`、图片参数拆为 `#imgParamsAgnes`（档位+比例）/`#imgParamsPixel`（像素+水印）、`⚡ 自动路由与模型白名单` 配置区、文案更新 |
| `popup.css` | `#videoParamsRow`、`.param-group`、`.md-auto` / `.md-auto-sub` |
| `manifest.json` | 版本 `1.0.0 → 1.1.0`，描述更新 |
| `README.md` | 新增「多模态自动路由」「限流排队与重试」「视频生成」章节 + 能力对照表 |

**验证**：`node --check popup.js` 通过；离线冒烟 63 项断言全通过，覆盖参数组装、范围校正、轮询地址推导（国际站/国内站）、限流记账与多 Key 分摊、5xx 重试与耗尽、鉴权头透传、意图识别 27 例（含防误判）、白名单过滤、槽位解析、商汤无视频降级、视频开关关闭降级、指令前缀剥离。

---

## 一、兼容性核查结论（摘要）

| 能力 | 现状 | 判定 |
|---|---|---|
| 文本 | `doChat` 复用 `/chat/completions` | ✅ |
| 图片 | `size=档位 + ratio`，另补 `extra_body.response_format` | ✅ 已修 |
| 视频 | `POST /videos` + 轮询，参数/取值/鉴权全部重写 | ✅ 已修 |

### 视频 P0（**均已在本次实施中修复**）

| # | 原问题位置 | 问题 | 修法（已落地） |
|---|---|---|---|
| 1 | `popup.js:93,1474` | `agnes-video-v2.0` 官方 2026-09-25 退役 | **移除**，只走 `agnes-video-2.5-flash`，`VIDEO_MODEL_SIZE='720P'` |
| 2 | `popup.js:1474-1480` | 发 `ratio`（应为 `aspect_ratio`）；缺必填 `mode` | `buildVideoBody()` 统一组装 `mode/seconds/size/aspect_ratio` |
| 3 | `popup.js:1506` | 成功结果读 `video_url\|\|url`，2.5 实际在 `metadata.url` | 兼容 `metadata.url / output.url / video_url / url` 四种 |
| 4 | `popup.js:1502` | 轮询 `fetch` 无 `Authorization` | `onKeyUsed` 回调锁定创建任务的 Key，轮询复用 |
| 5 | `popup.js:1490` | 轮询域名硬编码 | `buildVideoPollUrl()` 由 `baseUrl` 推导 origin |
| 6 | `popup.html` 全文 | 无 `videoEnabled` 控件 | 设置面板新增 `#chkVideoEnabled` 开关 + 底部时长/画幅参数行 |

### 视频参数存在**代际差异**（代码目前只写了一套）

| 参数 | `agnes-video-v2.0` | `agnes-video-2.5-flash` |
|---|---|---|
| 创建 | `POST /v1/videos` | `POST /v1/videos` |
| 查询 | `GET /agnesapi?video_id=` | `GET /agnesapi?video_id=&model_name=` |
| 时长 | `num_frames`(8n+1) + `frame_rate` | `seconds` 字符串 `"4"–"12"`（默认 `"5"`） |
| 尺寸 | `width`/`height`（1152×768） | `size` 固定 `"720P"` |
| 比例 | 由 width/height 决定 | `aspect_ratio`（默认 `16:9`） |
| 模式 | 无 | `mode` **必填**：`text`/`keyframe`/`reference` |

→ 必须加 `buildVideoBody(model, prompt)` 分支，一套 body 通吃不了。

---

## 二、免费模型白名单（只准用这些）

| 模态 | 模型 | 状态 | 说明 |
|---|---|---|---|
| 文本 | `agnes-3.0-flash` | ✅ 免费 | 512K 上下文 / 65,536 输出 / Thinking / Tool Calling，同类第 1 |
| 文本 | `agnes-2.5-flash` | ✅ 免费 | 512K / 65.5K，可作备选 |
| 图片 | `agnes-image-2.5-flash` | ✅ 免费 | 1K~4K 全免，能力 > 2.1 |
| 图片 | `agnes-image-2.1-flash` | ✅ 免费 | 备选 |
| 图片 | `agnes-image-2.0-flash` | ✅ 免费 | 备选 |
| 视频 | `agnes-video-2.5-flash` | ✅ 限时免费 | 仅 720P |
| 视频 | `agnes-video-v2.0` | ⚠️ 免费但官方标注已退役 | 保留可用，默认不选 |

**明确排除**（收费）：`agnes-2.5` / `agnes-2.5-pro` / `agnes-2.5-pro-beta` / `agnes-video-2.5`(标准版) 及一切 Pro 系列。

> 落地：供应商加 `allowedModels: []` 字段；`renderModelDropdown` 只渲染白名单模型（空 = 不限制，兼容商汤等其他供应商）；自动路由槽位下拉也只列白名单。

分类关键词已验证无需改动：`agnes-3.0-flash`→chat（命中 `agnes`）、`agnes-image-2.5-flash`→image、`agnes-video-2.5-flash`→video，顺序正确（`popup.js:736-738`）。

---

## 三、官方限流（免费 / default Key）

来源：官方 Token Plan FAQ（文本 RPM 2026-09-23 更新版；图片/视频 2026-06-28 版）。

| 能力 | Public RPM | **实际可执行 RPM** | 建议最小间隔 |
|---|---:|---:|---:|
| 文本 | — | **10**（2026-09-23 起由 20 下调 50%） | 6 s |
| 图片 1K | 30 | **20** | 3 s |
| 图片 2K | 20 | **10** | 6 s |
| 图片 3K | 2 | **1** | 60 s |
| 图片 4K | 1 | **1** | 60 s |
| 视频 | 2 | **1** | 60 s |

要点：
- `Public RPM` = 允许发起；`实际可执行 RPM` = 经服务端调度后真正能跑的，**按后者做预算**。
- ⚠️ **同类型 Key 共享同一限制池**：官方明确「两把免费 Key 共用同一个 free/default 池」，多把免费 Key **不会**放大 RPM（不同类型 Key：免费/企业/Token Plan 各自独立池）。
- 3K/4K 图片只有 1 RPM，**即便付费也不提升** → 默认档位建议 `2K`。
- 官方建议：429 降低并发 + 退避重试；5xx 指数退避。

商汤 SenseNova（Token Plan 公测免费）侧对照：
- **每模型每 5 小时 1500 次**（≈ 单模型均值 5 RPM），按模型分别计数（6.x-flash-lite / u1-fast 各自的池）。
- 429 = **配额窗口耗尽**，要等窗口重置（分钟级退避无意义）→ 这类失败最适合触发「跨供应商失败转移 + 供应商健康冷却」。

---

## 四、限流与重试设计（✅ 已实施）

### 4.1 分层节流（`acquireRate`）

实现为「能力 + 档位」的单桶最小间隔记账（`_rateLastTs`）：

```js
const AGNES_RPM = { chat: 10, video: 1, image: { '1K': 20, '2K': 10, '3K': 1, '4K': 1 } };
const minGap = Math.ceil(60000 / rpm);   // 10rpm→6s；1rpm→60s
```

- 仅对 **Agnes 供应商**生效（`isAgnesProvider()`），商汤等其它供应商零影响。
- **不按 Key 数放大**（2026-09-30 修正）：官方确认同类型 Key 共享同一限制池，多把免费 Key 不增加 RPM，放大记账只会提前撞 429。
- 等待期间显示「⏱ 免费额度限流（约 N/分钟），排队 Ns 后发送…」，且可被停止按钮中断。
- 图片档位取 `imageConfig.tier`，选 4K 自动变成 60s 一个。
- 视频的 1 RPM 仍由发送前的 `lastVideoTs` 检查承担（有明确的「还剩 Ns」提示）。

### 4.2 重试策略（按状态码分流）

| 状态 | 语义 | 处理（已实现） |
|---|---|---|
| `400` | 参数错 | **不重试**，官方 message 原样抛出（便于定位 size/mode 错） |
| `401` | Key 失效 | 该 Key 冷却 10 min，换下一个 Key |
| `429` | 限流 | 该 Key 冷却 60s，换 Key；全 Key 限流则轮级退避（单 Key 5s→15s→30s） |
| `500/502/503/520` | 服务端抖动 | 指数退避 `2s → 6s → 15s`，最多 3 次，重试耗尽后抛出真实错误 |
| `404` | 端点/模型不存在 | 不重试，提示检查模型名 |

**视频特例（已实现）**：
- 轮询**不走 Key 轮换**，通过 `onKeyUsed` 回调锁定「创建任务时的那把 Key」，轮询复用同一把。
- 轮询不计入视频 RPM，间隔按前快后慢 2s → 5s，总上限 5 分钟。
- 轮询结果状态兼容 `completed/succeeded/success/done` 与 `failed/error/canceled/cancelled`。

### 4.3 Key 与并发

- 视频限频是账号级「每分钟 1 个任务」，多 Key **不能突破**；不要用多 Key 并发刷视频。
- 文本/图片**不按 Key 数放大**（官方：同类型 Key 共享同一限制池）。

---

## 五、多模态自动路由（✅ 已实施）

### 5.1 机制

模型下拉顶部新增伪模型 **「⚡ 自动（按意图路由）」**（`__auto__`）。命中后 `handleSend` 走 `routeByIntent(text)`：

1. **显式指令**（零成本）：`/img` `/image` `/draw` `/图` `/画` → 图片；`/video` `/vid` `/视频` → 视频；`/chat` `/txt` `/文本` `/聊天` → 文本。指令前缀会在发送前剥离。
2. **强模式正则**（一律锚定句首，允许「请/帮我/给我」等礼貌前缀）：
   - 图片：`(生成|做|出|制作|设计|来) …(图|图片|插画|海报|logo|封面|头像|壁纸|表情包)`，或强图片动词 `画/绘画/绘制/渲染/draw/paint/sketch`
   - 视频：`(生成|做|出|制作|拍|来) …(视频|动画|短片|动效|小视频)`，或英文 `animate/make a video`
   - **防误判**：媒体名词必须在动词后 14 字符内；含「怎么/如何/画面/画质」等说明性词或技术词（代码/接口/html…）一律判为聊天
3. **兜底 `chat`** —— 宁可当聊天，绝不误触发生成。

### 5.2 能力槽位与跨供应商候选

`capabilityModels = { chat, image, video }` 按**供应商**分别保存（切换供应商即切换能力来源）：

| 槽位 | Agnes 预设 | 商汤 |
|---|---|---|
| chat | `agnes-3.0-flash` | 用户自选（或空 = 自动取首个文本模型） |
| image | `agnes-image-2.5-flash` | 同上（如 `u1-fast`） |
| video | `agnes-video-2.5-flash` | ❌ 无视频模型 → 跨供应商落到 Agnes |

`doChat` / `doImageGeneration` / `doVideoGeneration` 均已增 `model` 形参，路由时传槽位模型，**不改用户可见的选择器**。

### 5.2.1 跨供应商失败转移（✅ 已实施）

自动路由**不是只在自己的供应商内打转**，而是跨供应商：

- `capabilityCandidates(kind)` 收集候选序列：**当前供应商优先**，其余按供应商列表顺序；只纳入「已配可用 Key 且具备该能力」的供应商（视频还要求该供应商 `videoEnabled`）。
  - 例：当前是商汤、用户要视频 → 商汤无视频模型 → 候选自动落到 Agnes，**无需用户手动切换供应商**。
- `runWithFailover(candidates, kind, prompt, signal)` 按序执行：某家失败（网络错/4xx/5xx 重试耗尽等）→ toast 提示后自动换下一家重试，**谁成功用谁**；全部失败才落错误气泡。
  - 用户主动停止（AbortError）不换供应商，直接终止。
- `runUnderProvider(providerId, fn)` 执行期间把目标供应商投影到顶层（请求层零改动、Key 快照正确、限流按目标供应商记账），结束后恢复进入前的供应商；任务期间用户手动切换过供应商则以用户切换后的为准。
- 下拉「⚡ 自动」条目会展示三个槽位候选，并标注跨供应商来源（如「视频 → Agnes」）。

### 5.3 与限流的交互

- 目标是 video 且 1 RPM 冷却中 → 沿用「还需 Ns」提示并中止（不静默降级，避免用户以为要图却出图）。
  - 该冷却读的是**实际执行该视频任务的供应商**的 `lastVideoTs`，由 `videoTargetProvider(autoRoute)` 解析：自动路由取 `candidates[0].providerId`，非自动取当前供应商。
  - 之所以不能直接读顶层 `settings.lastVideoTs`：它是「当前供应商」的活动投影，当前在商汤、视频交给 Agnes 时会读到商汤的时间戳（恒为 0），导致冷却漏拦。
  - 同理，视频开关守卫（`videoEnabled`）也按目标供应商判定，否则「商汤未开视频」会把本应转交 Agnes 的请求误拦。
  - `lastVideoTs` 属供应商级字段，`makeProvider` / `normalizeProvider` / `projectProvider` / `absorbProvider` 四处均需同步（早期遗漏前两者，导致重载后冷却失效）。
- 目标是 image 且档位为 3K/4K（1 RPM）→ 由 `acquireRate` 排队并显示倒计时。

### 5.4 供应商健康标记（✅ 已实施，2026-09-30）

失败过的供应商短时间内被自动路由降权，省一次注定失败的等待：

- **打标**：`runWithFailover` 里某家失败（非用户主动停止）→ `markProviderFailed(id, e)`；成功一次 → `markProviderOk(id)` 清除。
- **冷却分级**（`PROVIDER_COOLDOWN_MS`）：
  - `rate`（429/配额耗尽，`requestWithRotation` 抛错带 `e.kind='rate'`）→ **90s**。商汤 Token Plan 的 429 是 5h 窗口配额耗尽，Agnes 是 RPM 限流，短期重试都无意义
  - `server`（5xx 重试耗尽）/ `network`（网络失败）→ **30s**，多为瞬时抖动
  - 类别判定：优先读 `e.kind` 标记，消息内容正则兜底（`errKind`）
- **候选排序**：`capabilityCandidates` 把冷却中的供应商**追加到候选末尾**——正常候选都失败才轮到它（兜底仍参与，不放弃）；下拉「⚡ 自动」副标题对冷却供应商显示 `⏸冷却Ns`。
- 运行时内存态（`_providerHealth`），不持久化：扩展重开即重置，保守无害。

---

## 六、实施清单

| # | 改动 | 优先级 | 状态 |
|---|---|---|---|
| 1 | 视频 P0 六项修复（`buildVideoBody` 只保留 2.5-flash 一套参数） | P0 | ✅ 已完成 |
| 2 | `acquireRate` 限流预算 + 5xx 指数退避 + `onKeyUsed` | P0 | ✅ 已完成 |
| 3 | 供应商 `allowedModels` 白名单；Agnes 预设填免费模型 | P1 | ✅ 已完成 |
| 4 | `visibleModels()` 按白名单过滤模型列表与槽位下拉 | P1 | ✅ 已完成 |
| 5 | Agnes 档位（1K–4K）+ 画幅 UI，与商汤像素控件按供应商切换 | P1 | ✅ 已完成 |
| 6 | `⚡ 自动` 伪模型 + `detectIntent` + `resolveRoute` + 能力槽位 | P2 | ✅ 已完成 |
| 7 | `doChat/doImage/doVideo` 增 `model` 形参 | P2 | ✅ 已完成 |
| 8 | `AGNES_INTEGRATION_PLAN.md` 加「已过时」横幅 + 修正 v2.0 | P2 | ✅ 已完成 |
| 9 | `manifest.json` 版本 → 1.1.0；`README.md` 补三大能力章节 | — | ✅ 已完成 |
| 10 | 跨供应商自动路由失败转移（`capabilityCandidates` + `runWithFailover` + `runUnderProvider`） | P2 | ✅ 已完成 |
| 11 | 供应商健康标记（失败冷却分级 + 候选降权 + 自动跳过）；`AGNES_RPM` 文本对齐官方 10、取消多 Key 放大 | P2 | ✅ 已完成 |

---

## 七、已确认决策

- ✅ **`agnes-video-v2.0`**：直接移除，只保留 `agnes-video-2.5-flash`
- ✅ **免费白名单**：文本 `agnes-3.0-flash` / `agnes-2.5-flash`；图片 `agnes-image-2.0/2.1/2.5-flash`；视频 `agnes-video-2.5-flash`
- ✅ 视频参数走 2.5 系列：`mode:"text"` + `seconds`("4"–"12") + `size:"720P"` + `aspect_ratio`
- ✅ **能力分布**：文本 / 图片 —— Agnes 与商汤都可胜任；视频 —— 仅 Agnes；自动路由下**跨供应商取能力**（商汤下要视频自动走 Agnes），不必手动切换
- ✅ **自动路由采用「显式指令 + 强模式正则」两级**，未启用 LLM 轻分类（避免额外占用免费额度）
- ✅ **失败转移**：自动路由按候选序跨供应商尝试，谁成功用谁；用户主动停止不转移

## 八、验证与遗留

**离线验证（已完成）**：`node --check popup.js` + 76 项断言冒烟，覆盖：
参数组装 / 范围校正 / 轮询地址推导（国际站·国内站）/ 限流记账 / 5xx 重试与耗尽 / 鉴权头透传 /
意图识别 27 例（含「怎么画图」「画面很漂亮」「生成一段调用视频接口的代码」等防误判用例）/
白名单过滤 / 槽位解析与类型校验 / 跨供应商候选顺序 / 商汤无视频自动落 Agnes / 全部无能力降级文本 /
`runUnderProvider` 投影与恢复（含任务期间用户切换供应商的情形）/ `runWithFailover` 失败切换与全部失败抛错 /
健康标记（rate 90s / server 30s 分级、冷却降权排序、全冷却兜底、成功清除）

**待真机联调**（需装到 Chrome + 真实 Key）：
- [ ] 文本 → 图片 → 视频 各跑一轮
- [ ] 重点确认 2.5-flash 完成地址确实在 `metadata.url`、`size` 只接受 `720P`
- [ ] 确认国内站 `apihub.agnes-ai.cn` 的轮询域名与 Key 是否与国际站一致（官方称账号与 Key 不通用）
