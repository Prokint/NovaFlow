// collector.mjs — 采集核心的加密加载器（对外导出与旧版完全一致）
//
// 真实实现放在 src-core/collector.src.mjs；构建脚本 build-encrypted.mjs 把它压成
// core.enc（AES-256-GCM）。本文件只做四件事：
//   1) 读 core.enc，按 magic/版本/算法校验载荷头；
//   2) AES-256-GCM 认证解密（tag 校验 + 明文 sha256 校验），失败直接抛错，绝不放行；
//   3) 落到 <home>/runtime/<payload sha256 前 16 位>/collector.mjs（命中缓存不重复解密）；
//   4) 把扩展密钥放进 globalThis，再 import 解密后的模块并导出四个名字。
//
// 改了 src-core/ 或 extension/ 之后必须重建：node build-encrypted.mjs
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url));
const HOME = process.env.DOUYIN_HOME || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'douyin-collector');
const CORE_ENC = path.join(PLUGIN_DIR, 'core.enc');
const CORE_MAGIC = 'DYC-CORE-1';
const EXT_KEY_SYMBOL = Symbol.for('dsh.douyin-collector.ext-key.v1');

// ---------- 密钥材料 ----------
// 故意拆成多段、混用大小写、掺入无用常量，避免完整密钥以明文单串出现。
// 构建脚本 build-encrypted.mjs 里有同一份（必须逐字节一致；构建结束会对比派生结果，漂移会报错）。
const DECOY_SALT = '9f3a7c11';          // 未参与派生
const SEED_A = ['c1be', 'f04f'];
const SEED_B = { hi: '77FC', lo: 'f0f9', x: 'e586', y: '2c82' };
const SEED_C = ['df7d', 'b0e6', '1493', 'fe10'];
const SEED_D = { u: '46de', v: '6d4b', w: 'c873', z: '74D5', q: 'ede4', r: '623d' };
const DECOY_PARTS = ['0000', 'ffff'];  // 未参与派生

/** 拼回 64 位十六进制主串，再加域分隔后缀 */
function keyMaterial() {
  const parts = [
    ...SEED_A,
    SEED_B.hi, SEED_B.lo, SEED_B.x, SEED_B.y,
    ...SEED_C,
    SEED_D.u, SEED_D.v, SEED_D.w, SEED_D.z, SEED_D.q, SEED_D.r,
  ];
  return parts.join('').toLowerCase() + '|dyc.v1';
}

/** 每个域（core / ext）用自己的盐；salt 是确定性的，载荷里那份必须与之一致 */
function saltFor(domain) {
  return crypto.createHash('sha256').update('DYC-SALT|' + domain + '|v1').digest();
}

/** scrypt(sha256(material), salt(domain), 32) */
function deriveKey(domain) {
  const material = crypto.createHash('sha256').update(keyMaterial()).digest('hex');
  return crypto.scryptSync(material, saltFor(domain), 32, { N: 16384, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
}

// ---------- 解密 ----------
function hexBuf(v, what, len) {
  if (typeof v !== 'string' || !/^[0-9a-f]+$/i.test(v)) throw new Error('core.enc 的 ' + what + ' 不是十六进制');
  const b = Buffer.from(v, 'hex');
  if (len && b.length !== len) throw new Error('core.enc 的 ' + what + ' 长度不对（' + b.length + '，期望 ' + len + '）');
  return b;
}

function parsePayload(encBytes) {
  let p;
  try {
    p = JSON.parse(encBytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error('core.enc 不是合法 JSON（文件被截断/改坏？）：' + ((e && e.message) || e));
  }
  if (!p || p.magic !== CORE_MAGIC) throw new Error('core.enc magic 不匹配（期望 ' + CORE_MAGIC + '，收到 ' + (p && p.magic) + '）');
  if (Number(p.v) !== 1) throw new Error('core.enc 版本不支持：' + p.v);
  if (p.alg !== 'aes-256-gcm' || p.kdf !== 'scrypt') throw new Error('core.enc 算法/派生参数不支持：' + p.alg + '/' + p.kdf);
  if (typeof p.ct !== 'string' || typeof p.sha256 !== 'string') throw new Error('core.enc 缺 ct 或 sha256');
  return p;
}

/** 认证解密，返回明文字节与明文 sha256；任何校验失败都抛错 */
function decryptCore(encBytes) {
  const p = parsePayload(encBytes);
  const salt = hexBuf(p.salt, 'salt', 32);
  const iv = hexBuf(p.iv, 'iv', 12);
  const tag = hexBuf(p.tag, 'tag', 16);
  const ct = Buffer.from(p.ct, 'base64');
  // 盐由域派生，载荷里那份必须一致：不一致说明这份载荷不是本密钥体系生成的
  if (!salt.equals(saltFor('core'))) throw new Error('core.enc 的 salt 与密钥域不一致');
  const key = deriveKey('core');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([d.update(ct), d.final()]);
  } catch (e) {
    throw new Error('core.enc 认证失败：载荷被改过或密钥不匹配（' + ((e && e.message) || e) + '）');
  }
  const got = crypto.createHash('sha256').update(plain).digest('hex');
  if (got !== p.sha256) throw new Error('core.enc 明文完整性校验失败（sha256 不符）');
  if (Number(p.size) !== plain.length) throw new Error('core.enc 明文长度与声明不符（' + plain.length + ' vs ' + p.size + '）');
  return { plain, sha: got, payload: p };
}

function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}

/** 原子写：临时文件 + rename（Windows 上先删目标再 rename，避免 EPERM） */
function atomicWrite(target, buf) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), '.collector-' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.tmp');
  fs.writeFileSync(tmp, buf);
  try { fs.rmSync(target, { force: true }); } catch (e) { /* 目标正被别的进程加载：rename 会失败，下面会抛 */ }
  fs.renameSync(tmp, target);
}

