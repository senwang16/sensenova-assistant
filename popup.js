/* =========================================================
 * SenseNova Assistant - popup.js
 * 商汤大模型多账号智能助手（Chrome MV3 · 原生 JS 无依赖）
 *
 * 核心能力：
 *  1. 多 Key Round-Robin 轮换 + 429/401 静默重试 + 指数退避
 *  2. /models 拉取并按关键词自动分类 文本(chat)/绘图(image)，支持手动修正
 *  3. 文本模型：流式(SSE)多轮对话，自动携带最近 6 轮上下文
 *  4. 绘图模型：/images/generations 生成，结果自动抓取转 Base64 本地缓存
 *  5. 图片历史限额：最多 20 张 / 10MB，防止撑爆 storage
 * ========================================================= */
'use strict';

/* ---------------- 常量与默认配置 ---------------- */
const DEFAULTS = {
  baseUrl: 'https://token.sensenova.cn/v1',
  chatEndpoint: '/chat/completions',
  imageEndpoint: '/images/generations',
  modelsEndpoint: '/models',
  keys: [],                                  // [{id, value, status, failCount, coolingUntil, coolReason}]
  imageConfig: { size: '2048x2048', watermark: false },
  modelTypeOverrides: {},                    // { modelId: 'chat' | 'image' } 手动修正
  theme: 'light',
  streamOutput: true,               // 流式输出总开关（false = 全部使用非流式，最稳）
  noStreamModels: {},               // { modelId: true } 已确认流式异常的模型，请求时自动用非流式
  inputHeight: 0,                   // 用户手动拖拽的输入框高度（跨会话记忆）
  lastModel: '',
  providers: [],                    // [{id, name, baseUrl, chatEndpoint, imageEndpoint, modelsEndpoint,
                                    //   keys, modelTypeOverrides, noStreamModels, cachedModels, imageConfig, lastModel}]
  currentProviderId: '',            // 当前活动供应商
  memory: {                         // 三层记忆系统配置
    recentRounds: 8,                // 近期原文保留轮数（5-10）
    summaryEnabled: true,           // 滚动综述开关
    summaryModels: [],              // 综述模型链（按优先级依次尝试，空=自动选轻量模型）
    retrievalEnabled: true,         // 跨会话向量检索开关
    rewriteEnabled: true,           // 检索前查询改写开关（消解指代）
    topK: 6,                        // 召回条数
    embeddingMode: ''               // ''=未探测 / 'api' / 'local'（本地词法嵌入）
  }
};

/* 常见供应商预设模板（新增强可按需选用，避免手填） */
const PROVIDER_PRESETS = [
  { name: '商汤 SenseNova', baseUrl: 'https://token.sensenova.cn/v1', chatEndpoint: '/chat/completions', imageEndpoint: '/images/generations', modelsEndpoint: '/models' },
  { name: 'Google Gemini (OpenAI 兼容)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', chatEndpoint: '/chat/completions', imageEndpoint: '', modelsEndpoint: '/models' },
  { name: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn/v1', chatEndpoint: '/chat/completions', imageEndpoint: '', modelsEndpoint: '/models' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', chatEndpoint: '/chat/completions', imageEndpoint: '', modelsEndpoint: '/models' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', chatEndpoint: '/chat/completions', imageEndpoint: '/images/generations', modelsEndpoint: '/models' },
  { name: '自定义', baseUrl: '', chatEndpoint: '/chat/completions', imageEndpoint: '', modelsEndpoint: '/models' }
];

/* 商汤 U1 绘图模型支持的合法尺寸（来自 API 400 报错白名单，2K 分辨率 11 种比例 + 2 种全景） */
const VALID_IMAGE_SIZES = [
  '2048x2048',  // 1:1  方形
  '2752x1536',  // 16:9 横版（API 默认）
  '1536x2752',  // 9:16 竖版
  '2496x1664',  // 3:2  横版
  '1664x2496',  // 2:3  竖版
  '2368x1760',  // 4:3  横版
  '1760x2368',  // 3:4  竖版
  '2272x1824',  // 5:4  横版
  '1824x2272',  // 4:5  竖版
  '3072x1376',  // 21:9 超宽
  '1344x3136',  // 9:21 超长竖版
  '2560x720',   // 32:9 全景横幅
  '3072x864'    // 32:9 全景横幅
];

/* 旧版本无效尺寸 → 最近似合法尺寸迁移映射 */
const LEGACY_SIZE_MAP = {
  '1024x1024': '2048x2048',
  '512x512': '2048x2048',
  '768x768': '2048x2048',
  '1024x1792': '1536x2752',
  '1792x1024': '2752x1536',
  '1024x1536': '1760x2368',
  '1536x1024': '2368x1760'
};

/** 校正尺寸：非法值按比例就近迁移，兜底 API 默认 2752x1536 */
function normalizeImageSize(size) {
  const s = String(size || '').trim().toLowerCase().replace(/[×*]/g, 'x');
  if (VALID_IMAGE_SIZES.includes(s)) return s;
  return LEGACY_SIZE_MAP[s] || '2752x1536';
}

/* 模型类型识别关键词（小写匹配） */
const IMAGE_KEYWORDS = ['image', 'u1-fast', 'draw', 'diffusion', 'dall', 'flux', 'seedream', 'sdxl', 'sd3', 'stable-diffusion', 'picture'];
// 视频/多模态生成模型（如 Google veo、gemini-image 等），既非对话也非本扩展支持的图片接口，发送前拦截
const VIDEO_KEYWORDS = ['veo', '-generate-preview', 'imagegen', 'image-gen', 'video', 'generatecontent'];
const CHAT_KEYWORDS = ['sensechat', 'chat', 'glm', 'deepseek', 'gpt', 'qwen', 'llama', 'ernie', 'hunyuan', 'kimi', 'moonshot', 'minimax', 'abab', 'baichuan', 'internlm', 'yi-'];

const MIN_SUMMARY_OVERFLOW = 6;                // 综述触发阈值：窗口外未综述消息 ≥ 6 条（约 3 轮）
const MEM_SEARCH_BUDGET_MS = 8000;             // 记忆检索总预算：超时放弃本层，绝不阻塞发送
const MEM_REWRITE_BUDGET_MS = 6000;            // 查询改写限时：超时用原句检索
const MEM_PROBE_TIMEOUT_MS = 6000;             // embeddings 探测限时（单发，不走退避）
const MEM_API_EMBED_TIMEOUT_MS = 15000;        // API 嵌入单次限时
const MAX_IMAGE_COUNT = 20;                   // 最多缓存 20 张图
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;     // 图片缓存总量上限 10MB
const COOLDOWN_429_MS = 60 * 1000;            // 429 限流冷却 60s
const COOLDOWN_401_MS = 10 * 60 * 1000;       // 401 鉴权失败冷却 10min
const BACKOFF_BASE_MS = 2000;                 // 指数退避基准 2s
const MAX_BACKOFF_ROUNDS = 2;                 // 全 Key 限流时最多额外退避重试轮数
const SINGLE_KEY_BACKOFF_MS = [5000, 15000, 30000]; // 单 Key 退避计划（RPM 限流窗口通常 60s，退避过快只会持续撞墙）
// 流式超时两段式：慢模型思考期（首字节前）给足时间，输出开始后若长时间卡住才判死
const STREAM_FIRST_BYTE_TIMEOUT_MS = 120000;  // 首字节超时：等待第一段数据（思考期）上限 120s，避免把慢模型误判为卡死
const STREAM_STALL_TIMEOUT_MS = 60000;        // 输出中途卡住：已开始输出后再连续 60s 无新数据 → 视为卡死
const REQUEST_TOTAL_TIMEOUT_MS = 300000;      // 单次请求总超时（含非流式与退避等待）300s/5min，杜绝无限转圈

/* ---------------- 全局状态 ---------------- */
let settings = JSON.parse(JSON.stringify(DEFAULTS));
let cachedModels = [];    // [{id, type}] 基础分类结果
let sessions = [];        // 所有聊天会话 [{id,title,createdAt,updatedAt,messages}]
let trash = [];           // 回收站（软删除的会话，可恢复/彻底清理）
let currentSessionId = null;
let chatHistory = [];     // 当前会话消息数组（始终引用 curSession().messages）
let keyPointer = -1;      // Round-Robin 指针
let selectedModel = null; // 当前选中模型 id
const generating = new Map(); // sessionId -> AbortController（生成任务按会话隔离，切聊天互不干扰）
let mdFilterText = '';    // 模型下拉框过滤词
let keyStatusTimer = null;// 设置面板 Key 状态刷新定时器
let lbCurrent = null;     // 大图预览当前消息

/* ---------------- DOM 快捷方式 ---------------- */
const $ = (s) => document.querySelector(s);

/* ---------------- 通用工具 ---------------- */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function abortError() { const e = new Error('已停止生成'); e.name = 'AbortError'; return e; }

/** 可被停止按钮中断的等待：分片轮询 signal 状态 */
async function abortableSleep(ms, signal) {
  const step = 100;
  for (let t = 0; t < ms; t += step) {
    if (signal?.aborted) throw abortError();
    await sleep(Math.min(step, ms - t));
  }
  if (signal?.aborted) throw abortError();
}

/** 合并多个中断信号（Chrome 116+ 用原生 AbortSignal.any，旧版手动桥接） */
function linkedAbortSignal(...signals) {
  const list = signals.filter(Boolean);
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const ctrl = new AbortController();
  list.forEach(s => {
    if (s.aborted) { ctrl.abort(); return; }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  });
  return ctrl.signal;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function formatTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatFileTs(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(path || '').startsWith('/') ? path : '/' + path;
  return b + p;
}

/* ---------------- 多供应商（Provider）体系 ----------------
 * 顶层 settings.baseUrl / keys / modelTypeOverrides / noStreamModels / lastModel / imageConfig
 * 一律视为「当前供应商」的活动投影，便于既有请求代码零改动。
 * 实际持久化按供应商分别保存于 settings.providers[]。
 */
function curProvider() {
  const list = settings.providers || [];
  return list.find(p => p.id === settings.currentProviderId) || list[0] || null;
}

/** 新建一个供应商对象（id 全局唯一） */
function makeProvider(preset = {}) {
  const name = (preset.name || '自定义').trim();
  const baseUrl = String(preset.baseUrl || '').trim().replace(/\/+$/, '');
  return {
    id: 'prov_' + uid(),
    name,
    baseUrl,
    chatEndpoint: normEndpoint(preset.chatEndpoint, DEFAULTS.chatEndpoint),
    imageEndpoint: normEndpoint(preset.imageEndpoint, DEFAULTS.imageEndpoint, true),
    modelsEndpoint: normEndpoint(preset.modelsEndpoint, DEFAULTS.modelsEndpoint),
    keys: [],
    modelTypeOverrides: {},
    noStreamModels: {},
    cachedModels: [],
    imageConfig: { ...JSON.parse(JSON.stringify(DEFAULTS.imageConfig)) },
    lastModel: ''
  };
}

function normEndpoint(v, def, allowEmpty) {
  const s = String(v || '').trim();
  if (!s) return allowEmpty ? '' : def;
  return s.startsWith('/') ? s : '/' + s;
}

/** 规范化一个已持久化的供应商对象（兼容缺字段/旧结构） */
function normalizeProvider(p, idx) {
  const baseUrl = String(p.baseUrl || '').trim().replace(/\/+$/, '');
  return {
    id: p.id || 'prov_' + (idx + 1) + '_' + uid(),
    name: (p.name || '供应商 ' + (idx + 1)).toString().slice(0, 30),
    baseUrl,
    chatEndpoint: normEndpoint(p.chatEndpoint, DEFAULTS.chatEndpoint),
    imageEndpoint: normEndpoint(p.imageEndpoint, DEFAULTS.imageEndpoint, true),
    modelsEndpoint: normEndpoint(p.modelsEndpoint, DEFAULTS.modelsEndpoint),
    keys: (p.keys || []).map((k, i) => ({
      id: k.id || 'key_' + i,
      value: k.value || '',
      status: k.status || 'active',
      failCount: k.failCount || 0,
      coolingUntil: k.coolingUntil || 0,
      coolReason: k.coolReason || ''
    })),
    modelTypeOverrides: p.modelTypeOverrides || {},
    noStreamModels: p.noStreamModels || {},
    cachedModels: Array.isArray(p.cachedModels) ? p.cachedModels : [],
    imageConfig: { ...DEFAULTS.imageConfig, ...(p.imageConfig || {}) },
    lastModel: p.lastModel || ''
  };
}

/** 把指定供应商的配置投影到顶层 settings + 载入其模型列表 */
function projectProvider(p) {
  if (!p) return;
  settings.currentProviderId = p.id;
  settings.baseUrl = p.baseUrl || '';
  settings.chatEndpoint = p.chatEndpoint;
  settings.imageEndpoint = p.imageEndpoint;
  settings.modelsEndpoint = p.modelsEndpoint;
  settings.keys = p.keys;
  settings.modelTypeOverrides = p.modelTypeOverrides;
  settings.noStreamModels = p.noStreamModels;
  settings.lastModel = p.lastModel || '';
  settings.imageConfig = p.imageConfig;
  cachedModels = p.cachedModels || [];
}

/** 把顶层 settings 的活动值写回当前供应商（持久化前调用） */
function absorbProvider() {
  const p = curProvider();
  if (!p) return;
  p.baseUrl = settings.baseUrl;
  p.chatEndpoint = settings.chatEndpoint;
  p.imageEndpoint = settings.imageEndpoint;
  p.modelsEndpoint = settings.modelsEndpoint;
  p.keys = settings.keys;
  p.modelTypeOverrides = settings.modelTypeOverrides;
  p.noStreamModels = settings.noStreamModels;
  p.lastModel = settings.lastModel || '';
  p.imageConfig = settings.imageConfig;
  p.cachedModels = cachedModels;
}

function isDataUrl(s) { return typeof s === 'string' && s.startsWith('data:image'); }

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('图片读取失败'));
    fr.readAsDataURL(blob);
  });
}

