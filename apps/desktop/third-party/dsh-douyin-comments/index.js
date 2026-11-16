// dsh-douyin-comments —— DSH（Cordis）工具插件：抖音公开评论采集
//
// 只做一件事：把「采一个抖音视频的公开评论并导出 CSV/JSON」注册成 agent 可直接调用的
// 工具 `douyin_comments`。实现见 ./collector.mjs：
//   · 插件自带 Chrome 扩展副本（extension/），运行时自动装进浏览器（--load-extension）；
//   · 驱动扩展拿页面真实签名、分页重放、落库，再把结果写成 CSV/JSON；
//   · 只交付「本次新采」的数据，拿不到签名/没新数据就明确失败。
//
// 安装：dsh plugin --profile web add file:D:\dycopy\dsh-douyin-comments
//       （package.json 的 dsh.bundle.patch 让它成为 profile 的一个 bundle 层；装「新」插件
//        由宿主 HMR 即时挂载、不用重启；只有覆盖安装同名包换版本时才要重启 dsh 加载新代码）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectDouyinComments, collectDouyinKeyword, collectDouyinLinks, resolveDouyinVideoInputs, DEFAULTS, describeSearchOptions, normalizeSearchOptions, resolveOutDir, sessionWorkspaceCwd, fetchDouyinSelfProfile, readAccountProfiles, accountProfilePath, accountTypeFromUser, sendDouyinDmBatch } from './collector.mjs';
import { EntitlementError, activate, entitlementEnabled, issueKey, machineId, status as entitlementStatus, textOf } from './entitlement.mjs';
import { CONSOLE_PREFIX, createConsole, rememberOutDir } from './console.mjs';
import { VIEWER_PREFIX, createViewerHandler } from './viewer.mjs';
import { resolveShopAccount } from './shop-accounts-bridge.mjs';
import {
  outreachGuide, outreachList, outreachPick, outreachDraft, outreachRecord, outreachQuota, outreachPrecheck, OUTREACH_QUOTAS,
} from './outreach.mjs';

/** Loader 稳定标识（同时也是 cordis.patch.yml 里 id 的来源）。 */
export const name = 'dsh-douyin-comments';

/** 必需服务：tools 提供 ctx.tools。 */
export const inject = ['tools'];

