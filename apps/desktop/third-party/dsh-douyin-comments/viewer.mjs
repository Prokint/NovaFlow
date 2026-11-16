/**
 * 评论分析台（交互词云 + 评论表）的服务端半身 —— v0.6.0 由独立插件 dsh-comment-viewer 合并进来。
 *
 * 服务端做三件事：
 *   1. 把本包 viewer/ 目录（纯静态的评论分析台）挂到 /plugins/dsh-douyin-comments/viewer；
 *   2. 提供只读接口，让页面不用手选文件就能读本地导出的评论 JSON：
 *        GET  <prefix>/api/list            列出可读的 douyin-comments-*.json
 *        GET  <prefix>/api/latest          最新一份（采集完成后客户端靠它判断"有新导出"）
 *        GET  <prefix>/api/load?path=<p>   读取其中一个（必须在允许的目录里）
 *        POST <prefix>/api/explain         AI 解读（复用 DSH 默认模型）
 *        POST <prefix>/api/delete          批量删除导出记录
 *   3. 由 index.js 在 `ctx.inject(['webServer'])` 作用域里调 registerViewer(ctx, { rootCtx }) 挂载。
 *
 * 目录来源（按顺序去重）：
 *   - 环境变量 DSH_COMMENT_VIEWER_DIRS（分号分隔，可写多个）
 *   - ~/.dsh/douyin-collector/out（采集插件/扩展的全局默认输出目录）
 *   - <当前工作目录>/douyin-comments（DSH 插件默认落盘目录）
 *   - last-out.json 记录的「采集工具最后一次落盘目录」（通常是会话工作区）
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectorHome, lastOutDir } from "./console.mjs";
import { EntitlementError, activate, entitlementEnabled, machineId, removeDevice, status as entitlementStatus, textOf } from "./entitlement.mjs";

// v0.6.0：合并后不再作为独立 cordis 插件导出（没有 name/inject/apply），
// 只有 index.js 会调用 registerViewer / createViewerHandler。

// v0.2.10：AI 解读。llm / agentDefaultModel 是可选服务（某些 profile 里没有），
// 因此不写进 inject，而是在请求时惰性取，取不到就回 409 让前端退回「复制摘要」。
let llmModulePromise = null;
function loadLlmModule() {
  if (!llmModulePromise) llmModulePromise = import("@deepseek-ai/dsh-llm").catch(() => null);
  return llmModulePromise;
}
/** v0.5.56b：优先用官方 createUserMessage 构造消息（DSH 的 runtime 会校验消息形状），失败退回最小对象 */
async function makeUserMessage(text) {
  const mod = await loadLlmModule();
  if (mod && typeof mod.createUserMessage === "function") {
    try {
      return mod.createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "dsh-comment-viewer" },
      });
    } catch {
      /* 退回最小对象 */
    }
  }
  return { role: "user", content: [{ type: "text", text }] };
}

function describeFinish(finish) {
  if (!finish) return "";
  if (finish.kind === "error" || finish.kind === "aborted") {
    const f = finish.failure;
    const parts = [];
    if (f) {
      if (f.message) parts.push(String(f.message));
      if (f.code) parts.push("(" + String(f.code) + ")");
      if (f.provider) parts.push("[" + String(f.provider) + "]");
    }
    return finish.kind + (parts.length ? "：" + parts.join(" ") : "");
  }
  return String(finish.kind || "");
}

function appendDebug(line) {
  try {
    appendFileSync("D:/dycopy/devkit/_ai-explain-debug.jsonl", JSON.stringify({ at: new Date().toISOString(), ...line }) + "\n");
  } catch {
    /* 忽略 */
  }
}

function optionalService(ctx, name) {
  try {
    if (typeof ctx.get === "function") return ctx.get(name);
    return ctx[name];
  } catch {
    return undefined;
  }
}

const AI_SYSTEM_PROMPT = [
  "你是电商/短视频评价分析师。只依据用户给出的 JSON 摘要下结论，不得编造任何数字或原文。",
  "如果 summary.placeholder.count > 0，必须明确指出这部分是平台系统默认评价、不代表买家真实表达，并在结论里说明它如何影响打分。",
  "引用买家原话时用「」，并在括号里标注评价类型（如 好评/差评）与 SKU（若有）。",
  "语气克制、可执行，不写空话；不评价你无法从数据里看到的维度。",
  "只输出 JSON，不要 markdown 代码块，不要多余解释，结构必须为：",
  '{"headline":"一句话结论","reading":"2-3 句整体解读","issues":[{"title":"问题","evidence":"数据或原文证据","severity":"high|medium|low"}],"actions":[{"title":"建议","why":"为什么有用"}],"quotes":[{"text":"买家原话","rating":"好评|中评|差评","sku":"可选"}]}',
].join("\n");

const AI_MAX_DIGEST_CHARS = 12000;
// v0.9.43：1600 是「我们给这次输出设的上限」，不是供应商的硬限制。
// 之所以默认不大：AI 解读只需要一段固定 JSON（几百到 1-2K token 就够），
// 上限开太大时，一旦思考丢不掉，模型会先烧掉更多预算/时间才给出 0 字正文。
// 需要时可用 DYC_AI_MAX_TOKENS=200..32000 覆盖基础预算（调试/长摘要用）。
const AI_MAX_TOKENS = (() => {
  const raw = Number.parseInt(String(process.env.DYC_AI_MAX_TOKENS || "").trim(), 10);
  return Number.isFinite(raw) && raw >= 200 ? Math.min(raw, 32000) : 1600;
})();
// 思考关不掉时（effort 为 undefined），思考 token 与正文共用同一个输出预算，
// 所以基础预算自动放大（默认 4 倍、封顶 6400），留给正文一些空间。
const AI_MAX_TOKENS_THINKING = Math.max(AI_MAX_TOKENS, Math.min(AI_MAX_TOKENS * 4, 6400));

