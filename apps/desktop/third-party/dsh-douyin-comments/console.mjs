/**
 * dsh-douyin-comments 的 DSH Web 控制台后端。
 *
 * 目标：让 DSH 页面里能「输入视频链接 → 开始采集 → 看进度 → 下载 CSV/JSON/词云」，
 * 同时不重写采集核心。真正干活仍然是 collector.mjs 的 collectDouyinComments()：
 *   · 它负责启动有头 Chromium、自动装扩展、扫码登录、复用页面签名、落库、导出；
 *   · 这里只加一层「作业（job）」：后台跑、暴露状态、支持取消、列出导出文件。
 *
 * 只在 DSH Web 的 webServer 里挂一个 prefix：
 *   /plugins/dsh-douyin-comments/app/...   静态控制台页面
 *   /plugins/dsh-douyin-comments/api/...   JSON 接口
 *
 * 没有 webServer 的宿主（headless / 纯工具模式）不会调用 registerConsole，
 * 原来的 douyin_comments 工具完全不受影响。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDouyinComments, DEFAULTS } from './collector.mjs';
import { listShopAccounts } from './shop-accounts-bridge.mjs';

export const CONSOLE_PREFIX = '/plugins/dsh-douyin-comments';

const APP_DIR = fileURLToPath(new URL('./app/', import.meta.url));
const PKG = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const VERSION = String(PKG.version || '0.0.0');

const MAX_JOBS = 20;
const MAX_LOG_LINES = 400;
const MAX_BODY_BYTES = 1_000_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const EXPORT_RE = /^douyin-(?:comments|wordcloud)-.*\.(json|csv|html)$/i;

function httpError(message, status = 400) {
  const error = new Error(String(message || '请求失败'));
  error.status = status;
  return error;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(httpError('请求体太大', 413));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(httpError('请求体不是合法 JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 采集器数据根目录（NovaFlow / DSH Desktop 会按账号注入 DSH_HOME，
 * collector.mjs 的 DEFAULTS.home 因此也已随账号隔离；这里只做统一出口）。
 */
export function collectorHome() {
  return DEFAULTS.home || path.join(os.homedir(), '.dsh', 'douyin-collector');
}

/**
 * v0.5.62：记住「工具这次把产物写到哪了」。
 *
 * 工具调用默认写**当前会话工作区**（`<cwd>/douyin-comments`），而控制台没有会话上下文，
 * 只能写全局目录。两边目录不同 → 控制台「导出记录」看不到工具采的文件。
 * 所以工具每跑一次就把 outDir 记到 `<home>/last-out.json`，控制台据此把它也当成可读根。
 */
const LAST_OUT_FILE = path.join(collectorHome(), 'last-out.json');

export function rememberOutDir(dir) {
  const abs = String(dir || '').trim();
  if (!abs) return;
  try {
    fs.mkdirSync(path.dirname(LAST_OUT_FILE), { recursive: true });
    fs.writeFileSync(LAST_OUT_FILE, JSON.stringify({ outDir: path.resolve(abs), at: Date.now() }) + '\n', 'utf8');
  } catch { /* 记不住也不影响采集 */ }
}

export function lastOutDir() {
  try {
    const raw = JSON.parse(fs.readFileSync(LAST_OUT_FILE, 'utf8'));
    const dir = raw && typeof raw.outDir === 'string' ? raw.outDir.trim() : '';
    return dir ? path.resolve(dir) : '';
  } catch {
    return '';
  }
}

function allowedRoots(extraOutDir) {
  const roots = [];
  const push = (dir) => {
    if (!dir) return;
    const abs = path.resolve(String(dir));
    if (roots.includes(abs)) return;
    try {
      if (fs.statSync(abs).isDirectory()) roots.push(abs);
    } catch { /* 目录还不存在：不算可读根 */ }
  };
  push(extraOutDir);
  push(DEFAULTS.outDir);
  push(path.join(os.homedir(), '.dsh', 'douyin-collector', 'out'));
  push(path.join(process.cwd(), 'douyin-comments'));
  // 工具上一次实际写入的目录（通常是当前会话工作区）
  push(lastOutDir());
  return roots;
}

function isInside(file, roots) {
  const abs = path.resolve(file);
  return roots.some((root) => abs === root || abs.startsWith(root + path.sep));
}

