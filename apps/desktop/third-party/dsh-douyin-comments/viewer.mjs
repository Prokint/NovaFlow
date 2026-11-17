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
import { EntitlementError, activate, analyze, entitlementEnabled, explainFetch, machineId, removeDevice, status as entitlementStatus, textOf } from "./entitlement.mjs";

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

// v0.9.53：AI 解读的 prompt 已迁到服务端（novaflow-collect/explain.mjs），客户端不再持有。

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

// v0.9.50：付费功能闸门。
// 词云的授权校验目前只在 client.js 里做（LicenseGatePage 盖板 + 购买链接），
// 直接访问 /plugins/dsh-douyin-comments/viewer/ 能绕过；所以这里在**后端接口**上再拦一层：
// - entitlementEnabled() 为 false（独立 DSH / 未开启收费模式）时一律放行；
// - 查询服务端失败时沿用最近一次缓存状态（grace），避免断网把已付费用户锁死。
const ENT_GATE_CACHE = { at: 0, state: null };
const ENT_GATE_TTL_MS = 60 * 1000;
async function entitlementGateState() {
  if (!entitlementEnabled()) return { on: false, activated: true };
  const now = Date.now();
  if (ENT_GATE_CACHE.state && now - ENT_GATE_CACHE.at < ENT_GATE_TTL_MS) {
    return { on: true, activated: ENT_GATE_CACHE.state.activated === true };
  }
  try {
    const st = await entitlementStatus();
    ENT_GATE_CACHE.state = st || {};
    ENT_GATE_CACHE.at = now;
  } catch (error) {
    const code = String((error && error.code) || "");
    // 明确的「没开通/已到期/版本停用」不是网络问题 ⇒ 直接判定未激活，并缓存下来。
    if (code === "NOT_ACTIVATED" || code === "EXPIRED" || code === "VERSION_RETIRED" || code === "DEVICE_LIMIT" || code === "TOKEN_INVALID") {
      ENT_GATE_CACHE.state = { activated: false, code };
      ENT_GATE_CACHE.at = now;
    } else if (!ENT_GATE_CACHE.state) {
      // 服务不可达且没有历史状态：fail-open，避免断网把已付费用户锁死。
      return { on: true, activated: true };
    }
  }
  return { on: true, activated: Boolean(ENT_GATE_CACHE.state && ENT_GATE_CACHE.state.activated === true) };
}
function replyNotActivated(res, feature) {
  sendJson(res, 402, {
    ok: false,
    code: "NOT_ACTIVATED",
    error: "这个功能需要 NovaFlow 订阅",
    feature,
    hint: "在「订阅/激活」里输入激活码，或点购买链接开通后重启 DSH Desktop",
    purchaseUrl: "https://collect.lanjiaotrade.com/buy",
  });
}

// v0.9.53：云端评论分析代理 —— 情感 / 意图的词典、模型与阈值全在服务端（/v1/analyze）。
// 这里只做三件事：校验入参、带订阅身份转发、把结果原样回给页面。
async function handleAnalyze(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "只支持 POST" });
    return;
  }
  if (!entitlementEnabled()) {
    sendJson(res, 409, {
      ok: false,
      code: "NOT_CONFIGURED",
      error: "独立运行模式不启用云端评论分析（需要 NovaFlow 订阅）",
    });
    return;
  }
  readJsonBody(req, 512 * 1024, async ({ body, error }) => {
    if (error) {
      sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
      return;
    }
    const texts = Array.isArray(body && body.texts) ? body.texts : [];
    if (!texts.length) {
      sendJson(res, 400, { ok: false, error: "texts 不能为空" });
      return;
    }
    if (texts.length > 200) {
      sendJson(res, 400, { ok: false, error: "单次最多 200 条文本" });
      return;
    }
    const mode = String((body && body.mode) || "sentiment+intent");
    try {
      const result = await analyze({ texts, mode });
      sendJson(res, 200, {
        ok: true,
        version: result.version || "",
        mode: result.mode || mode,
        results: Array.isArray(result.results) ? result.results : [],
      });
    } catch (err) {
      const code = String((err && (err.code || err.name)) || "");
      const status = code === "NOT_ACTIVATED" || code === "EXPIRED" ? 402
        : code === "RATE_LIMITED" ? 429
          : 502;
      sendJson(res, status, {
        ok: false,
        code: code || "ANALYZE_FAILED",
        error: textOf(code) || String((err && err.message) || err),
      });
    }
  });
}