// v0.9.44：思考档跨模型适配。
// 不同供应商的档位 id 五花八门（off/none/minimal/low/medium/high/max/xhigh…），
// DSH 对接层不做钳制：传了不支持的档会直接报 UNSUPPORTED_REASONING_EFFORT。
// 所以这里做「请求档 → 该模型实际支持的档」的映射：
//   1) 档位 id 精确匹配（忽略大小写）→ 直接用
//   2) 档位 name 匹配 → 用它的 id
//   3) 否则按「思考深度等级」映射到最接近的受支持档（同距离时取更省的那档）
//   4) 都映射不到 → 不传（交给供应商默认值）
// 等级表只用于跨模型换算，不是抖音/DSH 的官方定义。
const AI_EFFORT_RANK = { off: 0, none: 0, disabled: 0, minimal: 1, low: 2, medium: 3, high: 4, max: 5, xhigh: 5 };
function effortRankOf(id) {
  const key = String(id || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(AI_EFFORT_RANK, key) ? AI_EFFORT_RANK[key] : null;
}
function pickEffortForModel(supported, requested) {
  const req = String(requested || "").trim().toLowerCase();
  if (!req || req === "auto") {
    const off = (supported || []).find((e) => String((e && e.id) || "").toLowerCase() === "off");
    return off ? { effort: String(off.id), how: "auto-off" } : { effort: undefined, how: "auto-omit" };
  }
  const byId = (supported || []).find((e) => String((e && e.id) || "").toLowerCase() === req);
  if (byId) return { effort: String(byId.id), how: "exact" };
  const byName = (supported || []).find((e) => String((e && e.name) || "").toLowerCase() === req);
  if (byName) return { effort: String(byName.id), how: "name" };
  const target = effortRankOf(req);
  if (target === null) return { effort: undefined, how: "unknown-request" };
  let best = null;
  let bestDiff = Infinity;
  for (const e of supported || []) {
    const r = effortRankOf(String((e && e.id) || ""));
    if (r === null) continue;
    const diff = Math.abs(r - target);
    if (diff < bestDiff || (diff === bestDiff && best && r < effortRankOf(String(best.id))) ) {
      best = e;
      bestDiff = diff;
    }
  }
  if (!best) return { effort: undefined, how: "no-mappable" };
  return { effort: String(best.id), how: "nearest" };
}

// v0.9.44：有的模型会把「思考」直接写进正文（而不是走 reasoning-delta，例如带
// 思考标签的推理模型 / 某些中转网关）。正常情况我们只把 reasoning-delta 计入字数、
// 不显示内容；但若思考漏进正文，这里兜底把常见的思考标签整段剥掉，
// 只留下真正的 JSON 正文。剥完仍解析不出 JSON 时，退化为「截取最外层 {}」。
function stripInlineReasoning(input) {
  let out = String(input || "");
  const tagPairs = [
    [/<think\b[^>]*>[\s\S]*?<\/think[^>]*>/gi, ""],
    [/<reasoning\b[^>]*>[\s\S]*?<\/reasoning[^>]*>/gi, ""],
    [/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, ""],
    [/<\|reasoning\|>[\s\S]*?<\|\/reasoning\|>/gi, ""],
  ];
  for (const [re, rep] of tagPairs) out = out.replace(re, rep);
  return out.trim();
}
function normalizeAiAnswer(rawText) {
  let text = stripInlineReasoning(rawText);
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    /* 不是纯 JSON，继续尝试截取 */
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = text.slice(start, end + 1);
    try {
      return JSON.stringify(JSON.parse(slice));
    } catch {
      /* 放弃 */
    }
  }
  return text;
}

