/**
 * 「计价单位」复合控件（ego 版）—— 移植自原 Playwright/CDP 脚本 `tb_fill_measure.js`。
 *
 * ── 原脚本 ──────────────────────────────────────────────────────────────
 *   taobao-product-listing\scripts\tb_fill_measure.js
 *   干什么：计价单位 = **数字输入 + 单位下拉**（复合控件 / taoSirProp），墙纸类目用。
 *   默认 1 卷，可用 TB_NUM / TB_UNIT 覆盖。原位没有 ok/退出码，只把读回打到日志。
 *
 * ── 移植差异（locator→evaluate、真实鼠标） ──────────────────────────────
 *   1) 取页：不连 CDP —— page 由编排层传进来；原「没有发布页就静默 return」改成
 *      `{ok:false, why:'no_publish_page'}`（编排层要能判定「这一步没做」）。
 *   2) 定位：ego 无 locator → 全部 `page.evaluate`：
 *      · 数字框：`div` 里文本以 `*计价单位` 开头、长度 < 40、取最短；容器内第一个可见 input，
 *        没有就向上最多 3 层找；
 *      · 单位下拉：`div,span,input` 里文本/placeholder 含「请选单位」，**取最后一个可见的**，
 *        target = 它内部的 input（没有就用它自己）。
 *   3) 点击：move（ego 没有就跳过）→ 250ms → 真实鼠标 click → 2000ms 等弹层；选值仍是
 *      原脚本的合成 `mousedown/mouseup/click`；最后点空白触发 blur（三处候选点，原样）。
 *   4) 数字框：仍走受控 setter + input/change/blur（原样）；**新增读回不一致时的真实鼠标 +
 *      键盘兜底**（点数字框 → Ctrl+A → insertText → Tab → 点空白，再读回）。
 *   5) 配置：ego 子进程不继承环境变量，也不再读 process.env（原 TB_NUM / TB_UNIT）→
 *      取值顺序：`opts.num/opts.unit` → `globalThis.__TB_CFG.measureNum/measureUnit`
 *      （兼容 `num/unit`）→ product.json 的 `attributes['计价单位']`（`1卷` 或 `{数量,单位}`）
 *      → 默认 `1` / `卷`。
 *   6) 判定：原脚本没有成功判据，只打印读回 → ego 版必须给 ok，判据定为
 *      「数字读回 === 期望 **且** 单位下拉点中」。容器文本是否含单位只放 `读回含单位` 作诊断，
 *      不参与 ok（原脚本的容器文本是截 40 字，可能只截到标签 → 参与判定会假失败）。
 *      这是新增判据（原脚本无），已在最终回复里标注「需现场确认」。
 *   7) 导出接口：`fillMeasure(page, product, opts?)`（第三参数可省略）。
 *
 * ── 仍然依赖的硬规则 ────────────────────────────────────────────────────
 *   · 数字框定位**不能**按全局第一个 input 找：页面别处（标题/货号）也有 input → 必须按
 *     「计价单位」这个词的容器锚定，并取最短匹配（否则拿到整块属性区）。
 *   · 单位下拉的触发文本是「请选单位」占位符，**取最后一个可见命中**（页面上方可能还有一个
 *     同名控件/说明）；点开前必须 `scrollIntoView({block:'center'})`。
 *   · 选单位只认**文本全等且长度 ≤ 3** 的节点（`卷`/`米`/`平方米`），避免点到「卷（含…）」这类长文案。
 *   · 选完必须点空白触发 blur，否则值不生效。
 *   · 该控件只在墙纸类目出现；找不到容器就返回 `no_box` / `no_num_input` / `no_unit_select`，
 *     由编排层按 catId 决定这一步是否适用（**不要**在没有该控件的类目上硬填）。
 *
 * 不要在本文件里连浏览器/开进程；只导出函数，由同一个 ego 进程里的编排脚本调用。
 */
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { sleep, say, waitUntil } from '../lib/tb_ego.mjs'

