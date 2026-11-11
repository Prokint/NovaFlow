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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
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
const AI_MAX_TOKENS = 1600;

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
  push(path.join(os.homedir(), ".dsh", "douyin-collector", "out"));
  push(path.join(process.cwd(), "douyin-comments"));
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
    send({ start: true, provider: selection.provider, model: selection.model });

    let text = "";
    let reasonChars = 0;
    let finish = null;
    let usage = null;
    try {
      const userMessage = await makeUserMessage("数据摘要：\n" + digestJson);
      // v0.5.59：这个任务是「读摘要→输出固定 JSON」，不需要长思考。
      // 但 dsh-llm-deepseek 的默认 reasoningEffort 是 high，思考内容走
      // `reasoning-delta`（我们不计入正文），于是 900 token 全被思考吃掉、
      // 可见正文 0 字，finish.kind === 'max-tokens' —— 表现为「没有返回内容」。
      // 这里显式关掉推理，并支持一次「预算加倍」重试。
      const runOnce = async (maxTokens) => {
        const stream = llm.stream({
          provider: selection.provider,
          model: selection.model,
          system: AI_SYSTEM_PROMPT,
          messages: [userMessage],
          temperature: 0.3,
          maxTokens,
          reasoningEffort: "off",
          signal: controller.signal,
        });
        for await (const chunk of stream) {
          if (!chunk) continue;
          if (chunk.type === "text-delta" && chunk.text) {
            text += chunk.text;
            send({ delta: chunk.text });
          } else if (chunk.type === "reasoning-delta") {
            // 仅统计，不发给前端（摘要要求只输出 JSON）
            reasonChars += String(chunk.text || "").length;
          } else if (chunk.type === "usage") {
            usage = chunk.usage;
            send({ usage: chunk.usage });
          } else if (chunk.type === "finish") {
            finish = chunk.reason;
          }
        }
        const kind = finish && (finish.kind || finish);
        return kind;
      };
      let kind = await runOnce(AI_MAX_TOKENS);
      if (!text && kind === "max-tokens" && !controller.signal.aborted) {
        appendDebug({ event: "retry", reason: "max-tokens-no-text", firstMaxTokens: AI_MAX_TOKENS });
        finish = null;
        kind = await runOnce(AI_MAX_TOKENS * 2);
      }
      appendDebug({
        event: "finish",
        provider: selection.provider,
        model: selection.model,
        kind,
        chars: text.length,
        reasonChars,
        maxTokens: AI_MAX_TOKENS,
        digestChars: digestJson.length,
      });
      if (finish && kind !== "stop" && kind !== "max-tokens") {
        send({ error: "模型返回失败：" + describeFinish(finish) });
      } else if (!text && kind === "max-tokens" && reasonChars > 0) {
        send({ error: "模型把 token 预算都用在思考上了（思考 " + reasonChars + " 字、正文 0 字）。已在请求里关闭推理，如仍出现请把这份摘要复制给任意 AI。" });
      } else if (!text) {
        send({ error: "模型没有返回内容（可点「重新生成」再试一次）" });
      } else {
        send({ done: true, chars: text.length });
      }
    } catch (err) {
      appendDebug({ event: "throw", message: String((err && err.message) || err) });
      send({ error: String((err && err.message) || err) });
    } finally {
      res.end();
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
  const body = readFileSync(file);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
    // v0.5.47：静态资源也不缓存，避免升级后浏览器仍用旧 styles.css / app.js
        "Cache-Control": "no-store, max-age=0",
  });
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