/* ---------------- 轻量 Markdown 渲染 ----------------
 * 支持：代码块、行内代码、加粗、斜体、删除线、标题、
 *       有序/无序列表、引用、链接、分隔线、换行
 * 全部输入先经 HTML 转义，防注入 */
function renderMarkdown(src) {
  if (!src) return '';
  const blocks = [];

  // 1. 先抽离 ``` 代码块（占位符保护，避免被行内语法污染）
  let text = String(src).replace(/```([\w+#-]*)[ \t]*\n?([\s\S]*?)(```|$)/g, (m, lang, code) => {
    blocks.push({ lang, code: code.replace(/\n$/, '') });
    return '\u0001B' + (blocks.length - 1) + '\u0001';
  });

  // 2. HTML 转义
  text = escapeHtml(text);

  // 3. 行内语法
  const inline = (s) => s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // 4. 逐行解析块级语法
  const lines = text.split('\n');
  const out = [];
  let para = [], ul = false, ol = false, quote = [];

  const flushPara = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
  const closeLists = () => {
    if (ul) { out.push('</ul>'); ul = false; }
    if (ol) { out.push('</ol>'); ol = false; }
  };
  const flushQuote = () => {
    if (quote.length) { out.push('<blockquote>' + quote.map(inline).join('<br>') + '</blockquote>'); quote = []; }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { flushPara(); closeLists(); flushQuote(); continue; }

    // 代码块占位符独占一行
    if (/^\u0001B\d+\u0001$/.test(line)) { flushPara(); closeLists(); flushQuote(); out.push(line); continue; }

    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {          // 标题
      flushPara(); closeLists(); flushQuote();
      const lv = Math.min(4, m[1].length) + 2;
      out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {             // 分隔线
      flushPara(); closeLists(); flushQuote(); out.push('<hr>');
      continue;
    }
    if ((m = line.match(/^&gt;\s?(.*)$/))) {               // 引用（> 已被转义）
      flushPara(); closeLists(); quote.push(m[1]);
      continue;
    }
    if ((m = line.match(/^[-*+]\s+(.*)$/))) {              // 无序列表
      flushPara(); flushQuote();
      if (ol) { out.push('</ol>'); ol = false; }
      if (!ul) { out.push('<ul>'); ul = true; }
      out.push('<li>' + inline(m[1]) + '</li>');
      continue;
    }
    if ((m = line.match(/^\d+[.、)]\s+(.*)$/))) {          // 有序列表
      flushPara(); flushQuote();
      if (ul) { out.push('</ul>'); ul = false; }
      if (!ol) { out.push('<ol>'); ol = true; }
      out.push('<li>' + inline(m[1]) + '</li>');
      continue;
    }
    para.push(line);
  }
  flushPara(); closeLists(); flushQuote();

  // 5. 还原代码块
  return out.join('\n').replace(/\u0001B(\d+)\u0001/g, (m, i) => {
    const b = blocks[+i];
    return `<div class="codeblock">`
      + `<div class="cb-head"><span>${escapeHtml(b.lang || 'code')}</span>`
      + `<button class="cb-copy" type="button" title="复制代码">复制</button></div>`
      + `<pre><code>${escapeHtml(b.code)}</code></pre></div>`;
  });
}

/* ---------------- 存储层 ---------------- */
async function loadAll() {
  const data = await chrome.storage.local.get(['settings', 'cachedModels', 'history', 'sessions', 'trash', 'currentSessionId']);
  settings = { ...JSON.parse(JSON.stringify(DEFAULTS)), ...(data.settings || {}) };
  settings.imageConfig = { ...DEFAULTS.imageConfig, ...(settings.imageConfig || {}) };
  settings.imageConfig.size = normalizeImageSize(settings.imageConfig.size); // 迁移旧版非法尺寸（如 1024x1024）
  settings.modelTypeOverrides = settings.modelTypeOverrides || {};
  settings.streamOutput = settings.streamOutput !== false;
  settings.noStreamModels = settings.noStreamModels || {};
  settings.memory = { ...DEFAULTS.memory, ...(settings.memory || {}) };
  settings.keys = (settings.keys || []).map((k, i) => ({
    id: k.id || `key_${i + 1}`,
    value: k.value || '',
    status: k.status || 'active',
    failCount: k.failCount || 0,
    coolingUntil: k.coolingUntil || 0,
    coolReason: k.coolReason || ''
  }));
  cachedModels = Array.isArray(data.cachedModels) ? data.cachedModels : [];

  /* ---- 多供应商：迁移旧版单端配置 → 首个供应商 ---- */
  if (!Array.isArray(settings.providers) || settings.providers.length === 0) {
    // 旧版（无 providers）：把顶层 baseUrl/keys/模型缓存整体降级为第一个供应商
    settings.providers = [normalizeProvider({
      baseUrl: settings.baseUrl,
      chatEndpoint: settings.chatEndpoint,
      imageEndpoint: settings.imageEndpoint,
      modelsEndpoint: settings.modelsEndpoint,
      keys: settings.keys,
      modelTypeOverrides: settings.modelTypeOverrides,
      noStreamModels: settings.noStreamModels,
      cachedModels,
      imageConfig: settings.imageConfig,
      lastModel: settings.lastModel
    }, 0)];
  } else {
    // 已有多供应商：规范化每一项
    settings.providers = settings.providers.map(normalizeProvider);
  }
  // 确保 currentProviderId 有效
  const cur = settings.currentProviderId;
  if (!settings.providers.some(p => p.id === cur)) settings.currentProviderId = settings.providers[0].id;
  // 投影当前供应商到顶层（既有请求代码零改动地读取顶层配置）
  projectProvider(curProvider());

  /* 会话数据加载（含旧版 history 单流自动迁移） */
  sessions = Array.isArray(data.sessions) ? data.sessions : [];
  trash = Array.isArray(data.trash) ? data.trash : [];
  currentSessionId = data.currentSessionId || null;

  if (!sessions.length && Array.isArray(data.history) && data.history.length) {
    const s = makeSessionObject('历史对话', data.history); // 旧版全部历史 → 归入一个会话
    sessions.push(s);
    currentSessionId = s.id;
    chrome.storage.local.remove('history'); // 迁移完成，清理旧键
  }
  if (!sessions.length) {
    const s = makeSessionObject('新对话');
    sessions.push(s);
    currentSessionId = s.id;
  }
  if (!sessions.some(s => s.id === currentSessionId)) currentSessionId = sessions[0].id;
  chatHistory = curSession().messages;
}

async function saveSettings() {
  absorbProvider(); // 顶层活动值 → 写回当前供应商，再整体持久化
  try { await chrome.storage.local.set({ settings }); }
  catch (e) { console.warn('保存设置失败', e); }
}

/** 持久化会话数据（当前会话消息通过引用包含在 sessions 内） */
async function persistHistory() {
  try {
    await chrome.storage.local.set({ sessions, trash, currentSessionId });
  } catch (e) {
    // 配额不足时逐步删除当前会话最旧图片后重试
    for (let i = 0; i < 10; i++) {
      const idx = chatHistory.findIndex(m => m.type === 'image' && isDataUrl(m.content));
      if (idx === -1) break;
      chatHistory.splice(idx, 1);
      try { await chrome.storage.local.set({ sessions, trash, currentSessionId }); return; } catch (_) { /* 继续裁剪 */ }
    }
    toast('本地存储空间不足，部分历史未能保存', 'error');
  }
}

/* ---------------- 会话管理（增删改查 + 回收站） ---------------- */
function makeSessionObject(title, messages = []) {
  return {
    id: 'sess_' + uid(), title, createdAt: Date.now(), updatedAt: Date.now(), messages,
    model: '', draft: '',
    providerId: settings.currentProviderId || curProvider()?.id || '', // 所属供应商
    category: '',                   // 分类收纳（空 = 未分类）
    summary: '',                    // 滚动综述（更早对话的要点）
    summarizedUpTo: 0               // 已综述的已完成文本消息数（幂等水位）
  };
}

function curSession() { return sessions.find(s => s.id === currentSessionId) || sessions[0]; }

/** 当前选中模型写回会话（每个聊天记住自己的模型） */
function syncSessionModel() {
  const s = curSession();
  if (s) s.model = selectedModel || '';
}

/** 保存输入草稿到当前会话（内存更新，切换/失焦时落盘） */
function syncSessionDraft() {
  const s = curSession();
  if (s) s.draft = $('#input').value;
}

/** 会话切换后同步整个右侧 UI：模型选择 / 输入草稿 / 发送(停止)按钮 / 绘图参数 / 下拉勾选 */
function applySessionUI() {
  const s = curSession();
  if (!s) return;
  // 模型：优先用会话记忆的模型；已失效（模型列表变化）则回退并写回
  if (s.model && cachedModels.some(m => m.id === s.model)) {
    selectedModel = s.model;
  } else {
    selectedModel = null;
    autoSelectModel();          // 回退：lastModel → 首个文本模型
    syncSessionModel();
  }
  // 输入草稿恢复
  const inputEl = $('#input');
  inputEl.value = s.draft || '';
  autoGrow(inputEl);
  renderModelDropdown();
  updateModelButton();
  updateComposerMode();
  setSendState();
}

function touchSession(sid = currentSessionId) {
  const s = sessions.find(x => x.id === sid);
  if (s) s.updatedAt = Date.now();
  renderSessionList(); // 更新排序
}

/** 新建聊天并切换过去 */
async function newSession() {
  syncSessionDraft();                                   // 旧会话草稿暂存
  const s = makeSessionObject('新对话');
  s.model = selectedModel || settings.lastModel || '';  // 新聊天延续当前模型
  sessions.unshift(s);
  currentSessionId = s.id;
  chatHistory = s.messages;
  await persistHistory();
  renderAllMessages();
  renderSessionList();
  applySessionUI();                                     // 空草稿 + 延续模型 + 复位按钮
  toast('已新建聊天', 'success');
}

/** 切换会话：聊天内容、输入草稿、模型选择、停止按钮、绘图参数全部跟随切换 */
async function switchSession(id) {
  if (id === currentSessionId) return;
  syncSessionDraft();                                   // 切走前保存当前输入草稿
  currentSessionId = id;
  chatHistory = curSession().messages;
  // 会话归属的供应商 ≠ 当前 → 跟随切换（保证其模型列表可用）
  const s = curSession();
  if (s && s.providerId && s.providerId !== settings.currentProviderId &&
      (settings.providers || []).some(p => p.id === s.providerId)) {
    switchProvider(s.providerId);
  }
  await persistHistory();
  renderAllMessages();
  renderSessionList();
  applySessionUI();
}

/** 重命名 */
async function renameSession(id) {
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  const name = prompt('修改聊天名称：', s.title);
  if (name === null) return; // 取消
  const t = name.trim().slice(0, 40);
  if (!t) { toast('名称不能为空', 'error'); return; }
  s.title = t;
  await persistHistory();
  renderSessionList();
  toast('已重命名', 'success');
}

/** 删除 → 移入回收站（软删除，可恢复） */
async function deleteSessionToTrash(id) {
  const idx = sessions.findIndex(x => x.id === id);
  if (idx === -1) return;
  const [s] = sessions.splice(idx, 1);
  s.deletedAt = Date.now();
  trash.unshift(s);

  // 删除的是当前会话 → 切到剩余第一个，一个不剩则新建空会话
  if (id === currentSessionId) {
    if (sessions.length) {
      currentSessionId = sessions[0].id;
      chatHistory = curSession().messages;
    } else {
      const ns = makeSessionObject('新对话');
      ns.model = selectedModel || '';
      sessions.unshift(ns);
      currentSessionId = ns.id;
      chatHistory = ns.messages;
    }
    renderAllMessages();
    applySessionUI();
  }
  await persistHistory();
  renderSessionList();
  renderTrashList();
  toast('已移入回收站（可恢复）');
}

/** 从回收站恢复（自动重建该会话的向量索引） */
async function restoreSession(id) {
  const idx = trash.findIndex(x => x.id === id);
  if (idx === -1) return;
  const [s] = trash.splice(idx, 1);
  delete s.deletedAt;
  sessions.unshift(s);
  await persistHistory();
  renderSessionList();
  renderTrashList();
  backfillSessionVectors(s).catch(() => {}); // 回收站期间向量可能已被清理 → 重建
  toast('已恢复：' + s.title, 'success');
}