/** ego 子进程不继承自定义环境变量 → 配置只从 globalThis.__TB_CFG 惰性读。 */
const cfg = () => (typeof globalThis !== 'undefined' && globalThis.__TB_CFG) || {}
const pick = (key, dflt) => {
  const c = cfg()
  if (c[key] !== undefined && c[key] !== null && c[key] !== '') return c[key]
  return dflt
}
const firstDefined = (...vals) => {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

const msg = (e) => String((e && e.message) || e || 'unknown_error')
const json = (v) => {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

const getUrl = async (page) => {
  try {
    return String(await page.url())
  } catch {
    return ''
  }
}

// ── 真实鼠标 / 键盘安全封装 ──────────────────────────────────────────────────
const mouseMove = async (page, x, y) => {
  const fn = page && page.mouse && page.mouse.move
  if (typeof fn !== 'function') return { ok: false, why: 'no_mouse_move' }
  try {
    await fn.call(page.mouse, x, y)
    return { ok: true }
  } catch (e) {
    return { ok: false, why: msg(e) }
  }
}

const mouseClick = async (page, x, y, label = '', { retryPlain = false } = {}) => {
  if (!page || !page.mouse || typeof page.mouse.click !== 'function') return { ok: false, why: 'no_mouse_click' }
  try {
    await page.mouse.click(x, y, { label })
    return { ok: true, how: 'labelled' }
  } catch (e) {
    if (!retryPlain) return { ok: false, why: msg(e) }
    try {
      await page.mouse.click(x, y)
      return { ok: true, how: 'plain' }
    } catch (e2) {
      return { ok: false, why: msg(e2) }
    }
  }
}

const keyPress = async (page, key) => {
  try {
    await page.keyboard.press(key)
    return { ok: true }
  } catch (e) {
    return { ok: false, why: msg(e) }
  }
}

const typeText = async (page, text) => {
  const s = String(text)
  if (page && page.keyboard && typeof page.keyboard.insertText === 'function') {
    try {
      await page.keyboard.insertText(s)
      return { ok: true, how: 'insertText' }
    } catch {
      /* 落下面 */
    }
  }
  if (page && page.keyboard && typeof page.keyboard.type === 'function') {
    try {
      await page.keyboard.type(s)
      return { ok: true, how: 'type' }
    } catch {
      /* 落下面 */
    }
  }
  return { ok: false, why: 'no_keyboard_input' }
}

/** 点空白触发 blur（原位三处候选点：右上、左上、右下；真实鼠标）。
 *  ⚠️ 候选点先夹进视口（ego 窗口可能比 1250 宽/窄都不一定；越界时 elementFromPoint 为 null）。 */
async function clickBlank(page) {
  const blank = await page
    .evaluate(() => {
      const w = document.documentElement.clientWidth || window.innerWidth || 1280
      const h = document.documentElement.clientHeight || window.innerHeight || 800
      const clamp = (p) => ({
        x: Math.min(Math.max(2, p.x), Math.max(2, w - 2)),
        y: Math.min(Math.max(2, p.y), Math.max(2, h - 2)),
      })
      for (const c of [{ x: 1250, y: 60 }, { x: 300, y: 62 }, { x: 1250, y: 950 }]) {
        const q = clamp(c)
        const el = document.elementFromPoint(q.x, q.y)
        if (el && !el.closest('input,textarea,select,button,a')) return q
      }
      return clamp({ x: 1250, y: 60 })
    })
    .catch(() => ({ x: 1250, y: 60 }))
  const r = await mouseClick(page, blank.x, blank.y, 'blank', { retryPlain: true })
  return { ...r, at: blank }
}

// ── 浏览器侧函数（自包含） ───────────────────────────────────────────────────

/**
 * ① 数字框：按「计价单位」容器锚定（**不能**按全局第一个 input 找），受控 setter + 事件。
 * 返回坐标是为了给 Node 侧「读回不一致 → 真实鼠标键盘」兜底用。
 */
export async function locateNumInput(page) {
  return page
    .evaluate(async () => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const cands = Array.from(document.querySelectorAll('div'))
        .filter(vis)
        .filter((e) => /^\*?\s*计价单位/.test(clean(e.innerText)) && clean(e.innerText).length < 40)
      cands.sort((a, b) => a.innerText.length - b.innerText.length)
      const box = cands[0]
      if (!box) return { ok: false, why: 'no_box', 候选: cands.length }
      box.scrollIntoView({ block: 'center' })
      let inp = Array.from(box.querySelectorAll('input')).filter(vis)[0]
      if (!inp) {
        let p = box.parentElement
        for (let k = 0; k < 3 && p && !inp; k += 1) {
          inp = Array.from(p.querySelectorAll('input')).filter(vis)[0]
          if (!inp) p = p.parentElement
        }
      }
      if (!inp) return { ok: false, why: 'no_num_input', 容器: clean(box.innerText).slice(0, 30) }
      const r = inp.getBoundingClientRect()
      return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 现: inp.value }
    })
    .catch((e) => ({ ok: false, why: 'evaluate_failed', 详情: msg(e) }))
}