function listExports(extraOutDir) {
  const roots = allowedRoots(extraOutDir);
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (!EXPORT_RE.test(name)) continue;
      const full = path.join(root, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile() || seen.has(full)) continue;
      seen.add(full);
      const ext = path.extname(name).toLowerCase().replace('.', '');
      out.push({
        name,
        path: full,
        kind: ext,
        size: st.size,
        mtime: st.mtime.toISOString(),
      });
    }
  }
  out.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return out;
}

function serveStatic(req, res, pathname) {
  let rel = pathname.slice(`${CONSOLE_PREFIX}/app`.length);
  if (!rel || rel === '/') rel = '/index.html';
  const file = path.resolve(APP_DIR, '.' + rel);
  const appRoot = path.resolve(APP_DIR);
  if (file !== appRoot && !file.startsWith(appRoot + path.sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  let st;
  try { st = fs.statSync(file); } catch {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  if (!st.isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function publicResult(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    ok: result.ok === true,
    error: String(result.error || ''),
    videoId: String(result.videoId || ''),
    title: String(result.title || ''),
    count: Number(result.count) || 0,
    csvPath: String(result.csvPath || ''),
    jsonPath: String(result.jsonPath || ''),
    htmlPath: String(result.htmlPath || ''),
    phase: String(result.phase || ''),
    note: String(result.note || ''),
    lanes: Number(result.extLanes || result.lanes) || 0,
    durationSec: Number(result.durationSec) || 0,
    extensionVersion: String((result.extension && result.extension.version) || ''),
    sample: Array.isArray(result.sample) ? result.sample.slice(0, 8).map((s) => String(s)) : [],
    logPath: String(result.logPath || ''),
    snapshotDir: String(result.snapshotDir || ''),
  };
}

function publicJob(job, { logs = true } = {}) {
  const status = job.status || {};
  return {
    id: job.id,
    state: job.state,
    phase: job.phase,
    done: job.done,
    needLogin: job.needLogin === true,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt || 0,
    elapsedMs: Math.max(0, (job.endedAt || Date.now()) - job.startedAt),
    options: job.options,
    counts: {
      unique: Number(status.unique) || 0,
      topSeen: Number(status.topSeen) || 0,
      savedCount: Number(status.savedCount) || 0,
      total: Number(status.total) || 0,
      videoId: String(status.videoId || ''),
      note: String(status.note || ''),
      hasSig: status.hasSig === true,
    },
    logs: logs ? job.logs.slice(-120).map((item) => item.line) : [],
    result: job.done ? publicResult(job.result) : null,
    error: String(job.error || ''),
  };
}

function normalizeInput(raw, settings, outDir) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const url = String(body.url || '').trim();
  if (!url) throw httpError('缺少视频链接', 400);
  if (url.length > 4000) throw httpError('视频链接太长', 400);

  const n = (value, fallback) => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : fallback;
  };
  const max = Math.min(1_000_000, Math.max(1, Math.round(n(body.max, settings.max || DEFAULTS.max || 80000))));
  const lanes = Math.min(8, Math.max(1, Math.round(n(body.lanes, settings.lanes || DEFAULTS.lanes || 3))));
  const timeoutMs = Math.min(14_400_000, Math.max(60_000, Math.round(n(body.timeoutMs, settings.timeoutMs || DEFAULTS.timeoutMs || 1_800_000))));
  const waitLoginSec = body.waitLoginSec === undefined || body.waitLoginSec === null
    ? Math.max(0, Number(settings.waitLoginSec ?? DEFAULTS.waitLoginSec) || 0)
    : Math.max(0, Math.round(Number(body.waitLoginSec) || 0));

  return {
    url,
    account: String(body.account || '').trim(),
    max,
    lanes,
    timeoutMs,
    waitLoginSec,
    replies: body.replies !== false,
    clearBefore: body.clearBefore === undefined ? settings.clearBefore === true : body.clearBefore === true,
    replyLanes: settings.replyLanes,
    replyGlobalGapMs: settings.replyGlobalGapMs,
    replyThrottleSec: settings.replyThrottleSec,
    replyNoProgressSec: settings.replyNoProgressSec,
    failSnapshot: settings.failSnapshot,
    keepSnapshots: settings.keepSnapshots,
    cloud: body.cloud === true,
    outDir,
  };
}

/**
 * @param {{
 *   collect?: Function,
 *   getSettings?: () => object,
 *   getOutDir?: () => string,
 *   version?: string,
 * }} [options]
 */
export function createConsole(options = {}) {
  const collect = options.collect || collectDouyinComments;
  const getSettings = options.getSettings || (() => ({}));
  const getOutDir = options.getOutDir || (() => DEFAULTS.outDir);
  const version = String(options.version || VERSION);
  const jobs = new Map();
  let activeJob = null;
  let seq = 0;

  function pruneJobs() {
    const done = [...jobs.values()].filter((job) => job.done).sort((a, b) => b.createdAt - a.createdAt);
    for (const job of done.slice(MAX_JOBS)) jobs.delete(job.id);
  }

  function startJob(raw) {
    if (activeJob && !activeJob.done) {
      throw httpError('已有一个采集任务在跑，等它结束或先取消', 409);
    }
    const outDir = String(getOutDir() || DEFAULTS.outDir || '');
    const settings = getSettings() || {};
    const input = normalizeInput(raw, settings, outDir);
    const id = `job-${Date.now().toString(36)}-${++seq}`;
    const controller = new AbortController();
    const job = {
      id,
      state: 'running',
      phase: 'starting',
      createdAt: Date.now(),
      startedAt: Date.now(),
      endedAt: 0,
      logs: [],
      status: null,
      result: null,
      error: '',
      needLogin: false,
      done: false,
      controller,
      options: input,
    };
    jobs.set(id, job);
    activeJob = job;

    const onLog = (line) => {
      const text = String(line);
      job.logs.push({ at: Date.now(), line: text });
      if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
      // 只有「真的在等登录」才算；匿名模式会打印「未登录…但按匿名继续」，那不是阻塞。
      if (!/按匿名继续/.test(text)
        && /扫码登录|等待扫码|需要登录|need-login|请在浏览器窗口里|登录后重试/i.test(text)) {
        job.needLogin = true;
      }
    };
    const onStatus = (status) => {
      if (!status || typeof status !== 'object') return;
      job.status = {
        phase: String(status.phase || ''),
        videoId: String(status.videoId || status.liveVideoId || ''),
        unique: Number(status.unique) || 0,
        topSeen: Number(status.topSeen) || 0,
        savedCount: Number(status.savedCount) || 0,
        total: Number(status.total) || 0,
        note: String(status.note || ''),
        hasSig: status.hasSig === true,
      };
      if (job.status.phase) job.phase = job.status.phase;
      if (job.status.phase === 'waiting-login' || job.status.phase === 'need-login') job.needLogin = true;
    };

    job.promise = Promise.resolve()
      .then(() => collect({
        ...input,
        signal: controller.signal,
        onLog,
        onStatus,
      }))
      .then((result) => {
        job.result = result || null;
        job.done = true;
        job.endedAt = Date.now();
        const ok = result && result.ok === true;
        job.state = ok ? 'done' : (controller.signal.aborted ? 'cancelled' : 'error');
        job.phase = String((result && result.phase) || (ok ? 'done' : 'error'));
        if (result && result.phase === 'need-login') job.needLogin = true;
        if (result && result.error) job.error = String(result.error);
      })
      .catch((error) => {
        job.result = null;
        job.done = true;
        job.endedAt = Date.now();
        job.state = controller.signal.aborted ? 'cancelled' : 'error';
        job.phase = 'error';
        job.error = String((error && error.message) || error);
      })
      .finally(() => {
        if (activeJob === job) activeJob = null;
        pruneJobs();
      });
    return job;
  }

  function findJob(id) {
    const job = jobs.get(String(id || ''));
    if (!job) throw httpError('任务不存在', 404);
    return job;
  }

  function handler(req, res) {
    (async () => {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;

      if (pathname === `${CONSOLE_PREFIX}/app`) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError('只支持 GET', 405);
        res.writeHead(302, { Location: `${CONSOLE_PREFIX}/app/` });
        return res.end();
      }
      if (pathname === `${CONSOLE_PREFIX}/app/`) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError('只支持 GET', 405);
        return serveStatic(req, res, `${CONSOLE_PREFIX}/app/`);
      }
      if (pathname.startsWith(`${CONSOLE_PREFIX}/app/`)) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError('只支持 GET', 405);
        return serveStatic(req, res, pathname);
      }

      if (pathname === `${CONSOLE_PREFIX}/api/health`) {
        return sendJson(res, 200, { ok: true, version, outDir: String(getOutDir() || '') });
      }

      if (pathname === `${CONSOLE_PREFIX}/api/accounts` && (req.method === 'GET' || req.method === 'HEAD')) {
        // v0.8.0：shop-accounts 账号清单（默认只列抖音账号）；不可用时 ok:false + error，UI 显示提示
        const data = await listShopAccounts({ platform: 'douyin' });
        return sendJson(res, 200, Object.assign({ ok: true, platform: 'douyin' }, data));
      }

      if (pathname === `${CONSOLE_PREFIX}/api/config`) {
        const settings = getSettings() || {};
        return sendJson(res, 200, {
          ok: true,
          version,
          outDir: String(getOutDir() || DEFAULTS.outDir || ''),
          defaults: {
            max: Number(settings.max) || DEFAULTS.max || 80000,
            lanes: Number(settings.lanes) || DEFAULTS.lanes || 3,
            timeoutMs: Number(settings.timeoutMs) || DEFAULTS.timeoutMs || 1_800_000,
            waitLoginSec: Number(settings.waitLoginSec) || 0,
            clearBefore: settings.clearBefore === true,
            replies: true,
            cloud: false,
          },
        });
      }

      if (pathname === `${CONSOLE_PREFIX}/api/jobs` && req.method === 'GET') {
        const list = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, MAX_JOBS)
          .map((job) => publicJob(job, { logs: false }));
        return sendJson(res, 200, { ok: true, jobs: list });
      }

      if (pathname === `${CONSOLE_PREFIX}/api/jobs` && req.method === 'POST') {
        const body = await readJson(req);
        const job = startJob(body);
        return sendJson(res, 200, { ok: true, job: publicJob(job) });
      }

      const jobMatch = pathname.match(new RegExp(`^${CONSOLE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/jobs/([^/]+)$`));
      if (jobMatch) {
        const job = findJob(decodeURIComponent(jobMatch[1]));
        if (req.method === 'GET') return sendJson(res, 200, { ok: true, job: publicJob(job) });
        throw httpError('只支持 GET', 405);
      }

      const cancelMatch = pathname.match(new RegExp(`^${CONSOLE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/jobs/([^/]+)/cancel$`));
      if (cancelMatch) {
        if (req.method !== 'POST') throw httpError('只支持 POST', 405);
        const job = findJob(decodeURIComponent(cancelMatch[1]));
        if (!job.done) job.controller.abort();
        return sendJson(res, 200, { ok: true, job: publicJob(job, { logs: false }) });
      }

      if (pathname === `${CONSOLE_PREFIX}/api/exports` && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, files: listExports(getOutDir()) });
      }

      if (pathname === `${CONSOLE_PREFIX}/api/download` && (req.method === 'GET' || req.method === 'HEAD')) {
        const target = String(url.searchParams.get('path') || '');
        const abs = path.resolve(target);
        if (!target || !isInside(abs, allowedRoots(getOutDir()))) {
          throw httpError('路径不在允许目录内', 403);
        }
        let st;
        try { st = fs.statSync(abs); } catch { throw httpError('文件不存在', 404); }
        if (!st.isFile()) throw httpError('不是文件', 400);
        const name = path.basename(abs);
        // v0.5.62：只允许下载导出产物（CSV / JSON / 词云 HTML），避免把目录里别的文件当下载口。
        if (!EXPORT_RE.test(name)) throw httpError('只允许下载采集导出的文件', 403);
        const ext = path.extname(name).toLowerCase();
        const inline = url.searchParams.get('inline') === '1';
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': st.size,
          'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Cache-Control': 'no-store',
        });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(abs).pipe(res);
      }

      if (pathname.startsWith(`${CONSOLE_PREFIX}/api/`)) throw httpError('接口不存在', 404);
      throw httpError('not found', 404);
    })().catch((error) => {
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        return;
      }
      sendJson(res, Number(error && error.status) || 500, {
        ok: false,
        error: String((error && error.message) || error),
      });
    });
  }

  return { handler, startJob, findJob, jobs, getExports: () => listExports(getOutDir()) };
}

/**
 * 把控制台挂到 DSH 的 webServer 上。没有 webServer 的宿主不会调用到这里，
 * 因此不影响纯工具模式。
 */
export function registerConsole(ctx, options = {}) {
  const api = createConsole(options);
  const register = () => ctx.webServer.register({
    kind: 'prefix',
    path: CONSOLE_PREFIX,
    handler: api.handler,
  });
  if (typeof ctx.effect === 'function') ctx.effect(register);
  else register();
  return api;
}

export default { CONSOLE_PREFIX, createConsole, registerConsole, rememberOutDir, lastOutDir };