/** 彻底删除：文字 + Base64 图片 + 向量数据 + 综述一并清理，不可恢复 */
async function purgeSession(id) {
  const idx = trash.findIndex(x => x.id === id);
  if (idx === -1) return;
  const [s] = trash.splice(idx, 1);
  s.messages = []; // 释放消息（含图片 Base64）
  s.summary = '';
  s.summarizedUpTo = 0;
  await persistHistory(); // 从 storage 移除该会话全部数据
  await memDeleteBySession(id).catch(() => {}); // 联动清理向量库记录
  renderTrashList();
  renderSessionList();
  toast('已彻底删除（含图片与向量数据）', 'success');
}

/** 清空回收站：二次确认后彻底清理全部（含向量） */
async function emptyTrash() {
  if (!trash.length) { toast('回收站已是空的'); return; }
  const ids = trash.map(s => s.id);
  trash = [];
  await persistHistory();
  for (const sid of ids) await memDeleteBySession(sid).catch(() => {}); // 清理全部向量
  renderTrashList();
  renderSessionList();
  toast('回收站已清空，数据已彻底清理', 'success');
}

/* ---------------- 侧边栏渲染与开关 ---------------- */
function toggleSidebar() { $('#app').classList.toggle('sb-collapsed'); }

function showSbView(v) {
  $('#sbMain').classList.toggle('hidden', v !== 'main');
  $('#sbTrash').classList.toggle('hidden', v !== 'trash');
}

/* 折叠状态存于 settings.collapsedCats（按分类名） */
function getCollapsedCats() {
  if (!Array.isArray(settings.collapsedCats)) settings.collapsedCats = [];
  return settings.collapsedCats;
}

function renderSessionList() {
  const box = $('#sessionList');
  if (!box) return;
  const title = $('#sbTitle');
  if (title) title.textContent = `💬 聊天（${sessions.length}）`; // 列表页显示聊天总数

  if (!sessions.length) {
    box.innerHTML = '<div class="sb-empty">暂无聊天，点击上方「＋ 新建」</div>';
    return;
  }

  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  // 分类收纳：按 category 分组，未分类置顶，其余按名称排序
  const groups = new Map();
  for (const s of sorted) {
    const c = s.category || '';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(s);
  }
  const catNames = [...groups.keys()].sort((a, b) => {
    if (a === '') return -1;
    if (b === '') return 1;
    return a.localeCompare(b, 'zh');
  });

  const itemHtml = (s) => `
    <div class="ss-item${s.id === currentSessionId ? ' active' : ''}" data-id="${escapeHtml(s.id)}">
      ${generating.has(s.id) ? '<span class="ss-busy" title="生成中…"></span>' : ''}
      <span class="ss-name" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</span>
      <span class="ss-meta">${s.messages.length ? s.messages.length + '条' : ''}</span>
      <button class="ss-act" data-act="rename" data-id="${escapeHtml(s.id)}" title="重命名">✎</button>
      <button class="ss-act" data-act="move" data-id="${escapeHtml(s.id)}" title="移动到分类">📁</button>
      <button class="ss-act del" data-act="delete" data-id="${escapeHtml(s.id)}" title="移入回收站">🗑</button>
    </div>`;

  box.innerHTML = catNames.map(cat => {
    const items = groups.get(cat);
    const collapsed = getCollapsedCats().includes(cat);
    return `<div class="ss-group">
      <div class="ss-group-head" data-cat="${escapeHtml(cat)}" title="折叠 / 展开">
        <span class="ss-caret${collapsed ? '' : ' open'}">▸</span>
        <span class="ss-cat-name">${escapeHtml(cat || '未分类')}</span>
        <span class="ss-cat-count">${items.length}</span>
      </div>
      ${collapsed ? '' : items.map(itemHtml).join('')}
    </div>`;
  }).join('');
}

function renderTrashList() {
  const box = $('#trashList');
  if (!box) return;
  const title = $('#sbTrashTitle');
  if (title) title.textContent = `🗑 回收站（${trash.length}）`; // 进入回收站时显示数量
  box.innerHTML = trash.map(s => `
    <div class="tr-item" data-id="${escapeHtml(s.id)}">
      <span class="tr-name" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</span>
      <button class="tr-act restore" data-act="restore" data-id="${escapeHtml(s.id)}" title="恢复到聊天列表">↩</button>
      <button class="tr-act purge" data-act="purge" data-id="${escapeHtml(s.id)}" title="彻底删除（含文字、图片与向量数据）">✕</button>
    </div>`).join('') || '<div class="sb-empty">回收站是空的</div>';
}

/** 移动会话到分类（输入名称即建新分类，留空 = 未分类） */
async function moveSessionCategory(id) {
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  const cats = [...new Set(sessions.map(x => x.category).filter(Boolean))];
  const tip = cats.length ? `已有分类：${cats.join('、')}` : '暂无自定义分类';
  const name = prompt(`${tip}\n输入目标分类名称（留空 = 未分类）：`, s.category || '');
  if (name === null) return; // 取消
  s.category = name.trim().slice(0, 20);
  await persistHistory();
  renderSessionList();
  toast(s.category ? `已移动到「${s.category}」` : '已移回未分类', 'success');
}

/* ---------------- 模型分类 ---------------- */
function classifyModel(id) {
  const s = String(id || '').toLowerCase();
  if (VIDEO_KEYWORDS.some(k => s.includes(k))) return 'video';
  if (IMAGE_KEYWORDS.some(k => s.includes(k))) return 'image';
  if (CHAT_KEYWORDS.some(k => s.includes(k))) return 'chat';
  return 'chat'; // 兜底默认为文本模型，可手动修正
}

function getEffectiveType(id) {
  return settings.modelTypeOverrides[id] || classifyModel(id);
}

async function fetchModels(auto = false) {
  if (!settings.keys.length) {
    toast('请先在设置中配置至少一个 API Key', 'error');
    openSettings();
    return;
  }
  const btn = $('#btnRefreshModels');
  btn.classList.add('spinning');
  try {
    const res = await requestWithRotation(joinUrl(settings.baseUrl, settings.modelsEndpoint), { method: 'GET' });
    const data = await res.json();
    const list = (data.data || data.models || [])
      .map(m => m.id || m.model || m.name)
      .filter(Boolean);
    cachedModels = [...new Set(list)].map(id => ({ id, type: classifyModel(id) }));
    await saveSettings();               // 写回当前供应商并持久化
    renderModelDropdown();
    autoSelectModel();
    syncSessionModel();   // 模型列表刷新后，把生效模型写回当前会话
    const nImg = cachedModels.filter(m => getEffectiveType(m.id) === 'image').length;
    toast(`已获取 ${cachedModels.length} 个模型（文本 ${cachedModels.length - nImg} / 绘图 ${nImg}）`, 'success');
  } catch (e) {
    if (!auto) toast('拉取模型失败：' + e.message, 'error');
  } finally {
    btn.classList.remove('spinning');
  }
}

function autoSelectModel() {
  if (!cachedModels.length) { selectedModel = null; updateModelButton(); updateComposerMode(); return; }
  if (selectedModel && cachedModels.some(m => m.id === selectedModel)) return;
  const last = settings.lastModel;
  if (last && cachedModels.some(m => m.id === last)) {
    selectedModel = last;
  } else {
    const firstChat = cachedModels.find(m => getEffectiveType(m.id) === 'chat');
    selectedModel = (firstChat || cachedModels[0]).id;
  }
  updateModelButton();
  updateComposerMode();
}