/** 填数字框（受控 setter + input/change/blur，原样）。 */
export async function setNumValue(page, num) {
  return page
    .evaluate(async ({ value }) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const sl = (ms) => new Promise((r) => setTimeout(r, ms))
      const cands = Array.from(document.querySelectorAll('div'))
        .filter(vis)
        .filter((e) => /^\*?\s*计价单位/.test(clean(e.innerText)) && clean(e.innerText).length < 40)
      cands.sort((a, b) => a.innerText.length - b.innerText.length)
      const box = cands[0]
      if (!box) return { ok: false, why: 'no_box' }
      box.scrollIntoView({ block: 'center' })
      let inp = Array.from(box.querySelectorAll('input')).filter(vis)[0]
      if (!inp) {
        let p = box.parentElement
        for (let k = 0; k < 3 && p && !inp; k += 1) {
          inp = Array.from(p.querySelectorAll('input')).filter(vis)[0]
          if (!inp) p = p.parentElement
        }
      }
      if (!inp) return { ok: false, why: 'no_num_input', 容器: clean(box.innerText).slice(0, 30) }
      inp.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, String(value))
      for (const ev of ['input', 'change', 'blur']) inp.dispatchEvent(new Event(ev, { bubbles: true }))
      await sl(700)
      return { ok: true, 数字读回: inp.value }
    }, { value: String(num) })
    .catch((e) => ({ ok: false, why: 'evaluate_failed', 详情: msg(e) }))
}

/** 读数字框当前值（兜底后复核用）。 */
export const readNumValue = (page) =>
  page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const cands = Array.from(document.querySelectorAll('div'))
        .filter(vis)
        .filter((e) => /^\*?\s*计价单位/.test(clean(e.innerText)) && clean(e.innerText).length < 40)
      cands.sort((a, b) => a.innerText.length - b.innerText.length)
      const box = cands[0]
      if (!box) return null
      let inp = Array.from(box.querySelectorAll('input')).filter(vis)[0]
      if (!inp) {
        let p = box.parentElement
        for (let k = 0; k < 3 && p && !inp; k += 1) {
          inp = Array.from(p.querySelectorAll('input')).filter(vis)[0]
          if (!inp) p = p.parentElement
        }
      }
      return inp ? inp.value : null
    })
    .catch(() => null)

/** ② 单位下拉：找「请选单位」触发点（取最后一个可见命中），返回坐标。 */
export async function locateUnitSelect(page) {
  return page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const hits = Array.from(document.querySelectorAll('div,span,input'))
        .filter(vis)
        .filter((e) => /请选单位/.test(clean(e.innerText) + (e.getAttribute && e.getAttribute('placeholder') || '')))
      const el = hits[hits.length - 1]
      if (!el) return { ok: false, why: 'no_unit_select', 全页有请选单位: false }
      const target = el.querySelector('input') || el
      target.scrollIntoView({ block: 'center' })
      const r = target.getBoundingClientRect()
      return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: target.tagName.toLowerCase() }
    })
    .catch((e) => ({ ok: false, why: 'evaluate_failed', 详情: msg(e) }))
}

/**
 * ③ 选单位：只认**文本全等且长度 ≤ 3** 的节点（`卷`/`米`/`平方米`），
 * 避免点到「卷（含…）」这类长文案；命中后合成 mousedown/mouseup/click。
 */
