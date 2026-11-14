/**
 * 抖音获客话术库（v0.9.27，v0.9.24 起内置；v0.9.25 增加「主动私信获客」场景，供 agent 调用）
 *
 * 目的：给「agent 半自动获客 / 人工操作」提供成体系的、可轮换的话术，降低同一句话高频重复
 * 触发风控/验证的概率。这里是**纯文案资产**；agent 通过工具 `douyin_outreach`（outreach.mjs）
 * 读话术、填变量、做发送前检查与配额记账，`douyin_outreach action=send` 会走受控发送
 * （dryRun 默认 true；硬闸门在前端工具层，核心发送器在 core 的 `sendDouyinDmBatch`）。
 *
 * 使用边界（务必看 SCRIPT_RULES）：
 *   · 默认不自动群发；真发必须显式 dryRun:false 且使用者已确认。
 *   · 账号类型不同，能用的场景不同：蓝V / 个人认证 / 注册满 1 个月的个人账号可私信获客；白号（新号）只建议公开评论
 *     （允许私信但配额更保守，遇验证立刻停）。
 *   · 配额是运营经验值，不是抖音官方额度；到量就停，遇到验证立刻停。
 *   · 主动私信获客的第一句 = 打招呼 + 自我介绍（我是谁、做什么）+ 为什么找他 + 一句轻问，
 *     第一条不要放价格 / 联系方式 / 链接。
 *
 * 变量：文本里的 {identity} / {nickname} / {videoTitle} / {city} / {direction} / {business} / {need}
 *       等占位符，由 agent 调 draft 时填掉（插件不会自动填，避免填错成硬广）。
 */

export const SCRIPT_LIBRARY_VERSION = '0.9.38';

/** 场景（前端 tab 用） */
export const SCRIPT_SCENES = [
  { id: 'comment', label: '评论互动', desc: '公开评论，最安全；白号（新号，注册不足 1 个月）只能用这一类' },
  { id: 'dm', label: '私信打招呼', desc: '首条私信：先给理由，再提一个小问题' },
  { id: 'outreach', label: '主动私信获客', desc: '主动找目标用户：先打招呼、自我介绍（我是谁、做什么），再说为什么找他，首条不推销' },
  { id: 'followup', label: '追问 / 邀约', desc: '对方回应之后再用，别第一条就推销' },
];

