/**
 * 抖音获客话术库（v0.9.39）
 *
 * 目的：给「agent 半自动获客 / 人工操作」提供成体系的、可轮换的**主动私信获客**话术，
 * 降低同一句话高频重复触发风控/验证的概率。这里是**纯文案资产**；agent 通过工具
 * `douyin_outreach`（outreach.mjs）读话术、填变量、做发送前检查与配额记账，
 * `douyin_outreach action=send` 会走受控发送（dryRun 默认 true；硬闸门在工具层，
 * 核心发送器在 core 的 `sendDouyinDmBatch`）。
 *
 * v0.9.39：本库只保留「主动私信获客」12 条内置话术；用户可在采集页「获客话术库」
 * 自己添加 / 删除话术（落在 `<DOUYIN_HOME>/user-scripts.json`，不进远端仓库）。
 *
 * 使用边界（务必看 SCRIPT_RULES）：
 *   · 默认不自动群发；真发必须显式 dryRun:false 且使用者已确认。
 *   · 蓝V / 个人认证 / 注册满 1 个月的个人账号可私信获客；白号（新号）不建议私信。
 *   · 配额是运营经验值，不是抖音官方额度；到量就停，遇到验证立刻停。
 *   · 主动私信获客的第一句 = 打招呼 + 自我介绍（我是谁、做什么）+ 为什么找他 + 一句轻问，
 *     第一条不要放价格 / 联系方式 / 链接。
 *
 * 变量：文本里的 {identity} / {category} / {need} / {city} / {direction} / {business} 等占位符，
 *       由 agent 调 draft 时填掉（插件不会自动填，避免填错成硬广）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SCRIPT_LIBRARY_VERSION = '0.9.41';

/** 自定义话术文件版本。 */
export const USER_SCRIPTS_VERSION = 1;

/** 场景（前端 tab 用）：本库只保留主动私信获客。 */
export const SCRIPT_SCENES = [
  { id: 'outreach', label: '主动私信获客', desc: '主动找目标用户：先打招呼、自我介绍（我是谁、做什么），再说为什么找他，首条不推销' },
];

/** 使用规则（页面上直接展示，也是配额提醒的文案来源）。 */
export const SCRIPT_RULES = [
  '同一句话不要连续发给同一个人；对同一个人 7 天内最多 1 次',
  '同一账号每天用完全相同的句子不超过 3 次，尽量在库里轮换',
  '白号（注册不足 1 个月的新号）：不建议私信（0 条），评论 ≤ 50 条/天',
  '个人认证：评论 100-200 条/天；私信 ≤ 30 条/天；每小时打招呼 ≤ 5 次',
  '蓝V企业号：评论 200-300 条/天；私信 ≤ 80 条/天；每小时打招呼 ≤ 30 次',
  '话术里不要放联系方式、导流词、敏感词；先聊内容，再谈需求',
  '主动私信获客：首条不要放价格/联系方式/链接，不要第一条就报价；对方不回复不要连发',
  '主动私信获客第一句的结构：打招呼 + 一句自我介绍（我是谁、做什么）+ 为什么找他 + 一句轻问；不要一上来只发产品/报价',
  '以上是运营经验值，不是官方额度；到量就停，出现验证/滑块立刻停手',
];

/**
 * @typedef {Object} ScriptItem
 * @property {string} id
 * @property {'outreach'} scene
 * @property {string} title 风格标签
 * @property {string} text 话术正文（含 {变量}）
 * @property {string[]} accountTypes 适用账号类型（enterprise / personal / unverified）
 * @property {boolean} [custom] 是否用户添加（true 时 id 以 u 开头）
 */