/**
 * v0.2.10：把前端算好的 digest 交给 DSH 已配置的模型，SSE 流式返回文字。
 * 模型只做「解读」，不参与任何统计计算。
 */
/**
 * v0.9.53：AI 解读改为「云端代理」。
 * prompt / LLM key / 模型选择全在服务端（novaflow-collect /v1/explain），
 * 插件只把前端算好的统计摘要转发上去，再把 SSE 原样流回浏览器。
 * 订阅闸门由服务端要求激活（402）；独立模式（无 entitlement）直接说明不可用。
 */
async function handleExplain(ctx, req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "只支持 POST" });
    return;
  }
  if (!entitlementEnabled()) {
    sendJson(res, 409, {
      ok: false,
      code: "NOT_CONFIGURED",
      error: "独立运行模式不启用云端 AI 解读（需要 NovaFlow 订阅）",
    });
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
    let digestLen = 0;
    try { digestLen = JSON.stringify(digest).length; } catch { digestLen = 0; }
    if (!digestLen) {
      sendJson(res, 400, { ok: false, error: "digest 无法序列化" });
      return;
    }
    // 与云端 MAX_DIGEST_CHARS = 12000 对齐
    if (digestLen > 12000) {
      sendJson(res, 413, { ok: false, error: "digest 过大", hint: "上限 12000 字符" });
      return;
    }
    const controller = new AbortController();
    if (typeof res.on === "function") {
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
    }
    let upstream;
    try {
      upstream = await explainFetch({ digest, signal: controller.signal });
    } catch (e) {
      sendJson(res, 502, { ok: false, error: "AI 解读云端不可用：" + String((e && e.message) || e) });
      return;
    }
    if (!upstream.ok || !upstream.body) {
      let detail = null;
      try { detail = await upstream.json(); } catch { /* ignore */ }
      const status = upstream.status || 502;
      sendJson(res, status, {
        ok: false,
        code: (detail && detail.code) || "UPSTREAM_UNAVAILABLE",
        error: (detail && (detail.message || detail.error)) || textOf("UPSTREAM_UNAVAILABLE") || "AI 解读服务不可用",
        paywall: status === 402,
        purchaseUrl: "https://collect.lanjiaotrade.com/buy",
      });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const write = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
    write({ start: true, provider: "novaflow-collect", model: "cloud" });
    try {
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        buf += dec.decode(step.value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let obj = null;
          try { obj = JSON.parse(payload); } catch { continue; }
          if (obj && obj.start) continue;
          if (obj && obj.error) { write({ error: obj.error }); continue; }
          if (obj && obj.done) {
            write({ delta: "", chars: obj.chars, reasoningChars: obj.reasoningChars || 0, done: true });
            continue;
          }
          if (obj && typeof obj.reasoningChars === "number") { write({ delta: "", reasoningChars: obj.reasoningChars }); continue; }
          if (obj && obj.delta) write({ delta: obj.delta });
          if (obj && obj.usage) write({ usage: obj.usage });
        }
      }
    } catch (e) {
      try { write({ error: String((e && e.message) || e) }); } catch { /* ignore */ }
    }
    res.end();
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

        if (pathname === `${PREFIX}/api/analyze`) {
          // v0.9.53：情感 + 意图判定改由云端执行（词典/模型/prompt 不随安装包下发）。
          handleAnalyze(req, res);
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
