// entitlement.mjs — NovaFlow 授权（激活码 / 到期 / 设备）客户端
//
// 插件本身不持有 Now API 令牌：所有请求都经 NovaFlow 主进程的本地 relay 转发，
// relay 负责附加用户令牌并转发到 collect.lanjiaotrade.com。
//
// 环境变量（NovaFlow 启动 DSH 宿主时注入）：
//   NOVAFLOW_RELAY_URL        http://127.0.0.1:<relay 端口>
//   NOVAFLOW_RELAY_CAPABILITY relay 鉴权能力串
//   NOVAFLOW_COLLECT_BASE     （可选）直连 collect 服务地址；仅开发调试用
// 两者都没有时 = 独立运行/开发模式，不启用授权（保持旧行为）。
import crypto from 'node:crypto';
import os from 'node:os';

export class EntitlementError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'EntitlementError';
    this.code = code;
  }
}

/** 是否处于 NovaFlow 收费模式 */
export function entitlementEnabled() {
  return !!(relayBase() || directBase());
}

function relayBase() {
  const u = String(process.env.NOVAFLOW_RELAY_URL || '').trim().replace(/\/+$/, '');
  return u ? u.replace(/\/novaflow\/collect$/, '') : '';
}
function directBase() {
  return String(process.env.NOVAFLOW_COLLECT_BASE || '').trim().replace(/\/+$/, '');
}
function capability() {
  return String(process.env.NOVAFLOW_RELAY_CAPABILITY || '').trim();
}

/** 稳定 machineId：主机名 + 平台 + 架构 + 用户目录的 hash（不收集隐私信息） */
export function machineId() {
  const seed = [os.hostname(), process.platform, process.arch, os.userInfo().username, os.homedir()].join('|');
  return 'mid_' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

/** 非加密随机 nonce（每次签发不同） */
export function nonce() {
  return crypto.randomBytes(24).toString('base64url');
}

function url(pathSuffix) {
  const base = directBase() || relayBase();
  if (!base) throw new EntitlementError('NOT_CONFIGURED', '未配置 NovaFlow relay（独立运行模式不启用授权）');
  // relay 路径带 /novaflow/collect 前缀；直连模式没有
  const prefix = directBase() ? '' : '/novaflow/collect';
  return base + prefix + pathSuffix;
}

async function call(method, pathSuffix, body) {
  const headers = { accept: 'application/json' };
  const cap = capability();
  if (cap) headers['x-novaflow-capability'] = cap;
  if (body) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(url(pathSuffix), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12_000),
    });
  } catch (e) {
    throw new EntitlementError('SERVICE_UNAVAILABLE', '授权服务不可用，请稍后重试');
  }
  let json = null;
  try { json = await res.json(); } catch (e) { /* 可能为空 */ }
  if (!res.ok || (json && json.ok === false)) {
    const code = (json && json.code) || 'UNKNOWN';
    const msg = (json && json.message) || CODE_TEXT[code] || ('授权服务返回 ' + res.status);
    throw new EntitlementError(code, msg);
  }
  return json;
}

export const CODE_TEXT = {
  TOKEN_INVALID: '登录已过期，请重新登录 NovaFlow',
  NOT_ACTIVATED: '尚未激活采集服务：请在「抖音采集」面板里输入激活码',
  EXPIRED: '采集订阅已到期，请在「抖音采集」面板续费',
  DEVICE_LIMIT: '设备数量已达上限（2 台），请在面板解绑旧设备',
  CODE_INVALID: '激活码无效，请检查后重试',
  CODE_BOUND_OTHER: '这个激活码已经绑定到其他账号，不能转移',
  CODE_REVOKED: '这个激活码已被吊销',
  VERSION_RETIRED: '插件版本过旧，请升级 NovaFlow 后重试',
  RATE_LIMITED: '请求过于频繁，请稍后重试',
  NONCE_REPLAY: '请求重放被拒绝，请重试',
  SERVICE_UNAVAILABLE: '授权服务不可用，请稍后重试',
};

export function textOf(code) {
  return CODE_TEXT[code] || String(code || '未知错误');
}

/** 查询授权状态 */
export async function status() {
  return call('GET', '/v1/status');
}

/** 用激活码激活（绑定当前 Now API 账号 + 当前设备） */
export async function activate(code) {
  return call('POST', '/v1/activate', { code, machineId: machineId() });
}

export async function removeDevice(deviceId) {
  return call('POST', '/v1/devices/remove', { machineId: deviceId });
}

let cachedMaterial = null; // { material, materialVersion, lease, expiresAt, at }

/**
 * 每次采集前换运行凭据：material（内存）+ lease（短期）。
 * 5 分钟内复用，不落盘（除非调用方要求 flushCache）。
 */
export async function issueKey({ version = PLUGIN_VERSION, force = false } = {}) {
  if (!entitlementEnabled()) return null;
  const now = Date.now();
  if (!force && cachedMaterial && cachedMaterial.expiresAt - 30_000 > now) return cachedMaterial;
  const res = await call('POST', '/v1/keys/issue', {
    machineId: machineId(),
    version,
    nonce: nonce(),
  });
  cachedMaterial = { ...res, at: now };
  return cachedMaterial;
}

export function flushKeyCache() { cachedMaterial = null; }
export function peekKeyCache() { return cachedMaterial; }

export const PLUGIN_VERSION = '0.9.22';