/** 使用规则（页面上直接展示，也是配额提醒的文案来源） */
export const SCRIPT_RULES = [
  '同一句话不要连续发给同一个人；对同一个人 7 天内最多 1 次',
  '同一账号每天用完全相同的句子不超过 3 次，尽量在库里轮换',
  '白号（注册不足 1 个月的新号）：不建议私信（0 条），评论 ≤ 50 条/天；先从公开评论起步',
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
 * @property {'comment'|'dm'|'followup'} scene
 * @property {string} title 风格标签
 * @property {string} text 话术正文（含 {变量}）
 * @property {string[]} accountTypes 适用账号类型（enterprise / personal / unverified）
 */

/** @type {ScriptItem[]} */
export const SCRIPTS = [
  // ---- 评论互动（公开评论，风险最低）----
  {
    id: 'c01', scene: 'comment', title: '共鸣式',
    text: '你这里说得太真实了，我前两天也遇到一模一样的情况',
    accountTypes: ['enterprise', 'personal', 'unverified'],
  },
  {
    id: 'c02', scene: 'comment', title: '认同式',
    text: '看完这条一下想明白了，之前一直绕不过这个弯',
    accountTypes: ['enterprise', 'personal', 'unverified'],
  },
  {
    id: 'c03', scene: 'comment', title: '夸细节',
    text: '细节讲得很清楚，比很多长篇大论有用多了',
    accountTypes: ['enterprise', 'personal', 'unverified'],
  },
  {
    id: 'c04', scene: 'comment', title: '提问式',
    text: '想问下 {direction} 这块你一般怎么处理？想跟着学一下',
    accountTypes: ['enterprise', 'personal', 'unverified'],
  },
  {
    id: 'c05', scene: 'comment', title: '同城',
    text: '同城路过支持一下，内容做得很用心',
    accountTypes: ['enterprise', 'personal', 'unverified'],
  },
  {
    id: 'c06', scene: 'comment', title: '收藏',
    text: '这条先收藏了，回头照着试一遍',
    accountTypes: ['enterprise', 'personal', 'unverified'],
  },
  {
    id: 'c07', scene: 'comment', title: '替朋友问',
    text: '你视频里提到的那个点，我朋友前两天也在问，正好找到答案了',
    accountTypes: ['enterprise', 'personal', 'unverified'],
  },
  {
    id: 'c08', scene: 'comment', title: '蹲后续',
    text: '蹲个后续，有更新记得发出来',
    accountTypes: ['enterprise', 'personal', 'unverified'],
  },
  {
    id: 'c09', scene: 'comment', title: '补充经验',
    text: '补充一点我的经验：{point}，你这条算是把关键说透了',
    accountTypes: ['enterprise', 'personal', 'unverified'],
  },
  {
    id: 'c10', scene: 'comment', title: '真诚提问',
    text: '刚好在纠结 {topic}，你这条给了一个新角度，能展开讲讲吗',
    accountTypes: ['enterprise', 'personal', 'unverified'],
  },

  // ---- 私信打招呼（首条，先给理由 + 一个小问题）----
  {
    id: 'd01', scene: 'dm', title: '就事论事',
    text: '你好，刷到你「{videoTitle}」那条，讲得挺实在，想请教一个小问题：{question}？',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'd02', scene: 'dm', title: '老粉冒泡',
    text: '关注你挺久了，第一次冒泡。你做的 {direction} 内容对我帮助很大，方便交流一下吗？',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'd03', scene: 'dm', title: '同频',
    text: '看到你也在做 {industry}，我这边刚好整理了一份 {material}，需要的话发你参考',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'd04', scene: 'dm', title: '找伙伴',
    text: '你好，我在做 {business}，想找 {city} 做 {direction} 的伙伴聊聊，你这边方便吗？',
    accountTypes: ['enterprise'],
  },
  {
    id: 'd05', scene: 'dm', title: '具体需求',
    text: '冒昧打扰，请问你最近还接 {need} 吗？有个具体的小问题想问问',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'd06', scene: 'dm', title: '请教两句',
    text: '你的「{videoTitle}」那条很有启发，我们这边正好在 {scene}，能不能请教两句？',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'd07', scene: 'dm', title: '先自我介绍',
    text: '先自我介绍下：我做 {business}。看到你的内容觉得方向挺近，想认识一下',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'd08', scene: 'dm', title: '不求推销',
    text: '不推销也不打扰，就想问一句：你 {direction} 做了多久？想请教点经验',
    accountTypes: ['enterprise', 'personal'],
  },

  // ---- 主动私信获客（v0.9.27：打招呼 + 自我介绍（{identity}/{business}）+ 一个具体理由 + 一句轻问；首条不报价、不推销）----
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

  // ---- 追问 / 邀约（对方回应之后）----
  {
    id: 'f01', scene: 'followup', title: '同步情况',
    text: '谢谢回复！那我先说下我的情况：{situation}，你看这样理解对吗？',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'f02', scene: 'followup', title: '先试再反馈',
    text: '明白，那我按你说的先试一下，有进展再来跟你同步',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'f03', scene: 'followup', title: '给资料',
    text: '方便的话我把整理好的 {material} 发你一份，你看要不要，不需要也没关系',
    accountTypes: ['enterprise'],
  },
  {
    id: 'f04', scene: 'followup', title: '不催',
    text: '不着急，你先忙。等你有空我们再聊 {topic}',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'f05', scene: 'followup', title: '带回反馈',
    text: '这条我先记下了，回头按你的思路做一版，再拿来请教你',
    accountTypes: ['enterprise', 'personal'],
  },
  {
    id: 'f06', scene: 'followup', title: '分享邀约',
    text: '如果方便，下次我做 {direction} 的分享时叫你一声，一起看看',
    accountTypes: ['enterprise', 'personal'],
  },
];

/** 账号类型 → 允许场景（白号=新号：只允许公开评论） */
const ACCOUNT_SCENES = {
  enterprise: ['comment', 'dm', 'outreach', 'followup'],
  personal: ['comment', 'dm', 'outreach', 'followup'],
  unverified: ['comment'],
};

export function sceneLabel(id) {
  const hit = SCRIPT_SCENES.find((s) => s.id === id);
  return hit ? hit.label : String(id || '');
}

/** 账号类型可用的场景 id 列表（白号只允许公开评论） */
export function allowedScenes(accountType) {
  if (!accountType) return SCRIPT_SCENES.map((s) => s.id);
  return (ACCOUNT_SCENES[accountType] || ['comment']).slice();
}

/**
 * 列出话术（按场景 / 账号类型过滤）。
 * @param {{scene?: string, accountType?: string}} [options]
 */
export function listScripts({ scene = '', accountType = '' } = {}) {
  const allowed = accountType ? (ACCOUNT_SCENES[accountType] || ['comment']) : null;
  // v0.9.30：白号（新号）只给公开评论话术；老号（个人账号/个人认证）不受影响
  const effectiveType = accountType === 'unverified' ? 'personal' : accountType;
  return SCRIPTS.filter((item) => {
    if (scene && item.scene !== scene) return false;
    if (allowed && !allowed.includes(item.scene)) return false;
    if (effectiveType && !item.accountTypes.includes(effectiveType)) return false;
    return true;
  });
}

/**
 * 随机挑一条（尽量避开最近用过的 id）。
 * @param {{scene?: string, accountType?: string, avoidIds?: string[], random?: () => number}} [options]
 */
export function pickScript({ scene = '', accountType = '', avoidIds = [], random = Math.random } = {}) {
  const pool = listScripts({ scene, accountType });
  if (!pool.length) return null;
  const avoided = new Set((avoidIds || []).map(String));
  const fresh = pool.filter((item) => !avoided.has(item.id));
  const list = fresh.length ? fresh : pool;
  const index = Math.min(list.length - 1, Math.floor(random() * list.length));
  return list[Math.max(0, index)];
}

export default { SCRIPT_LIBRARY_VERSION, SCRIPT_SCENES, SCRIPT_RULES, SCRIPTS, listScripts, pickScript, sceneLabel, allowedScenes };
