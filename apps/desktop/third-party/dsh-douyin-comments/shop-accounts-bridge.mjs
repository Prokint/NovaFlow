// shop-accounts-bridge.mjs — v0.8.0
// 从 dsh-plugin-shop-accounts 复用「已登录的浏览器档案」的登录态：
//   · Chrome 后端：读该账号浏览器（已开着就走 CDP；没开就用同一 user-data-dir 起个无头实例）里的 cookie；
//   · ego 后端：ego 没开时用 egoOfflineCookies（同一 User Data 起无头实例读），开着时用 egoProbe（临时 TaskSpace）。
// 读出 cookie 后交给采集器注入它自己的 Chromium（带采集扩展）—— shop-accounts 的浏览器不给加载扩展，
// 所以不复用它的窗口，只复用登录态。
//
// 为什么不用 shop-accounts 的 HTTP 接口：/shop-accounts 要求 x-dsh-shop-accounts: 1 + 同源/Host 校验，
// 只对自己的界面开放；直接读它写的 JSON + 复用它 lib 里的模块更稳（另一个插件也不依赖它的版本号）。
//
// 找不到 shop-accounts 插件时所有接口都返回 available:false，采集退回「插件自己的登录态」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** 抖音（含抖店）cookie 的域名后缀，和 shop-accounts 的 platforms.mjs 里 douyin 一致 */
export const DOUYIN_COOKIE_DOMAINS = ['douyin.com', 'jinritemai.com', 'bytedance.com'];

const PLUGIN_DIR = process.env.DSH_DOUYIN_COLLECTOR_ROOT
  || fileURLToPath(new URL('./', import.meta.url));