/* ---------------- Key 池轮换与 429/401 防爆 ---------------- */
function parseKeysFromText(text) {
  return String(text || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .map((v, i) => ({
      id: `key_${i + 1}`,
      value: v,
      status: 'active',
      failCount: 0,
      coolingUntil: 0,
      coolReason: ''
    }));
}

function authValue(key) {
  const v = String(key.value).trim();
  return /^bearer\s/i.test(v) ? v : 'Bearer ' + v;
}

function isKeyUsable(k) {
  return k.status !== 'invalid' && Date.now() >= (k.coolingUntil || 0);
}

/** Round-Robin：指针自动指向下一个可用 Key（keys 由调用方传入，杜绝跨供应商串 Key） */
function pickNextKey(keys) {
  if (!keys.length) return null;
  for (let i = 0; i < keys.length; i++) {
    keyPointer = (keyPointer + 1) % keys.length;
    if (isKeyUsable(keys[keyPointer])) return keys[keyPointer];
  }
  return null;
}

async function readApiError(res) {
  let msg = `HTTP ${res.status}`;
  try {
    const j = await res.json();
    msg += '：' + (j?.error?.message || j?.message || j?.error?.code || JSON.stringify(j).slice(0, 180));
  } catch (_) {
    try {
      const t = await res.text();
      if (t) msg += '：' + t.slice(0, 180);
    } catch (_) { /* 忽略 */ }
  }
  return new Error(msg);
}

/**
 * 带 Key 轮换的请求：
 * - 支持外部 signal 中断（停止按钮 / 超时）
 * - 429/401 → 当前 Key 进入冷却，静默切换下一个 Key 重试（上限 = Key 总数）
 * - 一轮全部失败且存在 429 → 指数退避后重置 429 冷却再来一轮：
 *     · 单 Key：退避 5s→15s→30s（贴合 60s RPM 限流窗口，避免快速重试持续撞墙）
 *     · 多 Key：退避 2s→4s（共 2 轮）
 * - 全部为 401 → 直接报错（等待无意义）
 */
async function requestWithRotation(url, init, { onNotice, signal, userSignal } = {}) {
  // 关键：锁定发起请求时的 Key 快照。
  // 多供应商场景下，生成中切换会话会跟随切换供应商（projectProvider 替换 settings.keys），
  // 若每次重试实时读 settings.keys，会拿 B 供应商的 Key 打 A 供应商的 URL → 必然 401 →
  // 误冷却无辜 Key，后续请求连环退避甚至超时（单供应商时代无此路径，故当时更稳）。
  // Key 对象本身仍是共享引用，冷却/激活状态变更可正常持久化。
  const keys = settings.keys.slice();
  if (!keys.length) {
    const e = new Error('尚未配置 API Key，请点击右上角 ⚙️ 进入设置');
    e.needSettings = true;
    throw e;
  }

  // 单 Key 场景使用更长的退避计划（见函数头注释）
  const single = keys.length <= 1;
  const backoffRounds = single ? SINGLE_KEY_BACKOFF_MS.length : MAX_BACKOFF_ROUNDS;

  for (let round = 0; round <= backoffRounds; round++) {
    if (round > 0) {
      const has429 = keys.some(k => k.coolReason === '429');
      if (!has429) break; // 全部 401，等待无意义
      const wait = single ? SINGLE_KEY_BACKOFF_MS[round - 1] : BACKOFF_BASE_MS * Math.pow(2, round - 1);
      if (onNotice) onNotice(`⏳ 所有 Key 均被限流，${wait / 1000}s 后自动重试（第 ${round + 1} 轮）…`);
      await abortableSleep(wait, signal); // 等待期间也可随时停止
      keys.forEach(k => { if (k.coolReason === '429') { k.coolingUntil = 0; k.status = 'active'; } });
    }

    // 每轮最多尝试 Key 总数次（单 Key 即：每轮试 1 次）
    for (let attempt = 0; attempt < keys.length; attempt++) {
      const key = pickNextKey(keys);
      if (!key) {
        // 唯一 Key 冷却中且本轮已到此处：跳出进入下一轮退避
        break;
      }

      let res;
      try {
        res = await fetch(url, {
          ...init,
          signal,
          headers: { ...(init.headers || {}), 'Authorization': authValue(key) }
        });
      } catch (e) {
        if (e.name === 'AbortError') {
          if (userSignal?.aborted) throw abortError(); // 用户主动停止
          throw e; // 内部超时中断，交由上层分类处理
        }
        throw new Error('网络请求失败：' + (e.message || '无法连接服务器，请检查 Base URL / 网络'));
      }

      if (res.status === 429 || res.status === 401) {
        key.failCount = (key.failCount || 0) + 1;
        key.status = 'cooling';
        key.coolReason = String(res.status);
        key.coolingUntil = Date.now() + (res.status === 429 ? COOLDOWN_429_MS : COOLDOWN_401_MS);
        let detail = '';
        try { detail = (await res.text()).replace(/\s+/g, ' ').slice(0, 100); } catch (_) { /* 忽略 */ }
        renderKeyStatus();
        saveSettings();
        if (onNotice) {
          const base = keys.length === 1
            ? `⚠️ Key 返回 ${res.status}（${res.status === 429 ? '限流' : '鉴权失败'}），将自动退避重试`
            : `⚠️ ${key.id} 返回 ${res.status}（${res.status === 429 ? '限流' : '鉴权失败'}），已冷却并自动切换下一个 Key`;
          onNotice(base + (detail ? '：' + detail : '…')); // 透出服务端限流详情，便于定位
        }
        continue; // 静默换 Key 重试
      }

      if (!res.ok) throw await readApiError(res);

      // 成功：恢复 Key 状态（含清除冷却原因，避免残留影响后续判断）
      key.failCount = 0;
      key.coolingUntil = 0;
      key.status = 'active';
      key.coolReason = '';
      renderKeyStatus();
      saveSettings();
      return res;
    }
  }

  const has429 = keys.some(k => k.coolReason === '429');
  const has401 = keys.some(k => k.coolReason === '401');
  let msg = '所有 Key 均不可用，请稍后再试';
  if (has429 && has401) msg = '所有 Key 均处于限流(429)/鉴权失败(401)状态，请检查 Key 或稍后再试';
  else if (has429) msg = keys.length === 1
    ? '当前 Key 持续被限流(429)，已自动退避重试多次仍失败，请稍后再试或补充更多 Key'
    : '所有 Key 均被限流(429)，已按指数退避自动重试仍失败，请稍后再试';
  else if (has401) msg = '所有 Key 鉴权失败(401)，请检查 Key 是否正确或已过期';
  const err = new Error(msg);
  if (has429) err.code = 'rate_limited'; // 上层据此尝试关闭流式降级重试
  throw err;
}

/* ---------------- 聊天（流式 SSE） ---------------- */
/* =========================================================
 * 三层记忆系统
 *  L1 近期原文：最近 N 轮原样保留（可配置 5-10，默认 8）
 *  L2 滚动综述：更早对话后台压缩为要点综述（模型链按优先级依次尝试）
 *  L3 向量检索：全部会话问答对入本地 IndexedDB 向量库，
 *              对话时召回 Top-K 相关历史注入上下文（支持查询改写消解指代）
 *  嵌入：优先探测网关 /embeddings，不支持则回落本地词法嵌入（零下载零依赖）
 * ========================================================= */

const MEM_SYSTEM_PREAMBLE = '你是一个具有长期记忆的助手。以下背景资料来自更早的对话与历史聊天记录，仅供回答参考：若与近期对话内容冲突，以近期对话为准；不要主动提及"综述/检索/记忆"等内部机制。';

/* ---------- 本地向量库（IndexedDB，浏览器通用标准方案） ---------- */
const MEM_DB_NAME = 'sensenova_memory';
const MEM_STORE = 'vectors';
let memDbPromise = null;

function openMemDB() {
  if (memDbPromise) return memDbPromise;
  memDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(MEM_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MEM_STORE)) {
        const store = db.createObjectStore(MEM_STORE, { keyPath: 'id' });
        store.createIndex('sessionId', 'sessionId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(e => { memDbPromise = null; throw e; });
  return memDbPromise;
}

async function memStore(mode) {
  const db = await openMemDB();
  return db.transaction(MEM_STORE, mode).objectStore(MEM_STORE);
}

function memReq(request, pick) {
  return new Promise((res, rej) => {
    request.onsuccess = () => res(pick ? pick(request) : request.result);
    request.onerror = () => rej(request.error);
  });
}

function memPut(rec) { return memStore('readwrite').then(s => memReq(s.put(rec))); }
function memGetAll() { return memStore('readonly').then(s => memReq(s.getAll()).then(r => r || [])); }
function memCount() { return memStore('readonly').then(s => memReq(s.count())); }
function memClear() { return memStore('readwrite').then(s => memReq(s.clear())); }

/** 删除某会话的全部向量记录（彻底删除/清空聊天时联动清理） */
function memDeleteBySession(sid) {
  return memStore('readwrite').then(s => new Promise((res, rej) => {
    const rq = s.index('sessionId').openCursor(IDBKeyRange.only(sid));
    rq.onsuccess = () => {
      const cur = rq.result;
      if (cur) { cur.delete(); cur.continue(); } else res();
    };
    rq.onerror = () => rej(rq.error);
  }));
}

/* ---------- 嵌入：本地词法 + API 探测回退 ---------- */
const LOCAL_EMBED_DIM = 512;

/** 本地词法嵌入：中文字符二元组 + 拉丁词哈希 → L2 归一化。离线可用，毫秒级 */
function localEmbed(text) {
  const vec = new Array(LOCAL_EMBED_DIM).fill(0);
  const t = String(text || '').toLowerCase();
  const grams = t.match(/[a-z0-9]+/g) || [];
  const compact = t.replace(/\s+/g, '');
  for (let i = 0; i < compact.length - 1; i++) grams.push(compact.slice(i, i + 2));
  if (compact.length === 1) grams.push(compact);
  for (const g of grams) {
    let h = 5381;
    for (let i = 0; i < g.length; i++) h = ((h * 33) ^ g.charCodeAt(i)) >>> 0;
    vec[h % LOCAL_EMBED_DIM] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}

/** API 嵌入（OpenAI 兼容 /embeddings）。商汤 Token Plan 无此路由时抛错 → 回落本地 */
async function apiEmbed(text) {
  const res = await requestWithRotation(joinUrl(settings.baseUrl, '/embeddings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'embedding-1', input: [String(text).slice(0, 2000)] })
  });
  if (!res.ok) throw new Error('embeddings HTTP ' + res.status);
  const data = await res.json().catch(() => null);
  const v = data?.data?.[0]?.embedding;
  if (!Array.isArray(v) || !v.length) throw new Error('embeddings 空响应');
  return v;
}

/** 统一嵌入入口：首次探测网关能力并缓存结果（api / local） */
async function embedText(text) {
  const mode = settings.memory.embeddingMode;
  if (mode === 'api') {
    try { return await apiEmbed(text); }
    catch (_) { settings.memory.embeddingMode = 'local'; saveSettings(); }
  } else if (mode !== 'local') {
    try {
      const v = await apiEmbed('ping');
      settings.memory.embeddingMode = 'api';
      saveSettings();
      return v;
    } catch (_) {
      settings.memory.embeddingMode = 'local';
      saveSettings();
    }
  }
  return localEmbed(text);
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}

/* ---------- 综述模型链：按优先级依次尝试 ---------- */
function getSummaryChain() {
  const chain = (settings.memory.summaryModels || [])
    .map(s => String(s).trim())
    .filter(id => id && cachedModels.some(m => m.id === id));
  if (chain.length) return chain;
  // 自动链：轻量模型优先 → 当前会话模型 → 第一个文本模型
  const chats = cachedModels.filter(m => getEffectiveType(m.id) === 'chat').map(m => m.id);
  const light = chats.find(id => /flash|lite|mini|small|fast|nano/i.test(id));
  const cur = selectedModel && getEffectiveType(selectedModel) === 'chat' ? selectedModel : null;
  return [...new Set([light, cur, chats[0]].filter(Boolean))].slice(0, 3);
}

/** 非流式补全：模型链内逐个尝试，全部失败才抛错（综述/改写共用） */
async function chainChatComplete(messages, { signal } = {}) {
  const chain = getSummaryChain();
  if (!chain.length) throw new Error('无可用文本模型');
  let lastErr = null;
  for (const model of chain) {
    try {
      return await streamChat(model, messages, { stream: false, signal, onDelta: () => {} });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e; // 按优先级换下一个模型
    }
  }
  throw lastErr || new Error('模型链全部失败');
}

/* ---------- L2 滚动综述 ---------- */
/** 幂等水位推进：仅综述"近期窗口之外"的消息，欠账 ≥ 阈值才触发，失败下次重试 */
async function maybeUpdateSummary(sess) {
  if (!settings.memory.summaryEnabled || !sess) return;
  const done = sess.messages.filter(m =>
    m.type === 'text' && (m.role === 'user' || m.role === 'assistant') &&
    m.modelType !== 'image' && !m.pending && m.content
  );
  const recentN = clampRounds(settings.memory.recentRounds) * 2;
  const target = Math.max(0, done.length - recentN);
  const upTo = sess.summarizedUpTo || 0;
  if (target - upTo < MIN_SUMMARY_OVERFLOW) return;
  const slice = done.slice(upTo, target);
  if (!slice.length) return;

  const dialog = slice.map(m =>
    `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, 600)}`
  ).join('\n');
  const out = await chainChatComplete([{
    role: 'user',
    content: `你是记忆管理器。把【新增对话】合并进【既有综述】，输出更新后的综述。\n要求：保留关键事实、结论、决定、名称、数字、代码要点；删除寒暄与重复；按主题分点组织；不超过500字；直接输出综述正文，无任何前后缀。\n\n【既有综述】\n${sess.summary || '（无）'}\n\n【新增对话】\n${dialog}`
  }]);
  const text = String(out || '').trim();
  if (!text) return;
  sess.summary = text;
  sess.summarizedUpTo = target;
  await persistHistory();
}

function clampRounds(n) { return Math.max(5, Math.min(10, parseInt(n, 10) || 8)); }

/* ---------- L3 向量检索 ---------- */
/** 查询改写：仅当问题含指代词时触发（省配额省延迟），消解"它/这个/上述"等 */
function buildRewritePrompt(query, sess) {
  const done = sess.messages.filter(m =>
    m.type === 'text' && !m.pending && m.content && (m.role === 'user' || m.role === 'assistant')
  );
  const last = done.slice(-2).map(m =>
    `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, 150)}`
  ).join('\n');
  return `把下面的用户问题改写成一个独立、完整、可脱离上下文理解的检索查询：补全代词（它/这个/上述等）的指代对象，保留关键技术与实体词，不添加不存在的信息。只输出改写后的查询本身，不要解释。\n\n会话主题：${sess.title}\n最近对话：\n${last || '（无）'}\n用户问题：${query}`;
}

async function searchMemory(query, sess, k = settings.memory.topK || 6) {
  let q = query;
  if (settings.memory.rewriteEnabled && /它|他|她|这|那|上述|上面|前面|刚才/.test(query)) {
    try {
      const rewritten = await chainChatComplete([{ role: 'user', content: buildRewritePrompt(query, sess) }]);
      const t = String(rewritten || '').trim();
      if (t && t.length <= 300) q = t;
    } catch (_) { /* 改写失败用原句检索 */ }
  }
  const qvec = await embedText(q);
  const all = await memGetAll().catch(() => []);
  const activeIds = new Set(sessions.map(s => s.id)); // 回收站内不参与召回
  return all
    .filter(r => activeIds.has(r.sessionId) && Array.isArray(r.vec))
    .map(r => ({ sessionTitle: r.sessionTitle, text: r.text, ts: r.ts, score: cosine(qvec, r.vec) }))
    .sort((a, b) => b.score - a.score)
    .filter(r => r.score > 0.03)
    .slice(0, k);
}

/* ---------- 向量索引维护 ---------- */
/** 问答对写入向量库（回答完成后后台执行，失败静默） */
async function memoryIndexReply(sess, userText, assistantText) {
  if (!settings.memory.retrievalEnabled || !userText || !assistantText) return;
  const text = `问：${String(userText).slice(0, 300)}\n答：${String(assistantText).slice(0, 500)}`;
  const vec = await embedText(text);
  await memPut({ id: 'vec_' + uid(), sessionId: sess.id, sessionTitle: sess.title, text, vec, ts: Date.now() });
}

/** 按消息重建某会话全部向量（恢复/重建时用；本地嵌入毫秒级） */
async function backfillSessionVectors(sess) {
  if (!sess) return;
  const pairs = [];
  let lastUser = null;
  for (const m of sess.messages) {
    if (m.type !== 'text' || m.pending || !m.content) continue;
    if (m.role === 'user') lastUser = m.content;
    else if (m.role === 'assistant' && lastUser) { pairs.push([lastUser, m.content]); lastUser = null; }
  }
  for (const [q, a] of pairs.slice(-200)) {
    await memoryIndexReply(sess, q, a).catch(() => {});
  }
}

/* ---------- 上下文组装（替代旧 buildContext） ---------- */
async function buildMemoryMessages(newPrompt, sess, onInfo) {
  const mem = settings.memory;
  const done = sess.messages.filter(m =>
    m.type === 'text' && (m.role === 'user' || m.role === 'assistant') &&
    m.modelType !== 'image' && !m.pending && m.content
  );
  const recentN = clampRounds(mem.recentRounds) * 2;
  let recent = done.slice(-recentN);
  // 修复：新用户消息已入 history，剔除末尾重复项（旧实现会重复发送最后一条）
  if (recent.length && recent[recent.length - 1].role === 'user' &&
      recent[recent.length - 1].content === newPrompt) {
    recent = recent.slice(0, -1);
  }

  const sections = [];
  let hits = [];
  await maybeUpdateSummary(sess).catch(() => {}); // 顺带补做综述欠账（通常已最新）
  if (mem.summaryEnabled && sess.summary) sections.push('【对话主线综述】\n' + sess.summary);

  if (mem.retrievalEnabled && done.length) {
    hits = await searchMemory(newPrompt, sess).catch(() => []);
    if (hits.length) {
      sections.push('【相关历史记录】\n' + hits.map(h =>
        `- [会话「${h.sessionTitle}」] ${h.text.slice(0, 160)}`
      ).join('\n'));
    }
  }

  const msgs = [];
  if (sections.length) {
    msgs.push({
      role: 'system',
      content: MEM_SYSTEM_PREAMBLE + '\n\n' + sections.join('\n\n') + '\n\n要求：背景资料仅供参考，请直接回应用户当前的问题。'
    });
  }
  msgs.push(...recent.map(m => ({ role: m.role, content: m.content })));
  msgs.push({ role: 'user', content: newPrompt });
  if (onInfo) onInfo({ summary: !!(mem.summaryEnabled && sess.summary), hits: hits.length });
  return msgs;
}

/* ---------- 存储管理可视化 ---------- */
async function renderStorageStats() {
  const box = $('#storageStats');
  if (!box) return;
  const [vc, est] = await Promise.all([
    memCount().catch(() => 0),
    navigator.storage?.estimate ? navigator.storage.estimate().catch(() => null) : Promise.resolve(null)
  ]);
  const all = [...sessions, ...trash];
  const msgCount = all.reduce((s, x) => s + x.messages.length, 0);
  const imgCount = all.reduce((s, x) => s + x.messages.filter(m => m.type === 'image').length, 0);
  const fmt = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB'
    : n >= 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B';
  const rows = [
    ['聊天', sessions.length + ' 个'],
    ['回收站', trash.length + ' 个'],
    ['消息', msgCount + ' 条'],
    ['本地图片', imgCount + ' 张'],
    ['向量记录', vc + ' 条'],
    ['嵌入方式', settings.memory.embeddingMode === 'api' ? '网关 API' : '本地词法'],
    ['存储占用', est ? `${fmt(est.usage)} / 配额 ${fmt(est.quota)}` : '（浏览器未提供）']
  ];
  box.innerHTML = rows.map(([k, v]) =>
    `<div class="st-row"><span class="st-k">${k}</span><span class="st-v">${escapeHtml(v)}</span></div>`
  ).join('');
}

async function streamChat(model, messages, { onDelta, onNotice, onReasoning, signal, stream = true }) {
  // 中断守卫：用户停止 / 空闲超时 / 总超时 任一触发即断开连接
  const guard = new AbortController();
  let idleTimedOut = false, totalTimedOut = false, idlePhase = 'first-byte';
  let hasData = false; // 是否已收到过数据（用于区分"思考期"与"输出期"两段超时）
  let idleTimer = null;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    // 首字节前给慢模型更长时间（STREAM_FIRST_BYTE_TIMEOUT_MS）；开始输出后走更短的卡死判定
    idlePhase = hasData ? 'stall' : 'first-byte';
    idleTimer = setTimeout(() => { idleTimedOut = true; guard.abort(); },
      hasData ? STREAM_STALL_TIMEOUT_MS : STREAM_FIRST_BYTE_TIMEOUT_MS);
  };
  const totalTimer = setTimeout(() => { totalTimedOut = true; guard.abort(); }, REQUEST_TOTAL_TIMEOUT_MS);
  const combined = linkedAbortSignal(signal, guard.signal);

  try {
    const res = await requestWithRotation(joinUrl(settings.baseUrl, settings.chatEndpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: !!stream })
    }, { onNotice, signal: combined, userSignal: signal });

    const ct = (res.headers.get('content-type') || '').toLowerCase();

    // 非流式（或服务端忽略 stream 参数返回 JSON）：解析完整响应
    if (!stream || !ct.includes('event-stream')) {
      resetIdle();
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (_) { throw new Error('响应解析失败：' + text.slice(0, 120)); }
      if (data?.error) throw new Error(data.error.message || '接口返回错误');
      const m = data?.choices?.[0]?.message || {};
      const content = m.content || data?.choices?.[0]?.text || '';
      if (m.reasoning_content && onReasoning) onReasoning(m.reasoning_content);
      if (!content) throw new Error('接口返回了空响应');
      onDelta(content);
      return content;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', full = '', reasoning = '';
    resetIdle();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hasData = true; // 已收到数据（心跳/思考/正文均算），进入"输出期"走更短卡死判定
      resetIdle(); // 收到任何数据（含心跳/思考过程）即重置空闲计时
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const l = line.trim();
        if (!l.startsWith('data:')) continue;
        const payload = l.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          if (j.error) throw new Error(j.error.message || '流式返回错误');
          const ch = j.choices?.[0] || {};
          const rc = ch.delta?.reasoning_content ?? ch.reasoning_content ?? '';
          if (rc) { reasoning += rc; if (onReasoning) onReasoning(reasoning); }
          const delta = ch.delta?.content ?? ch.message?.content ?? '';
          if (delta) { full += delta; onDelta(full); }
        } catch (e) {
          if (e instanceof SyntaxError) continue; // 半包 JSON 忽略
          throw e;
        }
      }
    }
    if (!full && !reasoning) throw new Error('接口返回了空响应');
    return full || '（模型仅返回了思考过程，未输出正文，可尝试关闭流式或更换模型）';
  } catch (e) {
    if (signal?.aborted) throw abortError();          // 用户主动停止优先
    if (idleTimedOut) {
      const ms = idlePhase === 'stall' ? STREAM_STALL_TIMEOUT_MS : STREAM_FIRST_BYTE_TIMEOUT_MS;
      const label = !stream ? '等待响应超时' : (idlePhase === 'stall' ? '流式输出中断' : '流式无响应');
      const err = new Error(`${label}（${ms / 1000}s 未收到${idlePhase === 'stall' ? '新' : '任何'}数据）`);
      err.idleTimeout = true; err.idlePhase = idlePhase; throw err;
    }
    if (totalTimedOut) { const err = new Error(`请求总超时（${REQUEST_TOTAL_TIMEOUT_MS / 1000}s）`); err.totalTimeout = true; throw err; }
    throw e;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  }
}