/**
 * 取 `defineTool`：它不是恒等函数（要把 DSH 自有 schema DSL 编译成 JSON Schema 并建校验器），
 * 所以必须拿到宿主那一份。
 * 1) 裸说明符——插件被拷进 profile（file: 安装）时可用；
 * 2) 退回 profile 的「拦截层」`<DSH_HOME>/profiles/node_modules`；
 * 3) 再退回 dsh 安装目录自带的副本（从 process.argv[1] 推出来，换机器也成立）。
 */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (typeof mod.defineTool === 'function') return mod.defineTool;
  } catch { /* 继续试下面的绝对路径 */ }

  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const candidates = [
    path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
  ];
  if (process.argv[1]) {
    const dshRoot = path.resolve(path.dirname(process.argv[1]), '..');
    candidates.push(path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'));
  }
  // 开发机兜底：便携 node 的全局目录（用 DTS_NODE_GLOBAL 指明，如 D:\node-v22.23.1\node_global；不设就跳过）
  if (process.env.DTS_NODE_GLOBAL) {
    candidates.push(path.join(process.env.DTS_NODE_GLOBAL, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'));
  }

  const tried = [];
  for (const file of candidates) {
    tried.push(file);
    try {
      if (!fs.existsSync(file)) continue;
      const mod = await import(pathToFileURL(file).href);
      if (typeof mod.defineTool === 'function') return mod.defineTool;
    } catch { /* 继续 */ }
  }
  throw new Error('dsh-douyin-comments: 找不到 @deepseek-ai/dsh-tools 的 defineTool（试过：' + tried.join('、') + '）');
}

const defineTool = await loadDefineTool();

/**
 * 取 `Schema`（schemastery）：和 defineTool 同理，必须拿宿主那一份。
 * 顺序：1) profile 的「拦截层」`<DSH_HOME>/profiles/node_modules`；2) dsh 安装目录自带副本；
 *       3) 开发机全局 dsh 副本（DTS_NODE_GLOBAL）；4) 最后才试裸说明符。
 * 为什么裸说明符放最后：全新 profile 里 pnpm 会把 **旧版** `@deepseek-ai/schemastery`
 * （实测 3.18.2）装进插件自己的 node_modules，那份没有 `Schema.prototype.volatile`（3.18.3+ 才有）
 * —— 裸说明符会命中它，Config 里的链式 `.volatile()` 直接抛
 * `TypeError: ... .volatile is not a function`，整个插件 import 失败
 * （dsh 只打印「1 entry did not activate / failed to import」，工具就没了）。
 */
async function loadSchema() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const candidates = [
    path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'),
  ];
  if (process.argv[1]) {
    const dshRoot = path.resolve(path.dirname(process.argv[1]), '..');
    candidates.push(path.join(dshRoot, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'));
  }
  if (process.env.DTS_NODE_GLOBAL) {
    candidates.push(path.join(process.env.DTS_NODE_GLOBAL, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'));
  }

  const usable = (mod) => {
    const S = mod && (mod.default || mod);
    return (typeof S === 'function' && typeof S.object === 'function' && typeof S.number === 'function') ? S : undefined;
  };

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const S = usable(await import(pathToFileURL(file).href));
      if (S) return S;
    } catch { /* 继续 */ }
  }

  try {
    const S = usable(await import('@deepseek-ai/schemastery'));
    if (S) return S;
  } catch { /* 没有就退回没有表单 */ }
  return undefined;
}

const Schema = await loadSchema();

/**
 * `.volatile()` 是 3.18.3+ 才有的链式方法。拿不到就原样返回 —— 降级后果只是
 * 「DSH 设置表单里这几个字段不能改（不是 volatile）」，插件本身照常加载；
 * 绝不能因为一个可选的链式方法让整个插件 import 失败。
 */
function vol(schema) {
  try {
    if (schema && typeof schema.volatile === 'function') return schema.volatile();
  } catch { /* 有 volatile 但抛错也退回原样 */ }
  return schema;
}

/**
 * 导出给自检用：verify-tool.mjs 要复刻 dsh-settings 的 `new Schema(schema.toJSON())`
 * （见 dsh-settings/lib/index.js:103-104 plainSchema）。schema 实例身上拿不回这个类
 * ——`Object.getPrototypeOf(schema).constructor` 是 Function，所以只能由这里给出。
 */
export { Schema };

/**
 * 插件设置：声明成 cordis 的 Config 后，DSH 的「设置 → 插件 → dsh-douyin-comments」
 * 会自动生成这张表单（dsh-settings 的 schema(entry) 取 fiber.runtime.Config，要求能 toJSON）。
 * 八个字段都经 vol() 标了 volatile：DSH 只允许表单改 volatile 字段，好处是改完**立即生效**——
 * execute() 里每次都现读一遍，不用重启 dsh、也不用重装插件。（旧版 schemastery 没有 .volatile()
 * 时 vol() 原样返回，插件照常加载，只是这几个字段在表单里不能改。）
 * 加载不到 schemastery 时不导出 Config（cordis 会跳过校验），插件照常工作，只是没有表单。
 */
export const Config = Schema ? Schema.object({
  max: vol(Schema.number()
    .description('一级评论的目标条数：到量就停止顶层扫描、继续补二级回复（默认 80000 = 扩展单视频评论池的防御上限）。0.5.11 起真正生效（下发给扩展 maxCount）')
    .default(80000).min(1).max(1000000).step(1)),
  // 0.5.13 起顶层列表**错峰多路**：每路错开 200ms，实测比单路快 2.04× 且数量一样。
  // 同一瞬间发多路才会被服务端并成同一页（0.5.10 因此固定过单路）；扩展发现同页会自动降回单路。
  lanes: vol(Schema.number()
    .description('顶层列表路数：错峰多路推进（默认 3，每路错开 200ms）；1 = 单路。0.5.13 起真正生效——2026-10-07 实测扫完 21 页单路 15.8s vs 错峰 7.7s，唯一条数一样多')
    .default(3).min(1).max(8).step(1)),
  timeoutMs: vol(Schema.number()
    .description('单次采集总超时毫秒（默认 1800000 = 30 分钟）；到点也会把已采到的评论落盘。关键词模式下它是「单条视频」的超时，整个任务用 keywordTimeoutMs')
    .default(1800000).min(60000).max(14400000).step(1000)),
  keywordVideoCount: vol(Schema.number()
    .description('v0.9.0 关键词搜索模式：默认取前多少条视频（默认 10；工具参数 videoCount 优先）。每条视频的评论默认全采（不设单视频上限）')
    .default(10).min(1).max(100).step(1)),
  keywordTimeoutMs: vol(Schema.number()
    .description('v0.9.0 关键词模式的整体时间预算毫秒（默认 14400000 = 4 小时）；预算用尽就停止采剩下的视频并把已采的落盘。单条视频仍用 timeoutMs')
    .default(14400000).min(120000).max(86400000).step(1000)),
  waitLoginSec: vol(Schema.number()
    .description('检测到未登录时，等你在浏览器窗口里扫码的秒数（默认 180；0 = 不等，直接返回 need-login 并把窗口留着）')
    .default(180).min(0).max(1800).step(1)),
  // v0.9.1：撞到人机验证（风控）时不再立刻失败，而是在浏览器窗口里等你过验证，通过了自动接着采。
  verifyWaitSec: vol(Schema.number()
    .description('撞到人机验证（验证码/安全验证）时，采集器暂停并在浏览器窗口里等你手动过验证的秒数（默认 900 = 15 分钟；每 2.5 秒轮询一次，通过后自动点「开始采集」接着采；0 = 不等，直接收工并把窗口留着）')
    .default(900).min(0).max(7200).step(1)),
  clearBefore: vol(Schema.boolean()
    .description('采集前是否清空扩展缓存（默认 false）。清空会重置去重表和游标、毁掉「断点续采」进度，所以默认不清；不清空时靠 cid 差集保证只交付本轮新采')
    .default(false)),
  replyLanes: vol(Schema.number()
    .description('二级回复阶段的并发线程数 1~8（默认 4）。回复接口比列表接口更容易被限流，撞限流扩展会自动降 1 路并把全局限速翻倍')
    .default(4).min(1).max(8).step(1)),
  replyGlobalGapMs: vol(Schema.number()
    .description('回复请求「跨线程」的全局最小间隔毫秒（默认 0 = 用扩展内置的 250ms ≈ ≤4 次/秒）。实测 4 路各自零间隔发（≈20 次/秒）会撞成片拒绝，0.5.11 起按这个间隔全局限速；0 = 不指定')
    .default(0).min(0).max(2000).step(50)),
  replyThrottleSec: vol(Schema.number()
    .description('二级回复被服务端拒（HTTP 200 + 0 字节 body）时，本轮**总共**最多等多少秒（默认 120）。v0.5.12 起扩展分波重试：单波最多 12 秒，波间停 15/30/60 秒再打一波，总等待封顶在这个值 ⇒ 实测「等十几秒窗口就开了」的情况不用再靠手动点第二次；设 10 = 老行为「十秒不行就收尾」')
    .default(120).min(10).max(600).step(1)),
  replyNoProgressSec: vol(Schema.number()
    .description('二级回复阶段多久没有新数据就收工（秒，默认 900 = 15 分钟）。退避重试期间条数本来就长时间不动，太小会导致回复采不到就收工')
    .default(900).min(60).max(7200).step(10)),
  // 0.5.18：把「进二级回复补采前的静默预热」暴露出来。以前扩展里写死 30 秒、面板和插件都改不了，
  // 用户看到的就是「顶层采完 → 卡着等半分钟」。默认降到 10 秒；0 = 不预热（直接开打，可能撞风控）。
  replyWarmupSec: vol(Schema.number()
    .description('顶层评论采完后、开始补二级回复前先静默几秒（默认 10，0 = 不预热）。刚扫完列表就打回复接口容易被成片拒绝/空 body，停一下能减少失败；嫌切换慢就调小。面板「回复预热 s」优先级更高')
    .default(10).min(0).max(600).step(1)),
  // 0.5.14：失败/没采完时自动留现场。以前只有一行「60s 没动静」，事后完全看不出当时页面停在哪、
  // 扩展报了什么；现在每次运行都写日志，失败时另存截图 + 页面 HTML + 状态 JSON。
  failSnapshot: vol(Schema.boolean()
    .description('采集失败或没采完（超时/无进展/被取消）时，自动存一份现场：截图 + 页面 HTML + 状态 JSON + 日志副本，默认开')
    .default(true)),
  keepSnapshots: vol(Schema.number()
    .description('失败现场最多保留几份（默认 20，更旧的自动删掉），避免磁盘越攒越多')
    .default(20).min(1).max(500).step(1)),
}).default({}) : undefined;

/** 原始 config（保留 volatile 引用本身，而不是快照值）。 */
const RAW_CONFIG = { value: {} };

/** schemastery 的 volatile 字段被包成「只有 get、没有 set」的只读引用，写入后必须现读 get()。 */
function isVolatileRef(v) {
  return !!v && typeof v.get === 'function' && Symbol.for('cosmokit.volatile.write') in v;
}

function readCfg(cfg, key, fallback) {
  const raw = cfg ? cfg[key] : undefined;
  const v = isVolatileRef(raw) ? raw.get() : raw;
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readCfgBool(cfg, key, fallback) {
  const raw = cfg ? cfg[key] : undefined;
  const v = isVolatileRef(raw) ? raw.get() : raw;
  if (v === undefined || v === null || v === '') return fallback;
  return v === true || v === 'true' || v === 1 || v === '1';
}

/** 现读一遍插件设置（工具参数没给的部分用它兜底）。 */
export function readSettings(config) {
  const cfg = (config && typeof config === 'object') ? config : (RAW_CONFIG.value || {});
  return {
    max: readCfg(cfg, 'max', Number(DEFAULTS.max) > 0 ? Number(DEFAULTS.max) : 80000),
    lanes: Math.max(1, Math.min(8, Math.round(readCfg(cfg, 'lanes', Number(DEFAULTS.lanes) > 0 ? Number(DEFAULTS.lanes) : 3)))),
    timeoutMs: readCfg(cfg, 'timeoutMs', Number(DEFAULTS.timeoutMs) > 0 ? Number(DEFAULTS.timeoutMs) : 1800000),
    // v0.9.0：关键词搜索模式的两个独立预算（视频条数 + 整个任务时长）
    keywordVideoCount: Math.max(1, Math.min(100, Math.round(readCfg(cfg, 'keywordVideoCount', Number(DEFAULTS.keywordVideoCount) > 0 ? Number(DEFAULTS.keywordVideoCount) : 10)))),
    keywordTimeoutMs: Math.max(120000, Math.round(readCfg(cfg, 'keywordTimeoutMs', Number(DEFAULTS.keywordTimeoutMs) > 0 ? Number(DEFAULTS.keywordTimeoutMs) : 14400000))),
    waitLoginSec: Math.max(0, Math.round(readCfg(cfg, 'waitLoginSec', Number.isFinite(Number(DEFAULTS.waitLoginSec)) ? Number(DEFAULTS.waitLoginSec) : 180))),
    // v0.9.1：撞人机验证时等你手动过验证的秒数（0 = 不等）
    verifyWaitSec: Math.max(0, Math.min(7200, Math.round(readCfg(cfg, 'verifyWaitSec', Number.isFinite(Number(DEFAULTS.verifyWaitSec)) ? Number(DEFAULTS.verifyWaitSec) : 900)))),
    clearBefore: readCfgBool(cfg, 'clearBefore', !!DEFAULTS.clearBefore),
    replyLanes: Math.max(1, Math.min(8, Math.round(readCfg(cfg, 'replyLanes', Number(DEFAULTS.replyLanes) > 0 ? Number(DEFAULTS.replyLanes) : 4)))),
    // v0.5.11：回复请求全局限速（0 = 用扩展内置的 250ms）
    replyGlobalGapMs: Math.max(0, Math.min(2000, Math.round(readCfg(cfg, 'replyGlobalGapMs', Number(DEFAULTS.replyGlobalGapMs) > 0 ? Number(DEFAULTS.replyGlobalGapMs) : 0)))),
    replyThrottleSec: Math.max(10, Math.round(readCfg(cfg, 'replyThrottleSec', Number(DEFAULTS.replyThrottleSec) > 0 ? Number(DEFAULTS.replyThrottleSec) : 120))),
    replyNoProgressSec: Math.max(60, Math.round(readCfg(cfg, 'replyNoProgressSec', Number(DEFAULTS.replyNoProgressSec) > 0 ? Number(DEFAULTS.replyNoProgressSec) : 900))),
    // v0.5.18：回复预热（0 = 不预热，允许显式 0）
    replyWarmupSec: Math.max(0, Math.min(600, Math.round(readCfg(cfg, 'replyWarmupSec', Number.isFinite(Number(DEFAULTS.replyWarmupSec)) ? Number(DEFAULTS.replyWarmupSec) : 10)))),
    // v0.5.14：运行日志 + 失败现场快照
    failSnapshot: readCfgBool(cfg, 'failSnapshot', DEFAULTS.failSnapshot !== false),
    keepSnapshots: Math.max(1, Math.round(readCfg(cfg, 'keepSnapshots', Number(DEFAULTS.keepSnapshots) > 0 ? Number(DEFAULTS.keepSnapshots) : 20) || 20)),
  };
}

/** 把 config 里的路径类覆盖写进采集默认值（collector 每次调用时才读 DEFAULTS）。 */
function applyConfig(config) {
  RAW_CONFIG.value = (config && typeof config === 'object') ? config : {};
  const cfg = RAW_CONFIG.value;
  if (cfg.extDir) DEFAULTS.extDir = String(cfg.extDir);
  if (cfg.cookies) DEFAULTS.cookies = String(cfg.cookies);
  if (cfg.outDir) DEFAULTS.outDir = String(cfg.outDir);
  if (cfg.chromeProfile) DEFAULTS.profile = String(cfg.chromeProfile);
  if (cfg.chrome) DEFAULTS.chrome = String(cfg.chrome);
  if (cfg.home) DEFAULTS.home = String(cfg.home);
  if (cfg.cdpPort) DEFAULTS.port = Number(cfg.cdpPort);
}

export function apply(ctx, config = {}) {
  applyConfig(config);

  const dispose = ctx.tools.register(defineTool({
    name: 'douyin_comments',
    description: [
      '【v0.9.40 使用流程 —— 先问清楚，再调用】NovaFlow 付费版客户端**没有「新建采集」页面**，采集只能由 AI 通过本工具触发。所以每次采集前，你必须先按下面的顺序把信息问清楚，并把整理结果回给用户确认，**不要替用户默认/编造参数**：',
      '第 0 步 · 先确认账号：①调用 `douyin_account_info`（action=status）读本机已识别账号；②如果需要别的账号，先调用店铺账号管理插件 `shop_accounts`（action=list，platform=douyin）列出抖音账号，只能选 **买家账户**（seller/「抖店」这类卖家账户不可用于采集），把返回的账号 id 或名字填进本工具的 `account` 参数；③没激活订阅时先 `douyin_entitlement` action=status/activate。',
      '第 1 步 · 确认采集方式：问用户是「指定视频/图文链接（url，可多条，直接粘分享文案或短链也行）」还是「关键词搜视频再采评论（keyword）」。',
      '第 2 步 · 关键词模式必须逐项问清楚：关键词 keyword 是什么；要采多少个视频 videoCount（1~100，默认 10）；排序 sortType（综合排序 / 最新发布 / 最多点赞）；发布时间 publishTime（不限 / 一天内 / 一周内 / 半年内）；视频时长 duration（不限 / 1分钟以下 / 1-5分钟 / 5分钟以上）；内容形式 contentType（不限 / 视频 / 图文）。这 6 项都要问，不确定的要说明默认值再让用户确认。',
      '第 3 步 · 补充确认（非必须但建议问）：是否要采二级回复 replies（默认 true）；目标一级评论条数 max（默认 80000）；是否清空旧缓存 clearBefore（默认 false，清空会丢断点续采）；输出目录 outDir（默认会话工作区 douyin-comments/）；要不要顺手导交互词云 cloud（默认 false）。',
      '第 4 步 · 把「账号 + 链接或关键词 + 上述参数」整理成一句话复述给用户，用户确认后再调用本工具；调用后把返回的 csvPath/jsonPath/videoListPath 与条数告诉用户。',
      '采集抖音公开评论，导出 CSV（UTF-8 BOM，Excel 直接打开）和 JSON，返回文件路径与条数。两种用法：①给 url 采一条视频/图文的评论；②给 keyword 按关键词搜索视频，再采前 videoCount 条（默认 10，每条视频的评论全采）的评论，合并成一份 CSV/JSON + 一份视频清单。',
      '关键词模式可带筛选（都可选，默认不限）：sortType=综合排序/最新发布/最多点赞；publishTime=不限/一天内/一周内/半年内；duration=不限/1分钟以下/1-5分钟/5分钟以上；contentType=不限/视频/图文。网页版没有「内容形式」这个原生筛选项：视频走视频搜索接口，图文走综合搜索并只保留图文帖（aweme_type=68），不限=视频接口。搜索做法是打开搜索页、拿页面自己发出的带签名请求在页面内重放（只改 offset/翻页数与筛选参数、并置 is_filter_search=1），不点筛选浮层、不改扩展、不计算签名。整个关键词任务的时间预算是 keywordTimeoutMs（默认 4 小时），单条视频仍用 timeoutMs（默认 30 分钟）。',
      'CSV/JSON **默认写到当前会话的工作区**（<工作区>/douyin-comments/），调用方直接用返回值里的 csvPath/jsonPath 就能引用；要换位置用 outDir。',
      '自带 Chrome 扩展（抖音评论采集器）：第一次调用时会自动把扩展装进它启动的浏览器，无需手动安装。',
      '走本机 Chromium（有头窗口）+ 页面真实签名分页重放，约 10~60 秒；只读公开评论，不发帖/不点赞/不关注。',
      '浏览器用持久化 profile（默认 ~/.dsh/douyin-collector/chrome-profile）保存抖音登录态。',
      '没登录时**不会开始采集**：会在浏览器窗口里留出登录二维码，等使用者扫码（默认最多等 180 秒，可用 waitLoginSec 调整）。',
      'v0.9.1 起撞到**人机验证**（验证码/安全验证，服务端风控 VERIFY_REQUIRED）也不立刻失败：扩展停下后采集器每 2.5 秒轮询一次，在浏览器窗口里等你手动过验证（默认最多等 900 秒，可用 verifyWaitSec 调整；0 = 不等）；验证通过后自动点「开始采集」接着采，这一条采完继续下一条。等到超时就会收工（返回 phase=paused、endedBy=verify-wait），窗口保持打开，过完验证再调用一次可断点续采。',
      '若返回 phase=need-login，说明等不到登录：把返回的 error 原样转达给使用者，让他在那个（已保持打开的）浏览器窗口里用抖音 App 扫码，扫完再调用一次；不要重复空转，也不要另开窗口。',
      '只交付本次新采的数据：默认不清空扩展缓存（清空会毁掉断点续采进度），结束时按 cid 差集剔除旧数据；一条新数据都没有就返回失败并说明原因。要强制清空就把 clearBefore 设为 true。',
      'max 是「一级评论」的目标值：到量就**停止顶层扫描、继续把二级回复补完**再收工（0.5.11 起真正生效：下发给扩展 maxCount，旧版既不封一级、又会在回复阶段点暂停）。实际条数通常多于 max，返回值 count 是真实条数。',
      '插件设置（DSH「设置 → 插件 → dsh-douyin-comments」）里可以改目标条数 max（默认 80000）、顶层列表路数 lanes（默认 3，错峰多路；1 = 单路）、总超时 timeoutMs、等扫码秒数 waitLoginSec、是否先清空 clearBefore、二级回复的并发 replyLanes、回复请求全局限速 replyGlobalGapMs（0 = 用扩展内置 250ms）、限流等待 replyThrottleSec、回复阶段无进展收工 replyNoProgressSec、失败现场快照 failSnapshot（默认开）与保留份数 keepSnapshots（默认 20），改完立即生效；本次调用的工具参数只覆盖当次，不改设置。顶层列表 0.5.13 起改回**错峰多路**（每路错开 200ms）：2026-10-07 实测扫完 21 页单路 15.8s vs 错峰 7.7s、唯一条数一样多；同一瞬间发多路才会被服务端并成同一页，扩展发现后会自动降回单路并在面板说明。',
      '每次调用都会写一份运行日志（~/.dsh/douyin-collector/logs/），返回值里的 logPath 指向它；失败或没采完（超时/无进展/被取消）时还会自动存失败现场（截图 + 页面 HTML + 状态 JSON + 日志副本）到 ~/.dsh/douyin-collector/failures/，路径在 snapshotDir 与 error 里。用户反馈「采不到/卡住」时，先让他把 logPath 或 snapshotDir 里的 status.json 发来。',
    ].join(' '),
    parameters: {
      url: {
        type: 'string',
        description: 'v0.9.16：抖音作品链接，也可以直接粘整段分享文案/短链；**多条链接用逗号或空格（换行也行）隔开**时逐条采集、合并导出成一份 CSV/JSON（videoCount 会返回实际条数）。与 keyword 至少填一个；同时填时 keyword 优先（走关键词搜索模式）。',
      },
      keyword: {
        type: 'string',
        description: 'v0.9.0：搜索关键词。填了就走「关键词搜索视频 → 采前 videoCount 条视频的评论」模式，url 不用填。',
      },
      videoCount: {
        type: 'integer',
        description: 'v0.9.0 关键词模式：取前多少条视频（默认用插件设置 keywordVideoCount，出厂 10；1~100）。每条视频的评论默认全部采。',
      },
      sortType: {
        type: 'string',
        description: 'v0.9.0 关键词模式：排序依据。可传 综合排序/最新发布/最多点赞（也接受接口值 0/2/1），默认综合排序。',
      },
      publishTime: {
        type: 'string',
        description: 'v0.9.0 关键词模式：发布时间。可传 不限/一天内/一周内/半年内（也接受接口值 0/1/7/180），默认不限。',
      },
      duration: {
        type: 'string',
        description: 'v0.9.0 关键词模式：视频时长。可传 不限/1分钟以下/1-5分钟/5分钟以上（也接受接口值 ""/"0-1"/"1-5"/"5-10000"），默认不限。图文模式忽略此项。',
      },
      contentType: {
        type: 'string',
        description: 'v0.9.0 关键词模式：内容形式。可传 不限/视频/图文，默认不限（=视频搜索接口）。选图文会走综合搜索并只保留图文帖。',
      },
      account: {
        type: 'string',
        description: 'v0.8.0：用 shop-accounts 插件里某个已登录的抖音账号来采集（传账号 id 或名字，大小写/片段都行；不传 = 用本插件自己 profile 的登录态）。会读出该账号浏览器（Chrome 或 ego 后端）里的 cookie 注入采集浏览器；账号不存在时直接报错并列出可用账号。',
      },
      max: { type: 'integer', description: '本次「一级评论」目标条数：到量就停止顶层扫描、继续把二级回复补完（不传 = 用插件设置里的值，出厂默认 80000）；实际条数通常多于它。' },
      lanes: { type: 'integer', description: '顶层列表路数（默认 3，错峰多路；1 = 单路）。0.5.13 起真正生效：每路错开 200ms 出发，扩展若发现两路拿到同一页会自动降回单路。' },
      replies: { type: 'boolean', description: '是否等二级回复补采（默认 true；false 时只采一级评论，更快）。' },
      clearBefore: { type: 'boolean', description: '本次是否先清空扩展里该视频的旧数据（默认 false = 不清空，保留断点续采，结束时按 cid 差集只交付新采的）。' },
      timeoutMs: { type: 'integer', description: '本次总超时毫秒（不传 = 用插件设置里的值，出厂默认 1800000 = 30 分钟），到点也会把已采到的评论落盘。' },
      waitLoginSec: { type: 'integer', description: '检测到未登录时，等使用者在浏览器窗口里扫码登录的秒数（不传 = 用插件设置里的值，出厂默认 180；显式传 0 = 不等，直接返回 need-login 并把窗口留着）。' },
      verifyWaitSec: { type: 'integer', description: 'v0.9.1：撞到人机验证（验证码/安全验证）时，采集器暂停并在浏览器窗口里等你手动过验证的秒数（不传 = 用插件设置里的值，出厂默认 900 = 15 分钟；期间每 2.5 秒轮询，通过后自动继续采集；0 = 不等，直接收工并把窗口留着）。' },
      outDir: { type: 'string', description: '输出目录（默认：当前会话工作区下的 douyin-comments/ 子目录；取不到工作区时退回 ~/.dsh/douyin-collector/out）。' },
      keepOpen: { type: 'boolean', description: '调试用：采完不关浏览器窗口（默认 false）。' },
      failSnapshot: { type: 'boolean', description: '本次失败/没采完时是否存现场快照（截图 + 页面 HTML + 状态 JSON + 日志副本，默认用插件设置 true）；日志文件每次运行都会写。' },
      cloud: { type: 'boolean', description: '顺手再导一份**交互词云 HTML**（自包含：词云页 html/css/js 全内联，双击即可打开、可发给别人、数据不出本机）。默认 false；导出的路径见 htmlPath。需要扩展 v0.5.30+（v0.5.38 起插件这边也能唤起）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string', required: true, description: '失败原因（成功时为空串）' },
          videoId: { type: 'string', required: true, description: '实际采集的视频 id' },
          title: { type: 'string', required: true, description: '视频标题（拿不到时为空串）' },
          count: { type: 'integer', required: true, description: '本次新采的真实条数' },
          csvPath: { type: 'string', required: true },
          jsonPath: { type: 'string', required: true },
          htmlPath: { type: 'string', required: true, description: '交互词云 HTML 路径（v0.5.38 起；没勾 cloud 或导出失败时为空串）' },
          phase: { type: 'string', required: true, description: '收工时的扩展状态' },
          endedBy: { type: 'string', required: true, description: 'v0.9.1：收工原因（done/max-cap/top-done/stall/timeout/abort/verify-wait；verify-wait = 等人机验证超时，窗口留给你过验证后重跑可断点续采）' },
          lanes: { type: 'integer', required: true, description: '顶层列表实际用的路数（扩展写回的 dts_settings_effective；v0.5.13 起 = 设置值或检测到同页后自降的 1，读不到时为本次请求值）' },
          note: { type: 'string', required: true, description: '扩展面板的说明文字' },
          durationSec: { type: 'number', required: true },
          extensionVersion: { type: 'string', required: true, description: '安装进浏览器的扩展版本' },
          extensionInstalled: { type: 'boolean', required: true, description: '本次是否重新安装了扩展' },
          account: { type: 'string', required: true, description: 'v0.8.0：本次使用的 shop-accounts 账号名（没用账号时为空串）' },
          sample: { type: 'array', required: true, items: { type: 'string' }, description: '前 5 条预览' },
          logPath: { type: 'string', required: true, description: '本次运行日志文件路径（每次调用都写，含全过程与收工原因；排查时先看它）' },
          snapshotDir: { type: 'string', required: true, description: '失败现场目录（截图/页面 HTML/状态 JSON/日志副本）；成功且采完时为空串' },
          keyword: { type: 'string', required: true, description: 'v0.9.0：关键词模式实际用的关键词（单视频模式为空串）' },
          videoCount: { type: 'integer', required: true, description: 'v0.9.0：关键词模式实际采了多少条视频（单视频模式为 1）' },
          videoListPath: { type: 'string', required: true, description: 'v0.9.0：关键词模式的视频清单 CSV（一行一个视频，含采集状态/条数/分片文件；单视频模式为空串）' },
          videos: { type: 'array', required: true, items: { type: 'string' }, description: 'v0.9.0：关键词模式的视频摘要（每条形如「✓ [1] <id> <标题>（N 条）」；单视频模式为空数组）' },
        },
      },
      render(_args, value) {
        // v0.9.0：关键词搜索模式的结果文案（与单视频模式分开写，字段含义不同）
        if (value && value.keyword) {
          const kwErr = String(value.error || '');
          const kwTail = [];
          if (value.logPath && !kwErr.includes(value.logPath)) kwTail.push(`运行日志：${value.logPath}`);
          const kwSuffix = kwTail.length ? '\n' + kwTail.join('\n') : '';
          if (value.ok === false && value.phase === 'need-login') {
            return [{
              type: 'text',
              text: '搜索需要先登录抖音（关键词搜索对未登录用户是登录墙）：\n' + kwErr
                + '\n→ 让使用者在已经打开的浏览器窗口里用抖音 App 扫码；扫完再调用一次 douyin_comments（带上同样的 keyword）就会接着搜。',
            }];
          }
          if (!value.ok) {
            return [{ type: 'text', text: `关键词采集未成功：${kwErr}${kwSuffix}` }];
          }
          const kwLines = [
            `关键词「${value.keyword}」：采了 ${value.videoCount} 条视频，共 ${value.count} 条公开评论，用时 ${value.durationSec}s`,
            `合并 CSV（每行 = 视频信息 + 一条评论）：${value.csvPath}`,
            `合并 JSON：${value.jsonPath}`,
            `视频清单（一行一个视频，含采集状态）：${value.videoListPath}`,
          ];
          if (value.note) kwLines.push(`注意：${value.note}`);
          if (value.endedBy === 'verify-wait') {
            kwLines.push('⚠️ 撞到人机验证且等待超时：先停在这里。浏览器窗口还开着 —— 让使用者在窗口里完成页面上的验证，然后重新调用一次 douyin_comments（带同样的 keyword），会从断点接着采。');
          }
          if (kwTail.length) kwLines.push(kwTail.join('\n'));
          if (Array.isArray(value.videos) && value.videos.length > 0) {
            kwLines.push('视频：');
            value.videos.forEach((s) => kwLines.push('  ' + s));
          }
          return [{ type: 'text', text: kwLines.join('\n') }];
        }
        // 错误文本里通常已经带了「运行日志 / 失败现场」的路径（collector 拼的）；
        // 这里只在没有的时候补一行，避免同一路径打印两遍。
        const errText = String(value.error || '');
        const tail = [];
        if (value.snapshotDir && !errText.includes(value.snapshotDir)) tail.push(`失败现场（截图 + 页面 HTML + 状态 JSON + 日志）：${value.snapshotDir}`);
        if (value.logPath && !errText.includes(value.logPath)) tail.push(`运行日志：${value.logPath}`);
        if (value.ok === false && value.phase === 'need-login') {
          return [{
            type: 'text',
            text: '需要先登录抖音（本次没有开始采集，避免未登录被限流、数据残缺）：\n'
              + value.error
              + '\n→ 让使用者在已经打开的浏览器窗口里用抖音 App 扫码；扫完再调用一次 douyin_comments 就能接着采（登录态已存进本机 profile，下次不用再扫）。',
          }];
        }
        if (!value.ok) {
          return [{ type: 'text', text: `采集未成功：${value.error}\n（扩展 v${value.extensionVersion}，phase=${value.phase}${value.note ? '，面板：' + value.note : ''}）${tail.length ? '\n' + tail.join('\n') : ''}` }];
        }
        const head = `已采集 ${value.count} 条公开评论`
          + (value.title ? `（${value.title}）` : '')
          + (value.account ? `（账号：${value.account}）` : '')
          + ` — videoId=${value.videoId}，用时 ${value.durationSec}s，顶层列表 ${value.lanes} 路，扩展 v${value.extensionVersion}`
          + (value.extensionInstalled ? '（本次自动安装）' : '');
        const lines = [head, `CSV：${value.csvPath}`, `JSON：${value.jsonPath}`];
        if (value.htmlPath) lines.push(`词云：${value.htmlPath}（双击打开；自包含 HTML，可发给别人）`);
        if (value.note) lines.push(`面板：${value.note}`);
        if (value.endedBy === 'verify-wait') {
          lines.push('⚠️ 撞到人机验证且等待超时：先停在这里。浏览器窗口还开着 —— 在窗口里完成页面上的验证，然后重新调用一次 douyin_comments（同一个 url），会从断点接着采。');
        }
        if (value.snapshotDir) lines.push(`⚠️ 本轮没采完（超时/无进展/被取消），现场快照：${value.snapshotDir}`);
        if (value.logPath) lines.push(`运行日志：${value.logPath}`);
        if (Array.isArray(value.sample) && value.sample.length > 0) {
          lines.push('样本：');
          value.sample.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    // 同一时刻只能跑一个：它要独占一个有头浏览器和扩展面板。
    isConcurrencySafe: () => false,
    // 有意不声明 timeoutMs：采集本身可能跑几分钟，用参数 timeoutMs 自己控制时长。
    async execute(args, exec) {
      const url = String(args.url || '').trim();
      const keyword = String(args.keyword || '').trim();
      if (!url && !keyword) throw new Error('douyin_comments: url 或 keyword 至少填一个（keyword = 按关键词搜索视频再采评论）');
      if (exec && exec.signal && exec.signal.aborted) throw new Error('douyin_comments: 已被调用方取消');

      // v0.9.21：NovaFlow 授权模式下，每次采集前必须已激活且能换到运行凭据。
      // 独立运行/开发模式（没配 relay）不启用，保持旧行为。
      if (entitlementEnabled()) {
        try {
          const st = await entitlementStatus();
          if (!st || st.activated !== true) throw new EntitlementError((st && st.code) || 'NOT_ACTIVATED');
        } catch (e) {
          const code = (e && e.code) || 'NOT_ACTIVATED';
          throw new Error('douyin_comments: ' + textOf(code));
        }
        try {
          await issueKey({ force: true });
        } catch (e) {
          throw new Error('douyin_comments: ' + textOf((e && e.code) || 'SERVICE_UNAVAILABLE'));
        }
      }

      // 设置每次调用现读一遍：在「设置 → 插件」里改完，下一次调用就生效（不用重启 dsh）。
      // 工具参数只覆盖当次，不改设置。
      const settings = readSettings();
      const maxUsed = Number(args.max) > 0 ? Number(args.max) : settings.max;
      const timeoutMsUsed = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : settings.timeoutMs;
      // v0.9.0：关键词模式（keyword 优先）：整体时间预算 + 视频条数两个独立预算；
      // 工具参数 timeoutMs 在关键词模式下被当成「整个关键词任务」的预算。
      const isKeyword = keyword !== '';
      const keywordTimeoutMsUsed = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : settings.keywordTimeoutMs;
      const videoCountUsed = Number(args.videoCount) > 0
        ? Math.min(100, Math.max(1, Math.round(Number(args.videoCount))))
        : settings.keywordVideoCount;
      const searchCfg = isKeyword ? normalizeSearchOptions({
        keyword,
        videoCount: videoCountUsed,
        sortType: args.sortType,
        publishTime: args.publishTime,
        duration: args.duration,
        contentType: args.contentType,
      }) : null;
      const waitLoginSecUsed = (args.waitLoginSec === undefined || args.waitLoginSec === null)
        ? settings.waitLoginSec
        : Number(args.waitLoginSec);
      // v0.9.1：撞人机验证时等你过验证的秒数
      const verifyWaitSecUsed = (args.verifyWaitSec === undefined || args.verifyWaitSec === null)
        ? settings.verifyWaitSec
        : Math.max(0, Number(args.verifyWaitSec));
      const lanesUsed = Number(args.lanes) > 0 ? Number(args.lanes) : settings.lanes;
      const clearBeforeUsed = args.clearBefore === undefined ? settings.clearBefore : args.clearBefore === true;
      const replyLanesUsed = settings.replyLanes;
      const replyGlobalGapMsUsed = settings.replyGlobalGapMs;
      const replyThrottleSecUsed = settings.replyThrottleSec;
      const replyNoProgressSecUsed = settings.replyNoProgressSec;
      // 0.5.14：失败现场快照（工具参数只覆盖当次；日志文件不依赖这项，每次运行都写）
      const failSnapshotUsed = args.failSnapshot === undefined ? settings.failSnapshot : args.failSnapshot === true;
      const keepSnapshotsUsed = settings.keepSnapshots;

      const logs = [];
      const onLog = (line) => {
        const text = String(line);
        logs.push(text);
        if (logs.length > 60) logs.shift();
        if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info('[douyin] ' + text);
      };

      // 结果默认写进**当前会话的工作区**（exec.agent.session.header.cwd），别人拿到手就能在自己的
      // 项目目录里看到 CSV/JSON；显式 outDir 仍然优先。
      const outDir = resolveOutDir({ explicit: args.outDir, exec, fallback: DEFAULTS.outDir });
      // v0.5.62：把这次用的输出目录记下来，Web 控制台的「导出记录」据此能列到工具采的文件。
      rememberOutDir(outDir);
      onLog('输出目录：' + outDir
        + (args.outDir ? '（显式指定）' : sessionWorkspaceCwd(exec) ? '（当前会话工作区）' : '（全局默认：本会话没带工作区）'));
      onLog('本次设置：max=' + maxUsed + '，顶层列表路数=' + lanesUsed + (lanesUsed > 1 ? '（错峰多路，每路错开 200ms）' : '（单路）') + '，超时=' + timeoutMsUsed + 'ms，等扫码=' + waitLoginSecUsed + 's，等人机验证=' + (verifyWaitSecUsed > 0 ? verifyWaitSecUsed + 's' : '不开')
        + '，先清空=' + (clearBeforeUsed ? '是' : '否') + '，回复并发=' + replyLanesUsed
        + '，回复全局限速=' + (replyGlobalGapMsUsed > 0 ? replyGlobalGapMsUsed + 'ms' : '扩展内置 250ms')
        + '，回复限流等待=' + replyThrottleSecUsed + 's，回复无进展收工=' + replyNoProgressSecUsed + 's'
        + '，失败现场快照=' + (failSnapshotUsed ? '开' : '关') + '（最多留 ' + keepSnapshotsUsed + ' 份）'
        + '（设置 → 插件 → dsh-douyin-comments 可改，改完立即生效）');
      if (isKeyword) {
        onLog('关键词模式：关键词「' + keyword + '」，取前 ' + videoCountUsed + ' 条视频的评论'
          + '，筛选=' + describeSearchOptions(searchCfg)
          + '，整体预算=' + keywordTimeoutMsUsed + 'ms（单条视频超时=' + timeoutMsUsed + 'ms）');
        onLog('提示：关键词模式会先搜视频、再逐条采评论；每条视频之间要重开扩展窗口，'
          + '总耗时随 videoCount 线性增长。中途可以用 keepOpen=true 保留窗口排查。');
      }

      let res;
      let urlUsed = url;
      let multiLinks = [];
      try {
        if (!isKeyword && url) {
          // v0.9.14：url 可以是视频页链接、整段分享文案或 v.douyin.com 短链，先统一解析成标准作品页
          // v0.9.16：粘多条链接（逗号/空格分隔）时逐条采集并合并导出
          const resolvedList = await resolveDouyinVideoInputs(url, { log: (line) => onLog('[链接] ' + line) });
          if (!resolvedList.ok) throw new Error('视频链接无效：' + (resolvedList.errors.join('；') || '没认出抖音链接'));
          multiLinks = resolvedList.targets.map((t) => t.url);
          if (multiLinks.length > 1) {
            onLog('识别到 ' + multiLinks.length + ' 条链接：逐条采集后合并成一份 CSV/JSON');
            onLog('  ' + multiLinks.slice(0, 8).join('\n  ') + (multiLinks.length > 8 ? '\n  …共 ' + multiLinks.length + ' 条' : ''));
          } else {
            urlUsed = multiLinks[0] || urlUsed;
            if (resolvedList.targets[0] && resolvedList.targets[0].source !== 'direct') onLog('分享链接已还原成作品页：' + urlUsed);
          }
        }
        if (isKeyword) {
          res = await collectDouyinKeyword({
            keyword,
            videoCount: videoCountUsed,
            sortType: searchCfg.sortType,
            publishTime: searchCfg.publishTime,
            duration: searchCfg.duration,
            contentType: searchCfg.contentType,
            account: String(args.account || '').trim(),
            max: maxUsed,
            lanes: lanesUsed,
            replies: args.replies,
            timeoutMs: keywordTimeoutMsUsed,
            waitLoginSec: waitLoginSecUsed,
            verifyWaitSec: verifyWaitSecUsed,
            clearBefore: clearBeforeUsed,
            replyLanes: replyLanesUsed,
            replyGlobalGapMs: replyGlobalGapMsUsed,
            replyThrottleSec: replyThrottleSecUsed,
            replyNoProgressSec: replyNoProgressSecUsed,
            failSnapshot: failSnapshotUsed,
            keepSnapshots: keepSnapshotsUsed,
            outDir,
            keep: args.keepOpen === true,
            onLog,
            signal: exec ? exec.signal : undefined,
          });
        } else if (multiLinks.length > 1) {
          // v0.9.16：多条链接 → 逐条采集后合并导出（整体时间预算沿用 timeoutMs，单条视频超时由核心控）
          res = await collectDouyinLinks({
            urls: url,
            account: String(args.account || '').trim(),
            max: maxUsed,
            lanes: lanesUsed,
            replies: args.replies,
            timeoutMs: timeoutMsUsed,
            waitLoginSec: waitLoginSecUsed,
            verifyWaitSec: verifyWaitSecUsed,
            clearBefore: clearBeforeUsed,
            replyLanes: replyLanesUsed,
            replyGlobalGapMs: replyGlobalGapMsUsed,
            replyThrottleSec: replyThrottleSecUsed,
            replyNoProgressSec: replyNoProgressSecUsed,
            failSnapshot: failSnapshotUsed,
            keepSnapshots: keepSnapshotsUsed,
            outDir,
            keep: args.keepOpen === true,
            onLog,
            signal: exec ? exec.signal : undefined,
          });
        } else {
          res = await collectDouyinComments({
            url: urlUsed,
            account: String(args.account || '').trim(),
            max: maxUsed,
            lanes: lanesUsed,
            replies: args.replies,
            timeoutMs: timeoutMsUsed,
            waitLoginSec: waitLoginSecUsed,
            verifyWaitSec: verifyWaitSecUsed,
            clearBefore: clearBeforeUsed,
            replyLanes: replyLanesUsed,
            replyGlobalGapMs: replyGlobalGapMsUsed,
            replyThrottleSec: replyThrottleSecUsed,
            replyNoProgressSec: replyNoProgressSecUsed,
            failSnapshot: failSnapshotUsed,
            keepSnapshots: keepSnapshotsUsed,
            outDir,
            keep: args.keepOpen === true,
            cloud: args.cloud === true,
            onLog,
            signal: exec ? exec.signal : undefined,
          });
        }
      } catch (e) {
        res = {
          ok: false, error: String((e && e.message) || e),
          videoId: '', title: '', keyword: isKeyword ? keyword : '',
          videoCount: (isKeyword || multiLinks.length > 1) ? 0 : 1, videoListPath: '', videos: [],
          count: 0, csvPath: '', jsonPath: '', htmlPath: '', phase: 'error', endedBy: '', note: '',
        };
      }

      const ext = res.extension || {};
      return {
        ok: res.ok === true,
        error: String(res.error || ''),
        videoId: String(res.videoId || ''),
        title: String(res.title || ''),
        keyword: String(res.keyword || (isKeyword ? keyword : '')),
        videoCount: (isKeyword || multiLinks.length > 1) ? (Number(res.videoCount) || 0) : 1,
        videoListPath: String(res.videoListPath || ''),
        videos: Array.isArray(res.videos) ? res.videos.map((s) => String(s)) : [],
        count: Number.isFinite(res.count) ? Number(res.count) : 0,
        csvPath: String(res.csvPath || ''),
        jsonPath: String(res.jsonPath || ''),
        htmlPath: String(res.htmlPath || ''),
        phase: String(res.phase || ''),
        // v0.9.1：收工原因（done/max-cap/top-done/stall/timeout/abort/verify-wait）
        endedBy: String(res.endedBy || ''),
        lanes: Number(res.extLanes) > 0 ? Number(res.extLanes) : lanesUsed,
        note: String(res.note || ''),
        durationSec: Number(res.durationSec) || 0,
        extensionVersion: String(ext.version || ''),
        extensionInstalled: ext.copied === true,
        account: res.account && res.account.name ? String(res.account.name) : '',
        sample: Array.isArray(res.sample) ? res.sample.map((s) => String(s)) : [],
        logPath: String(res.logPath || ''),
        snapshotDir: String(res.snapshotDir || ''),
      };
    },
  }));

  // v0.9.21：授权查询/激活（只在 NovaFlow 收费模式下有用；独立运行模式直接告知未启用）。
  const disposeEnt = ctx.tools.register(defineTool({
    name: 'douyin_entitlement',
    description: '查询抖音采集订阅状态，或用激活码激活。NovaFlow 收费版里采集前必须先激活（一码绑一个 NovaFlow 账号，最多 2 台设备，199 元/月）。独立运行模式会返回「未启用」。',
    parameters: {
      action: {
        type: 'string',
        description: 'status = 查询订阅状态（默认）；activate = 用激活码激活（需要同时给 code）。',
      },
      code: {
        type: 'string',
        description: '激活码（action=activate 时必填），形如 NOVA-DY-XXXX-XXXX。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          activated: { type: 'boolean', required: true },
          expiresAt: { type: 'string', required: true },
          remainingDays: { type: 'number', required: true },
          devices: { type: 'number', required: true },
          deviceLimit: { type: 'number', required: true },
          purchaseUrl: { type: 'string', required: true },
          machineId: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (out) => {
        const lines = ['抖音采集订阅：' + (out.activated ? '已激活' : '未激活')];
        if (out.expiresAt) lines.push('到期时间：' + out.expiresAt + (out.remainingDays ? '（剩余 ' + out.remainingDays + ' 天）' : ''));
        if (out.devices !== undefined) lines.push('设备：' + out.devices + ' / ' + (out.deviceLimit || 2) + ' 台');
        if (out.machineId) lines.push('本机设备号：' + out.machineId);
        if (out.purchaseUrl) lines.push('续费/购买：' + out.purchaseUrl);
        if (out.message) lines.push(out.message);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      if (!entitlementEnabled()) {
        return { ok: true, activated: false, message: '当前是独立运行/开发模式，未启用 NovaFlow 订阅（不需要激活）。' };
      }
      const action = String(args.action || 'status').trim().toLowerCase();
      try {
        if (action === 'activate') {
          const code = String(args.code || '').trim();
          if (!code) throw new EntitlementError('CODE_INVALID');
          const r = await activate(code);
          return {
            ok: true,
            activated: true,
            expiresAt: String(r.expiresAt || ''),
            remainingDays: Number(r.remainingDays) || 0,
            devices: Number(r.devices) || 0,
            deviceLimit: Number(r.deviceLimit) || 2,
            purchaseUrl: String(r.purchaseUrl || ''),
            machineId: machineId(),
            message: '激活成功。',
          };
        }
        const st = await entitlementStatus();
        return {
          ok: true,
          activated: st.activated === true,
          expiresAt: String(st.expiresAt || ''),
          remainingDays: Number(st.remainingDays) || 0,
          devices: Number(st.devices) || 0,
          deviceLimit: Number(st.deviceLimit) || 2,
          purchaseUrl: String(st.purchaseUrl || ''),
          machineId: machineId(),
          message: st.activated === true ? '' : '输入激活码后即可采集：douyin_entitlement action=activate code=NOVA-DY-XXXX-XXXX',
        };
      } catch (e) {
        // v0.9.24：失败分支也要给全输出结构（工具参数都声明为 required），否则框架会报
        // 「输出字段不完整」，把真正的原因（如 CODE_INVALID）盖掉。
        return {
          ok: false,
          activated: false,
          expiresAt: '',
          remainingDays: 0,
          devices: 0,
          deviceLimit: 2,
          purchaseUrl: '',
          machineId: machineId(),
          message: textOf((e && e.code) || 'SERVICE_UNAVAILABLE'),
        };
      }
    },
  }));

  // v0.9.23：识别「自己的抖音账号」资质（蓝V企业号 / 个人账号 / 白号（新号））。
  // 只读：打开自己的主页、复用页面自己发出的签名请求；结果写 <DOUYIN_HOME>/account-profile.json，
  // 抖音采集页（/plugins/dsh-douyin-comments/app/）直接读这个文件展示，不进「店铺账号管理」插件。
  // 不发私信、不发评论、不改资料。
  const disposeAccount = ctx.tools.register(defineTool({
    name: 'douyin_account_info',
    description: '识别当前登录的抖音账号属于哪类：蓝V企业号 / 个人账号（注册满 1 个月、无官方认证）/ 白号（新号，注册不足 1 个月），并把昵称、uid、粉丝数、作品数、注册时间写进 account-profile.json。只读识别，不发私信、不发评论、不改资料。**采集/获客前建议先调 action=status 做第 0 步**，确认是哪个账号、能不能发私信、配额档位；action=refresh 打开抖音自己的主页重新识别一次（需要该账号已登录，可能要扫码）。',
    parameters: {
      action: {
        type: 'string',
        description: 'status = 读已识别的结果（默认，不发浏览器）；refresh = 打开抖音重新识别一次。',
      },
      account: {
        type: 'string',
        description: '可选：用「店铺账号管理」插件里的某个已登录抖音账号来识别（传账号 id 或名字）；不传 = 用本插件自己 profile 的登录态。',
      },
      waitLoginSec: {
        type: 'integer',
        description: '可选：识别时等扫码登录的秒数（默认 180；0 = 不等待，未登录直接报错）。',
      },
      keepOpen: {
        type: 'boolean',
        description: '调试用：识别完不关浏览器窗口（默认 false）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          accountType: { type: 'string', required: true },
          accountTypeLabel: { type: 'string', required: true },
          nickname: { type: 'string', required: true },
          uid: { type: 'string', required: true },
          uniqueId: { type: 'string', required: true },
          followers: { type: 'number', required: true },
          awemeCount: { type: 'number', required: true },
          registeredAt: { type: 'string', required: true },
          accountAgeDays: { type: 'integer', required: true },
          verifyReason: { type: 'string', required: true },
          source: { type: 'string', required: true },
          checkedAt: { type: 'string', required: true },
          file: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (out) => {
        const lines = [];
        if (out.ok) {
          lines.push('抖音账号资质：' + (out.accountTypeLabel || '未知') + (out.nickname ? '（' + out.nickname + '）' : ''));
          if (out.uid) lines.push('uid：' + out.uid + (out.uniqueId ? '（抖音号 ' + out.uniqueId + '）' : ''));
          if (out.followers || out.awemeCount) lines.push('粉丝 ' + (out.followers || 0) + ' · 作品 ' + (out.awemeCount || 0));
          if (out.registeredAt) {
            const day = String(out.registeredAt).slice(0, 10);
            lines.push('注册：' + day + (out.accountAgeDays ? '（约 ' + out.accountAgeDays + ' 天）' : ''));
          }
          if (out.verifyReason) lines.push('认证信息：' + out.verifyReason);
          if (out.source) lines.push('判定来源：' + (out.source === 'api' ? '接口' : (out.source === 'dom' ? '页面文案' : out.source)) + (out.checkedAt ? '（识别于 ' + out.checkedAt + '）' : ''));
          if (out.file) lines.push('档案文件：' + out.file);
        } else {
          lines.push('识别失败：' + (out.message || '未知错误'));
        }
        if (out.message && out.ok) lines.push(out.message);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const action = String(args.action || 'status').trim().toLowerCase();
      const accountRef = String(args.account || '').trim();
      try {
        if (action !== 'refresh') {
          const store = readAccountProfiles();
          const entries = Array.isArray(store.entries) ? store.entries : [];
          const hit = accountRef
            ? entries.find((e) => String(e.key || '').toLowerCase() === accountRef.toLowerCase()
              || String(e.accountName || '').toLowerCase() === accountRef.toLowerCase())
            : (entries.find((e) => String(e.key || '') === 'default') || entries[entries.length - 1]);
          if (!hit) {
            return {
              ok: true, accountType: '', accountTypeLabel: '', nickname: '', uid: '', uniqueId: '',
              followers: 0, awemeCount: 0, registeredAt: '', accountAgeDays: 0, verifyReason: '', source: '', checkedAt: '', file: accountProfilePath(),
              message: '还没有识别记录：用 action=refresh 识别一次（' + accountProfilePath() + '）',
            };
          }
          return {
            ok: true,
            accountType: String(hit.accountType || ''),
            accountTypeLabel: String(hit.accountTypeLabel || ''),
            nickname: String(hit.nickname || ''),
            uid: String(hit.uid || ''),
            uniqueId: String(hit.uniqueId || ''),
            followers: Number(hit.followers) || 0,
            awemeCount: Number(hit.awemeCount) || 0,
            registeredAt: String(hit.registeredAt || ''),
            accountAgeDays: Number(hit.accountAgeDays) || 0,
            verifyReason: String(hit.verifyReason || ''),
            source: String(hit.source || ''),
            checkedAt: String(hit.checkedAt || ''),
            file: accountProfilePath(),
            message: entries.length > 1 ? '共识别过 ' + entries.length + ' 个账号，可用 account 指定其中一个。' : '',
          };
        }
        const res = await fetchDouyinSelfProfile({
          account: accountRef,
          waitLoginSec: args.waitLoginSec,
          keep: args.keepOpen === true,
          log: (line) => (typeof console !== 'undefined' && console.log ? console.log('[douyin-account] ' + line) : undefined),
        });
        return {
          ok: true,
          accountType: String(res.accountType || ''),
          accountTypeLabel: String(res.accountTypeLabel || ''),
          nickname: String(res.nickname || ''),
          uid: String(res.uid || ''),
          uniqueId: String(res.uniqueId || ''),
          followers: Number(res.followers) || 0,
          awemeCount: Number(res.awemeCount) || 0,
          registeredAt: String(res.registeredAt || ''),
          accountAgeDays: Number(res.accountAgeDays) || 0,
          verifyReason: String(res.verifyReason || ''),
          source: String(res.source || ''),
          checkedAt: String(res.checkedAt || ''),
          file: String(res.file || accountProfilePath()),
          message: '已更新账号资质档案。',
        };
      } catch (e) {
        return {
          ok: false, accountType: '', accountTypeLabel: '', nickname: '', uid: '', uniqueId: '',
          followers: 0, awemeCount: 0, registeredAt: '', accountAgeDays: 0, verifyReason: '', source: '', checkedAt: '', file: accountProfilePath(),
          message: String((e && e.message) || e),
        };
      }
    },
  }));

  // v0.9.25：主动私信获客话术 —— 给 agent 用的「话术 + 配额记账」工具。
  // v0.9.26：新增 action=send —— 受控自动发送（必须显式传 account，dryRun 默认 true）。
  const disposeOutreach = ctx.tools.register(defineTool({
    name: 'douyin_outreach',
    description: [
      '主动私信获客：话术库 + 配额记账 + **受控自动发送**（给 agent 用）。内置 36 条话术（场景：comment 评论互动 / dm 私信打招呼 / outreach 主动私信获客 / followup 追问邀约），按账号类型过滤。',
      'action=guide 返回当前账号的可用场景、使用规则、当天配额和获客执行清单；action=list 列话术；action=pick 随机挑一条；action=draft 把 {变量} 填成待发文案并做发送前检查；action=send 用本机已登录的抖音账号把文案逐条发给 targets 里的目标（**受控**：必须传 account、必须已识别账号类型、过配额/7天去重/联系方式检查、dryRun 默认 true 只填不点发送）；action=record 记账；action=quota 查用量。',
      '配额是运营经验值，不是抖音官方额度：蓝V 评论 200-300/天、私信 ≤80/天、每小时 ≤30；个人账号/个人认证 评论 100-200（本地取 150）/天、私信 ≤30/天、每小时 ≤5；白号（新号）不建议私信（0 条）、评论 ≤50/天。到量或出现验证/滑块必须停手。',
      '每个陌生人（对方未回复/未关注）只能发 1 条文字消息；首条不要放价格、联系方式、链接，不要第一条就推销。send 仍是自动化操作，有触发验证/封号风险，只在小批量、真实意向目标上使用。',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        description: 'guide（默认）= 规则+配额+执行清单；list = 列话术；pick = 随机挑一条；draft = 生成待发文案；send = 受控发送私信（默认 dry-run）；record = 记一条已发；quota = 查用量。',
      },
      scene: {
        type: 'string',
        description: '场景：comment 评论互动 / dm 私信打招呼 / outreach 主动私信获客 / followup 追问邀约。不传 = 全部允许场景。',
      },
      accountType: {
        type: 'string',
        description: '账号类型：enterprise 蓝V企业号 / personal 个人账号（含个人认证）/ unverified 白号（新号，注册不足 1 个月）。不传 = 按保守口径（白号）并提示去识别。',
      },
      account: {
        type: 'string',
        description: 'send 必填：店铺账号管理里的抖音账号（id 或名字）。不传 account 一律拒绝发送；账号类型按 account-profile.json 里该账号的记录做硬闸门。',
      },
      targets: {
        type: 'string',
        description: 'send 必填：逗号分隔的目标 sec_uid 或抖音主页链接（https://www.douyin.com/user/<sec_uid>）。建议只在采集结果里挑明确意向的评论者，每批 ≤5 人。',
      },
      max: {
        type: 'integer',
        description: 'send 可选：本批最多发几条（默认 5，硬上限 10，并受当天/本小时剩余私信额度限制）。',
      },
      dryRun: {
        type: 'boolean',
        description: 'send 可选：默认 true（只打开聊天窗、把文案填进输入框，停在发送前）；显式传 false 才会真的点「关注」和「发送」。',
      },
      follow: {
        type: 'boolean',
        description: 'send 可选：默认 true —— 发私信前先点目标的「关注」（已关注会自动识别并跳过；dryRun 时只检测不点）。传 false 则只发私信不关注。',
      },
      scriptId: {
        type: 'string',
        description: 'draft/send/record 可选：指定话术 id（如 o01、d01、c03）；draft/send 不传则按场景自动挑一条。',
      },
      variables: {
        type: 'string',
        description: 'draft/send 可选：JSON 字符串，把话术里的 {变量} 填掉，例如 {"city":"上海","direction":"短视频剪辑","need":"剪辑师"}。没填的变量会在 missing 里列出，send 会拒绝带未填变量的文案。',
      },
      target: {
        type: 'string',
        description: '可选：单个目标用户标识（昵称/uid/抖音号），用于 record 记账与「7 天内是否已私信过同一个人」检查。',
      },
      avoidIds: {
        type: 'string',
        description: 'pick/draft 可选：逗号分隔的最近用过的话术 id，尽量不要重复用同一句。',
      },
      note: {
        type: 'string',
        description: 'record 可选：备注（例如「评论区的意向客户」）。',
      },
      limit: {
        type: 'integer',
        description: 'list 可选：最多返回几条（默认全部）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          accountType: { type: 'string', required: true },
          accountTypeLabel: { type: 'string', required: true },
          scene: { type: 'string', required: true },
          scriptId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          text: { type: 'string', required: true },
          warnings: { type: 'string', required: true },
          quotaText: { type: 'string', required: true },
          rules: { type: 'string', required: true },
          checklist: { type: 'string', required: true },
          scripts: { type: 'string', required: true },
          file: { type: 'string', required: true },
          message: { type: 'string', required: true },
          dryRun: { type: 'boolean', required: true },
          sent: { type: 'integer', required: true },
          endedBy: { type: 'string', required: true },
          details: { type: 'string', required: true },
        },
      },
      render: (out) => {
        const lines = [];
        if (!out.ok) {
          lines.push('douyin_outreach 失败：' + (out.message || '未知错误'));
          return [{ type: 'text', text: lines.join('\n') }];
        }
        if (out.action === 'list') {
          let items = [];
          try { items = JSON.parse(out.scripts || '[]'); } catch { items = []; }
          lines.push('可用话术 ' + items.length + ' 条' + (out.scene ? '（场景 ' + out.scene + '）' : '') + '：');
          for (const it of items) {
            lines.push('· [' + it.id + '] ' + it.title + '（' + it.sceneLabel + '）：' + it.text);
          }
        } else if (out.action === 'draft' || out.action === 'pick') {
          if (out.title) lines.push('话术 [' + (out.scriptId || '-') + '] ' + out.title + '（' + (out.scene || '') + '）');
          if (out.text) lines.push('待发文案：\n' + out.text);
        } else if (out.action === 'send') {
          lines.push((out.dryRun ? 'dry-run（只填文案、没有点发送）' : '真实发送') + '：' + (out.sent || 0) + ' 条 · endedBy=' + (out.endedBy || '-'));
          if (out.text) lines.push('本次文案：\n' + out.text);
          if (out.details) lines.push('逐条结果：\n' + out.details.split('\n').map((s) => '  ' + s).join('\n'));
          if (out.quotaText) lines.push(out.quotaText);
        } else if (out.action === 'guide') {
          lines.push('账号类型：' + (out.accountTypeLabel || '未知'));
          if (out.quotaText) lines.push(out.quotaText);
          if (out.rules) lines.push('使用规则：\n' + out.rules.split('\n').map((s) => '· ' + s).join('\n'));
          if (out.checklist) lines.push('执行清单：\n' + out.checklist.split('\n').map((s) => '  ' + s).join('\n'));
        } else if (out.action === 'record' || out.action === 'quota') {
          if (out.action === 'record' && out.message) lines.push(out.message);
          lines.push(out.quotaText || out.message || '');
        }
        if (out.warnings) lines.push('⚠️ ' + out.warnings.split('；').join('\n⚠️ '));
        if (out.action === 'guide' && out.file) lines.push('记账文件：' + out.file);
        if (out.message && out.action !== 'quota' && out.action !== 'record') lines.push(out.message);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const action = String(args.action || 'guide').trim().toLowerCase();
      const accountType = String(args.accountType || '').trim().toLowerCase();
      const scene = String(args.scene || '').trim().toLowerCase();
      const scriptId = String(args.scriptId || '').trim().toLowerCase();
      const target = String(args.target || '').trim();
      const note = String(args.note || '').trim();
      const limit = Number(args.limit) || 0;
      const avoidIds = String(args.avoidIds || '').split(/[,，\s]+/u).filter(Boolean);
      let variables = {};
      if (typeof args.variables === 'string' && args.variables.trim()) {
        try { variables = JSON.parse(args.variables); } catch { variables = {}; }
      } else if (args.variables && typeof args.variables === 'object') {
        variables = args.variables;
      }
      const empty = {
        ok: true, action, accountType: '', accountTypeLabel: '', scene: '', scriptId, title: '', text: '',
        warnings: '', quotaText: '', rules: '', checklist: '', scripts: '', file: '', message: '',
        dryRun: false, sent: 0, endedBy: '', details: '',
      };
      const quotaTextOf = (q) => (q.accountTypeLabel + '：今天评论 ' + q.used.commentToday + '/' + q.limits.commentPerDay
        + ' · 私信 ' + q.used.dmToday + '/' + q.limits.dmPerDay
        + ' · 本小时私信 ' + q.used.dmThisHour + '/' + q.limits.dmPerHour
        + ' · 今天关注 ' + (q.used.followsToday || 0) + ' 个'
        + '（' + (q.unknownAccountType ? '本地记录，账号类型未识别，按保守口径' : '本地记录') + '）');
      try {
        if (action === 'list') {
          const items = outreachList({ scene, accountType, limit });
          return {
            ...empty,
            scene: scene || '',
            accountType: accountType || '',
            accountTypeLabel: (OUTREACH_QUOTAS[accountType] && OUTREACH_QUOTAS[accountType].label) || '',
            scripts: JSON.stringify(items),
            message: '共 ' + items.length + ' 条可用话术' + (scene ? '（' + scene + '）' : ''),
          };
        }
        if (action === 'pick') {
          const item = outreachPick({ scene, accountType, avoidIds });
          if (!item) return { ...empty, ok: false, message: '这个场景下没有可用话术（当前账号类型不允许该场景）。' };
          return { ...empty, scene: item.scene, scriptId: item.id, title: item.title, text: item.text, message: '已随机挑一条：' + item.id };
        }
        if (action === 'draft') {
          const d = outreachDraft({ scene, accountType, scriptId, variables, target, avoidIds, home: DEFAULTS.home });
          return {
            ...empty,
            action: 'draft',
            accountType: d.quota.accountType,
            accountTypeLabel: d.quota.accountTypeLabel,
            scene: d.scene,
            scriptId: d.scriptId,
            title: d.title,
            text: d.text,
            warnings: d.warnings.join('；'),
            quotaText: quotaTextOf(d.quota),
            message: '待发文案已生成（插件不会自动发送）。',
          };
        }
        if (action === 'record') {
          const r = outreachRecord({ scene, scriptId, accountType, target, note, home: DEFAULTS.home });
          return {
            ...empty,
            accountType: r.quota.accountType,
            accountTypeLabel: r.quota.accountTypeLabel,
            scene: r.entry.scene,
            scriptId: r.entry.scriptId,
            warnings: r.warnings.join('；'),
            quotaText: quotaTextOf(r.quota),
            file: r.file,
            message: '已记账：' + r.entry.scene + (r.entry.scriptId ? ' / ' + r.entry.scriptId : '') + (r.entry.target ? ' → ' + r.entry.target : '')
              + '（今天累计记录 ' + r.total + ' 条）',
          };
        }
        if (action === 'quota') {
          const q = outreachQuota({ accountType, home: DEFAULTS.home });
          return {
            ...empty,
            accountType: q.accountType,
            accountTypeLabel: q.accountTypeLabel,
            warnings: q.warnings.join('；'),
            quotaText: quotaTextOf(q),
            message: '',
          };
        }
        if (action === 'send') {
          const accountRef = String(args.account || '').trim();
          if (!accountRef) {
            return { ...empty, ok: false, message: '发送私信必须指定 account（店铺账号管理里的抖音账号）；不传 account 一律拒绝。' };
          }
          const rawTargets = String(args.targets || '').split(/[,，\s]+/u).map((s) => {
            const t = String(s || '').trim();
            if (!t) return '';
            const m = t.match(/\/user\/([A-Za-z0-9_-]{5,})/u);
            if (m) return m[1];
            if (/(https?|www\.)/u.test(t)) return '';
            return t;
          }).filter(Boolean);
          const targets = Array.from(new Set(rawTargets));
          if (!targets.length) {
            return { ...empty, ok: false, message: '没有可发送的目标：targets 传逗号分隔的 sec_uid 或抖音主页链接（https://www.douyin.com/user/<sec_uid>）。' };
          }
          let shopAccount = null;
          try { shopAccount = await resolveShopAccount(accountRef, { platform: 'douyin' }); } catch (e) {
            return { ...empty, ok: false, message: '找不到店铺账号「' + accountRef + '」：' + String((e && e.message) || e) };
          }
          const store = readAccountProfiles({ home: DEFAULTS.home });
          const entry = (store.entries || []).find((e) =>
            String(e.key || '') === String(shopAccount.id || '')
            || String(e.accountName || '') === String(shopAccount.name || '')
            || String(e.accountRef || '') === String(shopAccount.id || ''));
          if (!entry || !entry.accountType) {
            return { ...empty, ok: false, message: '这个账号（' + shopAccount.name + '）还没识别过类型：先调用 douyin_account_info action=refresh account="' + accountRef + '" 识别一次；发送私信按账号类型硬限制配额。' };
          }
          const at = String(entry.accountType);
          const q = outreachQuota({ accountType: at, home: DEFAULTS.home });
          const sceneEff = scene || 'outreach';
          const d = outreachDraft({ scene: sceneEff, accountType: at, scriptId, variables, target: targets[0], home: DEFAULTS.home });
          if (d.missingVariables && d.missingVariables.length) {
            return { ...empty, ok: false, accountType: at, accountTypeLabel: q.accountTypeLabel, scene: d.scene, scriptId: d.scriptId, title: d.title, text: d.text, warnings: '文案里还有没填的变量：' + d.missingVariables.map((k) => '{' + k + '}').join('、') + '；先把 variables 填全再发。', quotaText: quotaTextOf(q), message: '未发送：文案变量没填完。' };
          }
          if ((d.warnings || []).some((w) => String(w).includes('联系方式'))) {
            return { ...empty, ok: false, accountType: at, accountTypeLabel: q.accountTypeLabel, scene: d.scene, scriptId: d.scriptId, title: d.title, text: d.text, warnings: d.warnings.join('；'), quotaText: quotaTextOf(q), message: '未发送：文案里带联系方式/导流词，先改文案。' };
          }
          const maxByQuota = Math.min(q.remaining.dmToday, q.remaining.dmThisHour);
          const maxWant = Number(args.max) > 0 ? Number(args.max) : 5;
          const max = Math.min(maxWant, 10, maxByQuota);
          if (max <= 0) {
            return { ...empty, ok: false, accountType: at, accountTypeLabel: q.accountTypeLabel, warnings: q.warnings.join('；'), quotaText: quotaTextOf(q), message: '未发送：今天/本小时的私信额度已用完。' };
          }
          const chosen = [];
          const skipped = [];
          for (const t of targets) {
            if (chosen.length >= max) break;
            const pre = outreachPrecheck({ scriptId: d.scriptId, target: t, accountType: at, home: DEFAULTS.home });
            if (pre.warnings.some((w) => String(w).includes('7 天内已经发过私信'))) { skipped.push(t); continue; }
            chosen.push(t);
          }
          if (!chosen.length) {
            return { ...empty, ok: false, accountType: at, accountTypeLabel: q.accountTypeLabel, warnings: q.warnings.join('；'), quotaText: quotaTextOf(q), message: '未发送：目标都在 7 天内已私信过（共 ' + targets.length + ' 个）。' };
          }
          const dryRun = !(args.dryRun === false || String(args.dryRun) === 'false');
          const follow = !(args.follow === false || String(args.follow) === 'false');
          const items = chosen.map((t) => ({ targetSecUid: t, text: d.text, scriptId: d.scriptId }));
          const batch = await sendDouyinDmBatch({ account: accountRef, items, dryRun, follow, maxPerRun: max, log: () => {} });
          let recorded = null;
          if (!dryRun && batch.sent > 0) {
            for (const r of batch.results) {
              if (r.status !== 'sent') continue;
              recorded = outreachRecord({ scene: d.scene, scriptId: d.scriptId, accountType: at, target: r.targetSecUid, note: note || '', followed: r.followed === true, home: DEFAULTS.home });
            }
          }
          const followedCount = batch.results.filter((r) => r.followed === true || r.followed === 'already').length;
          const details = batch.results.map((r) => (r.status === 'sent' ? '[sent] ' : (r.status === 'dry-run' ? '[dry-run] ' : '[failed] ')) + r.targetSecUid + ' · ' + r.status
            + (r.followed ? ' · 关注=' + r.followed : '')
            + (r.reason ? ' · ' + r.reason : '')).join('\n');
          const skipText = skipped.length ? '；跳过 ' + skipped.length + ' 个（7 天内已私信过）' : '';
          const followText = dryRun ? '；dry-run 未点关注' : '；关注/已关注 ' + followedCount + ' 个';
          const message = dryRun
            ? 'dry-run 完成：' + batch.skipped + ' 条已填进输入框（没有点发送）、' + batch.failed + ' 条失败，endedBy=' + batch.endedBy + skipText + followText + '。确认文案没问题后，把 dryRun 传 false 才会先关注、再真发送。'
            : '已发送 ' + batch.sent + ' 条、失败 ' + batch.failed + ' 条，endedBy=' + batch.endedBy + skipText + followText + '。';
          return {
            ...empty, ok: true, action: 'send', accountType: at, accountTypeLabel: q.accountTypeLabel,
            scene: d.scene, scriptId: d.scriptId, title: d.title, text: d.text,
            warnings: (d.warnings || []).join('；'),
            quotaText: quotaTextOf((recorded && recorded.quota) || q),
            file: (recorded && recorded.file) || '',
            message, dryRun, sent: batch.sent, endedBy: batch.endedBy, details,
          };
        }
        // guide
        const g = outreachGuide({ accountType, home: DEFAULTS.home });
        return {
          ...empty,
          action: 'guide',
          accountType: g.accountType,
          accountTypeLabel: g.accountTypeLabel,
          rules: g.rules.join('\n'),
          checklist: g.checklist.join('\n'),
          warnings: g.quota.warnings.join('；'),
          quotaText: quotaTextOf(g.quota),
          file: g.logFile,
          message: '场景：' + g.scenes.map((s) => s.id + '(' + s.label + ')').join('、'),
        };
      } catch (e) {
        return { ...empty, ok: false, message: String((e && e.message) || e) };
      }
    },
  }));

  // 插件卸载时精确注销这些工具。
  if (typeof ctx.effect === 'function') ctx.effect(() => () => { dispose(); disposeEnt(); disposeAccount(); disposeOutreach(); });

  // DSH Web 控制台 + 评论词云（v0.6.0 合并后一起挂载）：只在有 webServer 的宿主里挂；
  // headless / 纯工具模式没有这个服务，嵌套 inject 不会执行，原来的 douyin_comments 工具完全不受影响。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => {
      // 控制台与评论词云共用一个 webServer prefix（CONSOLE_PREFIX = /plugins/dsh-douyin-comments）：
      // 词云的接口与静态页都挂在它下面的 /viewer 路径，由这里统一分发。这样不依赖宿主对
      // 「两个互含前缀」的匹配优先级（/plugins/dsh-douyin-comments 与 .../viewer 谁先匹配）。
      const consoleApi = createConsole({
        // v0.9.0：按输入里有没有 keyword 分发到「关键词搜索模式」或「单视频模式」。
        // v0.9.16：控制台把「多条链接」解析成 urls 数组，这里也要分发到多链接模式，
        //          否则会退化成单视频模式（url 为空）而与自动识别结果「打架」。
        collect: (opts) => (opts && opts.keyword ? collectDouyinKeyword(opts)
          : (opts && Array.isArray(opts.urls) && opts.urls.length > 1 ? collectDouyinLinks(opts) : collectDouyinComments(opts))),
        getSettings: () => readSettings(),
        getOutDir: () => DEFAULTS.outDir,
      });
      // rootCtx 作为兜底：llm / agentDefaultModel 这类可选服务如果在 webServer 作用域里取不到，
      // 就从插件根 ctx 再试一次（AI 解读靠它）。
      const viewerHandler = createViewerHandler(scoped, ctx);
      const handler = (req, res) => {
        let pathname = '';
        try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch { pathname = ''; }
        if (pathname === VIEWER_PREFIX || pathname.startsWith(VIEWER_PREFIX + '/')) {
          return viewerHandler(req, res);
        }
        return consoleApi.handler(req, res);
      };
      const install = () => scoped.webServer.register({ kind: 'prefix', path: CONSOLE_PREFIX, handler });
      if (typeof scoped.effect === 'function') scoped.effect(install);
      else install();
      if (scoped.logger && typeof scoped.logger.info === 'function') {
        scoped.logger.info('[douyin] Web 控制台已挂载：' + CONSOLE_PREFIX + '/app/');
        scoped.logger.info('[douyin] 评论词云已挂载：' + VIEWER_PREFIX + '/（采集完成后客户端会自动打开）');
      }
    });
  }

  if (ctx.logger && typeof ctx.logger.info === 'function') {
    const s = readSettings();
    ctx.logger.info('[douyin] douyin_comments 工具已注册（自带扩展副本，运行时自动装进浏览器）；'
      + '当前设置：max=' + s.max + '，顶层列表路数=' + s.lanes + (s.lanes > 1 ? '（错峰多路）' : '（单路）') + '，超时=' + s.timeoutMs + 'ms，等扫码=' + s.waitLoginSec + 's'
      + '，等人机验证=' + (s.verifyWaitSec > 0 ? s.verifyWaitSec + 's' : '不开')
      + '，先清空=' + (s.clearBefore ? '是' : '否') + '，回复并发=' + s.replyLanes
      + '，回复全局限速=' + (s.replyGlobalGapMs > 0 ? s.replyGlobalGapMs + 'ms' : '扩展内置 250ms')
      + '，回复限流等待=' + s.replyThrottleSec + 's，回复无进展收工=' + s.replyNoProgressSec + 's'
      + '（可在「设置 → 插件 → dsh-douyin-comments」里改，改完立即生效）');
  }
}