/** shop-accounts 的 DSH home 下的数据目录（和插件自己的 %DSH_HOME%\shop-accounts 一致） */
export function shopAccountsDataDir() {
  const env = String(process.env.DSH_SHOP_ACCOUNTS_DIR || '').trim();
  if (env) return env;
  const home = String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
  return path.join(home, 'shop-accounts');
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 定位 shop-accounts 插件根目录（有 lib/ego.mjs 才算命中） */
export function resolveShopAccountsRoot() {
  const out = { root: '', error: '' };
  const candidates = [];
  const envRoot = String(process.env.DSH_SHOP_ACCOUNTS_PLUGIN || '').trim();
  if (envRoot) candidates.push(envRoot);
  for (const id of ['dsh-plugin-shop-accounts', 'dsh-plugin-shop-accounts/index.js']) {
    try { candidates.push(path.dirname(require.resolve(id))); } catch { /* 继续找 */ }
  }
  const home = String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
  candidates.push(
    path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-plugin-shop-accounts'),
    path.join(home, 'profiles', 'node_modules', 'dsh-plugin-shop-accounts'),
    path.join(PLUGIN_DIR, '..', 'dsh-plugin-shop-accounts'),
    path.join(PLUGIN_DIR, 'node_modules', 'dsh-plugin-shop-accounts'),
  );
  for (const c of candidates) {
    if (!c) continue;
    try {
      const probe = path.join(path.resolve(c), 'lib', 'ego.mjs');
      if (fs.existsSync(probe)) { out.root = path.dirname(path.dirname(probe)); return out; }
    } catch { /* 忽略坏路径 */ }
  }
  out.error = '没找到 dsh-plugin-shop-accounts 插件（可在设置里用 DSH_SHOP_ACCOUNTS_PLUGIN 指定它的目录）';
  return out;
}

let libCache = { root: '', mods: new Map() };
async function loadLib(root, name) {
  if (libCache.root !== root) libCache = { root, mods: new Map() };
  if (!libCache.mods.has(name)) {
    const file = path.join(root, 'lib', name);
    libCache.mods.set(name, import(pathToFileURL(file).href));
  }
  return libCache.mods.get(name);
}

/** 读 store：accounts.json / config.json / runtime.json（shop-accounts 没装就 error） */
export function readShopAccountsStore() {
  const dataDir = shopAccountsDataDir();
  const accountsDoc = readJsonSafe(path.join(dataDir, 'accounts.json'));
  if (!accountsDoc) {
    return { ok: false, dataDir, error: '读不到 shop-accounts 的账号清单（' + path.join(dataDir, 'accounts.json') + '），是不是还没装/没用过 shop-accounts？' };
  }
  const accounts = Array.isArray(accountsDoc.accounts) ? accountsDoc.accounts
    : (Array.isArray(accountsDoc) ? accountsDoc : []);
  const config = readJsonSafe(path.join(dataDir, 'config.json')) || {};
  const runtime = readJsonSafe(path.join(dataDir, 'runtime.json')) || {};
  return { ok: true, dataDir, accounts, config, runtime };
}

function runtimeEntryFor(store, account) {
  const rt = store.runtime || {};
  const list = Array.isArray(rt.accounts) ? rt.accounts : null;
  if (list) return list.find((r) => r && (r.id === account.id || r.accountId === account.id)) || {};
  return rt[account.id] || {};
}

const PLATFORM_LABELS = { pdd: '拼多多', taobao: '淘宝', tmall: '天猫', douyin: '抖音', jd: '京东', ali1688: '1688' };
const TYPE_LABELS = { seller: '卖家', buyer: '买家' };

/** 平台 → cookie 域名后缀 */
export function cookieDomainsFor(platform) {
  const p = String(platform || '').toLowerCase();
  if (p === 'douyin') return DOUYIN_COOKIE_DOMAINS.slice();
  if (p === 'pdd') return ['pinduoduo.com', 'yangkeduo.com'];
  if (p === 'taobao' || p === 'tmall') return ['taobao.com', 'tmall.com', 'alicdn.com'];
  if (p === 'jd') return ['jd.com'];
  if (p === 'ali1688') return ['1688.com', 'alibaba.com'];
  return DOUYIN_COOKIE_DOMAINS.slice();
}

function platformLabel(platform) {
  const p = String(platform || '').toLowerCase();
  return PLATFORM_LABELS[p] || p || '未知平台';
}

function normalizeAccount(raw, store) {
  const acc = raw && typeof raw === 'object' ? raw : {};
  const id = String(acc.id || acc.accountId || '').trim();
  if (!id) return null;
  const platform = String(acc.platform || '').toLowerCase();
  const accountType = String(acc.accountType || acc.type || 'seller').toLowerCase();
  const rt = runtimeEntryFor({ runtime: store.runtime }, acc);
  const port = Number(rt.port || acc.port) || 0;
  const browserMode = String((store.config && store.config.browser) || 'auto').toLowerCase();
  const egoDeclared = String(acc.egoProfile || '').trim();
  const backend = browserMode === 'chrome' ? 'chrome'
    : (browserMode === 'ego' || browserMode === 'egolite') ? 'ego'
      : (egoDeclared || (store.config && String(store.config.egoliteCli || '').trim()) ? 'ego' : 'auto');
  return {
    id,
    name: String(acc.name || id),
    platform,
    platformLabel: platformLabel(platform),
    accountType,
    accountTypeLabel: TYPE_LABELS[accountType] || accountType,
    backend,
    browserMode,
    egoProfile: egoDeclared,
    egoSpace: String(acc.egoSpace || rt.egoSpace || ''),
    port,
    running: port > 0,
    profileDir: String(acc.profileDir || path.join(shopAccountsDataDir(), 'profiles', id)),
    label: String(acc.name || id) + ' · ' + platformLabel(platform) + ' ' + (TYPE_LABELS[accountType] || accountType),
    // 本机踩坑：抖店卖家号的 ego 档案里只有 jinritemai 后台登录，没有 douyin.com 登录；
    // 采集抖音评论需要「在 douyin.com 登录过」的账号 —— 这条给 UI 做提示，不影响可用性判断。
    hint: (platform === 'douyin' && accountType === 'seller')
      ? '抖店卖家号通常只登录了抖店后台（jinritemai），采集抖音评论还需要该账号在 www.douyin.com 也登录过；建议用「抖音买家」账号'
      : '',
  };
}

async function egoSnapshot(config) {
  const found = resolveShopAccountsRoot();
  if (!found.root) return { available: false, appRunning: false, backend: '', error: found.error };
  try {
    const ego = await loadLib(found.root, 'ego.mjs');
    const status = ego.egoStatus(config || {});
    const appRunning = await ego.egoAppRunning().catch(() => false);
    return { available: !!status.available, appRunning, backend: String(status.backend || ''), error: status.available ? '' : 'ego lite 没装（可从 shop-accounts 设置里安装 ego）' };
  } catch (e) {
    return { available: false, appRunning: false, backend: '', error: 'ego 模块加载失败：' + String((e && e.message) || e) };
  }
}

/** 插件面板 / 工具用：shop-accounts 是否可用 + 账号列表（默认只列抖音） */
export async function listShopAccounts({ platform = 'douyin', includeAll = false } = {}) {
  const store = readShopAccountsStore();
  if (!store.ok) return { ok: false, available: false, accounts: [], error: store.error, dataDir: store.dataDir };
  const found = resolveShopAccountsRoot();
  const ego = await egoSnapshot(store.config);
  const all = (store.accounts || []).map((a) => normalizeAccount(a, store)).filter(Boolean);
  const want = String(platform || '').toLowerCase();
  const accounts = (includeAll || !want) ? all : all.filter((a) => a.platform === want);
  for (const a of accounts) {
    if (a.backend === 'auto') a.backend = ego.available ? 'ego' : 'chrome';
    a.backendLabel = a.backend === 'ego' ? 'ego' : 'Chrome';
    a.readable = a.backend === 'ego' ? !!ego.available : true;
    a.ready = a.backend === 'ego' ? !!ego.available : !!(store.config && (store.config.browserPath || true));
    if (!a.readable) a.blockedReason = ego.error || 'ego lite 不可用';
  }
  return {
    ok: true, available: true, dataDir: store.dataDir, pluginRoot: found.root,
    backendDefault: (store.config && store.config.browser) || 'auto',
    ego: { available: ego.available, appRunning: ego.appRunning, backend: ego.backend },
    accounts,
  };
}

/** 账号解析：id / 名字 / label / 名字片段都能匹配；找不到抛带候选列表的中文错误 */
export async function resolveShopAccount(ref, { platform = 'douyin' } = {}) {
  const want = String(ref == null ? '' : ref).trim();
  if (!want) return null;
  const listed = await listShopAccounts({ platform, includeAll: true });
  if (!listed.available) throw new Error(listed.error || 'shop-accounts 不可用');
  const pool = listed.accounts;
  const low = want.toLowerCase();
  const hit = pool.find((a) => a.id === want)
    || pool.find((a) => a.name === want)
    || pool.find((a) => a.label === want)
    || pool.find((a) => a.name.toLowerCase() === low)
    || pool.find((a) => a.name.toLowerCase().includes(low))
    || pool.find((a) => a.id.toLowerCase().includes(low));
  if (!hit) {
    const names = pool.map((a) => '「' + a.name + '」(' + a.id + '，' + a.platformLabel + ' ' + a.accountTypeLabel + ')');
    throw new Error('找不到 shop-accounts 账号「' + want + '」' + (names.length
      ? '；可用账号：' + names.join('、')
      : '；当前 shop-accounts 里一个账号都没有'));
  }
  if (String(hit.platform || '') !== String(platform || '').toLowerCase() && platform) {
    throw new Error('账号「' + hit.name + '」是 ' + hit.platformLabel + ' 的，不能用来采集' + platformLabel(platform) + '评论');
  }
  return hit;
}

function domainHit(domain, domains) {
  const d = String(domain || '').replace(/^\.+/, '').toLowerCase();
  return (domains || []).some((suf) => d === suf || d.endsWith('.' + suf));
}

/** 抖音网页端登录 cookie 名（有其一才算是「在 douyin.com 登录过」） */
export const DOUYIN_SESSION_COOKIE_NAMES = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'];

/**
 * 统计读到的 cookie 覆盖情况。本机实测踩坑：抖店卖家的 ego 档案里只有 jinritemai 后台登录，
 * 一个 douyin.com 的 cookie 都没有 —— 这种账号拿来采抖音评论必然被登录闸门拦下。
 */
export function classifyCookieCoverage(raw, domains = DOUYIN_COOKIE_DOMAINS) {
  const list = Array.isArray(raw) ? raw : [];
  const groups = {};
  for (const suf of domains || []) groups[suf] = 0;
  for (const c of list) {
    for (const suf of domains || []) {
      if (domainHit(c && c.domain, [suf])) { groups[suf] += 1; break; }
    }
  }
  const douyin = list.filter((c) => domainHit(c && c.domain, ['douyin.com']));
  const sessionNames = douyin
    .map((c) => String(c && c.name || ''))
    .filter((n) => DOUYIN_SESSION_COOKIE_NAMES.includes(n));
  return {
    total: list.length,
    groups,
    douyinCount: douyin.length,
    sessionNames: [...new Set(sessionNames)],
    hasDouyinLogin: douyin.length > 0 && sessionNames.length > 0,
  };
}

/** CDP / ego 的 cookie → playwright addCookies 能吃的形状（去掉 size/priority/session 等多余字段） */
export function cookiesForPlaywright(raw) {
  const out = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    if (!c || !c.name) continue;
    const domain = String(c.domain || '').trim();
    if (!domain) continue;
    const item = {
      name: String(c.name),
      value: String(c.value == null ? '' : c.value),
      domain,
      path: String(c.path || '/'),
      httpOnly: !!c.httpOnly,
      secure: c.secure !== false,
    };
    const exp = Number(c.expires);
    if (Number.isFinite(exp) && exp > 0) item.expires = Math.round(exp);
    const same = String(c.sameSite || '').toLowerCase();
    if (same === 'none') item.sameSite = 'None';
    else if (same === 'strict') item.sameSite = 'Strict';
    else if (same === 'lax') item.sameSite = 'Lax';
    out.push(item);
  }
  return out;
}