/* ---------------- 绘图与图片本地转存 ---------------- */
async function fetchImageAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('抓取图片失败：HTTP ' + res.status);
  const blob = await res.blob();
  return await blobToBase64(blob);
}

async function doImageGeneration(prompt, signal) {
  const sid = currentSessionId;
  const sess = sessions.find(s => s.id === sid);
  if (!sess) return;
  const msgs = sess.messages;                  // 锁定目标会话，切换聊天不串数据
  const isCur = () => currentSessionId === sid;
  const elOf = () => document.querySelector(`#messages [data-id="${msg.id}"]`);

  const msg = {
    id: uid(), ts: Date.now(), model: selectedModel, modelType: 'image',
    role: 'assistant', type: 'image', content: '', prompt,
    pending: true, cached: false
  };
  msgs.push(msg);
  appendMessageEl(msg);
  await persistHistory();

  const notice = (n) => {
    if (!isCur()) return;
    const el = elOf()?.querySelector('.bubble-notice');
    if (el) { el.textContent = n; el.classList.add('show'); }
  };

  try {
    if (!settings.imageEndpoint) {
      throw new Error('当前供应商「' + (curProvider()?.name || '') + '」没有绘图能力，请切换到支持绘图（如商汤）的供应商，或在该供应商设置中填写绘图端点。');
    }
    const res = await requestWithRotation(joinUrl(settings.baseUrl, settings.imageEndpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: selectedModel,
        prompt,
        size: normalizeImageSize(settings.imageConfig.size), // 白名单校正，杜绝 400
        watermark: !!settings.imageConfig.watermark
      })
    }, { onNotice: notice, signal });

    const data = await res.json().catch(() => null);
    if (data?.error) throw new Error(data.error.message || '接口返回错误');
    const item = data?.data?.[0] || {};

    if (item.b64_json) {
      // 接口直接返回 Base64
      msg.content = 'data:image/png;base64,' + item.b64_json;
      msg.cached = true;
    } else if (item.url) {
      // 抓取图片 URL → Blob → Base64，突破 1 小时有效期
      try {
        msg.content = await fetchImageAsBase64(item.url);
        msg.cached = true;
      } catch (_) {
        msg.content = item.url; // 兜底：保留原始链接并提示过期风险
        msg.cached = false;
      }
    } else {
      throw new Error('接口未返回图片数据（缺少 url / b64_json）');
    }

    msg.pending = false;
    await enforceImageLimitsAndSave(msgs);
    if (isCur()) { const n = elOf(); if (n) n.replaceWith(buildMessageEl(msg)); }
    touchSession(sid);
  } catch (e) {
    const i = msgs.indexOf(msg); if (i > -1) msgs.splice(i, 1);
    await persistHistory();
    if (isCur()) { const n = elOf(); if (n) n.remove(); }
    if (e.name === 'AbortError') {
      toast('已停止绘图');
    } else {
      pushError('绘图失败：' + e.message, e.needSettings, msgs, sid);
    }
  }
  if (isCur()) scrollToBottom();
}

/** 图片历史限额：最多 20 张且总量 ≤ 10MB，超出删除最旧 */
async function enforceImageLimitsAndSave(msgs = chatHistory) {
  const isCachedImg = (m) => m.type === 'image' && isDataUrl(m.content);
  const totalBytes = () => msgs.filter(isCachedImg).reduce((s, m) => s + m.content.length * 0.75, 0);
  let imgs = msgs.filter(isCachedImg);
  let total = totalBytes();
  while ((imgs.length > MAX_IMAGE_COUNT || total > MAX_IMAGE_BYTES)) {
    const idx = msgs.findIndex(isCachedImg);
    if (idx === -1) break;
    msgs.splice(idx, 1);
    imgs = msgs.filter(isCachedImg);
    total = totalBytes();
  }
  await persistHistory();
}

/* ---------------- 发送总入口 ---------------- */
async function handleSend() {
  if (generating.has(currentSessionId)) {
    toast('当前聊天正在生成中，请先停止或等待完成');
    return;
  }
  const inputEl = $('#input');
  const text = inputEl.value.trim();
  if (!text) return;

  if (!settings.keys.length) {
    toast('请先在设置中配置 API Key', 'error');
    openSettings();
    return;
  }
  if (!selectedModel) {
    toast('请先选择模型（点击上方模型栏）', 'error');
    toggleDropdown(true);
    return;
  }

  const modelType = getEffectiveType(selectedModel);
  // 视频/多模态生成模型本扩展不支持（非对话、非图片接口），直接拦截提示，避免 404
  if (modelType === 'video') {
    toast(`「${selectedModel}」是视频生成模型，当前扩展暂不支持视频生成，请选择文本或绘图模型`, 'error');
    return;
  }
  const sid = currentSessionId;                    // 锁定目标会话：之后切换聊天不影响本任务归属
  const ctrl = new AbortController();
  generating.set(sid, ctrl);
  setSendState();
  renderSessionList();

  // 用户消息入历史并渲染
  const userMsg = {
    id: uid(), ts: Date.now(), model: selectedModel, modelType,
    role: 'user', type: 'text', content: text
  };
  chatHistory.push(userMsg);
  // 首条消息自动命名（取用户输入前 18 字）；并刷新会话活跃时间
  const sess = curSession();
  if (sess && sess.title === '新对话') {
    sess.title = text.slice(0, 18) + (text.length > 18 ? '…' : '');
  }
  touchSession();
  appendMessageEl(userMsg);
  await persistHistory();

  inputEl.value = '';
  if (sess) sess.draft = '';   // 已发送，清空该会话草稿
  autoGrow(inputEl);

  try {
    if (modelType === 'image') {
      await doImageGeneration(text, ctrl.signal);
    } else {
      await doChat(text, ctrl.signal);
    }
  } finally {
    generating.delete(sid);
    setSendState();
    renderSessionList();
  }
}