/** 页面与接口的挂载前缀（index.js 也用它打印日志） */
export const VIEWER_PREFIX = "/plugins/dsh-douyin-comments/viewer";
const PREFIX = VIEWER_PREFIX;
const appDir = fileURLToPath(new URL("./viewer/", import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  // v0.9.48：情感模型推理资源（onnxruntime-web 的 wasm + int8 ONNX 模型）
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};

/** 允许被读取的目录列表（绝对路径，去重、去不存在的） */
export function viewRoots() {
  const out = [];
  const push = (dir) => {
    if (!dir) return;
    const abs = path.resolve(String(dir));
    if (!out.includes(abs) && existsSync(abs)) out.push(abs);
  };
  for (const dir of String(process.env.DSH_COMMENT_VIEWER_DIRS || "").split(";")) push(dir.trim());
  // 采集器的默认输出目录（NovaFlow/DSH Desktop 下 = <$DSH_HOME>/douyin-collector/out，按账号隔离）
  push(path.join(collectorHome(), "out"));
  // v0.9.25：NovaFlow 按账号注入 DSH_HOME 后，机器级 ~/.dsh 目录是旧版/独立运行留下的，
  // 不能再当可读根，否则 A 账号采的数据会出现在 B 账号的分析台里。
  if (process.env.DSH_NOVAFLOW_DESKTOP !== "1") {
    push(path.join(os.homedir(), ".dsh", "douyin-collector", "out"));
    push(path.join(process.cwd(), "douyin-comments"));
  }
  // v0.6.0：采集工具写会话工作区时，目录记在 last-out.json —— 分析台要能读到刚采的那份
  push(lastOutDir());
  return out;
}

/** 读取 JSON 头部的 count 字段（只读前 8KB，够用且不慢） */
function peekCount(file) {
  try {
    const head = readFileSync(file, { encoding: "utf8", flag: "r" }).slice(0, 8192);
    // v0.9.6：关键词模式的合并 JSON 用的是 commentCount；单视频 JSON 用 count
    const m = head.match(/"commentCount"\s*:\s*(\d+)/) || head.match(/"count"\s*:\s*(\d+)/);
    if (m) return Number(m[1]);
    const videoId = head.match(/"videoId"\s*:\s*"(\d+)"/);
    return videoId ? 0 : 0;
  } catch {
    return 0;
  }
}

/** 列出所有可读的导出 JSON（按 mtime 倒序） */
export function listExports() {
  const files = [];
  for (const root of viewRoots()) {
    let names;
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of names) {
      // v0.9.6：关键词模式的合并 JSON 也要能被分析台看到（否则「最新一份」只会是最后一条视频的分片）
      if (!/^douyin-(?:comments|keyword|links)-.*\.json$/i.test(entry)) continue;
      const full = path.join(root, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const head = readFileSync(full, { encoding: "utf8" }).slice(0, 8192);
      const videoId = (head.match(/"videoId"\s*:\s*"(\d+)"/) || [])[1] || "";
      const keyword = (head.match(/"keyword"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1] || "";
      let title = (head.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1] || "";
      if (keyword) title = "关键词「" + keyword + "」· 本次全部视频";
      files.push({
        name: entry,
        path: full,
        videoId,
        keyword,
        title,
        count: peekCount(full),
        size: st.size,
        mtime: st.mtimeMs,
      });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJsonBody(req, limit, onDone) {
  let raw = "";
  let tooBig = false;
  req.on("data", (chunk) => {
    if (tooBig) return;
    raw += chunk;
    if (raw.length > limit) {
      tooBig = true;
      req.destroy();
    }
  });
  req.on("end", () => {
    if (tooBig) return onDone({ error: "请求体过大" });
    try {
      onDone({ body: JSON.parse(raw || "{}") });
    } catch {
      onDone({ error: "请求体不是合法 JSON" });
    }
  });
}

/* ===================== v0.7.0：收藏用户（本机保存） =====================
 *
 * 存储位置按账号隔离：优先 `$DSH_HOME/douyin-collector/favorites.json`。
 * NovaFlow / DSH Desktop 给 Host 子进程注入 DSH_HOME（= 当前 NovaFlow 账号目录，
 * 见 ~/.novaflow/accounts/<key>），所以切换账号收藏天然互不混淆；独立 DSH 里则落
 * `~/.dsh/douyin-collector/favorites.json`。普通 JSON，原子写（tmp + rename）。
 */
const FAVORITES_VERSION = 1;

export function favoritesRoot() {
  const base = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(base, "douyin-collector");
}

export function favoritesFile() {
  return path.join(favoritesRoot(), "favorites.json");
}

function emptyFavorites() {
  return { version: FAVORITES_VERSION, users: {} };
}

function readFavorites() {
  const file = favoritesFile();
  try {
    if (!existsSync(file)) return emptyFavorites();
    const data = JSON.parse(readFileSync(file, "utf8"));
    const users = data && typeof data.users === "object" && data.users ? data.users : {};
    return { version: Number(data.version) || FAVORITES_VERSION, users };
  } catch {
    return emptyFavorites();
  }
}

function writeFavorites(store) {
  const dir = favoritesRoot();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = favoritesFile();
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  renameSync(tmp, file);
}

function favoriteList(store) {
  return Object.values((store && store.users) || {}).sort(
    (a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0),
  );
}

/* ===================== v0.9.10：给老收藏补头像 =====================
 * 收藏记录只存 uid/昵称/属地（老数据没有头像）。这里扫最近的导出 JSON，
 * 从评论里的 user.avatar_thumb/medium/larger 建「uid/secUid → 头像」索引，
 * 给收藏里缺头像的记录补上并落盘（之后 Console 采集页 / 词云页都能显示）。
 */
function userAvatarUrl(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const pick = (o) => {
    if (!o) return "";
    if (typeof o === "string") return o;
    const list = o.url_list || o.urlList;
    if (Array.isArray(list) && list.length) return String(list[0] || "");
    return String(o.url || o.uri || "");
  };
  return (
    pick(src.avatar_thumb) || pick(src.avatar_medium) || pick(src.avatar_larger)
    || String(src.avatar || src.avatarUrl || src.avatar_url || "")
  ).trim().slice(0, 600);
}

let avatarIndexCache = { at: 0, index: new Map() };
function avatarIndexFromExports(wanted) {
  // v0.9.10：从最新往旧扫导出 JSON，凑齐所有缺头像的 uid 就提前停（最多 40 个文件）。
  const now = Date.now();
  if (avatarIndexCache.index.size && now - avatarIndexCache.at < 60_000 && (!wanted || wanted.size === 0)) return avatarIndexCache.index;
  const index = new Map();
  const files = listExports().slice(0, 40);
  for (const f of files) {
    try {
      if (f.size && f.size > 80 * 1024 * 1024) continue;
      const obj = JSON.parse(readFileSync(f.path, "utf8"));
      const arr = Array.isArray(obj)
        ? obj
        : (obj && Array.isArray(obj.comments) ? obj.comments
          : (obj && obj.data && Array.isArray(obj.data.comments) ? obj.data.comments : []));
      for (const c of arr) {
        const raw = c && c.user;
        if (!raw) continue;
        const url = userAvatarUrl(raw);
        if (!url) continue;
        const uid = raw.uid ? String(raw.uid) : "";
        const sec = raw.sec_uid ? String(raw.sec_uid) : (raw.secUid ? String(raw.secUid) : "");
        if (uid) index.set("u:" + uid, url);
        if (sec) index.set("s:" + sec, url);
      }
    } catch { /* 跳过坏文件 */ }
    if (wanted && wanted.size) {
      const doneAll = Array.from(wanted).every((k) => index.has(k));
      if (doneAll) break;
    }
  }
  avatarIndexCache = { at: now, index };
  return index;
}

export function enrichFavoriteAvatars(store) {
  const users = Object.values((store && store.users) || {});
  const missing = users.filter((u) => !u.avatar);
  if (!missing.length) return 0;
  // 要凑的 key：优先 uid，其次 secUid
  const wanted = new Set();
  for (const u of missing) {
    if (u.uid) wanted.add("u:" + u.uid);
    else if (u.secUid) wanted.add("s:" + u.secUid);
  }
  const index = avatarIndexFromExports(wanted);
  let filled = 0;
  for (const u of missing) {
    const hit = (u.uid && index.get("u:" + u.uid)) || (u.secUid && index.get("s:" + u.secUid));
    if (hit) { u.avatar = hit; filled++; }
  }
  if (filled) writeFavorites(store);
  return filled;
}


function normalizeFavoriteUser(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const uid = String(src.uid || src.userId || "").trim();
  if (!uid) return null;
  const tags = Array.isArray(src.tags)
    ? src.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12)
    : [];
  return {
    uid,
    secUid: String(src.secUid || src.sec_uid || "").trim().slice(0, 400),
    nickname: String(src.nickname || src.name || "").trim().slice(0, 120),
    uniqueId: String(src.uniqueId || src.unique_id || "").trim().slice(0, 120),
    avatar: String(src.avatar || src.avatarUrl || src.avatar_url || "").trim().slice(0, 600),
    region: String(src.region || src.ip_label || src.ipLabel || "").trim().slice(0, 60),
    profileUrl: String(src.profileUrl || "").trim().slice(0, 400),
    tags,
  };
}

function upsertFavorite(store, raw, note) {
  const user = normalizeFavoriteUser(raw);
  if (!user) return { error: "缺少用户 uid" };
  const now = Date.now();
  const prev = store.users[user.uid] || {};
  const next = {
    ...prev,
    ...user,
    firstSavedAt: Number(prev.firstSavedAt) || now,
    savedAt: now,
  };
  if (note !== undefined) next.note = String(note || "").trim().slice(0, 500);
  store.users[user.uid] = next;
  return { user: next };
}

/**
 * v0.2.10：把前端算好的 digest 交给 DSH 已配置的模型，SSE 流式返回文字。
 * 模型只做「解读」，不参与任何统计计算。
 */
function handleExplain(ctx, req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "只支持 POST" });
    return;
  }
  const llm = optionalService(ctx, "llm");
  const dm = optionalService(ctx, "agentDefaultModel");
  if (!llm || typeof llm.stream !== "function") {
    sendJson(res, 409, { ok: false, error: "LLM_UNAVAILABLE", hint: "当前 DSH 没有可用的模型服务" });
    return;
  }
  const selection = (() => {
    try {
      return dm && typeof dm.currentSelection === "function" ? dm.currentSelection() : undefined;
    } catch {
      return undefined;
    }
  })();
  if (!selection || !selection.provider || !selection.model) {
    sendJson(res, 409, { ok: false, error: "NO_MODEL", hint: "先在 DSH 设置里选一个默认模型" });
    return;
  }

  readJsonBody(req, 256 * 1024, async ({ body, error }) => {
    if (error) {
      sendJson(res, 400, { ok: false, error });
      return;
    }
    const digest = body && body.digest;
    if (!digest || digest.schema !== "cv-digest/1") {
      sendJson(res, 400, { ok: false, error: "digest 缺失或 schema 不匹配（需要 cv-digest/1）" });
      return;
    }
    let digestJson = "";
    try {
      digestJson = JSON.stringify(digest);
    } catch {
      sendJson(res, 400, { ok: false, error: "digest 无法序列化" });
      return;
    }
    if (digestJson.length > AI_MAX_DIGEST_CHARS) {
      sendJson(res, 413, { ok: false, error: "digest 过大", hint: `上限 ${AI_MAX_DIGEST_CHARS} 字符` });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const controller = new AbortController();
    // v0.5.58：Node 18+ 里 `req` 的 'close' 在请求体读完就会触发（不是断连），
    // 用它 abort 会把模型请求立刻掐断（表现为「aborted：…request aborted」）。
    // 正确做法：监听响应的 'close'，且只在响应还没正常结束时才视为客户端断开。
    if (typeof res.on === "function") {
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
    }

    let text = "";
    let reasonChars = 0;
    let lastReasonSent = 0;
    let finish = null;
    let usage = null;
    try {
      const userMessage = await makeUserMessage("数据摘要：\n" + digestJson);
      // v0.9.44：思考档支持「用户指定（body.effort）」+「跨模型映射」。
      // 前端可传 auto/off/low/medium/high/max；后端按目标模型实际支持的档
      // 精确匹配 → 名称匹配 → 深度等级就近映射（见 pickEffortForModel）。
      // DYC_AI_REASONING_EFFORT 仍可强制覆盖（调试用）。
      // v0.9.45：不再让用户在页面上调思考档 —— 固定按「高」思考（分析更准）。
      // 目标模型如果没有 high，就由 pickEffortForModel 就近映射到它支持的档
      // （如 medium/low/max；能自动关思考的模型也优先按 high 想，除非被拒绝）。
      // DYC_AI_REASONING_EFFORT 仍可强制覆盖（调试/特殊模型用）。
      const requestedEffort = String(process.env.DYC_AI_REASONING_EFFORT || "").trim().toLowerCase() || "high";
      const forcedEffort = String(process.env.DYC_AI_REASONING_EFFORT || "").trim();
      let effort;
      let effortHow = "";
      let supportedEfforts = [];
      if (forcedEffort && forcedEffort !== "auto") {
        effort = forcedEffort;
        effortHow = "forced";
      } else {
        let supported = null;
        if (typeof llm.resolveModelInfo === "function") {
          try {
            const info = await llm.resolveModelInfo(selection.provider, selection.model, controller.signal);
            supported = info && info.reasoning && Array.isArray(info.reasoning.efforts) ? info.reasoning.efforts : [];
          } catch {
            supported = null;
            effortHow = "probe-failed";
          }
        }
        if (supported === null) {
          // 查不到模型能力：显式请求「非 off」的档时也不瞎传（DSH 会直接拒绝）；
          // off / auto 沿用旧的 "off" 行为，真被拒时靠下面的自动重试兜底。
          effort = requestedEffort && requestedEffort !== "off" ? undefined : "off";
          effortHow = effortHow || "no-probe";
        } else {
          supportedEfforts = supported.map((e) => String((e && e.id) || "")).filter(Boolean);
          const picked = pickEffortForModel(supported, requestedEffort);
          effort = picked.effort;
          effortHow = picked.how;
        }
      }
      send({
        start: true,
        provider: selection.provider,
        model: selection.model,
        requestedEffort: requestedEffort || "auto",
        effort: effort === undefined ? "(omit)" : effort,
        effortHow,
        supportedEfforts,
      });
      appendDebug({
        event: "effort",
        provider: selection.provider,
        model: selection.model,
        effort: effort === undefined ? "(omit)" : effort,
        effortHow,
        requested: requestedEffort || "auto",
        supportedEfforts,
        forced: forcedEffort || undefined,
      });

      const runOnce = async (maxTokens, useEffort) => {
        const options = {
          provider: selection.provider,
          model: selection.model,
          system: AI_SYSTEM_PROMPT,
          messages: [userMessage],
          temperature: 0.3,
          maxTokens,
          signal: controller.signal,
        };
        if (useEffort !== undefined) options.reasoningEffort = useEffort;
        const stream = llm.stream(options);
        for await (const chunk of stream) {
          if (!chunk) continue;
          if (chunk.type === "text-delta" && chunk.text) {
            text += chunk.text;
            send({ delta: chunk.text });
          } else if (chunk.type === "reasoning-delta") {
            // 只统计字数、不把思考内容发给前端（结果里只应有 JSON 正文）。
            // v0.9.44：把思考进度也推给前端（前端只显示字数，不显示内容），
            // 便于用户确认「模型在认真想」以及预算是否被思考吃掉。每 200 字推一次。
            reasonChars += String(chunk.text || "").length;
            if (reasonChars - lastReasonSent >= 200) {
              lastReasonSent = reasonChars;
              send({ reasoningChars: reasonChars });
            }
          } else if (chunk.type === "usage") {
            usage = chunk.usage;
            send({ usage: chunk.usage });
          } else if (chunk.type === "finish") {
            finish = chunk.reason;
          }
        }
        const kind = finish && (finish.kind || finish);
        const failureCode = finish && finish.kind === "error" && finish.failure ? String(finish.failure.code || "") : "";
        return { kind, failureCode };
      };
      const resetAttempt = () => {
        text = "";
        reasonChars = 0;
        lastReasonSent = 0;
        finish = null;
      };
      // v0.9.43：思考关不掉时（effort 为 undefined），思考 token 和正文共用
      // 同一个输出预算，所以基础预算自动放大；能关掉思考时仍用 1600 这个小上限。
      const budgetNow = () => (effort === "off" ? AI_MAX_TOKENS : AI_MAX_TOKENS_THINKING);
      let attempt;
      try {
        attempt = await runOnce(budgetNow(), effort);
      } catch (err) {
        const msg = String((err && err.message) || err);
        if (effort !== undefined && /reasoning effort/i.test(msg)) {
          appendDebug({ event: "retry", reason: "unsupported-reasoning-effort-throw", message: msg });
          resetAttempt();
          effort = undefined;
          attempt = await runOnce(budgetNow(), undefined);
        } else {
          throw err;
        }
      }
      if (!text && attempt.kind === "error" && attempt.failureCode === "UNSUPPORTED_REASONING_EFFORT") {
        appendDebug({ event: "retry", reason: "unsupported-reasoning-effort", tried: effort === undefined ? "(omit)" : effort });
        resetAttempt();
        effort = undefined;
        attempt = await runOnce(budgetNow(), undefined);
      }
      let kind = attempt.kind;
      if (!text && kind === "max-tokens" && !controller.signal.aborted) {
        appendDebug({ event: "retry", reason: "max-tokens-no-text", firstMaxTokens: budgetNow() });
        resetAttempt();
        const second = await runOnce(budgetNow() * 2, effort);
        kind = second.kind;
      }
      // v0.9.44：兜底剥掉「漏进正文的思考标签」；能截出 JSON 就只保留 JSON。
      if (text) text = normalizeAiAnswer(text);
      appendDebug({
        event: "finish",
        provider: selection.provider,
        model: selection.model,
        kind,
        chars: text.length,
        reasonChars,
        effort: effort === undefined ? "(omit)" : effort,
        effortHow,
        maxTokens: budgetNow(),
        digestChars: digestJson.length,
      });
      if (finish && kind !== "stop" && kind !== "max-tokens") {
        send({ error: "模型返回失败：" + describeFinish(finish) });
      } else if (!text && kind === "max-tokens" && reasonChars > 0) {
        send({
          error:
            "模型把 token 预算都用在思考上了（思考 " + reasonChars + " 字、正文 0 字）。" +
            (effort === undefined
              ? "这个模型/供应商关闭不了思考（或不支持思考档参数），DSH 只按模型能力传参；可以换一个不需要长思考的模型，或把摘要复制给任意 AI。"
              : "已在请求里关闭推理；如仍出现请把这份摘要复制给任意 AI。"),
        });
      } else if (!text) {
        send({ error: "模型没有返回内容（可点「重新生成」再试一次）" });
      } else {
        send({
          done: true,
          chars: text.length,
          reasoningChars: reasonChars,
          effort: effort === undefined ? "(omit)" : effort,
          effortHow,
          requestedEffort: requestedEffort || "auto",
          supportedEfforts,
        });
      }
    } catch (err) {
      appendDebug({ event: "throw", message: String((err && err.message) || err) });
      send({ error: String((err && err.message) || err) });
    } finally {
      res.end();
    }
  });
}

// v0.9.49：LLM 兜底情感分类 —— 只给「规则 + 本地小模型都判中性」的少数评论复核一次。
// 目的：修本地模型对短句/反讽的漏洞，同时控制调用量（一份导出最多 40 条）并按文本哈希落盘缓存。
const SENT_LLM_MAX_ITEMS = 40;
const SENT_LLM_BATCH = 10;
const SENT_LLM_MIN_CONF = 0.6;
const SENT_LLM_CACHE = { loaded: false, map: new Map() };

function sentLlmCacheFile() {
  try {
    return path.join(collectorHome(), "sentiment-llm-cache.json");
  } catch {
    return null;
  }
}

function loadSentLlmCache() {
  if (SENT_LLM_CACHE.loaded) return SENT_LLM_CACHE.map;
  SENT_LLM_CACHE.loaded = true;
  const file = sentLlmCacheFile();
  if (!file) return SENT_LLM_CACHE.map;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const entries = parsed && parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {};
    for (const [key, value] of Object.entries(entries)) {
      if (value && typeof value.label === "string" && ["pos", "neu", "neg"].includes(value.label)) {
        SENT_LLM_CACHE.map.set(key, { label: value.label, conf: Number(value.conf) || 0.9 });
      }
    }
  } catch {
    /* 没有缓存文件或损坏：按空缓存处理 */
  }
  return SENT_LLM_CACHE.map;
}

function saveSentLlmCache() {
  const file = sentLlmCacheFile();
  if (!file) return;
  try {
    const entries = {};
    for (const [key, value] of SENT_LLM_CACHE.map) entries[key] = { label: value.label, conf: value.conf };
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries }, null, 2), "utf8");
  } catch {
    /* 缓存写失败不影响结果 */
  }
}

