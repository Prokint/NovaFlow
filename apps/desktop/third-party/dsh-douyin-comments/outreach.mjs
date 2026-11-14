/**
 * 抖音主动私信获客：agent 侧工具层（v0.9.25 起）
 *
 * 定位：话术库（scripts-library.mjs）是「文案资产」，这里把资产变成 **agent 可直接调用的能力**：
 *   · guide  → 账号类型该用哪些场景、当天配额、获客执行清单
 *   · list   → 按场景/账号类型列话术（带 id，可让 agent 指定或避开）
 *   · pick   → 随机挑一条（支持 avoidIds，避免连续用同一句）
 *   · draft  → 把 {变量} 填成可发送的文案，并做发送前检查（变量缺失/联系方式/配额/重复目标）
 *   · record → 记一条「已发」，用于配额统计与重复检查
 *   · quota  → 查当前账号今天/本小时已用与剩余
 *
 * 边界：本模块**不发送任何内容**，也不操作抖音页面；发送仍由 agent 或使用者完成。
 * 配额是运营经验值，不是抖音官方额度；出现验证/滑块应立刻停手。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listScripts, pickScript, sceneLabel, allowedScenes,
  SCRIPT_RULES, SCRIPT_SCENES, SCRIPT_LIBRARY_VERSION,
} from './scripts-library.mjs';

/** 记录文件版本（和抖音账号档案一样是本地 JSON，不进远端）。 */
export const OUTREACH_LOG_VERSION = 1;

/** 账号类型 → 经验配额（评论/天、私信/天、每小时私信）。 */
export const OUTREACH_QUOTAS = {
  enterprise: { label: '蓝V企业号', commentPerDay: 300, dmPerDay: 80, dmPerHour: 30 },
  personal: { label: '个人认证', commentPerDay: 200, dmPerDay: 30, dmPerHour: 5 },
  // 0.9.30：白号 = 没有官方认证且注册不足 1 个月（30 天）的新号，按用户规则：不建议私信、评论 ≤ 50/天。
  unverified: { label: '白号（新号）', commentPerDay: 50, dmPerDay: 0, dmPerHour: 0 },
};

/** 没识别过账号类型时按「个人认证」的保守口径算。 */
const FALLBACK_ACCOUNT_TYPE = 'personal';

/** 算作私信的场景（用于私信/小时配额）。comment 只算评论配额。 */
const DM_SCENES = new Set(['dm', 'outreach']);

/** 文案里出现这些词，基本就是硬广/导流，发送前拦一下。 */
const CONTACT_WORD_RE = /(微信|威信|vx|VX|v信|加我|加薇|电话|手机号|QQ|企鹅|二维码|扫码|链接|https?:|www\.|私域|导流)/u;

const MAX_ENTRIES = 5000;

/** 插件工作目录，解析规则与 collector.mjs 的 DEFAULTS.home 保持一致。 */
function homeDir(home) {
  if (home) return String(home);
  if (process.env.DOUYIN_HOME) return process.env.DOUYIN_HOME;
  if (process.env.DSH_HOME) return path.join(process.env.DSH_HOME, 'douyin-collector');
  return path.join(os.homedir(), '.dsh', 'douyin-collector');
}

export function outreachLogPath(home) {
  return path.join(homeDir(home), 'outreach-log.json');
}

/** 读记录文件；文件坏了/不存在都退化成空记录，不影响工具可用。 */
export function readOutreachLog({ home } = {}) {
  const file = outreachLogPath(home);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.entries)) {
      return {
        version: Number(parsed.version) || OUTREACH_LOG_VERSION,
        updatedAt: String(parsed.updatedAt || ''),
        entries: parsed.entries.filter((e) => e && typeof e === 'object'),
      };
    }
  } catch { /* 不存在或损坏都当空 */ }
  return { version: OUTREACH_LOG_VERSION, updatedAt: '', entries: [] };
}