async function doChat(prompt, signal) {
  const sid = currentSessionId;
  const sess = sessions.find(s => s.id === sid);
  if (!sess) return;
  const msgs = sess.messages;                  // 锁定目标会话消息数组，切换聊天不串数据
  const isCur = () => currentSessionId === sid; // 当前视图是否仍是该会话
  const elOf = () => document.querySelector(`#messages [data-id="${msg.id}"]`);

  const msg = {
    id: uid(), ts: Date.now(), model: selectedModel, modelType: 'chat',
    role: 'assistant', type: 'text', content: '', pending: true
  };
  msgs.push(msg);                               // 先入列：切走再切回能看到生成中状态
  appendMessageEl(msg);
  await persistHistory();

  // 三层记忆组装：近期原文 + 主线综述 + 相关历史检索（失败兜底为裸问题）
  let messages;
  try {
    messages = await buildMemoryMessages(prompt, sess, (info) => {
      const parts = [];
      if (info.summary) parts.push('主线综述');
      if (info.hits) parts.push(`相关历史 ${info.hits} 条`);
      if (parts.length) notice(`🧠 已注入记忆：${parts.join(' + ')}`);
    });
  } catch (_) {
    messages = [{ role: 'user', content: prompt }];
  }

  let lastPaint = 0;
  const paint = () => {
    if (!isCur()) return;                       // 不在当前视图：只更新数据不碰 DOM
    const bodyEl = elOf()?.querySelector('.bubble-body');
    if (!bodyEl) return;
    const now = Date.now();
    if (now - lastPaint < 80) return;
    lastPaint = now;
    const r = msg._reasoning
      ? `<div class="reasoning">${escapeHtml(msg._reasoning).replace(/\n/g, '<br>')}</div>` : '';
    const c = msg.content
      ? escapeHtml(msg.content).replace(/\n/g, '<br>') + '<span class="cursor"></span>'
      : '<span class="spinner"></span>';
    bodyEl.innerHTML = r + c;
    scrollToBottom();
  };
  const notice = (n) => {
    if (!isCur()) return;
    const el = elOf()?.querySelector('.bubble-notice');
    if (el) { el.textContent = n; el.classList.add('show'); }
  };

  const runOnce = (useStream) => streamChat(selectedModel, messages, {
    signal,
    stream: useStream,
    onDelta: (cur) => { msg.content = cur; paint(); },
    onReasoning: (r) => { msg._reasoning = r; paint(); },
    onNotice: notice
  });

  // 是否用流式：全局开关 + 该模型未被标记为"流式异常"
  const wantStream = settings.streamOutput !== false && !settings.noStreamModels[selectedModel];

  // 生成中计时提示：首字/首 token 前显示已等待秒数，让用户知道模型在响应而非卡死
  const gStart = Date.now();
  const firstUsable = () => msg.content || msg._reasoning;
  const gTimer = setInterval(() => {
    if (!isCur()) return;
    if (firstUsable()) { clearInterval(gTimer); return; } // 已有输出，交给 paint 展示
    const s = Math.floor((Date.now() - gStart) / 1000);
    notice(`⏳ 模型思考中… 已等待 ${s}s（${wantStream?'流式':'非流式'}）。${s >= 60 ? '该模型思考较慢属正常，可继续等待（最长约 120s）或点停止后切换流式/非流式。' : s >= 30 ? '若为慢思考模型请耐心等待，前 120s 内不会误判超时。' : ''}`);
  }, 1000);

  try {
    let full;
    try {
      full = wantStream ? await runOnce(true) : await runOnce(false);
    } catch (e) {
      // 流式疑似引发问题时（限流/挂起/超时）→ 自动降级为非流式重试一次（与 curl 行为一致）
      const canFallback = wantStream && (e.idleTimeout || e.totalTimeout || e.code === 'rate_limited');
      if (!canFallback) throw e;
      settings.noStreamModels[selectedModel] = true; // 记住该模型：后续请求直接走非流式
      saveSettings();
      notice(`⚠️ ${selectedModel} 流式模式异常（${e.message}），已自动切换非流式重试，之后该模型将直接使用非流式`);
      msg.content = ''; msg._reasoning = ''; // 重置上次的部分输出
      try {
        full = await runOnce(false);
      } catch (e2) {
        // 非流式重试也失败（多为模型/网关本身不稳定或服务端挂起）：
        // 解除非流式锁，避免模型被"永久卡死"在这条坏路径上
        if (settings.noStreamModels[selectedModel]) { delete settings.noStreamModels[selectedModel]; saveSettings(); }
        e2.lockReleased = true;
        throw e2;
      }
    }

    msg.content = full;
    msg.pending = false;
    delete msg._reasoning; // 思考过程仅流式期间展示，最终答案保持干净
    await persistHistory();
    if (isCur()) { const n = elOf(); if (n) n.replaceWith(buildMessageEl(msg)); } // 完成后渲染完整 Markdown
    touchSession(sid);
    // 后台记忆维护：问答对入向量库 + 综述补账（不阻塞界面，失败下次自动重试）
    memoryIndexReply(sess, prompt, full).catch(() => {});
    maybeUpdateSummary(sess).catch(() => {});
  } catch (e) {
    if (e.name === 'AbortError') {
      // 用户主动停止：已有部分内容则保留，否则移除气泡
      if (msg.content) {
        msg.pending = false;
        msg.stopped = true;
        delete msg._reasoning;
        await persistHistory();
        if (isCur()) { const n = elOf(); if (n) n.replaceWith(buildMessageEl(msg)); }
      } else {
        const i = msgs.indexOf(msg); if (i > -1) msgs.splice(i, 1);
        await persistHistory();
        if (isCur()) { const n = elOf(); if (n) n.remove(); }
      }
      toast('已停止生成');
    } else {
      const i = msgs.indexOf(msg); if (i > -1) msgs.splice(i, 1);
      if (isCur()) { const n = elOf(); if (n) n.remove(); }
      const hint = e.lockReleased
        ? `\n\n已解除该模型的非流式锁定。若该模型持续无响应，可能是模型或网关不稳定，请在模型列表点击「非流式 ↺」手动测试流式，或更换模型。`
        : `\n\n若模型无响应，可点击右侧模型名下的「非流式 ↺」手动切换流式/非流式再试。`;
      pushError('请求失败：' + e.message + hint, e.needSettings, msgs, sid);
    }
  }
  clearInterval(gTimer);
  if (isCur()) scrollToBottom();
}

/** 错误气泡写入指定会话（默认当前），DOM 仅在目标会话正被查看时刷新 */
function pushError(text, needSettings, msgs = chatHistory, sid = currentSessionId) {
  const em = { id: uid(), ts: Date.now(), role: 'assistant', type: 'error', content: text };
  msgs.push(em);
  if (sid === currentSessionId) appendMessageEl(em);
  persistHistory();
  if (needSettings) openSettings();
}

/** 发送按钮状态跟随"当前会话"的生成状态（其他会话生成中不影响本会话显示） */
function setSendState() {
  const btn = $('#btnSend');
  const b = generating.has(currentSessionId);
  btn.classList.toggle('stop', b);
  btn.title = b ? '停止生成' : '发送';
  btn.innerHTML = b ? '<span class="stop-icon"></span>' : '➤';
}

/** 停止当前会话的生成任务（其他会话的任务不受影响） */
function stopGeneration() {
  const c = generating.get(currentSessionId);
  if (c) { c.abort(); toast('正在停止…'); }
}

/* ---------------- 消息渲染 ---------------- */
function toggleEmpty() {
  $('#emptyState').classList.toggle('hidden', chatHistory.length > 0);
}

function buildMessageEl(m) {
  const wrap = document.createElement('div');
  const time = formatTime(m.ts);
  wrap.dataset.id = m.id;

  if (m.type === 'error') {
    wrap.className = 'msg ai';
    wrap.innerHTML = `<div class="bubble error-bubble"><div class="bubble-body">❌ ${escapeHtml(m.content)}</div><div class="msg-meta">${time}</div></div>`;
    return wrap;
  }

  if (m.type === 'image') {
    wrap.className = 'msg ai';
    if (m.pending) {
      wrap.innerHTML = `<div class="bubble"><div class="pending-line"><span class="spinner"></span>🎨 正在生成图片…</div><div class="bubble-notice"></div></div>`;
      return wrap;
    }
    const badge = m.cached
      ? '<span class="chip chip-ok">✓ 已转存本地缓存（永不过期）</span>'
      : '<span class="chip chip-warn">⚠ 原始链接约 1 小时后过期，请尽快保存</span>';
    wrap.innerHTML = `
      <div class="bubble image-bubble">
        <img class="gen-img" src="${escapeHtml(m.content)}" alt="生成图片" data-id="${m.id}" title="点击查看大图">
        <div class="img-chips">${badge}</div>
        <div class="img-actions">
          <button class="mini-btn" data-act="zoom" data-id="${m.id}">🔍 放大</button>
          <button class="mini-btn" data-act="copy" data-id="${m.id}">📋 复制图片</button>
          <button class="mini-btn" data-act="download" data-id="${m.id}">⬇ 下载</button>
        </div>
        <div class="msg-meta">${time} · ${escapeHtml(m.model || '')}</div>
      </div>`;
    return wrap;
  }

  // 文本消息
  wrap.className = 'msg ' + (m.role === 'user' ? 'user' : 'ai');
  const bodyHtml = m.pending
    ? (m.content
        ? escapeHtml(m.content).replace(/\n/g, '<br>') + '<span class="cursor"></span>' // 切回会话时显示已流出的部分内容
        : '<span class="cursor"></span>')
    : renderMarkdown(m.content);
  const meta = m.role === 'assistant' && m.model
    ? `${time} · ${escapeHtml(m.model)}${m.stopped ? ' · ⏹ 已停止' : ''}`
    : time;
  wrap.innerHTML = `<div class="bubble"><div class="bubble-body">${bodyHtml}</div><div class="bubble-notice"></div><div class="msg-meta">${meta}</div></div>`;
  return wrap;
}

function renderAllMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  chatHistory.forEach(m => box.appendChild(buildMessageEl(m)));
  toggleEmpty();
  scrollToBottom(false);
}

function appendMessageEl(m) {
  const el = buildMessageEl(m);
  $('#messages').appendChild(el);
  toggleEmpty();
  scrollToBottom();
  return el;
}

function nearBottom() {
  const sc = $('#chatScroll');
  return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
}

function scrollToBottom(force = true) {
  if (!force && !nearBottom()) return;
  const sc = $('#chatScroll');
  sc.scrollTop = sc.scrollHeight;
}

/* ---------------- 图片操作 ---------------- */
function findMsg(id) { return chatHistory.find(m => m.id === id); }

function openLightbox(msg) {
  lbCurrent = msg;
  $('#lightboxImg').src = msg.content;
  $('#lbPrompt').textContent = msg.prompt ? 'prompt：' + msg.prompt : '';
  $('#lightbox').classList.remove('hidden');
}

function closeLightbox() {
  $('#lightbox').classList.add('hidden');
  lbCurrent = null;
}

async function toDataUrl(content) {
  if (isDataUrl(content)) return content;
  return await fetchImageAsBase64(content); // 未缓存成功的旧链接（可能已过期）
}

async function dataUrlToPngBlob(dataUrl) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  return await new Promise((resolve, reject) =>
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('图片编码失败')), 'image/png'));
}

async function copyImage(msg) {
  try {
    const dataUrl = await toDataUrl(msg.content);
    const blob = await dataUrlToPngBlob(dataUrl);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('图片已复制到剪贴板', 'success');
  } catch (e) {
    toast('复制失败：' + (e.message || '请改用下载'), 'error');
  }
}

function downloadImage(msg) {
  if (!msg) return;
  const mimeMatch = String(msg.content).match(/^data:image\/(\w+)/);
  const ext = mimeMatch ? (mimeMatch[1] === 'jpeg' ? 'jpg' : mimeMatch[1]) : 'png';
  chrome.downloads.download(
    { url: msg.content, filename: `sensenova-${formatFileTs(msg.ts || Date.now())}.${ext}` },
    (downloadId) => {
      if (downloadId === undefined) {
        toast('下载失败：' + (chrome.runtime.lastError?.message || '未知错误'), 'error');
      } else {
        toast('已开始下载', 'success');
      }
    }
  );
}

/* ---------------- 模型下拉框 ---------------- */
function toggleDropdown(show) {
  const dd = $('#modelDropdown');
  const willShow = typeof show === 'boolean' ? show : dd.classList.contains('hidden');
  dd.classList.toggle('hidden', !willShow);
  if (willShow) {
    $('#mdFilter').value = mdFilterText;
    renderModelDropdown();
    if (!cachedModels.length && settings.keys.length) fetchModels(true);
    setTimeout(() => $('#mdFilter').focus(), 50);
  }
}

function renderModelDropdown() {
  const listEl = $('#modelList');
  if (!listEl) return;

  if (!cachedModels.length) {
    listEl.innerHTML = '<div class="md-empty">暂无模型，请先配置 Key 并点击 ⟳ 刷新</div>';
    $('#mdCount').textContent = '';
    return;
  }

  const kw = mdFilterText.trim().toLowerCase();
  const chat = [], image = [], other = [];
  cachedModels.forEach(m => {
    if (kw && !m.id.toLowerCase().includes(kw)) return;
    const t = getEffectiveType(m.id);
    if (t === 'video') other.push(m);
    else if (t === 'image') image.push(m);
    else chat.push(m);
  });

  $('#mdCount').textContent = kw ? `${chat.length + image.length + other.length}/${cachedModels.length}` : `${cachedModels.length} 个`;

  const item = (m) => {
    const sel = m.id === selectedModel;
    const t = getEffectiveType(m.id);
    const ovr = !!settings.modelTypeOverrides[m.id];
    const tIcon = t === 'image' ? '🎨' : '💬';
    const isVideo = t === 'video';
    return `<div class="model-item${sel ? ' selected' : ''}${isVideo ? ' muted' : ''}" data-id="${escapeHtml(m.id)}">
      ${isVideo
        ? '<span class="type-toggle" style="pointer-events:none" title="视频生成模型，暂不支持">🎬</span>'
        : `<button class="type-toggle${ovr ? ' overridden' : ''}" data-id="${escapeHtml(m.id)}"
             title="点击切换类型（当前：${t === 'image' ? '🎨 绘图' : '💬 文本'}）">${tIcon}</button>`}
      <span class="mi-name" title="${escapeHtml(m.id)}">${escapeHtml(m.id)}</span>
      ${settings.noStreamModels[m.id] ? '<button class="mi-ns-toggle" data-id="' + escapeHtml(m.id) + '" title="该模型被自动锁定为非流式。点击解除，恢复流式请求（若仍异常会再次自动降级）">非流式 ↺</button>' : ''}
      ${sel ? '<span class="mi-check">✓</span>' : ''}
    </div>`;
  };

  let html = '';
  if (chat.length) html += `<div class="md-group-title">💬 文本模型（${chat.length}）</div>` + chat.map(item).join('');
  if (image.length) html += `<div class="md-group-title">🎨 绘图模型（${image.length}）</div>` + image.map(item).join('');
  if (other.length) html += `<div class="md-group-title">🎬 其他（不支持）</div>` + other.map(item).join('');
  listEl.innerHTML = html || '<div class="md-empty">没有匹配的模型</div>';
}