function sentLlmTextKey(text) {
  return createHash("sha1").update(String(text)).digest("hex");
}

const SENT_LLM_SYSTEM_PROMPT = "你是一个中文抖音评论情感分类器。只输出 JSON，不要解释、不要 Markdown 代码块。";

function sentLlmUserPrompt(items) {
  const lines = items
    .map((item, i) => `[${i}] ${String(item.text || "").slice(0, 300).replace(/\s+/g, " ").trim()}`)
    .join("\n");
  return [
    "给每条评论标注情感标签：pos（正面：夸赞/喜欢/推荐/想买/期待）、neg（负面：不满/抱怨/贬低/避雷/质量问题/售后问题）、neu（中性：提问、互动、@人、纯表情、没有明确情绪、只有关键词）。",
    "再给一个 0 到 1 的置信度；判断不准时给低置信。",
    '只输出 JSON：{"labels":[{"i":0,"label":"pos","conf":0.9}]}。label 只能是 pos/neu/neg。',
    "评论：",
    lines,
  ].join("\n");
}

function parseSentLlmLabels(rawText) {
  const text = normalizeAiAnswer(String(rawText || ""));
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!parsed) return [];
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.labels) ? parsed.labels : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const i = Number(item.i ?? item.index);
    const label = String(item.label || "").toLowerCase();
    if (!Number.isInteger(i) || i < 0 || !["pos", "neu", "neg"].includes(label)) continue;
    const conf = Math.max(0, Math.min(1, Number(item.conf) || 0.9));
    out[i] = { label, conf };
  }
  return out;
}