async function readChromeCookies(account, store, log) {
  const found = resolveShopAccountsRoot();
  if (!found.root) throw new Error(found.error);
  const cdp = await loadLib(found.root, 'cdp.mjs');
  const chrome = await loadLib(found.root, 'chrome.mjs');
  const config = store.config || {};
  const domains = cookieDomainsFor(account.platform);
  const rt = runtimeEntryFor(store, account);
  const port = Number(rt.port || account.port) || 0;
  const profileDir = account.profileDir || path.join(path.join(shopAccountsDataDir(), 'profiles', account.id));

  if (port && await cdp.browserUp(port).catch(() => false)) {
    const got = await cdp.getAllCookies(port);
    const all = (got && got.cookies) || [];
    log('从已打开的 Chrome（端口 ' + port + '）读到 ' + all.length + ' 个 cookie');
    return { cookies: all.filter((c) => domainHit(c.domain, domains)), mode: 'attached', port };
  }

  const exe = chrome.resolveBrowserPath(config.browserPath);
  if (!exe) throw new Error('找不到 Chrome/Chromium 可执行文件：请在 shop-accounts 设置里填「浏览器路径」');
  if (!fs.existsSync(profileDir)) {
    throw new Error('这个账号还没在 shop-accounts 里打开过浏览器（没有档案目录 ' + profileDir + '）：请先在 shop-accounts 里点「打开」登录一次');
  }
  const pickPort = await chrome.pickPort(Number(config.portBase) || 9222, []);
  chrome.launchBrowser({ exe, profileDir, port: pickPort, headless: true, urls: ['about:blank'] });
  try {
    const up = await chrome.waitForCdp(pickPort, 25000);
    if (!up) throw new Error('无头 Chrome 没能就绪（端口 ' + pickPort + '）');
    const got = await cdp.getAllCookies(pickPort);
    const all = (got && got.cookies) || [];
    log('用同一档案起了无头 Chrome（端口 ' + pickPort + '），读到 ' + all.length + ' 个 cookie');
    return { cookies: all.filter((c) => domainHit(c.domain, domains)), mode: 'headless', port: pickPort };
  } finally {
    await cdp.closeBrowser(pickPort).catch(() => {});
    await chrome.waitPortGone(pickPort, 6000).catch(() => {});
  }
}