// ---------- 主流程 ----------
let encBytes;
try {
  encBytes = fs.readFileSync(CORE_ENC);
} catch (e) {
  throw new Error('读不到 core.enc（' + CORE_ENC + '）：加密载荷缺失，请在插件目录跑 node build-encrypted.mjs 重建');
}
const head = parsePayload(encBytes);
const cacheId = crypto.createHash('sha256').update(encBytes).digest('hex').slice(0, 16);
const runtimeDir = path.join(HOME, 'runtime', cacheId);
const cachePath = path.join(runtimeDir, 'collector.mjs');

// 缓存命中：文件哈希必须等于载荷声明的明文哈希，否则重新解密（核心载荷换过就自动失效）
let cacheOk = false;
try {
  cacheOk = fs.statSync(cachePath).size === Number(head.size) && sha256File(cachePath) === head.sha256;
} catch (e) { cacheOk = false; }

if (!cacheOk) {
  const { plain } = decryptCore(encBytes);
  atomicWrite(cachePath, plain);
}

// 扩展解密密钥：只有这里派生，解密后的核心模块从 globalThis 取（见 src-core 里 extKeyBytes）
globalThis[EXT_KEY_SYMBOL] = deriveKey('ext');
// 核心模块在缓存目录里执行，插件根目录由这里注入
process.env.DSH_DOUYIN_COLLECTOR_ROOT = PLUGIN_DIR;

// 清掉旧版本的运行期缓存（只清 runtime/ 下 16 位十六进制目录，失败不影响启动）
try {
  for (const d of fs.readdirSync(path.join(HOME, 'runtime'))) {
    if (d === cacheId || !/^[0-9a-f]{16}$/.test(d)) continue;
    try { fs.rmSync(path.join(HOME, 'runtime', d), { recursive: true, force: true }); } catch (e) { /* 别的进程在用 */ }
  }
} catch (e) { /* runtime 目录不存在 */ }

const inner = await import(pathToFileURL(cachePath).href);
const { collectDouyinComments, DEFAULTS, resolveOutDir, sessionWorkspaceCwd } = inner;
for (const [name, v] of Object.entries({ collectDouyinComments, DEFAULTS, resolveOutDir, sessionWorkspaceCwd })) {
  if (v === undefined) throw new Error('core.enc 解出的模块缺少导出：' + name);
}

// 兼容既有调用方（verify-tool / sync 脚本 / 老代码）的具名导入：
// 这些名字在解密后的核心模块里都有，加载器原样透传（不改变 4 个主接口的语义）。
const {
  installExtension,
  findExtensionSource,
  loginGate,
  acquireRunLock,
  clearStaleScriptCaches,
  readLaunchState,
  writeLaunchState,
  extensionIdFromPath,
  extensionIdPathBytes,
  decryptExtensionBundle,
  videoIdFromUrl,
  cleanText,
  toCsv,
  csvLabelRow,
  CSV_COL_LABELS,
  SESSION_COOKIE_NAMES,
  runLogDir,
  failureRootDir,
  pruneDir,
  createRunLog,
  captureFailureSnapshot,
  hints,
  RUN_LOG_KEEP,
  WORKSPACE_OUT_SUBDIR,
} = inner;

export {
  collectDouyinComments,
  DEFAULTS,
  resolveOutDir,
  sessionWorkspaceCwd,
  installExtension,
  findExtensionSource,
  loginGate,
  acquireRunLock,
  clearStaleScriptCaches,
  readLaunchState,
  writeLaunchState,
  extensionIdFromPath,
  extensionIdPathBytes,
  decryptExtensionBundle,
  videoIdFromUrl,
  cleanText,
  toCsv,
  csvLabelRow,
  CSV_COL_LABELS,
  SESSION_COOKIE_NAMES,
  runLogDir,
  failureRootDir,
  pruneDir,
  createRunLog,
  captureFailureSnapshot,
  hints,
  RUN_LOG_KEEP,
  WORKSPACE_OUT_SUBDIR,
};