/** @type {ScriptItem[]} */
export const SCRIPTS = [
  {
    id: 'o01', scene: 'outreach', title: '源头厂家推荐款',
    text: '你好，我是{identity}，主要做{category}。看到你在关注{need}，可以先给你推荐几款看看，合适再细聊',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'o02', scene: 'outreach', title: '供货/拿货',
    text: '你好，我是{identity}，做{category}供货。看你这边在找货源，我们有小批量起订的方案，要不要先发你看看？',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'o03', scene: 'outreach', title: '样品寄样',
    text: '你好，我是{identity}，可以给你寄几款{category}的样品先看质量，你这边方便收件吗？',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'o04', scene: 'outreach', title: '批发价目',
    text: '你好，我是{identity}，这边有{category}的最新批发价目表；需要的话我发你一份，不合适也没关系',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'o05', scene: 'outreach', title: '新品/爆款推荐',
    text: '你好，我是{identity}，最近上了几款{category}新品，反馈不错，想推荐给你看看，有兴趣我再细说',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'o06', scene: 'outreach', title: '定制/代工',
    text: '你好，我是{identity}，做{category}{business}的，支持{clientType}定制和代工；看到你的方向挺合适，要不要先聊下需求？',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'o07', scene: 'outreach', title: '同行交流',
    text: '你好，我是{identity}，也在做{category}；看到你的内容挺专业，想认识一下，以后有{need}可以互相推一下',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'o08', scene: 'outreach', title: '案例复盘',
    text: '你好，我是{identity}；整理了一份{caseName}的复盘，看到你在关注{industry}，需要的话发你，不需要也没关系',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'o09', scene: 'outreach', title: '合作邀约',
    text: '你好，我是{identity}，主要做{business}。想找几位在{city}做{direction}的伙伴一起试试{project}，你有兴趣聊聊吗？',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'o10', scene: 'outreach', title: '送资料',
    text: '你好，我是{identity}；有一份{material}整理得比较实用，看到你在{industry}，想发给你看看要不要',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'o11', scene: 'outreach', title: '活动邀约',
    text: '你好，我是{identity}，{date}我们有一场{topic}的分享，重点是{point}，想邀请你来听，不收费',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'o12', scene: 'outreach', title: '回访同步',
    text: '你好，我是{identity}；之前看到你在关注{industry}，最近这边有{change}，想跟你同步一下，也问问你现在的情况',
    accountTypes: ['enterprise', 'personal'],
  },
];

/** 账号类型 → 允许场景（白号=新号：不建议私信，本库只有主动私信获客，所以白号没有可用场景）。 */
const ACCOUNT_SCENES = {
  enterprise: ['outreach'],
  personal: ['outreach'],
  unverified: [],
};

/** 插件工作目录，解析规则与 collector.mjs / outreach.mjs 保持一致。 */
function homeDir(home) {
  if (home) return String(home);
  if (process.env.DOUYIN_HOME) return process.env.DOUYIN_HOME;
  if (process.env.DSH_HOME) return path.join(process.env.DSH_HOME, 'douyin-collector');
  return path.join(os.homedir(), '.dsh', 'douyin-collector');
}

export function userScriptsPath(home) {
  return path.join(homeDir(home), 'user-scripts.json');
}

/** 读用户自定义话术文件；坏了/不存在都退化成空。 */
export function readUserScripts({ home } = {}) {
  try {
    const raw = fs.readFileSync(userScriptsPath(home), 'utf8');
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed.items) ? parsed.items.filter((it) => it && typeof it.text === 'string' && it.text.trim()) : [];
    const removed = Array.isArray(parsed.removed) ? parsed.removed.map(String) : [];
    return { version: USER_SCRIPTS_VERSION, items, removed };
  } catch (err) {
    return { version: USER_SCRIPTS_VERSION, items: [], removed: [] };
  }
}

function writeUserScripts(data, { home } = {}) {
  const file = userScriptsPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { version: USER_SCRIPTS_VERSION, items: data.items || [], removed: data.removed || [] };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { file, data: next };
}

/** 内置 + 用户自定义，并去掉被隐藏/删除的。 */
function mergedScripts({ home } = {}) {
  const user = readUserScripts({ home });
  const removed = new Set(user.removed.map(String));
  const builtin = SCRIPTS.filter((item) => !removed.has(item.id));
  const custom = user.items
    .filter((item) => !removed.has(String(item.id)))
    .map((item) => ({
      id: String(item.id),
      scene: 'outreach',
      title: String(item.title || '自定义'),
      text: String(item.text),
      accountTypes: Array.isArray(item.accountTypes) && item.accountTypes.length
        ? item.accountTypes.filter((t) => t === 'enterprise' || t === 'personal' || t === 'unverified')
        : ['enterprise', 'personal'],
      custom: true,
    }));
  return builtin.concat(custom);
}