async function readEgoCookies(account, store, log) {
  const found = resolveShopAccountsRoot();
  if (!found.root) throw new Error(found.error);
  const ego = await loadLib(found.root, 'ego.mjs');
  const config = store.config || {};
  const status = ego.egoStatus(config);
  if (!status.available) throw new Error('ego lite 不可用（' + (status.backend || '未安装') + '），请在 shop-accounts 设置里装/指一下 ego');
  const profileId = ego.normalizeEgoProfileId(account.egoProfile);
  if (!profileId) throw new Error('账号「' + account.name + '」没有记录 ego 档案（egoProfile），请先在 shop-accounts 里用 ego 打开一次');
  const domains = cookieDomainsFor(account.platform);
  const appRunning = await ego.egoAppRunning().catch(() => false);
  const opts = { timeoutMs: 60000 };
  let r;
  if (appRunning) {
    log('ego 正在运行：用临时 TaskSpace 读 Profile ' + profileId + ' 的 cookie…');
    r = await ego.egoProbe({
      profileId, url: 'https://www.douyin.com', domains,
      tempSpace: 'dsh-douyin-collect',
    }, opts);
  } else {
    log('ego 没在运行：用同一 User Data 起无头实例读 Profile ' + profileId + ' 的 cookie…');
    r = await ego.egoOfflineCookies({
      profileId, domains, timeoutMs: 20000,
      appConfigured: config.egoliteApp, userDataConfigured: config.egoliteUserData,
    });
  }
  const cookies = (r && r.cookies) || [];
  if (r && r.ok) {
    log('ego 读到 ' + cookies.length + ' 个 cookie（' + (r.mode || 'ego') + '）');
    return { cookies, mode: r.mode || 'ego' };
  }
  throw new Error('ego 读 cookie 失败：' + ((r && (r.error || r.code)) || '未知原因'));
}