async function classifyWithLlm(llm, selection, items) {
  const options = {
    provider: selection.provider,
    model: selection.model,
    system: SENT_LLM_SYSTEM_PROMPT,
    messages: [await makeUserMessage(sentLlmUserPrompt(items))],
    temperature: 0,
    maxTokens: 700,
  };
  const info = typeof llm.resolveModelInfo === "function"
    ? await llm.resolveModelInfo(selection.provider, selection.model).catch(() => null)
    : null;
  const efforts = info && info.reasoning && Array.isArray(info.reasoning.efforts) ? info.reasoning.efforts : [];
  if (efforts.some((e) => String((e && e.id) || "") === "off")) options.reasoningEffort = "off";
  const collect = async (opts) => {
    let text = "";
    for await (const chunk of llm.stream(opts)) {
      if (chunk && chunk.type === "text-delta" && chunk.text) text += chunk.text;
    }
    return text;
  };
  let text = "";
  try {
    text = await collect(options);
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (options.reasoningEffort === undefined || !/reasoning effort/i.test(msg)) throw err;
    delete options.reasoningEffort;
    text = await collect(options);
  }
  // 若该模型不支持 off 档（会抛 UNSUPPORTED_REASONING_EFFORT），去掉参数重试一次。
  if (!text && options.reasoningEffort !== undefined) {
    try {
      delete options.reasoningEffort;
      text = await collect(options);
    } catch {
      text = "";
    }
  }
  return parseSentLlmLabels(text);
}