function writeOutreachLog(store, { home } = {}) {
  const file = outreachLogPath(home);
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 目录已存在 */ }
  const entries = (store.entries || []).slice(-MAX_ENTRIES);
  const payload = {
    version: OUTREACH_LOG_VERSION,
    updatedAt: new Date().toISOString(),
    entries,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

/** 本地日期键（YYYY-MM-DD），按使用者本机时区算，不用 UTC。 */
function localDayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 本地小时键（YYYY-MM-DDTHH）。 */
function localHourKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return localDayKey(d) + 'T' + String(d.getHours()).padStart(2, '0');
}

function normalizeTarget(target) {
  return String(target == null ? '' : target).trim().toLowerCase();
}

/** 账号类型归一：没给/不认识的都按保守口径，并带一条提示。 */
function resolveAccountType(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (OUTREACH_QUOTAS[key]) {
    return { type: key, quota: OUTREACH_QUOTAS[key], unknown: false };
  }
  return { type: FALLBACK_ACCOUNT_TYPE, quota: OUTREACH_QUOTAS[FALLBACK_ACCOUNT_TYPE], unknown: true };
}

/**
 * 今天/本小时用量与剩余。
 * @param {{accountType?: string, home?: string, now?: Date}} [options]
 */
export function outreachQuota({ accountType = '', home, now = new Date() } = {}) {
  const resolved = resolveAccountType(accountType);
  const store = readOutreachLog({ home });
  const day = localDayKey(now);
  const hour = localHourKey(now);
  let commentToday = 0;
  let dmToday = 0;
  let dmThisHour = 0;
  let followsToday = 0;
  for (const e of store.entries) {
    const at = String(e.at || '');
    if (!at) continue;
    const scene = String(e.scene || '');
    if (at.slice(0, 10) === day) {
      if (scene === 'comment') commentToday += 1;
      if (DM_SCENES.has(scene)) dmToday += 1;
      if (e.followed === true) followsToday += 1;
    }
    if (at.slice(0, 13) === hour) {
      if (DM_SCENES.has(scene)) dmThisHour += 1;
    }
  }
  const limits = {
    commentPerDay: resolved.quota.commentPerDay,
    dmPerDay: resolved.quota.dmPerDay,
    dmPerHour: resolved.quota.dmPerHour,
  };
  const remaining = {
    commentToday: Math.max(0, limits.commentPerDay - commentToday),
    dmToday: Math.max(0, limits.dmPerDay - dmToday),
    dmThisHour: Math.max(0, limits.dmPerHour - dmThisHour),
  };
  const warnings = [];
  if (resolved.unknown) {
    warnings.push('没有识别过账号类型，这里按「' + resolved.quota.label + '」的保守配额计算；先调用 douyin_account_info action=refresh 识别一次。');
  }
  if (resolved.type === 'unverified') {
    warnings.push('白号（注册不足 1 个月的新号）：不建议私信（私信配额 ' + limits.dmPerDay + ' 条/天）、评论 ≤ ' + limits.commentPerDay + ' 条/天；新号更容易触发验证，遇到验证/频繁提示立即停手。');
  }
  if (remaining.dmToday === 0 && limits.dmPerDay > 0) {
    warnings.push('今天私信已达上限（' + limits.dmPerDay + ' 条），建议今天停手，明天再发。');
  }
  if (followsToday >= 100) {
    warnings.push('今天已经关注了 ' + followsToday + ' 个陌生人（经验阈值约 100/天），建议放慢，明天再继续关注，避免被判定为营销号。');
  }
  return {
    accountType: resolved.type,
    accountTypeLabel: resolved.quota.label,
    unknownAccountType: resolved.unknown,
    limits,
    used: { commentToday, dmToday, dmThisHour, followsToday },
    remaining,
    warnings,
  };
}