/**
 * 读某个 shop-accounts 账号的登录 cookie（抖音站点域）。
 * @returns {{ok:boolean, backend:string, mode:string, cookies:object[], count:number, coverage:object, code:string, error:string}}
 */
export async function readAccountCookies(account, { log = () => {} } = {}) {
  const store = readShopAccountsStore();
  if (!store.ok) return { ok: false, backend: account.backend || '', mode: '', cookies: [], count: 0, coverage: null, code: 'store_unavailable', error: store.error };
  const backend = account.backend === 'ego' ? 'ego' : account.backend === 'chrome' ? 'chrome'
    : ((await egoSnapshot(store.config)).available ? 'ego' : 'chrome');
  const name = String((account && account.name) || (account && account.id) || '');
  try {
    const got = backend === 'ego' ? await readEgoCookies(account, store, log) : await readChromeCookies(account, store, log);
    const list = cookiesForPlaywright(got.cookies);
    const coverage = classifyCookieCoverage(got.cookies);
    if (!list.length) {
      return {
        ok: false, backend, mode: got.mode || '', cookies: [], count: 0, coverage, code: 'account_no_cookies',
        error: '账号「' + name + '」在浏览器里没有抖音域的 cookie：请先在 shop-accounts 里用这个账号打开 https://www.douyin.com 登录一次',
      };
    }
    if (coverage.douyinCount === 0) {
      const where = Object.entries(coverage.groups || {}).filter(([, n]) => n > 0).map(([k, n]) => k + '×' + n).join('、') || '无';
      return {
        ok: false, backend, mode: got.mode || '', cookies: [], count: 0, coverage, code: 'account_no_douyin_login',
        error: '账号「' + name + '」读到 ' + list.length + ' 个 cookie，但**没有 douyin.com（抖音网页）的登录态** —— 只有这些域：'
          + where + '（抖店后台 / 巨量）。采集抖音评论需要抖音网页登录：请在 shop-accounts 里用这个账号打开 https://www.douyin.com 登录'
          + '（或用「抖音买家」账号扫码登录），再回来重试',
      };
    }
    if (!coverage.hasDouyinLogin) {
      return {
        ok: false, backend, mode: got.mode || '', cookies: [], count: 0, coverage, code: 'account_no_douyin_session',
        error: '账号「' + name + '」有 douyin.com 的 cookie，但没看到 sessionid/sid_tt 这类登录 cookie（登录可能已过期）：'
          + '请在 shop-accounts 里用这个账号打开 https://www.douyin.com 重新登录一次',
      };
    }
    return { ok: true, backend, mode: got.mode || '', cookies: list, count: list.length, coverage, code: '', error: '' };
  } catch (e) {
    return { ok: false, backend, mode: '', cookies: [], count: 0, coverage: null, code: 'read_failed', error: String((e && e.message) || e) };
  }
}

/** 账号目录名（采集 profile 用，杜绝路径穿越） */
export function accountProfileName(account) {
  return String(account && account.id || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'unknown';
}