function handleSentimentLlm(ctx, req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" });
    res.end();
    return;
  }
  const llm = optionalService(ctx, "llm");
  const dm = optionalService(ctx, "agentDefaultModel");
  if (!llm || typeof llm.stream !== "function") {
    sendJson(res, 409, { ok: false, error: "LLM_UNAVAILABLE", hint: "当前 DSH 没有可用的模型服务" });
    return;
  }
  const selection = (() => {
    try {
      return dm && typeof dm.currentSelection === "function" ? dm.currentSelection() : undefined;
    } catch {
      return undefined;
    }
  })();
  if (!selection || !selection.provider || !selection.model) {
    sendJson(res, 409, { ok: false, error: "NO_MODEL", hint: "先在 DSH 设置里选一个默认模型" });
    return;
  }
  readJsonBody(req, 256 * 1024, async ({ body, error }) => {
    if (error) {
      sendJson(res, 400, { ok: false, error });
      return;
    }
    try {
      const raw = Array.isArray(body && body.items) ? body.items : [];
      const items = [];
      for (const it of raw.slice(0, SENT_LLM_MAX_ITEMS)) {
        const text = String((it && it.text) || "").trim();
        if (!text || text.length < 2) continue;
        items.push({ cid: String((it && it.cid) || ""), text: text.slice(0, 300) });
      }
      if (!items.length) {
        sendJson(res, 200, { ok: true, items: [], cached: 0, llmCalls: 0, skipped: raw.length });
        return;
      }
      const cache = loadSentLlmCache();
      const results = [];
      const todo = [];
      for (const item of items) {
        const key = sentLlmTextKey(item.text);
        const hit = cache.get(key);
        if (hit) results.push({ cid: item.cid, label: hit.label, conf: hit.conf, cached: true });
        else todo.push({ item, key });
      }
      let llmCalls = 0;
      for (let start = 0; start < todo.length; start += SENT_LLM_BATCH) {
        const batch = todo.slice(start, start + SENT_LLM_BATCH);
        try {
          const labels = await classifyWithLlm(llm, selection, batch.map((x) => x.item));
          llmCalls++;
          for (let i = 0; i < batch.length; i++) {
            const pred = labels[i];
            if (!pred) continue;
            cache.set(batch[i].key, { label: pred.label, conf: pred.conf });
            results.push({ cid: batch[i].item.cid, label: pred.label, conf: pred.conf, cached: false });
          }
        } catch (err) {
          appendDebug({ event: "sentiment-llm-batch-error", message: String((err && err.message) || err) });
        }
      }
      saveSentLlmCache();
      sendJson(res, 200, {
        ok: true,
        model: selection.model,
        items: results,
        cached: results.filter((r) => r.cached).length,
        llmCalls,
        skipped: raw.length - items.length,
        minConf: SENT_LLM_MIN_CONF,
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
    }
  });
}

// v0.9.48：头像代理（页面开了 COEP: require-corp 后，抖音 CDN 的跨域图片会被浏览器拦掉，
// 报 net::ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep；这里同源抓一次并缓存）
const AVATAR_HOST_ALLOW = ["douyinpic.com", "byteimg.com", "douyincdn.com", "iesdouyin.com", "douyin.com"];
const AVATAR_CACHE = new Map();
const AVATAR_MAX_ENTRIES = 240;
function avatarHostAllowed(host) {
  const h = String(host || "").toLowerCase();
  return AVATAR_HOST_ALLOW.some((d) => h === d || h.endsWith("." + d));
}
function serveAvatar(req, res, url) {
  const target = url.searchParams.get("u") || "";
  let parsed;
  try { parsed = new URL(target); } catch { parsed = null; }
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:") || !avatarHostAllowed(parsed.hostname)) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("bad avatar url");
    return;
  }
  const key = parsed.href;
  const cached = AVATAR_CACHE.get(key);
  const sendImg = (type, body) => {
    res.writeHead(200, {
      "Content-Type": type || "image/jpeg",
      "Content-Length": body.length,
      "Cache-Control": "public, max-age=86400",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return sendImg(cached.type, cached.body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  fetch(key, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0", Referer: "" } })
    .then(async (r) => {
      clearTimeout(timer);
      if (!r.ok) throw new Error("avatar http " + r.status);
      const type = r.headers.get("content-type") || "image/jpeg";
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 3 * 1024 * 1024) throw new Error("avatar too large");
      if (AVATAR_CACHE.size >= AVATAR_MAX_ENTRIES) {
        const oldest = AVATAR_CACHE.keys().next().value;
        if (oldest) AVATAR_CACHE.delete(oldest);
      }
      AVATAR_CACHE.set(key, { type, body: buf, at: Date.now() });
      sendImg(type, buf);
    })
    .catch((err) => {
      clearTimeout(timer);
      if (!res.writableEnded) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(String((err && err.message) || err));
      }
    });
}

function serveStatic(req, res, pathname) {
  let rel = pathname.slice(PREFIX.length);
  if (rel === "" || rel === "/") rel = "/index.html";
  const file = path.resolve(appDir, "." + rel);
  if (!file.startsWith(path.resolve(appDir))) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const ext = path.extname(file).toLowerCase();
  const size = statSync(file).size;
  // v0.9.48：文档页给 COOP/COEP，允许 Worker 里用 SharedArrayBuffer 多线程跑 WASM 推理；
  // 其余静态资源（worker.js / .wasm / .onnx 等）也必须带 CORP，否则 COEP: require-corp 下 Chromium
  // 会把 Worker 脚本请求直接拦成 net::ERR_BLOCKED_BY_RESPONSE。
  const docHeaders = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  // v0.9.48：模型/运行时等大文件（>4MB）允许长缓存并流式发送，避免每次进页面重下 100MB+
  if (size > 4 * 1024 * 1024) {
    res.writeHead(200, Object.assign({
      "Content-Type": type,
      "Content-Length": size,
      "Cache-Control": "public, max-age=31536000, immutable",
    }, docHeaders || {}));
    if (req.method === "HEAD") { res.end(); return; }
    createReadStream(file).pipe(res);
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, Object.assign({
    "Content-Type": type,
    "Content-Length": body.length,
    // v0.5.47：静态资源也不缓存，避免升级后浏览器仍用旧 styles.css / app.js
    "Cache-Control": "no-store, max-age=0",
  }, docHeaders || {}));
  res.end(req.method === "HEAD" ? undefined : body);
}

/**
 * 供 index.js 使用：返回挂在 PREFIX 上的 handler。
 * llm / agentDefaultModel 是可选服务，先在 webServer 作用域里取，取不到再退回插件根 ctx。
 */
export function createViewerHandler(scopeCtx, rootCtx) {
  const serviceCtx = {
    get(name) {
      const found = optionalService(scopeCtx, name);
      if (found !== undefined && found !== null) return found;
      return optionalService(rootCtx || {}, name);
    },
  };
  return function viewerHandler(req, res) {
        if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
          res.writeHead(405, { Allow: "GET, HEAD, POST" });
          res.end();
          return;
        }
        const url = new URL(req.url, "http://localhost");
        const pathname = url.pathname;

        if (pathname === `${PREFIX}/api/avatar`) return serveAvatar(req, res, url);

        if (pathname === PREFIX || pathname === `${PREFIX}/`) return serveStatic(req, res, pathname);

        if (pathname === `${PREFIX}/api/entitlement`) {
          // v0.9.21：授权状态（NovaFlow 收费模式）。未启用时只回 enabled:false。
          const readBody = () => new Promise((resolve) => {
            let raw = "";
            req.on("data", (chunk) => {
              raw += chunk;
              if (raw.length > 1_000_000) req.destroy();
            });
            req.on("end", () => {
              let body = {};
              try { body = JSON.parse(raw || "{}"); } catch { body = {}; }
              resolve(body);
            });
            req.on("error", () => resolve({}));
          });
          const replyErr = (error) => {
            const code = (error && error.code) || "SERVICE_UNAVAILABLE";
            const http = { TOKEN_INVALID: 401, NOT_ACTIVATED: 402, EXPIRED: 402, DEVICE_LIMIT: 403, CODE_INVALID: 400, CODE_BOUND_OTHER: 409, CODE_REVOKED: 409, VERSION_RETIRED: 426, RATE_LIMITED: 429, NONCE_REPLAY: 409 }[code] || 503;
            sendJson(res, http, { ok: false, code, error: textOf(code) });
          };
          (async () => {
            try {
              if (!entitlementEnabled()) {
                sendJson(res, 200, { ok: true, enabled: false, activated: false, machineId: machineId() });
                return;
              }
              const st = await entitlementStatus();
              sendJson(res, 200, Object.assign({ ok: true, enabled: true, machineId: machineId() }, st));
            } catch (error) {
              replyErr(error);
            }
          })();
          return;
        }

        if (pathname === `${PREFIX}/api/entitlement/activate`) {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: "只支持 POST" });
            return;
          }
          let raw = "";
          req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 1_000_000) req.destroy();
          });
          req.on("end", () => {
            let body = {};
            try { body = JSON.parse(raw || "{}"); } catch {
              sendJson(res, 400, { ok: false, code: "CODE_INVALID", error: "请求体不是合法 JSON" });
              return;
            }
            (async () => {
              try {
                const code = String(body.code || "").trim();
                if (!code) throw new EntitlementError("CODE_INVALID");
                const r = await activate(code);
                sendJson(res, 200, Object.assign({ ok: true, activated: true, enabled: true, machineId: machineId() }, r));
              } catch (error) {
                const errCode = (error && error.code) || "SERVICE_UNAVAILABLE";
                const http = { TOKEN_INVALID: 401, NOT_ACTIVATED: 402, EXPIRED: 402, DEVICE_LIMIT: 403, CODE_INVALID: 400, CODE_BOUND_OTHER: 409, CODE_REVOKED: 409, VERSION_RETIRED: 426, RATE_LIMITED: 429 }[errCode] || 503;
                sendJson(res, http, { ok: false, code: errCode, error: textOf(errCode) });
              }
            })();
          });
          return;
        }

        if (pathname === `${PREFIX}/api/entitlement/remove`) {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: "只支持 POST" });
            return;
          }
          let raw = "";
          req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 1_000_000) req.destroy();
          });
          req.on("end", () => {
            let body = {};
            try { body = JSON.parse(raw || "{}"); } catch { body = {}; }
            (async () => {
              try {
                const deviceId = String(body.deviceId || "").trim();
                if (!deviceId) throw new EntitlementError("BAD_REQUEST");
                await removeDevice(deviceId);
                const st = await entitlementStatus();
                sendJson(res, 200, Object.assign({ ok: true, enabled: true, machineId: machineId() }, st));
              } catch (error) {
                const errCode = (error && error.code) || "SERVICE_UNAVAILABLE";
                sendJson(res, 400, { ok: false, code: errCode, error: textOf(errCode) });
              }
            })();
          });
          return;
        }

        if (pathname === `${PREFIX}/api/roots`) {
          sendJson(res, 200, { ok: true, roots: viewRoots() });
          return;
        }

        if (pathname === `${PREFIX}/api/list`) {
          try {
            sendJson(res, 200, { ok: true, roots: viewRoots(), files: listExports() });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String((error && error.message) || error) });
          }
          return;
        }

        if (pathname === `${PREFIX}/api/load`) {
          const target = String(url.searchParams.get("path") || "");
          const abs = path.resolve(target);
          const allowed = viewRoots().some((root) => abs === root || abs.startsWith(root + path.sep));
          if (!target || !allowed) {
            sendJson(res, 403, { ok: false, error: "路径不在允许目录内" });
            return;
          }
          if (!existsSync(abs) || !statSync(abs).isFile()) {
            sendJson(res, 404, { ok: false, error: "文件不存在" });
            return;
          }
          const body = readFileSync(abs);
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": body.length,
            "Cache-Control": "no-store",
          });
          res.end(req.method === "HEAD" ? undefined : body);
          return;
        }

        if (pathname === `${PREFIX}/api/latest`) {
          // v0.6.0：合并插件的「采集完成自动打开词云」靠这条接口判断有没有新导出：
          // 客户端轮询它，发现 file.path 变化就 openTab 并让 iframe 带 ?latest=1 重载。
          try {
            const files = listExports();
            sendJson(res, 200, { ok: true, at: Date.now(), file: files[0] || null });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String((error && error.message) || error) });
          }
          return;
        }

        if (pathname === `${PREFIX}/api/favorites`) {
          // v0.7.0：收藏用户（目标客户）。GET 列表 / POST 新增或更新（upsert）。
          if (req.method === "GET") {
            const store = readFavorites();
            enrichFavoriteAvatars(store);
            const uid = String(url.searchParams.get("uid") || "").trim();
            if (uid) {
              sendJson(res, 200, {
                ok: true,
                file: favoritesFile(),
                user: store.users[uid] || null,
                favorites: favoriteList(store),
              });
              return;
            }
            sendJson(res, 200, { ok: true, file: favoritesFile(), favorites: favoriteList(store) });
            return;
          }
          readJsonBody(req, 2_000_000, ({ error, body }) => {
            if (error) return sendJson(res, 400, { ok: false, error });
            const store = readFavorites();
            enrichFavoriteAvatars(store);
            const inputs = Array.isArray(body.users) ? body.users : Array.isArray(body.favorites) ? body.favorites : [body.user || body];
            const saved = [];
            const failed = [];
            for (const input of inputs) {
              const result = upsertFavorite(store, input, body.note);
              if (result.error) failed.push({ user: input && input.uid, error: result.error });
              else saved.push(result.user);
            }
            if (saved.length) { enrichFavoriteAvatars(store); writeFavorites(store); }
            sendJson(res, 200, { ok: saved.length > 0, saved, failed, favorites: favoriteList(store), file: favoritesFile() });
          });
          return;
        }

        if (pathname === `${PREFIX}/api/favorites/remove`) {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: "只支持 POST" });
            return;
          }
          readJsonBody(req, 1_000_000, ({ error, body }) => {
            if (error) return sendJson(res, 400, { ok: false, error });
            const store = readFavorites();
            const uids = Array.isArray(body.uids)
              ? body.uids
              : [body.uid || (body.user && body.user.uid)].filter(Boolean);
            const removed = [];
            for (const rawUid of uids) {
              const uid = String(rawUid || "").trim();
              if (!uid || !store.users[uid]) continue;
              delete store.users[uid];
              removed.push(uid);
            }
            if (removed.length) writeFavorites(store);
            sendJson(res, 200, { ok: true, removed, favorites: favoriteList(store) });
          });
          return;
        }

        if (pathname === `${PREFIX}/api/explain`) {
          handleExplain(serviceCtx, req, res);
          return;
        }

        if (pathname === `${PREFIX}/api/sentiment-llm`) {
          // v0.9.49：本地规则/小模型都判中性时，用 DSH 默认模型兜底复核一小批评论。
          handleSentimentLlm(serviceCtx, req, res);
          return;
        }

        if (pathname === `${PREFIX}/api/delete`) {
          // v0.1.6：批量删除导出记录（真删磁盘文件，只允许删允许目录里的 douyin-comments-*）
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: "只支持 POST" });
            return;
          }
          let raw = "";
          req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 1_000_000) req.destroy();
          });
          req.on("end", () => {
            let body = {};
            try {
              body = JSON.parse(raw || "{}");
            } catch {
              sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
              return;
            }
            const targets = Array.isArray(body.paths) ? body.paths : [];
            const roots = viewRoots();
            const deleted = [];
            const failed = [];
            for (const target of targets) {
              const abs = path.resolve(String(target || ""));
              const allowed = roots.some((root) => abs === root || abs.startsWith(root + path.sep));
              const looksLikeExport = /^douyin-(?:comments|keyword|links)-.*\.(json|csv)$/i.test(path.basename(abs));
              if (!allowed || !looksLikeExport) {
                failed.push({ path: String(target || ""), error: "不允许删除该路径" });
                continue;
              }
              try {
                if (!existsSync(abs) || !statSync(abs).isFile()) {
                  failed.push({ path: abs, error: "文件不存在" });
                  continue;
                }
                unlinkSync(abs);
                deleted.push(abs);
              } catch (error) {
                failed.push({ path: abs, error: String((error && error.message) || error) });
              }
            }
            sendJson(res, 200, { ok: failed.length === 0, deleted, failed });
          });
          return;
        }

        // 其余一律当静态资源（/viewer/index.html、styles.css、app.js …）
        serveStatic(req, res, pathname);
      };
}

/**
 * 把评论分析台挂到 DSH 的 webServer 上。由 index.js 在 `ctx.inject(['webServer'])` 作用域里调用；
 * 没有 webServer 的宿主不会走到这里，因此不影响纯工具模式。
 */
export function registerViewer(ctx, options = {}) {
  const handler = createViewerHandler(ctx, options.rootCtx);
  const install = () => ctx.webServer.register({ kind: "prefix", path: PREFIX, handler });
  if (typeof ctx.effect === "function") return ctx.effect(install);
  return install();
}