export async function pickUnit(page, unit) {
  return page
    .evaluate(async (u) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const all = Array.from(document.querySelectorAll('li,[class*=option-item],[class*=menu-item],div')).filter(vis)
      const hit = all.filter((e) => clean(e.innerText) === u && clean(e.innerText).length <= 3)[0]
      if (!hit) {
        return {
          ok: false,
          why: 'no_option',
          候选: Array.from(document.querySelectorAll('li,[class*=option-item]')).filter(vis).map((e) => clean(e.innerText)).slice(0, 14),
        }
      }
      for (const ev of ['mousedown', 'mouseup', 'click']) {
        hit.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
      }
      await new Promise((r) => setTimeout(r, 900))
      return { ok: true, 选中: clean(hit.innerText) }
    }, String(unit))
    .catch((e) => ({ ok: false, why: 'evaluate_failed', 详情: msg(e) }))
}

/** 最终读回：第一个「计价单位」容器（长度 < 40）的文本 + 里面的数字框值。 */
export async function readMeasure(page) {
  return page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const cands = Array.from(document.querySelectorAll('div')).filter((e) => /计价单位/.test(clean(e.innerText)) && clean(e.innerText).length < 40)
      if (!cands.length) return { 容器文本: null, 数字读回: null }
      const box = cands[0]
      const inp = Array.from(box.querySelectorAll('input')).filter((e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })[0]
      return { 容器文本: clean(box.innerText).slice(0, 40), 数字读回: inp ? inp.value : null }
    })
    .catch(() => ({ 容器文本: null, 数字读回: null }))
}

// ── product 装载 ─────────────────────────────────────────────────────────────
async function loadProduct(product) {
  if (product && typeof product === 'object') return product
  if (!product) return {}
  try {
    return JSON.parse(readFileSync(resolvePath(String(product)), 'utf8'))
  } catch (e) {
    return { __readError: msg(e) }
  }
}

/** 从素材包 `attributes['计价单位']`（`1卷` 或 `{数量,单位}`）解析出 { num, unit }。 */
function fromProductMeasure(ATTRS) {
  const raw = ATTRS['计价单位']
  if (typeof raw === 'string') {
    const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(.*)$/)
    if (m) return { num: m[1], unit: m[2].trim() || '' }
  }
  if (raw && typeof raw === 'object') {
    return { num: raw['数量'] ?? raw.num, unit: raw['单位'] ?? raw.unit }
  }
  return {}
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
/**
 * 填「计价单位」= 数字输入 + 单位下拉（复合控件）。
 *
 * @param page ego page（编排层 connectSpace 取好；本函数不 goto）。
 * @param product product.json 对象或路径（用于取 `attributes['计价单位']` 兜底）。
 * @param opts.num 覆盖数字（原 TB_NUM，默认 1）。
 * @param opts.unit 覆盖单位（原 TB_UNIT，默认 卷）。
 * @returns 成功 `{ ok:true, 数字读回, 选中单位, 读回 }`；
 *          失败 `{ ok:false, why, 数字读回, 选中单位, 读回, 失败 }`。
 */