function updateModelButton() {
  if (!selectedModel) {
    $('#modelBtnIcon').textContent = '❔';
    $('#modelBtnName').textContent = '选择模型';
    return;
  }
  const t = getEffectiveType(selectedModel);
  $('#modelBtnIcon').textContent = t === 'image' ? '🎨' : '💬';
  $('#modelBtnName').textContent = selectedModel;
}

function updateComposerMode() {
  const isImage = selectedModel && getEffectiveType(selectedModel) === 'image';
  $('#imageParamsRow').classList.toggle('hidden', !isImage);
  if (isImage) {
    $('#selSize').value = normalizeImageSize(settings.imageConfig.size);
    $('#chkWatermark').checked = !!settings.imageConfig.watermark;
    $('#input').placeholder = '描述你想生成的画面，Enter 发送…';
  } else {
    $('#input').placeholder = selectedModel
      ? '输入消息，Enter 发送 / Shift+Enter 换行'
      : '请先在上方选择模型';
  }
}

/* ---------------- 设置面板 ---------------- */
/** 渲染供应商列表（每行可切换，右侧行内 重命名/删除） */
function renderProviderSelect() {
  const listEl = $('#providerList');
  if (!listEl) return;
  const cur = curProvider();
  if (!(settings.providers || []).length) {
    listEl.innerHTML = '<div class="pv-empty">暂无供应商，从上方预设添加</div>';
    return;
  }
  listEl.innerHTML = (settings.providers || []).map(p => {
    const active = p.id === cur?.id;
    const keyCount = (p.keys || []).filter(k => k.value).length;
    const imgEnd = p.imageEndpoint ? '🎨' : '';
    return `<div class="pv-item${active ? ' active' : ''}" data-pid="${escapeHtml(p.id)}">
      <span class="pv-dot" title="${active ? '当前供应商' : '点击切换'}"></span>
      <span class="pv-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
      <span class="pv-badges">${keyCount > 0 ? '<span class="pv-badge">🔑' + keyCount + '</span>' : ''}${imgEnd ? '<span class="pv-badge">🎨</span>' : ''}</span>
      <span class="pv-ops">
        <button class="pv-op pv-rename" data-pid="${escapeHtml(p.id)}" title="重命名">✎</button>
        <button class="pv-op pv-del" data-pid="${escapeHtml(p.id)}" title="删除">🗑</button>
      </span>
    </div>`;
  }).join('');
}

/** 切换供应商：投影配置 + 载入模型 + 刷新 UI + 明确反馈
 *  opts.bindSession=true 时手动切换，把当前会话绑定到新供应商
 *  opts.followSession=true（switchSession 内部使用）仅投影，不改会话绑定 */
function switchProvider(id, opts = {}) {
  const p = (settings.providers || []).find(x => x.id === id);
  if (!p) return;
  projectProvider(p);
  saveSettings();
  renderProviderSelect();
  // 手动切换：当前会话改绑到新供应商（避免"绑死"原供应商无法更换）
  if (opts.bindSession) {
    const s = curSession();
    if (s) {
      s.providerId = p.id;
      // 若原会话模型在新商下不存在，则按新商模型列表选一个
      if (!cachedModels.some(m => m.id === s.model)) { autoSelectModel(); syncSessionModel(); }
      persistHistory();
    }
  }
  // 会话级模型跟随该供应商的模型列表
  autoSelectModel();
  updateModelButton();
  updateComposerMode();
  renderModelDropdown();
  renderKeyStatus();
  // 打开设置面板时同步编辑区
  if (!$('#settingsOverlay').classList.contains('hidden')) syncProviderEditor();
  if (opts.toast !== false) toast('已切换供应商：' + p.name, 'success');
}

/** 设置打开时：把当前供应商配置填入编辑区 + 填充预设下拉 */
function syncProviderEditor() {
  $('#inpBaseUrl').value = settings.baseUrl;
  $('#inpChatEndpoint').value = settings.chatEndpoint;
  $('#inpImageEndpoint').value = settings.imageEndpoint;
  $('#inpModelsEndpoint').value = settings.modelsEndpoint;
  $('#inpKeys').value = settings.keys.map(k => k.value).join('\n');
  const ps = $('#inpProviderPreset');
  if (ps) {
    ps.innerHTML = '<option value="">＋ 从预设新增…</option>' +
      PROVIDER_PRESETS.map(x => `<option value="${escapeHtml(x.name)}">${escapeHtml(x.name)}</option>`).join('');
    ps.value = '';
  }
}

/** 行内重命名：该行名称变输入框 */
function startRename(pid) {
  const p = (settings.providers || []).find(x => x.id === pid);
  if (!p) return;
  const item = document.querySelector(`#providerList .pv-item[data-pid="${CSS.escape(pid)}"] .pv-name`);
  if (!item) return;
  const old = p.name;
  const input = document.createElement('input');
  input.className = 'pv-rename-input';
  input.value = old;
  input.maxLength = 30;
  const commit = () => {
    const name = input.value.trim().slice(0, 30);
    if (!name) { input.remove(); item.textContent = old; return; }
    p.name = name;
    saveSettings();
    renderProviderSelect();
    toast('已重命名：' + name, 'success');
  };
  item.replaceWith(input);
  input.focus();
  input.select();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') { input.remove(); }
  });
  input.addEventListener('blur', commit);
}

function openSettings() {
  renderProviderSelect();
  syncProviderEditor();
  $('#inpBaseUrl').value = settings.baseUrl;
  $('#inpChatEndpoint').value = settings.chatEndpoint;
  $('#inpImageEndpoint').value = settings.imageEndpoint;
  $('#inpModelsEndpoint').value = settings.modelsEndpoint;
  $('#inpStream').checked = settings.streamOutput !== false;
  $('#inpKeys').value = settings.keys.map(k => k.value).join('\n');
  // 记忆系统
  $('#selRecentRounds').value = String(clampRounds(settings.memory.recentRounds));
  $('#chkSummary').checked = settings.memory.summaryEnabled !== false;
  $('#taSummaryModels').value = (settings.memory.summaryModels || []).join('\n');
  $('#chkRetrieval').checked = settings.memory.retrievalEnabled !== false;
  $('#selTopK').value = String(settings.memory.topK || 6);
  $('#chkRewrite').checked = settings.memory.rewriteEnabled !== false;
  renderStorageStats(); // 存储管理统计
  renderKeyStatus();
  $('#settingsOverlay').classList.remove('hidden');
  clearInterval(keyStatusTimer);
  keyStatusTimer = setInterval(renderKeyStatus, 1000); // 冷却倒计时实时刷新
}

function closeSettings() {
  $('#settingsOverlay').classList.add('hidden');
  clearInterval(keyStatusTimer);
  keyStatusTimer = null;
}

function applySettingsFromPanel() {
  settings.baseUrl = $('#inpBaseUrl').value.trim().replace(/\/+$/, '') || DEFAULTS.baseUrl;

  const norm = (v, def) => {
    let s = String(v || '').trim();
    if (!s) return def;
    if (!s.startsWith('/')) s = '/' + s;
    return s;
  };
  settings.chatEndpoint = norm($('#inpChatEndpoint').value, DEFAULTS.chatEndpoint);
  settings.imageEndpoint = norm($('#inpImageEndpoint').value, DEFAULTS.imageEndpoint);
  settings.modelsEndpoint = norm($('#inpModelsEndpoint').value, DEFAULTS.modelsEndpoint);
  settings.streamOutput = $('#inpStream').checked;

  // 记忆系统
  settings.memory.recentRounds = clampRounds($('#selRecentRounds').value);
  settings.memory.summaryEnabled = $('#chkSummary').checked;
  settings.memory.summaryModels = $('#taSummaryModels').value.split('\n').map(s => s.trim()).filter(Boolean);
  settings.memory.retrievalEnabled = $('#chkRetrieval').checked;
  settings.memory.topK = Math.max(3, Math.min(10, parseInt($('#selTopK').value, 10) || 6));
  settings.memory.rewriteEnabled = $('#chkRewrite').checked;

  const newKeys = parseKeysFromText($('#inpKeys').value);
  const sameAsOld = newKeys.length === settings.keys.length &&
    newKeys.every((k, i) => k.value === settings.keys[i].value);
  if (!sameAsOld) settings.keys = newKeys; // Key 变更后重置状态

  saveSettings();
  renderKeyStatus();
}

function maskKey(v) {
  const s = String(v).replace(/^bearer\s+/i, '');
  if (s.length <= 10) return s.slice(0, 2) + '****';
  return s.slice(0, 6) + '…' + s.slice(-4);
}

function renderKeyStatus() {
  const box = $('#keyStatusList');
  if (!box) return;
  if (!settings.keys.length) {
    box.innerHTML = '<div class="ks-empty">尚未配置 Key</div>';
    return;
  }
  const now = Date.now();
  box.innerHTML = settings.keys.map(k => {
    let cls = 'ok', label = '可用';
    if (k.coolingUntil && now < k.coolingUntil) {
      const left = Math.ceil((k.coolingUntil - now) / 1000);
      if (k.coolReason === '401') { cls = 'bad'; label = `鉴权失败(401) 冷却${left}s`; }
      else { cls = 'cool'; label = `限流(429) 冷却${left}s`; }
    }
    return `<div class="ks-row">
      <span class="ks-dot ${cls}"></span>
      <span class="ks-key" title="${escapeHtml(k.id)}">${escapeHtml(maskKey(k.value))}</span>
      <span class="ks-state">${label}${k.failCount ? ` · 失败${k.failCount}次` : ''}</span>
    </div>`;
  }).join('');
}

/* ---------------- 主题 ---------------- */
function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  $('#btnTheme').textContent = settings.theme === 'dark' ? '☀️' : '🌙';
}

/* ---------------- Toast ---------------- */
let toastTimer = null;
function toast(msg, type = 'info') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (type === 'error' ? ' error' : type === 'success' ? ' success' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 2600);
}

/* ---------------- 输入框高度：随内容增长 + 尊重手动拖拽 ---------------- */
const INPUT_MIN_H = 68;    // 与 CSS min-height 保持一致（3 行）
const INPUT_MAX_H = 240;

function autoGrow(el) {
  // 手动拖拽过的高度作为基准下限，内容增长时继续撑开，封顶 INPUT_MAX_H
  const base = parseInt(el.dataset.manualH || '0', 10) || INPUT_MIN_H;
  const max = el.classList.contains('fs') ? 380 : INPUT_MAX_H;
  el.style.height = 'auto';
  el.style.height = Math.min(Math.max(el.scrollHeight, base), max) + 'px';
}

