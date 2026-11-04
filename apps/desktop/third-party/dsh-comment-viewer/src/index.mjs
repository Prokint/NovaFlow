/**
 * dsh-comment-viewer —— 把「评论分析台（交互词云 + 评论表）」嵌入 DSH Web。
 *
 * 服务端只做两件事：
 *   1. 把本包 app/ 目录（纯静态的评论分析台）挂到 /plugins/dsh-comment-viewer/app；
 *   2. 提供两个只读接口，让页面不用手选文件就能读本地导出的评论 JSON：
 *        GET  <prefix>/api/list            列出可读的 douyin-comments-*.json
 *        GET  <prefix>/api/load?path=<p>   读取其中一个（必须在允许的目录里）
 *
 * 目录来源（按顺序去重）：
 *   - 环境变量 DSH_COMMENT_VIEWER_DIRS（分号分隔，可写多个）
 *   - ~/.dsh/douyin-collector/out（采集插件/扩展的全局默认输出目录）
 *   - <当前工作目录>/douyin-comments（DSH 插件默认落盘目录）
 */
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync , appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const name = "dsh-comment-viewer";
export const inject = ["webServer"];

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

const PREFIX = "/plugins/dsh-comment-viewer/app";
const appDir = fileURLToPath(new URL("../app/", import.meta.url));

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
  push(path.join(os.homedir(), ".dsh", "douyin-collector", "out"));
  push(path.join(process.cwd(), "douyin-comments"));
  return out;
}

/** 读取 JSON 头部的 count 字段（只读前 8KB，够用且不慢） */
function peekCount(file) {
  try {
    const head = readFileSync(file, { encoding: "utf8", flag: "r" }).slice(0, 8192);
    const m = head.match(/"count"\s*:\s*(\d+)/);
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
      if (!/^douyin-comments-.*\.json$/i.test(entry)) continue;
      const full = path.join(root, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const head = readFileSync(full, { encoding: "utf8" }).slice(0, 4096);
      const videoId = (head.match(/"videoId"\s*:\s*"(\d+)"/) || [])[1] || "";
      const title = (head.match(/"title"\s*:\s*"([^"]{0,120})"/) || [])[1] || "";
      files.push({
        name: entry,
        path: full,
        videoId,
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

export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: "prefix",
      path: PREFIX,
      handler(req, res) {
        if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
          res.writeHead(405, { Allow: "GET, HEAD, POST" });
          res.end();
          return;
        }
        const url = new URL(req.url, "http://localhost");
        const pathname = url.pathname;

        if (pathname === PREFIX || pathname === `${PREFIX}/`) return serveStatic(req, res, pathname);

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

        if (pathname === `${PREFIX}/api/explain`) {
          handleExplain(ctx, req, res);
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
              const looksLikeExport = /^douyin-comments-.*\.(json|csv)$/i.test(path.basename(abs));
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

        serveStatic(req, res, pathname);
      },
    }),
  );
}