export async function fillMeasure(page, product, opts = {}) {
  const url0 = await getUrl(page)
  if (!page || typeof page.evaluate !== 'function') return { ok: false, why: 'no_page', 读回: null }
  if (!/publish\.htm/.test(url0)) {
    say('没有发布页')
    return { ok: false, why: 'no_publish_page', 现有页: [url0.slice(0, 120)], 读回: null }
  }

  const PRODUCT = await loadProduct(product)
  if (PRODUCT.__readError) return { ok: false, why: 'product_read_failed', 详情: PRODUCT.__readError, 读回: null }
  const ATTRS = opts.attributes && typeof opts.attributes === 'object' ? opts.attributes : PRODUCT.attributes || {}
  const 素材 = fromProductMeasure(ATTRS)
  const NUM = String(firstDefined(opts.num, pick('measureNum', null), pick('num', null), 素材.num, '1'))
  const UNIT = String(firstDefined(opts.unit, pick('measureUnit', null), pick('unit', null), 素材.unit, '卷'))

  const 失败 = []

  // ① 数字框（受控 setter + 事件，原样）
  let s1 = await locateNumInput(page)
  let 方式数字 = 'setter'
  if (s1.ok) {
    const setRes = await setNumValue(page, NUM)
    // setRes 失败（no_box / no_num_input / evaluate 失败）时不要用旧坐标去点（可能点到别的控件）
    const 有坐标 = typeof s1.x === 'number' && typeof s1.y === 'number'
    s1 = { ...s1, ...setRes, ...(有坐标 ? {} : { 坐标: 'missing' }) }
    say('① 数字:', json(s1))
    if (setRes.ok === false) {
      失败.push(setRes.why || 'no_num_input')
    } else if (s1.数字读回 !== NUM && 有坐标) {
      // ego 兜底：真实鼠标点数字框 + Ctrl+A + 打字 + Tab + 点空白，再读回
      await mouseMove(page, s1.x, s1.y)
      await sleep(150)
      await mouseClick(page, s1.x, s1.y, 'measure-num')
      await sleep(250)
      await keyPress(page, 'Control+A')
      await typeText(page, NUM)
      await sleep(300)
      await keyPress(page, 'Tab')
      await sleep(200)
      await clickBlank(page)
      await sleep(300)
      const waited = await waitUntil(
        async () => {
          const v = await readNumValue(page)
          return v === NUM ? v : null
        },
        { timeoutMs: 2500, intervalMs: 250, label: 'measure-num-readback' },
      )
      const back = waited.value === null ? await readNumValue(page) : waited.value
      s1 = { ...s1, 数字读回: back, 兜底: 'mouse+keyboard' }
      方式数字 = 'setter+兜底'
    }
    if (s1.数字读回 !== NUM) 失败.push('计价单位数字读回不等于期望')
  } else {
    say('① 数字:', json(s1))
    失败.push(s1.why || 'no_num_input')
  }

  // ② 单位下拉（「请选单位」）
  const s2 = await locateUnitSelect(page)
  say('② 单位下拉:', json(s2))
  let 选中单位 = null
  let s3 = null
  let blankAt = null
  if (s2.ok) {
    await mouseMove(page, s2.x, s2.y)
    await sleep(250)
    const clicked = await mouseClick(page, s2.x, s2.y, 'measure-unit', { retryPlain: true })
    await sleep(2000)
    if (!clicked.ok) 失败.push('单位下拉点不开:' + clicked.why)
    // ③ 选单位
    s3 = await pickUnit(page, UNIT)
    say('③ 选单位:', json(s3))
    if (!s3.ok) {
      失败.push(s3.why || 'no_option')
    } else {
      选中单位 = s3.选中
    }
    await sleep(800)
    // 点空白触发 blur
    const blank = await clickBlank(page)
    blankAt = blank.at
    await sleep(900)
  } else {
    失败.push(s2.why || 'no_unit_select')
  }

  const back = await readMeasure(page)
  const 读回 = back ? back.容器文本 : null
  const 数字读回 = back && back.数字读回 !== null ? back.数字读回 : s1 && s1.数字读回 !== undefined ? s1.数字读回 : null
  say('读回:', json(back))

  // 判据（原脚本没有 ok，这里新增）：数字读回 == 期望 + 单位点中；
  // 容器文本是否含单位只作**诊断**（长短不一、可能只截到标签），不参与 ok，避免假失败。
  const 数字ok = 数字读回 === NUM
  const 单位ok = 选中单位 !== null && String(选中单位).includes(UNIT)
  const 文本一致 = 读回 === null ? null : String(读回).includes(UNIT)
  const ok = 数字ok && 单位ok
  const base = {
    数字读回,
    选中单位,
    读回,
    读回含单位: 文本一致,
    计价单位数字: NUM,
    计价单位单位: UNIT,
    方式数字,
    空白: blankAt,
    数字: s1,
    单位下拉: s2,
    选单位: s3,
    失败,
  }
  if (ok) {
    if (文本一致 === false) say('⚠ 计价单位容器文本里没看到单位，请人工核对：' + 读回)
    return { ok: true, ...base }
  }
  const why = 失败[0] || (!数字ok ? '计价单位数字读回不等于期望' : '单位未选中')
  say('✗ 计价单位没填对:', why)
  return { ok: false, why, ...base }
}

export default { fillMeasure, locateNumInput, setNumValue, locateUnitSelect, pickUnit, readMeasure, readNumValue }