function rememberInputHeight(el) {
  const h = el.offsetHeight;
  if (h > INPUT_MIN_H - 2 && Math.abs(h - (parseInt(el.dataset.manualH || '0', 10) || 0)) > 2) {
    el.dataset.manualH = String(h);
    settings.inputHeight = h;
    saveSettings(); // 跨会话记忆
  }
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  // 发送 / 停止（复用同一按钮）
  // 发送 / 停止（复用同一按钮，仅作用于当前会话）
  $('#btnSend').addEventListener('click', () => { generating.has(currentSessionId) ? stopGeneration() : handleSend(); });
  const inputEl = $('#input');
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { // 兼容中文输入法
      e.preventDefault();
      handleSend();
    }
  });
  inputEl.addEventListener('input', () => {
    autoGrow(inputEl);
    syncSessionDraft();                 // 草稿实时跟随当前聊天（内存）
  });
  inputEl.addEventListener('blur', () => persistHistory()); // 失焦落盘，防意外关闭丢失
  // 手动拖拽右下角手柄后：记住高度（本会话 + 持久化）
  inputEl.addEventListener('mouseup', () => rememberInputHeight(inputEl));
  inputEl.addEventListener('touchend', () => rememberInputHeight(inputEl));

  // 会话侧边栏（常驻左侧，☰ 收起 / 展开）
  $('#btnSessions').addEventListener('click', toggleSidebar);
  $('#btnNewSession').addEventListener('click', newSession);

  // 会话列表事件委托：切换 / 重命名 / 移入回收站
  $('#sessionList').addEventListener('click', (e) => {
    // 分组头：折叠 / 展开（记忆分类名）
    const head = e.target.closest('.ss-group-head');
    if (head) {
      const cat = head.dataset.cat || '';
      const list = getCollapsedCats();
      const i = list.indexOf(cat);
      if (i > -1) list.splice(i, 1); else list.push(cat);
      saveSettings();
      renderSessionList();
      return;
    }
    const act = e.target.closest('.ss-act');
    if (act) {
      e.stopPropagation();
      if (act.dataset.act === 'rename') renameSession(act.dataset.id);
      else if (act.dataset.act === 'delete') deleteSessionToTrash(act.dataset.id);
      else if (act.dataset.act === 'move') moveSessionCategory(act.dataset.id);
      return;
    }
    const item = e.target.closest('.ss-item');
    if (item) switchSession(item.dataset.id);
  });

  // 回收站视图
  $('#btnTrash').addEventListener('click', () => { renderTrashList(); showSbView('trash'); });
  $('#btnTrashBack').addEventListener('click', () => showSbView('main'));

  // 回收站条目：恢复 / 彻底删除（二次确认）
  $('#trashList').addEventListener('click', (e) => {
    const act = e.target.closest('.tr-act');
    if (!act) return;
    const id = act.dataset.id;
    if (act.dataset.act === 'restore') {
      restoreSession(id);
    } else if (act.dataset.act === 'purge') {
      const s = trash.find(x => x.id === id);
      const nImg = s ? s.messages.filter(m => m.type === 'image').length : 0;
      if (confirm(`彻底删除「${s?.title || ''}」？\n将同时清除 ${s?.messages.length || 0} 条消息${nImg ? `（含 ${nImg} 张图片缓存）` : ''}，不可恢复。`)) {
        purgeSession(id);
      }
    }
  });

  // 清空回收站（二次确认）
  const emptyBtn = $('#btnEmptyTrash');
  let emptyArmed = false, emptyTimer = null;
  emptyBtn.addEventListener('click', () => {
    if (!trash.length) { toast('回收站已是空的'); return; }
    if (!emptyArmed) {
      emptyArmed = true;
      emptyBtn.textContent = '⚠️ 确认清空';
      emptyBtn.classList.add('armed');
      emptyTimer = setTimeout(() => {
        emptyArmed = false;
        emptyBtn.textContent = '清空';
        emptyBtn.classList.remove('armed');
      }, 3000);
      return;
    }
    clearTimeout(emptyTimer);
    emptyArmed = false;
    emptyBtn.textContent = '清空';
    emptyBtn.classList.remove('armed');
    emptyTrash();
  });

  // 主题切换
  $('#btnTheme').addEventListener('click', () => {
    settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    saveSettings();
  });

  // 新标签页打开完整界面（空间更大，不易误关）
  $('#btnFullscreen').addEventListener('click', async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?full=1') });
    window.close(); // 关闭小弹窗；全页标签中此调用无害
  });

  // 设置面板
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnCloseSettings').addEventListener('click', closeSettings);
  $('#settingsOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });
  $('#btnSaveSettings').addEventListener('click', () => {
    applySettingsFromPanel();
    toast('配置已保存', 'success');
  });
  $('#btnSaveAndFetch').addEventListener('click', async () => {
    applySettingsFromPanel();
    toast('配置已保存，正在拉取模型…');
    await fetchModels();
  });

  // ---- 多供应商管理（列表交互：点击切换 / 行内重命名 / 删除） ----
  $('#providerList').addEventListener('click', (e) => {
    // 行内操作按钮优先
    const delBtn = e.target.closest('.pv-del');
    if (delBtn) return deleteProvider(delBtn.dataset.pid);
    const rnBtn = e.target.closest('.pv-rename');
    if (rnBtn) { startRename(rnBtn.dataset.pid); return; }
    // 点击行本身 → 切换供应商
    const item = e.target.closest('.pv-item');
    if (item) {
      const pid = item.dataset.pid;
      if (pid === curProvider()?.id) return; // 已是当前，跳过高亮闪烁
      applySettingsFromPanel();          // 先把当前供应商编辑内容写回
      switchProvider(pid, { bindSession: true }); // 手动切换（含聊天窗口模型列表），并把当前会话改绑新供应商
    }
  });

  function deleteProvider(pid) {
    const p = (settings.providers || []).find(x => x.id === pid);
    if (!p) return;
    if (settings.providers.length <= 1) { toast('至少需保留一个供应商', 'error'); return; }
    if (!confirm('确认删除供应商「' + p.name + '」？其 Key、模型列表与设置将一并删除，无法恢复。该供应商下的聊天将自动改用当前供应商。')) return;
    settings.providers = settings.providers.filter(x => x.id !== pid);
    settings.currentProviderId = settings.providers[0].id;
    // 同步会话：被删供应商绑定的会话 → 重定向到新当前供应商（避免悬空引用）
    sessions.forEach(s => { if (s.providerId === pid) { s.providerId = settings.currentProviderId; } });
    projectProvider(settings.providers[0]);
    saveSettings();
    renderProviderSelect(); syncProviderEditor();
    // 刷新聊天窗口的模型列表与按钮
    autoSelectModel(); updateModelButton(); updateComposerMode(); renderModelDropdown(); renderSessionList(); applySessionUI();
    toast('已删除供应商，相关聊天已改用当前供应商', 'success');
  }

  // 预设新增：读取当前面板填好的表单作为新供应商
  $('#inpProviderPreset').addEventListener('change', (e) => {
    const val = e.target.value;
    const preset = PROVIDER_PRESETS.find(x => x.name === val) || null;
    // 记住选中预设名，点「新增」时按此创建
    e.target.dataset.pick = preset ? preset.name : '';
  });
  $('#btnAddProvider').addEventListener('click', async () => {
    const ps = $('#inpProviderPreset');
    const pickName = ps.dataset.pick || ps.value || '自定义';
    const preset = PROVIDER_PRESETS.find(x => x.name === pickName) || {};
    const prov = makeProvider({
      name: preset.name === '自定义' ? '自定义' : preset.name,
      baseUrl: preset.baseUrl || '',
      chatEndpoint: preset.chatEndpoint,
      imageEndpoint: preset.imageEndpoint,
      modelsEndpoint: preset.modelsEndpoint
    });
    settings.providers.push(prov);
    projectProvider(prov);             // 直接切到新供应商（继承预设端点）
    await saveSettings();
    renderProviderSelect(); syncProviderEditor();
    toast('已新增供应商：' + prov.name + '，请填写 API Key', 'success');
  });

  // 清空当前聊天（两步确认，避免误触；其他会话不受影响）
  const clearBtn = $('#btnClearHistory');
  let clearArmed = false, clearTimer = null;
  clearBtn.addEventListener('click', async () => {
    if (!clearArmed) {
      clearArmed = true;
      clearBtn.textContent = '⚠️ 再次点击确认清空当前聊天';
      clearTimer = setTimeout(() => {
        clearArmed = false;
        clearBtn.textContent = '🗑 清空当前聊天';
      }, 3000);
      return;
    }
    clearTimeout(clearTimer);
    clearArmed = false;
    clearBtn.textContent = '🗑 清空当前聊天';
    chatHistory.length = 0; // 清空当前会话消息（保持数组引用不断裂）
    const cs = curSession();
    if (cs) { cs.summary = ''; cs.summarizedUpTo = 0; } // 综述一并复位
    await memDeleteBySession(currentSessionId).catch(() => {}); // 联动清理该会话向量
    await persistHistory();
    renderAllMessages();
    renderSessionList();
    toast('当前聊天已清空（含记忆数据）', 'success');
  });

  // 存储管理：清理回收站向量 / 重建全部向量
  $('#btnCleanTrashedVectors').addEventListener('click', async () => {
    if (!trash.length) { toast('回收站是空的'); return; }
    let n = 0;
    for (const s of trash) { await memDeleteBySession(s.id).catch(() => {}); n++; }
    toast(`已清理回收站 ${n} 个会话的向量`, 'success');
    renderStorageStats();
  });
  $('#btnRebuildVectors').addEventListener('click', async () => {
    if (!confirm('重建全部向量库？\n将清空现有向量记录，并按所有聊天的历史问答重新生成（本地计算，几秒内完成）。')) return;
    await memClear().catch(() => {});
    for (const s of sessions) await backfillSessionVectors(s).catch(() => {});
    toast('向量库已重建', 'success');
    renderStorageStats();
  });

  // 模型栏
  $('#modelBtn').addEventListener('click', () => toggleDropdown());
  $('#btnRefreshModels').addEventListener('click', () => fetchModels());
  $('#mdFilter').addEventListener('input', (e) => {
    mdFilterText = e.target.value;
    renderModelDropdown();
  });
  $('#modelList').addEventListener('click', async (e) => {
    const toggle = e.target.closest('.type-toggle');
    if (toggle) {
      // 手动修正模型类型（Override）
      const id = toggle.dataset.id;
      const cur = getEffectiveType(id);
      const next = cur === 'chat' ? 'image' : 'chat';
      settings.modelTypeOverrides[id] = next;
      await saveSettings();
      renderModelDropdown();
      if (id === selectedModel) { updateModelButton(); updateComposerMode(); }
      toast(`已将 ${id} 标记为 ${next === 'image' ? '🎨 绘图' : '💬 文本'} 模型`, 'success');
      e.stopPropagation();
      return;
    }
    // 点击"非流式"标签 → 解除该模型的非流式锁定（改回流式）
    const nsTag = e.target.closest('.mi-ns-toggle');
    if (nsTag) {
      const id = nsTag.dataset.id;
      delete settings.noStreamModels[id];
      await saveSettings();
      renderModelDropdown();
      toast(`已解除 ${id} 的非流式锁定，恢复流式请求`, 'success');
      e.stopPropagation();
      return;
    }
    const item = e.target.closest('.model-item');
    if (item) {
      // 视频/不支持模型不可选（muted）
      if (item.classList.contains('muted')) { toast('该模型暂不支持生成，请选择文本或绘图模型', 'error'); return; }
      selectedModel = item.dataset.id;
      settings.lastModel = selectedModel;
      syncSessionModel();          // 模型选择记住到当前聊天
      await saveSettings();
      await persistHistory();
      updateModelButton();
      updateComposerMode();
      toggleDropdown(false);
    }
  });

  // 点击空白处关闭下拉框
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#modelBar')) toggleDropdown(false);
  });

  // 绘图参数即时保存
  $('#selSize').addEventListener('change', async (e) => {
    settings.imageConfig.size = normalizeImageSize(e.target.value);
    e.target.value = settings.imageConfig.size; // 回写校正后的合法值
    await saveSettings();
  });
  $('#chkWatermark').addEventListener('change', (e) => {
    settings.imageConfig.watermark = e.target.checked;
    saveSettings();
  });

  // 消息区事件委托：图片放大 / 复制 / 下载 / 代码复制
  $('#messages').addEventListener('click', async (e) => {
    const cbCopy = e.target.closest('.cb-copy');
    if (cbCopy) {
      const code = cbCopy.closest('.codeblock')?.querySelector('code')?.innerText || '';
      try {
        await navigator.clipboard.writeText(code);
        cbCopy.textContent = '已复制';
        setTimeout(() => { cbCopy.textContent = '复制'; }, 1500);
      } catch (_) { toast('复制代码失败', 'error'); }
      return;
    }

    const img = e.target.closest('.gen-img');
    if (img) {
      const msg = findMsg(img.dataset.id);
      if (msg) openLightbox(msg);
      return;
    }

    const btn = e.target.closest('.mini-btn');
    if (btn) {
      const msg = findMsg(btn.dataset.id);
      if (!msg) return;
      if (btn.dataset.act === 'zoom') openLightbox(msg);
      else if (btn.dataset.act === 'copy') copyImage(msg);
      else if (btn.dataset.act === 'download') downloadImage(msg);
    }
  });

  // 大图预览
  $('#btnLightboxClose').addEventListener('click', closeLightbox);
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeLightbox();
  });
  $('#btnLightboxDownload').addEventListener('click', () => downloadImage(lbCurrent));

  // Esc 关闭浮层
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#lightbox').classList.contains('hidden')) closeLightbox();
      toggleDropdown(false);
    }
  });
}

/* ---------------- 入口 ---------------- */
async function init() {
  // 全页面模式（popup.html?full=1 新标签页打开）：启用宽屏布局
  if (new URLSearchParams(location.search).get('full') === '1') {
    document.documentElement.classList.add('fullscreen');
    $('#input').classList.add('fs');
  }

  await loadAll();

  // 恢复上次手动拖拽的输入框高度
  const inputEl = $('#input');
  if (settings.inputHeight) {
    inputEl.dataset.manualH = String(settings.inputHeight);
  }
  autoGrow(inputEl);
  applyTheme();
  renderAllMessages();
  renderSessionList();
  applySessionUI();      // 恢复当前会话的模型选择 + 输入草稿 + 按钮状态
  renderKeyStatus();
  bindEvents();

  // 记忆系统启动任务（后台，不阻塞界面）：
  // 1. 向量库为空且有历史对话 → 补建索引（首次升级到记忆版自动完成）
  // 2. 当前会话综述有欠账 → 补做（上次关闭弹窗时中断的综述任务）
  memCount().then(async n => {
    if (n === 0 && sessions.some(s => s.messages.length)) {
      for (const s of sessions) await backfillSessionVectors(s).catch(() => {});
    }
  }).catch(() => {});
  maybeUpdateSummary(curSession()).catch(() => {});

  // 已配置 Key 且无模型缓存时，自动拉取模型列表
  if (!cachedModels.length && settings.keys.length) fetchModels(true);
}

document.addEventListener('DOMContentLoaded', init);