/** 发送前/记账时共用的检查：同一条话术今天用了几次、同一个目标 7 天内是否发过。 */
export function outreachPrecheck({ scriptId = '', target = '', accountType = '', home, now = new Date() } = {}) {
  const store = readOutreachLog({ home });
  const day = localDayKey(now);
  const since7d = new Date((now instanceof Date ? now : new Date(now)).getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const warnings = [];
  if (scriptId) {
    const sameScriptToday = store.entries.filter((e) => String(e.at || '').slice(0, 10) === day && String(e.scriptId || '') === String(scriptId)).length;
    if (sameScriptToday >= 3) warnings.push('这条话术（' + scriptId + '）今天已经用了 ' + sameScriptToday + ' 次，建议换一条再发。');
  }
  const norm = normalizeTarget(target);
  if (norm) {
    const recent = store.entries.filter((e) => {
      if (String(e.target || '').trim().toLowerCase() !== norm) return false;
      if (DM_SCENES.has(String(e.scene || ''))) return true;
      return false;
    }).filter((e) => String(e.at || '') >= since7d);
    if (recent.length) warnings.push('对同一个目标 7 天内已经发过私信（最近一次 ' + String(recent[recent.length - 1].at || '') + '），别重复发。');
  }
  const quota = outreachQuota({ accountType, home, now });
  if (quota.warnings.length) warnings.push(...quota.warnings);
  return { warnings, quota };
}

/** 把 {变量} 替换成 values；返回仍是占位符的变量名。 */
export function renderScriptText(text, variables = {}) {
  const vars = (variables && typeof variables === 'object') ? variables : {};
  const missing = [];
  const rendered = String(text || '').replace(/\{([A-Za-z0-9_]+)\}/gu, (whole, key) => {
    const v = vars[key];
    if (v == null || String(v).trim() === '') {
      if (!missing.includes(key)) missing.push(key);
      return whole;
    }
    return String(v).trim();
  });
  return { text: rendered, missing };
}

/** 给 agent 的获客执行清单（guide 的正文来源）。 */
export function outreachChecklist() {
  return [
    '1) 先用 douyin_account_info 确认自己的账号类型（白号=新号：不建议私信；个人账号/蓝V 才走私信获客）。',
    '2) 用 douyin_comments 采集目标（关键词搜视频 / 指定视频评论），导出 CSV 挑出「有明确意向」的人，不要全量群发。',
    '3) 用 douyin_outreach action=draft 选话术并填 {变量}；第一条必须有「打招呼 + 自我介绍」（{identity}/{business}：我是谁、做什么），再补上为什么找他；同一条话术不要连续发给不同人，7 天内对同一人最多 1 次。',
    '4) 每发一条就调 action=record 记账；到配额/出现验证或滑块立刻停手。',
    '5) 首条私信先给理由和价值、再问一个小问题；不要放价格、联系方式、链接，不要第一条就推销。',
  ];
}

/** 账号类型可用的场景（带中文名）。 */
export function outreachScenes({ accountType = '' } = {}) {
  const allowed = allowedScenes(String(accountType || '') || undefined);
  return SCRIPT_SCENES.filter((s) => allowed.includes(s.id))
    .map((s) => ({ id: s.id, label: s.label, desc: s.desc }));
}

/**
 * 列出可用话术。
 * @param {{scene?: string, accountType?: string, limit?: number}} [options]
 */
export function outreachList({ scene = '', accountType = '', limit = 0 } = {}) {
  const list = listScripts({ scene: String(scene || ''), accountType: String(accountType || '') })
    .map((item) => ({ id: item.id, scene: item.scene, sceneLabel: sceneLabel(item.scene), title: item.title, text: item.text }));
  return limit > 0 ? list.slice(0, limit) : list;
}

/**
 * 挑一条话术（避开 avoidIds）。
 * @param {{scene?: string, accountType?: string, avoidIds?: string[]}} [options]
 */
export function outreachPick({ scene = '', accountType = '', avoidIds = [] } = {}) {
  const item = pickScript({ scene: String(scene || ''), accountType: String(accountType || ''), avoidIds: avoidIds || [] });
  return item ? { id: item.id, scene: item.scene, sceneLabel: sceneLabel(item.scene), title: item.title, text: item.text } : null;
}

/**
 * 生成一条待发文案（不发送）。
 * @param {{scene?: string, accountType?: string, scriptId?: string, variables?: object, target?: string, avoidIds?: string[], home?: string, now?: Date}} [options]
 */
export function outreachDraft({
  scene = '', accountType = '', scriptId = '', variables = {}, target = '', avoidIds = [], home, now = new Date(),
} = {}) {
  const item = scriptId
    ? (listScripts({ accountType: String(accountType || '') }).find((s) => s.id === String(scriptId)) || null)
    : outreachPick({ scene, accountType, avoidIds });
  if (!item) {
    throw new Error('这个场景下没有可用话术' + (accountType ? '（当前账号类型不允许该场景）' : ''));
  }
  const rendered = renderScriptText(item.text, variables);
  const warnings = [];
  if (rendered.missing.length) {
    warnings.push('还有变量没填：' + rendered.missing.map((k) => '{' + k + '}').join('、') + '（发送前必须换成真实内容）。');
  }
  if (CONTACT_WORD_RE.test(rendered.text)) {
    warnings.push('文案里带联系方式/导流词，容易被判营销：建议删掉再发。');
  }
  const precheck = outreachPrecheck({ scriptId: item.id, target, accountType, home, now });
  warnings.push(...precheck.warnings);
  const quota = precheck.quota;
  if (DM_SCENES.has(item.scene) && quota.remaining.dmToday === 0) {
    warnings.push('剩余私信额度为 0，这条先别发。');
  }
  return {
    scriptId: item.id,
    scene: item.scene,
    sceneLabel: sceneLabel(item.scene),
    title: item.title,
    text: rendered.text,
    missingVariables: rendered.missing,
    warnings,
    quota,
    libraryVersion: SCRIPT_LIBRARY_VERSION,
  };
}

/**
 * 记一条「已发」。没有发送的 action 参数就只记账，不会碰抖音页面。
 * @param {{scene?: string, scriptId?: string, accountType?: string, target?: string, note?: string, followed?: boolean, home?: string, now?: Date}} [options]
 */
export function outreachRecord({
  scene = '', scriptId = '', accountType = '', target = '', note = '', followed = false, home, now = new Date(),
} = {}) {
  const sceneId = String(scene || '').trim();
  const allowed = allowedScenes(String(accountType || '') || undefined);
  if (!sceneId || !SCRIPT_SCENES.some((s) => s.id === sceneId)) throw new Error('record 需要合法 scene（v0.9.39 只保留 outreach：主动私信获客）');
  if (String(accountType || '') && !allowed.includes(sceneId)) throw new Error('当前账号类型不允许这个场景（白号（新号）不建议私信获客）');
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  const entry = {
    at,
    scene: sceneId,
    scriptId: String(scriptId || ''),
    accountType: String(accountType || ''),
    target: String(target || ''),
    note: String(note || ''),
    followed: followed === true,
  };
  const store = readOutreachLog({ home });
  // 先做发送前检查（此时还没有这条记录），再记账，避免「自己算成 7 天内已发」。
  const precheck = outreachPrecheck({ scriptId: entry.scriptId, target: entry.target, accountType, home, now });
  store.entries.push(entry);
  store.version = OUTREACH_LOG_VERSION;
  store.updatedAt = at;
  const file = writeOutreachLog(store, { home });
  const quota = outreachQuota({ accountType, home, now });
  return {
    entry,
    file,
    warnings: precheck.warnings,
    quota,
    total: store.entries.length,
  };
}

/** guide：账号类型 + 可用场景 + 规则 + 配额 + 执行清单。 */
export function outreachGuide({ accountType = '', home, now = new Date() } = {}) {
  const quota = outreachQuota({ accountType, home, now });
  return {
    libraryVersion: SCRIPT_LIBRARY_VERSION,
    accountType: quota.accountType,
    accountTypeLabel: quota.accountTypeLabel,
    scenes: outreachScenes({ accountType: quota.accountType }),
    rules: SCRIPT_RULES.slice(),
    checklist: outreachChecklist(),
    quota,
    logFile: outreachLogPath(home),
  };
}

export default {
  OUTREACH_LOG_VERSION, OUTREACH_QUOTAS, outreachLogPath, readOutreachLog, outreachQuota,
  outreachPrecheck, outreachList, outreachPick, outreachDraft, outreachRecord,
  outreachGuide, outreachScenes, outreachChecklist, renderScriptText,
};