/** 添加一条自定义话术（用户自己维护的库，落在 user-scripts.json）。 */
export function addUserScript({ scene = 'outreach', title = '', text = '', accountTypes, home, now = new Date() } = {}) {
  const body = String(text || '').trim();
  if (!body) throw new Error('话术内容不能为空');
  if (body.length > 500) throw new Error('话术太长（≤500 字）');
  const sceneId = String(scene || 'outreach');
  if (!SCRIPT_SCENES.some((s) => s.id === sceneId)) throw new Error('未知场景：' + sceneId);
  const types = Array.isArray(accountTypes) && accountTypes.length
    ? accountTypes.filter((t) => t === 'enterprise' || t === 'personal' || t === 'unverified')
    : ['enterprise', 'personal'];
  if (!types.length) throw new Error('适用账号类型不能为空');
  const suffix = Math.random().toString(36).slice(2, 6);
  const id = 'u' + String(now.getTime()).slice(-9) + suffix;
  const data = readUserScripts({ home });
  const item = { id, scene: 'outreach', title: String(title || '').trim() || '自定义', text: body, accountTypes: types, createdAt: now.toISOString() };
  data.items.push(item);
  if (data.items.length > 300) data.items = data.items.slice(-300);
  const saved = writeUserScripts(data, { home });
  return { item: Object.assign({ custom: true }, item), file: saved.file, total: mergedScripts({ home }).length };
}

/** 删除一条话术：用户添加的直接移除；内置的记入 removed（隐藏，可恢复）。 */
export function deleteScript({ id = '', home } = {}) {
  const target = String(id || '').trim();
  if (!target) throw new Error('缺少要删除的话术 id');
  const data = readUserScripts({ home });
  const userIdx = data.items.findIndex((it) => String(it.id) === target);
  if (userIdx >= 0) {
    data.items.splice(userIdx, 1);
    data.removed = data.removed.filter((x) => String(x) !== target);
    const saved = writeUserScripts(data, { home });
    return { ok: true, id: target, hidden: false, file: saved.file, total: mergedScripts({ home }).length };
  }
  if (!SCRIPTS.some((item) => item.id === target)) throw new Error('没有找到这条话术：' + target);
  if (!data.removed.includes(target)) data.removed.push(target);
  if (data.removed.length > 300) data.removed = data.removed.slice(-300);
  const saved = writeUserScripts(data, { home });
  return { ok: true, id: target, hidden: true, file: saved.file, total: mergedScripts({ home }).length };
}

export function sceneLabel(id) {
  const hit = SCRIPT_SCENES.find((s) => s.id === id);
  return hit ? hit.label : String(id || '');
}

/** 账号类型可用的场景 id 列表（白号没有可用场景）。 */
export function allowedScenes(accountType) {
  if (!accountType) return SCRIPT_SCENES.map((s) => s.id);
  return (ACCOUNT_SCENES[accountType] || []).slice();
}

/**
 * 列出话术（按场景 / 账号类型过滤，含用户自定义）。
 * @param {{scene?: string, accountType?: string, home?: string}} [options]
 */
export function listScripts({ scene = '', accountType = '', home } = {}) {
  const allowed = accountType ? (ACCOUNT_SCENES[accountType] || []) : null;
  const items = mergedScripts({ home });
  return items.filter((item) => {
    if (scene && item.scene !== scene) return false;
    if (allowed && !allowed.includes(item.scene)) return false;
    if (accountType && !item.accountTypes.includes(accountType)) return false;
    return true;
  });
}

/**
 * 随机挑一条（尽量避开最近用过的 id）。
 * @param {{scene?: string, accountType?: string, avoidIds?: string[], home?: string, random?: () => number}} [options]
 */
export function pickScript({ scene = '', accountType = '', avoidIds = [], home, random = Math.random } = {}) {
  const pool = listScripts({ scene, accountType, home });
  if (!pool.length) return null;
  const avoided = new Set((avoidIds || []).map(String));
  const fresh = pool.filter((item) => !avoided.has(item.id));
  const list = fresh.length ? fresh : pool;
  const index = Math.min(list.length - 1, Math.floor(random() * list.length));
  return list[Math.max(0, index)];
}

export default {
  SCRIPT_LIBRARY_VERSION, USER_SCRIPTS_VERSION, SCRIPT_SCENES, SCRIPT_RULES, SCRIPTS,
  listScripts, pickScript, sceneLabel, allowedScenes,
  userScriptsPath, readUserScripts, addUserScript, deleteScript,
};
