/**
 * 基础字段 + 必填属性（ego 版）—— 移植自原 Playwright/CDP 脚本 `tb_fill_basic.js`。
 *
 * ── 原脚本 ──────────────────────────────────────────────────────────────
 *   taobao-product-listing\scripts\tb_fill_basic.js
 *   干的事：宝贝标题 / 导购标题（卖点）/ 货号·型号·购买须知·商家编码 / 类目属性，
 *   属性按**页面上读到的属性名**匹配 `sell-field-p-<id>`（换类目自适应），值全部来自
 *   product.json（= 素材包 excel，不猜）。幂等：每个字段先读回，已是目标值就跳过。
 *
 * ── 移植差异（locator→evaluate、真实鼠标） ──────────────────────────────
 *   1) 取页：不连 CDP、不自己挑页 —— page 由 run_listing_tb.mjs 用
 *      `connectSpace(spaceId, { preferUrl:/item\.upload\.taobao\.com/ })` 取好传进来。
 *      原「必须在 publish.htm 上工作」的守卫保留为 `opts.requirePublishPage`（默认 true），
 *      并新增 `opts.catId` 读回核对（页面 URL 的 catId ≠ 期望 → 立即失败，防填错类目的表）。
 *   2) 定位：ego 没有 locator / frames / mainFrame，所以**所有查找都在 page.evaluate 里做**
 *      （原脚本本来就是这个写法，逻辑原样保留，不做 `document.querySelector` 之外的花样）。
 *   3) 点击：一律「evaluate 算中心坐标 → `page.mouse.click`」真实鼠标；`element.click()`
 *      从来不用。个别控件（展开折叠、下拉选项）保留原脚本的合成 `mousedown/mouseup/click`
 *      （淘宝只认这个序列）。ego 不保证有 `mouse.move` / `keyboard.type` → safeMove / typeText
 *      先探测再调；打字优先 `keyboard.insertText`（中文比 `type` 稳，等价原 `keyboard.type`）。
 *   4) 受控输入：`setter(HTMLInputElement.prototype.value)` + input/change/blur 之后，
 *      **新增「真实鼠标点它 → Ctrl+A → 打字 → Tab → 点空白触发 blur」兜底**。触发条件：
 *      setter 后读回 ≠ 期望（原脚本不查这一步，受控组件回滚时会**假通过**）。
 *      ⚠️ 默认**成功判据不改**（仍按原脚本：setter 成功即 ok，并在结果里给 `读回一致`）；
 *      `opts.strictReadback:true`（或 `__TB_CFG.strictReadback`）才把 ok 收紧为「读回严格相等」。
 *      导购标题/卖点原脚本本来就是 `ok: inp.value === v`，所以那里始终严格判。
 *   5) select/combobox/多选：原脚本是「合成 mousedown/mouseup/click 打开下拉」；ego 版
 *      **先真实鼠标点下拉**（算坐标 → mouse.click），弹层没出来再退回原来的合成事件
 *      （两条路径都在，打开后同样走「全等→includes→弹层搜索框→滚 .options-content」）。
 *   6) 配置：ego 子进程不继承环境变量 → 配置**只从 `globalThis.__TB_CFG` 惰性读取**
 *      （原脚本的 `--title` / `--product` / `--dry` 改走 opts；模块顶层不能读，因为 ego 的
 *      `-e` 脚本 import 先于赋值）。不读 process.env。
 *   7) 输出：原 `console.log` + `process.exitCode` → 这里返回对象，由编排层决定停不停。
 *      导出接口按 Lead 约定：`fillBasic(page, product, { catId = '' } = {})`，
 *      成功 `{ ok:true, 标题, 卖点, 属性, 货号, ... }`，失败 `{ ok:false, why, ...读回 }`。
 *
 * ── 仍然依赖的硬规则（一条都不放松） ───────────────────────────────────
 *   · 属性按页面「属性名」匹 p-id，换类目自适应（不写死 20000 / 20608 之类 id）。
 *   · 同一属性容器里可能有子字段（品牌 `p-20000` 与货号 `p-20000~1`）→ 只取 name
 *     **不带 `~`** 的主输入框；否则品牌会被写成货号的值（PE-001 实测踩过）。
 *   · 多选 tag 只读叶子 `.next-tag-body`（一个 tag 有 tag/body/close-btn 三层，用
 *     `[class*=next-tag]` 会把 1 个值读成 3 份：`户外/户外/阳台/阳台`）；再叠加页面自己的
 *     「已选择 n/m 项」作权威读回。
 *   · 空值 = 用户明确不上这个属性 → 跳过。**绝不能用空串去搜下拉**：`includes('')` 恒真，
 *     会点中列表第一个选项（静默填错值）。
 *   · 品牌是 auto-complete：点框 → Ctrl+A → 打字 →（有全等候选就点）→ **点空白触发 blur**
 *     → 再读回才判 ok。不点空白值不生效（用户 2026-10-10 指路）。
 *   · 点品牌前先查遮挡（`elementFromPoint`）：被遮 → 先关遮挡（scoped 的 取消/关闭/知道了/…
 *     按钮，兜底 Esc）→ **重新取坐标**（关浮层后页面回流，旧坐标失效）。Esc 只在确实被遮时按，
 *     因为它会顺手把正在用的规格抽屉关掉。
 *   · `option_not_found` 按**必填/选填**分流（product.required_attributes）：必填 → 判失败并把
 *     可选值原样列出来给人改素材包；选填 → 警告 + 跳过，不拖垮整条链（门禁 12：不许静默换近义词）。
 *   · `no_box` = 本类目页面上没有这个属性（素材包属性集比现场表宽）→ 跳过但**显式记录**；
 *     **过半**属性都 no_box → 仍判失败（多半类目/页面不对）。
 *   · 标题 30 汉字 = **60 字符（汉字按 2 计）**，超长从尾部砍（用户 2026-10-10 口径）。
 *
 * 不要在本文件里连浏览器/开进程；它只导出函数，由同一个 ego 进程里的编排脚本调用。
 */
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { sleep, say, waitUntil } from '../lib/tb_ego.mjs'

// ── 配置：只从 globalThis.__TB_CFG 惰性读（ego 子进程不继承自定义环境变量） ─────────
const cfg = () => (typeof globalThis !== 'undefined' && globalThis.__TB_CFG) || {}
/** 取配置：INLINE(globalThis.__TB_CFG) → 调用方 opts → 默认值。不读 process.env。 */
const pick = (key, dflt) => {
  const c = cfg()
  if (c[key] !== undefined && c[key] !== null && c[key] !== '') return c[key]
  return dflt
}

const msg = (e) => String((e && e.message) || e || 'unknown_error')
const json = (v) => {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** ego 不保证有 page.url() 的 promise 语义统一 → 统一包一层，读不到就当空串。 */
const getUrl = async (page) => {
  try {
    return String(await page.url())
  } catch {
    return ''
  }
}

// ── 真实鼠标 / 键盘的安全封装（ego API 不保证 move/type 存在） ────────────────────
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

/** 真实鼠标点击。`retryPlain` 只在「点空白/打开下拉」这类重复点无害的场景开启，避免误双击。 */
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

/** 打字：insertText 优先（中文稳），其次 type；都不行就返回失败让上层读回判。 */
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

/**
 * 点空白触发 blur（不点的话部分控件的值不生效）。候选点用 elementFromPoint 排除可点控件。
 * 原脚本 basic 用 [{1250,60},{300,62}]；measure 多一个 {1250,950}。
 * ⚠️ ego 窗口可能比 1250 窄：候选点先夹进视口（原坐标越界时 elementFromPoint 返回 null，
 *    直接点会落在窗口外）；夹完仍不是空白就换下一个候选，最后兜底夹紧的第一个。
 */
export async function clickBlank(page, { candidates = [{ x: 1250, y: 60 }, { x: 300, y: 62 }] } = {}) {
  const blank = await page
    .evaluate((pts) => {
      const w = document.documentElement.clientWidth || window.innerWidth || 1280
      const h = document.documentElement.clientHeight || window.innerHeight || 800
      const clamp = (p) => ({
        x: Math.min(Math.max(2, p.x), Math.max(2, w - 2)),
        y: Math.min(Math.max(2, p.y), Math.max(2, h - 2)),
      })
      for (const p of pts) {
        const q = clamp(p)
        const el = document.elementFromPoint(q.x, q.y)
        if (el && !el.closest('input,textarea,select,button,a')) return q
      }
      return clamp(pts[0])
    }, candidates)
    .catch(() => candidates[0])
  const r = await mouseClick(page, blank.x, blank.y, 'blank', { retryPlain: true })
  return { ...r, at: blank }
}

/** 真实鼠标点一个坐标 + 键盘输入（受控输入 setter 之后的统一兜底动作）。 */
async function typeAt(page, x, y, want, label = 'type') {
  await mouseMove(page, x, y)
  await sleep(150)
  const clicked = await mouseClick(page, x, y, label)
  await sleep(250)
  const selected = await keyPress(page, 'Control+A')
  const typed = await typeText(page, want)
  await sleep(300)
  const tabbed = await keyPress(page, 'Tab')
  await sleep(200)
  const blank = await clickBlank(page)
  await sleep(300)
  return { 点击: clicked, 全选: selected, 输入: typed, Tab: tabbed, 空白: blank }
}

// ── 浏览器侧函数（必须自包含：ego 会把函数序列化进页面执行） ─────────────────────

/**
 * 读回属性区：属性名 → p-id / 控件类型 / 当前值（原 readFields 原样）。
 * 多选 tag 只取叶子 `.next-tag-body`，没有才退回 `.next-tag`/selection-item；
 * 「已选择 n/m 项」是页面自己的计数，是最权威的读回。
 */
export async function readFields(page) {
  return page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      return Array.from(document.querySelectorAll('[id^="sell-field-p-"]')).map((box) => {
        const t = clean(box.innerText)
        const cls = String(box.className || '')
        const kind = ['combobox', 'select', 'checkbox', 'input', 'taoSirProp'].find((k) => new RegExp('(^|\\s)' + k).test(cls)) || '?'
        const label = ((t.replace(/^\*+/, '').split('重要')[0].trim().match(/^[^\s0-9/]+/) || [''])[0] || '').trim()
        const vals = Array.from(box.querySelectorAll('input'))
          .filter(vis)
          .map((i) => String(i.value || ''))
          .filter(Boolean)
        // ⚠️ 只取叶子文本，见文件头「多选 tag」硬规则
        const tagEls = Array.from(box.querySelectorAll('.next-tag-body'))
        const chips = (tagEls.length ? tagEls : Array.from(box.querySelectorAll('.next-tag,[class*=selection-item],[class*=SelectionItem]')))
          .map((e) => clean(e.innerText))
          .filter(Boolean)
        const 已选计数 = (t.match(/已选择\s*(\d+)\s*\/\s*(\d+)\s*项/) || []).slice(1).join('/') || null
        return {
          id: box.id,
          pid: (box.id.match(/p-(\d+)/) || [])[1] || null,
          kind,
          label,
          输入值: vals[0] || null,
          chips: chips.slice(0, 6),
          已选计数,
          文本: t.slice(0, 50),
        }
      })
    })
    .catch(() => [])
}

/**
 * 反复点开所有折叠入口，直到没有为止（原脚本的 ①b）。
 * 属性常被折叠（「展开补充更多信息」「展开」），不展开就读不到、更填不上
 * （PE 木纹实测：15 个属性只读到 3 个）。返回每次点到的文案数组。
 */
export async function expandCollapsedSections(page, { passes = 5 } = {}) {
  return page
    .evaluate(async (maxPass) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const sl = (ms) => new Promise((r) => setTimeout(r, ms))
      const done = []
      for (let pass = 0; pass < maxPass; pass += 1) {
        const cands = Array.from(document.querySelectorAll('div,span,a,button'))
          .filter(vis)
          .filter((e) => /^(展开补充更多信息|展开|更多属性|查看更多|展开全部)$/.test(clean(e.innerText)))
        const el = cands.filter((e) => !cands.some((o) => o !== e && e.contains(o)))[0]
        if (!el) break
        el.scrollIntoView({ block: 'center' })
        for (const ev of ['mousedown', 'mouseup', 'click']) {
          el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
        }
        done.push(clean(el.innerText))
        await sl(1500)
      }
      return done
    }, passes)
    .catch(() => [])
}

// ── 小工具（Node 侧） ─────────────────────────────────────────────────────────
const byLabel = (fields, name) =>
  fields.find((f) => f.label === name) || fields.find((f) => f.label.includes(name) || name.includes(f.label)) || null

/** 读标题输入框（placeholder 含「30个汉字」）当前值。 */
const readTitleValue = (page) =>
  page
    .evaluate(() => {
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const inp = Array.from(document.querySelectorAll('input'))
        .filter(vis)
        .find((i) => (i.getAttribute('placeholder') || '').includes('30个汉字'))
      return inp ? inp.value : null
    })
    .catch(() => null)

/**
 * 宝贝标题：**30 汉字 = 60 字符**（汉字按 2 计），超长从尾部砍（原 clampTitle 原样）。
 * @export
 */
export function clampTitle(s) {
  let n = 0
  let out = ''
  for (const ch of String(s)) {
    const w = /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1
    if (n + w > 60) break
    n += w
    out += ch
  }
  return out.trim()
}

/**
 * 填标题（placeholder 含「30个汉字」）。先受控 setter + input/change/blur（原样），
 * 读回不一致再走真实鼠标 + 键盘兜底；成功判据默认按原脚本（setter 成功即 ok）。
 */
export async function fillTitle(page, want, { strict = false } = {}) {
  const w = String(want)
  const first = await page
    .evaluate((v) => {
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const inp = Array.from(document.querySelectorAll('input'))
        .filter(vis)
        .find((i) => (i.getAttribute('placeholder') || '').includes('30个汉字'))
      if (!inp) return { ok: false, why: 'no_title_input' }
      if (inp.value === v) return { ok: true, already: true, 读回: inp.value }
      inp.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, v)
      for (const ev of ['input', 'change', 'blur']) inp.dispatchEvent(new Event(ev, { bubbles: true }))
      return { ok: true, 读回: inp.value, 字符数: inp.value.length }
    }, w)
    .catch((e) => ({ ok: false, why: 'evaluate_failed', 详情: msg(e) }))

  if (first.already) {
    return { ok: true, 读回: first.读回, 字符数: String(first.读回 || '').length, 方式: 'already', 读回一致: true }
  }
  if (!first.ok) return { ...first, 读回: null, 方式: 'none', 读回一致: false }
  if (first.读回 === w) return { ...first, 方式: 'setter', 读回一致: true }

  // ★ setter 后读回 ≠ 期望：受控输入被 React 回滚 → 真实鼠标 + 键盘兜底（ego 新增）
  const coords = await page
    .evaluate(() => {
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const inp = Array.from(document.querySelectorAll('input'))
        .filter(vis)
        .find((i) => (i.getAttribute('placeholder') || '').includes('30个汉字'))
      if (!inp) return null
      inp.scrollIntoView({ block: 'center' })
      const r = inp.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })
    .catch(() => null)

  let 读回 = first.读回
  let 兜底 = 'no_coords'
  if (coords) {
    await typeAt(page, coords.x, coords.y, w, 'title')
    const waited = await waitUntil(
      async () => {
        const v = await readTitleValue(page)
        return v === w ? v : null
      },
      { timeoutMs: 3000, intervalMs: 250, label: 'title-readback' },
    )
    读回 = waited.value === null ? await readTitleValue(page) : waited.value
    兜底 = 'mouse+keyboard'
  }
  const 一致 = 读回 === w
  return {
    ok: 一致 ? true : !strict, // 原判据：setter 成功即 ok；strictReadback 才收紧
    读回,
    字符数: String(读回 || '').length,
    方式: 'setter+兜底',
    setter读回: first.读回,
    读回一致: 一致,
    兜底,
    期望: w,
    ...(一致 ? {} : strict ? { why: 'title_readback_mismatch' } : {}),
  }
}

/**
 * 导购标题 / 卖点：placeuholder 含「15个汉字」为主（原脚本），找不到再按「卖点/导购标题」
 * 标签找最近的输入框（ego 版补充，表单改版后这两个叫法都出现过）。
 * 原脚本判据是严格的 `ok: inp.value === v`，这里保留严格，并先补真实鼠标键盘兜底。
 */
export async function fillSellingPoint(page, want) {
  const w = String(want)
  const first = await page
    .evaluate((v) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      let inp = Array.from(document.querySelectorAll('input'))
        .filter(vis)
        .find((i) => (i.getAttribute('placeholder') || '').includes('15个汉字'))
      let 定位 = 'placeholder15'
      if (!inp) {
        // 兜底：按「卖点 / 导购标题」标签找最近容器的输入框
        const cands = Array.from(document.querySelectorAll('div,label')).filter(vis)
        cands.sort((a, b) => a.innerText.length - b.innerText.length)
        for (const c of cands) {
          const t = clean(c.innerText)
          if (!/^\*?\s*(卖点|导购标题)(\s|$)/.test(t) || t.length >= 40) continue
          let p = c
          for (let k = 0; k < 4 && p && !inp; k += 1) {
            inp = Array.from(p.querySelectorAll('input')).filter(vis)[0] || null
            if (!inp) p = p.parentElement
          }
          if (inp) {
            定位 = 'label:' + t.slice(0, 12)
            break
          }
        }
      }
      if (!inp) return { ok: false, why: 'no_input' }
      if (inp.value === v) return { ok: true, already: true, 读回: inp.value, 定位 }
      inp.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, v)
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      return { ok: inp.value === v, 读回: inp.value, 定位 }
    }, w)
    .catch((e) => ({ ok: false, why: 'evaluate_failed', 详情: msg(e) }))

  if (first.ok) return { ...first, 方式: first.already ? 'already' : 'setter', 读回一致: first.读回 === w }
  if (first.why === 'no_input') return { ...first, 读回: null, 方式: 'none', 读回一致: false }

  // setter 没成功 → 真实鼠标 + 键盘兜底，再严格判读回
  const coords = await page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      let inp = Array.from(document.querySelectorAll('input'))
        .filter(vis)
        .find((i) => (i.getAttribute('placeholder') || '').includes('15个汉字'))
      if (!inp) {
        const cands = Array.from(document.querySelectorAll('div,label')).filter(vis)
        cands.sort((a, b) => a.innerText.length - b.innerText.length)
        for (const c of cands) {
          const t = clean(c.innerText)
          if (!/^\*?\s*(卖点|导购标题)(\s|$)/.test(t) || t.length >= 40) continue
          let p = c
          for (let k = 0; k < 4 && p && !inp; k += 1) {
            inp = Array.from(p.querySelectorAll('input')).filter(vis)[0] || null
            if (!inp) p = p.parentElement
          }
          if (inp) break
        }
      }
      if (!inp) return null
      inp.scrollIntoView({ block: 'center' })
      const r = inp.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })
    .catch(() => null)
  if (!coords) return { ...first, 读回: null, 方式: 'none', 读回一致: false }
  await typeAt(page, coords.x, coords.y, w, 'selling-point')
  const 读回 = await page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      let inp = Array.from(document.querySelectorAll('input'))
        .filter(vis)
        .find((i) => (i.getAttribute('placeholder') || '').includes('15个汉字'))
      if (!inp) {
        const cands = Array.from(document.querySelectorAll('div,label')).filter(vis)
        cands.sort((a, b) => a.innerText.length - b.innerText.length)
        for (const c of cands) {
          const t = clean(c.innerText)
          if (!/^\*?\s*(卖点|导购标题)(\s|$)/.test(t) || t.length >= 40) continue
          let p = c
          for (let k = 0; k < 4 && p && !inp; k += 1) {
            inp = Array.from(p.querySelectorAll('input')).filter(vis)[0] || null
            if (!inp) p = p.parentElement
          }
          if (inp) break
        }
      }
      return inp ? inp.value : null
    })
    .catch(() => null)
  return { ok: 读回 === w, 读回, 读回一致: 读回 === w, 方式: 'mouse+keyboard', setter读回: first.读回, 定位: first.定位 }
}

/** 定位某 p-id 容器里的主输入框（**name 不带 `~`**，见硬规则）并返回中心坐标。 */
const locatePidInput = (page, pid) =>
  page
    .evaluate((p) => {
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const box = document.querySelector('#sell-field-p-' + p)
      if (!box) return null
      const inputs = Array.from(box.querySelectorAll('input')).filter(vis)
      const inp = inputs.find((i) => !/~/.test(i.getAttribute('name') || '')) || inputs[0]
      if (!inp) return null
      inp.scrollIntoView({ block: 'center' })
      const r = inp.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 现: inp.value }
    }, pid)
    .catch(() => null)

/** 读某 p-id 主输入框当前值。 */
const readPidInput = (page, pid) =>
  page
    .evaluate((p) => {
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const box = document.querySelector('#sell-field-p-' + p)
      const inputs = box ? Array.from(box.querySelectorAll('input')).filter(vis) : []
      const inp = inputs.find((i) => !/~/.test(i.getAttribute('name') || '')) || inputs[0]
      return inp ? inp.value : null
    }, pid)
    .catch(() => null)

/**
 * 文本框类属性直填（货号 / 型号 / 购买须知 / 商家编码 / kind=input）。
 * 受控 setter + input/change/blur（原样）→ 读回不一致 → 真实鼠标 + 键盘兜底。
 * 成功判据默认按原脚本（setter 成功即 ok），结果里给 `读回一致`。
 */
export async function fillInputByPid(page, pid, want, { strict = false } = {}) {
  const w = String(want)
  const first = await page
    .evaluate(({ pid: p, want: v }) => {
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const box = document.querySelector('#sell-field-p-' + p)
      if (!box) return { ok: false, why: 'no_box' }
      // ⚠️ 同容器子字段（品牌 p-20000 / 货号 p-20000~1）→ 取 name 不带 ~ 的主框
      const inp =
        Array.from(box.querySelectorAll('input')).filter(vis).find((i) => !/~/.test(i.getAttribute('name') || '')) ||
        Array.from(box.querySelectorAll('input')).filter(vis)[0]
      if (!inp) return { ok: false, why: 'no_input' }
      if (inp.value === v) return { ok: true, already: true, 读回: inp.value }
      inp.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, v)
      for (const ev of ['input', 'change', 'blur']) inp.dispatchEvent(new Event(ev, { bubbles: true }))
      return { ok: true, 读回: inp.value }
    }, { pid, want: w })
    .catch((e) => ({ ok: false, why: 'evaluate_failed', 详情: msg(e) }))

  if (first.already) return { ...first, 方式: 'already', 读回一致: first.读回 === w }
  if (!first.ok) return { ...first, 读回: null, 方式: 'none', 读回一致: false }
  if (first.读回 === w) return { ...first, 方式: 'setter', 读回一致: true }

  const coords = await locatePidInput(page, pid)
  let 读回 = first.读回
  if (coords) {
    await typeAt(page, coords.x, coords.y, w, 'pid:' + pid)
    const waited = await waitUntil(
      async () => {
        const v = await readPidInput(page, pid)
        return v === w ? v : null
      },
      { timeoutMs: 3000, intervalMs: 250, label: 'pid-readback:' + pid },
    )
    读回 = waited.value === null ? await readPidInput(page, pid) : waited.value
  }
  const 一致 = 读回 === w
  return {
    ok: 一致 ? true : !strict,
    读回,
    方式: coords ? 'setter+兜底' : 'setter(no_coords)',
    setter读回: first.读回,
    读回一致: 一致,
    期望: w,
    ...(一致 ? {} : strict ? { why: 'input_readback_mismatch' } : {}),
  }
}

/**
 * 不在属性区的属性（宝贝类型 / 采购地 / 图案 / 材质 等）→ 按属性名找最近的容器兜底。
 * 原脚本判据：`ok: inp.value !== ''`；这里保留判据，但读回 ≠ 期望时补一次真实鼠标键盘。
 */
export async function fillByName(page, name, value, { strict = false } = {}) {
  const v = String(value)
  const first = await page
    .evaluate(async ({ n, v: val }) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const sl = (ms) => new Promise((r) => setTimeout(r, ms))
      const cands = Array.from(document.querySelectorAll('div,label,span'))
        .filter(vis)
        .filter((e) => new RegExp('^\\*?\\s*' + n + '(\\s|$)').test(clean(e.innerText)) && clean(e.innerText).length < 28)
      cands.sort((a, b) => a.innerText.length - b.innerText.length)
      const el = cands[0]
      if (!el) return { ok: false, why: 'no_box' }
      el.scrollIntoView({ block: 'center' })
      let p = el
      let inp = null
      for (let k = 0; k < 4 && p && !inp; k += 1) {
        inp = Array.from(p.querySelectorAll('input,textarea')).filter(vis)[0] || null
        if (!inp) p = p.parentElement
      }
      if (!inp) return { ok: false, why: 'no_input', 容器: clean(el.innerText).slice(0, 20) }
      if (inp.value === val) return { ok: true, already: true, 读回: inp.value }
      const r = inp.getBoundingClientRect()
      inp.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, val)
      for (const ev of ['input', 'change', 'blur']) inp.dispatchEvent(new Event(ev, { bubbles: true }))
      await sl(400)
      return {
        ok: inp.value !== '',
        填入: val,
        读回: inp.value,
        坐标: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
      }
    }, { n: name, v })
    .catch((e) => ({ ok: false, why: 'evaluate_failed', 详情: msg(e) }))

  if (first.already) return { ...first, 方式: 'already', 读回一致: first.读回 === v }
  // ⚠️ `why` 才是「真没控件」（no_box / no_input / evaluate 失败）；value 为空是 setter 没生效，
  //    要往下走真实鼠标键盘兜底，不能在这里提前返回。
  if (!first.ok && first.why) return { ...first, 读回: null, 方式: 'none', 读回一致: false }
  const 一致 = first.读回 === v
  if (一致) return { ...first, 方式: 'setter', 读回一致: true }

  // 补兜底（原脚本没有，但这里只影响「怎么达到值」，不改原判据 `读回 !== ''`）
  let 读回 = first.读回
  let 兜底 = 'no_coords'
  if (first.坐标) {
    await typeAt(page, first.坐标.x, first.坐标.y, v, 'by-name:' + name)
    兜底 = 'mouse+keyboard'
    const back = await page
      .evaluate((n) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const vis = (e) => {
          if (!e) return false
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const cands = Array.from(document.querySelectorAll('div,label,span'))
          .filter(vis)
          .filter((e) => new RegExp('^\\*?\\s*' + n + '(\\s|$)').test(clean(e.innerText)) && clean(e.innerText).length < 28)
        cands.sort((a, b) => a.innerText.length - b.innerText.length)
        let p = cands[0]
        for (let k = 0; k < 4 && p; k += 1) {
          const i2 = Array.from(p.querySelectorAll('input,textarea')).filter(vis)[0]
          if (i2) return i2.value
          p = p.parentElement
        }
        return null
      }, name)
      .catch(() => null)
    读回 = back
  }
  const 有值 = typeof 读回 === 'string' && 读回 !== ''
  return {
    // 原脚本判据就是 `ok: inp.value !== ''`；strictReadback 才收紧成读回严格相等
    ok: !strict && 有值,
    填入: v,
    读回,
    方式: 兜底 === 'no_coords' ? 'setter(mismatch)' : 'setter+兜底',
    读回一致: 读回 === v,
    兜底,
    ...(读回 === v ? {} : { why: 'by_name_readback_mismatch', 期望: v }),
  }
}

/**
 * 品牌 auto-complete（原 pickAutoComplete 原样保留顺序）：
 * 定位 → 已等即过 → 查遮挡并重取坐标 → 移动/点击 → Ctrl+A → 打字 → 全等候选（合成事件）
 * → 点空白触发 blur → 读回（name 不带 ~ 的主框），**读回 === 期望 才 ok**。
 */
export async function pickAutoComplete(page, pid, want) {
  const w = String(want)
  const locate = () =>
    page
      .evaluate((p) => {
        const vis = (e) => {
          if (!e) return false
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const box = document.querySelector('#sell-field-p-' + p)
        if (!box) return null
        const inputs = Array.from(box.querySelectorAll('input')).filter(vis)
        // ⚠️ 品牌(p-20000) 与货号(p-20000~1) 同容器 → 取 name 不带 ~ 的那个
        const inp = inputs.find((i) => !/~/.test(i.getAttribute('name') || '')) || inputs[0]
        if (!inp) return null
        inp.scrollIntoView({ block: 'center' })
        const r = inp.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 现: inp.value }
      }, pid)
      .catch(() => null)

  let c = await locate()
  if (!c) return { ok: false, why: 'no_input', 读回: null }
  if (c.现 === w) return { ok: true, already: true, 读回: c.现, 读回一致: true }

  const ov = await clearOverlayAt(page, c.x, c.y)
  if (ov.blocked) {
    c = await locate()
    if (!c) return { ok: false, why: 'no_input_after_clear', 遮挡: ov.遮挡, 读回: null }
    say('   品牌框原先被遮挡 → ' + ov.处理 + '，已重新取坐标')
  }

  await mouseMove(page, c.x, c.y)
  await sleep(200)
  const clicked = await mouseClick(page, c.x, c.y, 'brand')
  await sleep(1200)
  // ★ ego 实测：品牌是只读 combobox —— 往输入框 insertText 改不动值（读回仍是旧品牌 Arte）。
  //   正确做法：点开下拉 → 在弹层里找「【无品牌/无注册商标】」（复用下拉选值逻辑：搜索框 + 滚动 + 包含匹配）。
  // ★★ 2026-11-13 实测（唯一稳定路径）：
  //   品牌弹层自带**搜索框**；往搜索框写「无品牌」→ 选项过滤成 ["无品牌","无品牌/无注册商标"]
  //   → 真实鼠标点第一个 → 表单值变成「无品牌/无注册商标」，关弹层/点空白后仍保持。
  //   ⚠️ 不要往显示框 insertText（那是显示值，一 blur 就回到旧品牌 Arte）。
  const popSearch = (kw) =>
    page
      .evaluate((keyword) => {
        const vis = (e) => {
          if (!e) return false
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const pop = document.querySelector('.sell-o-select-options')
        if (!pop) return { ok: false, why: 'no_pop' }
        const i = [...pop.querySelectorAll('input')].filter(vis)[0]
        if (!i) return { ok: false, why: 'no_search_input' }
        i.focus()
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(i, keyword)
        i.dispatchEvent(new Event('input', { bubbles: true }))
        return { ok: true, 搜索框: i.value }
      }, kw)
      .catch((e) => ({ ok: false, why: String((e && e.message) || e) }))
  const popPick = (kw) =>
    page
      .evaluate((keyword) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const vis = (e) => {
          if (!e) return false
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const pop = document.querySelector('.sell-o-select-options')
        if (!pop) return { ok: false, why: 'no_pop' }
        const item = [...pop.querySelectorAll('.options-item')].filter(vis).find((e) => clean(e.innerText).includes(keyword))
        if (!item) return { ok: false, why: 'no_item', 候选: [...pop.querySelectorAll('.options-item')].filter(vis).map((e) => clean(e.innerText)).slice(0, 8) }
        const r = item.getBoundingClientRect()
        return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 文本: clean(item.innerText).slice(0, 24) }
      }, kw)
      .catch((e) => ({ ok: false, why: String((e && e.message) || e) }))

  let 下拉选择 = null
  let 读回B = null
  // 弹层是异步渲染的：每次点开都轮询等它出现（最多 6s），最多重试 3 轮
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await mouseMove(page, c.x, c.y)
    await sleep(250)
    await mouseClick(page, c.x, c.y, 'brand')
    let popped = false
    for (let i = 0; i < 12 && !popped; i += 1) {
      popped = await page.evaluate(() => !!document.querySelector('.sell-o-select-options')).catch(() => false)
      if (!popped) await sleep(500)
    }
    if (!popped) continue
    const search = await popSearch(w)
    if (!search.ok) continue
    await sleep(2200)
    const opt = await popPick(w)
    下拉选择 = opt
    if (opt.ok) {
      await mouseMove(page, opt.x, opt.y)
      await sleep(200)
      await mouseClick(page, opt.x, opt.y, 'brand-option')
      await sleep(1500)
    }
    await page.keyboard.press('Escape').catch(() => {})
    await sleep(600)
    await clickBlank(page)
    await sleep(800)
    读回B = await readPidInput(page, pid)
    if (typeof 读回B === 'string' && (读回B === w || 读回B.includes(w))) break
  }
  if (typeof 读回B === 'string' && (读回B === w || 读回B.includes(w))) {
    return {
      ok: true,
      读回: 读回B,
      读回一致: true,
      选中: 读回B,
      遮挡: ov.blocked ? ov.处理 : null,
      点击: clicked.ok ? clicked.how || 'mouse' : clicked.why,
      下拉选择,
      空白: 'clickBlank',
    }
  }
  // 有完全匹配的候选就点它（可省，但更稳）
  await page
    .evaluate((want) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const hit = Array.from(document.querySelectorAll('.options-item,[class*=option-item],li'))
        .filter(vis)
        .find((e) => clean(e.innerText) === want)
      if (hit) {
        for (const ev of ['mousedown', 'mouseup', 'click']) {
          hit.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
        }
      }
    }, w)
    .catch(() => {})
  await sleep(600)
  // ★ 点空白触发 blur（不触发的话值不生效 —— 用户指路）
  const blank = await clickBlank(page)
  await sleep(900)
  const 读回 = await readPidInput(page, pid)
  return {
    ok: 读回 === w,
    读回,
    读回一致: 读回 === w,
    选中: 读回 === w ? w : null,
    遮挡: ov.blocked ? ov.处理 : null,
    点击: clicked.ok ? clicked.how || 'mouse' : clicked.why,
    输入: typed.how || typed.why,
    空白: blank.at,
    ...(读回 === w ? {} : { why: 'brand_readback_mismatch', 期望: w }),
  }
}

/**
 * 查遮挡：点品牌前先看 elementFromPoint 命中的是不是输入框/属性区；
 * 被遮就关遮挡物（scoped 的 取消/关闭/知道了/好的/完成 按钮；没有按钮才 Esc），
 * 关完调用方必须**重新取坐标**（页面回流后旧坐标失效）。
 * ⚠️ 不用 lib 的 dismissDialogs：它会连「确定」一起点，遇到「切换显示模式将清空当前数据」
 *    这类确认框等于替用户确认了破坏性操作。这里保持原脚本的 scoped + 取消优先。
 */
export async function clearOverlayAt(page, x, y) {
  const info = await page
    .evaluate((p) => {
      const cls = (e) => String((e && e.getAttribute && e.getAttribute('class')) || '')
      const el = document.elementFromPoint(p.x, p.y)
      if (!el) return { blocked: false }
      const tag = el.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || el.closest('#sell-field-p-20000')) return { blocked: false }
      const dlg = el.closest('.next-dialog,.next-overlay-wrapper,[class*=overlay],[class*=mask]')
      return {
        blocked: true,
        tag,
        cls: cls(el).slice(0, 50),
        inDialog: !!dlg,
        dialogText: dlg ? String(dlg.innerText || '').replace(/\s+/g, ' ').slice(0, 60) : null,
      }
    }, { x, y })
    .catch(() => ({ blocked: false }))
  if (!info.blocked) return { ok: true, blocked: false }

  let closed = false
  const btn = await page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const b = Array.from(document.querySelectorAll('.next-dialog button,[class*=overlay] button'))
        .filter(vis)
        .find((x) => /^(取消|关闭|知道了|好的|完成)/.test(clean(x.innerText)))
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 文案: clean(b.innerText) }
    })
    .catch(() => null)
  if (btn) {
    await mouseClick(page, btn.x, btn.y, 'close-overlay', { retryPlain: true })
    closed = '点了「' + btn.文案 + '」'
  } else {
    await keyPress(page, 'Escape')
    closed = '按了 Esc'
  }
  await sleep(1500)
  return { ok: true, blocked: true, 遮挡: info, 处理: closed }
}

/**
 * 打开下拉（select / combobox / 多选 next-select）：
 * ① ego 版先**真实鼠标**点控件（aria-expanded=true 或弹层出现即算打开）；
 * ② 没打开再退回原脚本的合成 mousedown/mouseup/click + 等待。
 * @returns `{ ok, how }`
 */
export async function openSelect(page, pid, { coords = null, timeoutMs = 4000 } = {}) {
  const pre = await page
    .evaluate(({ pid: p, coords: c }) => {
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const box = document.querySelector('#sell-field-p-' + p)
      if (!box) return null
      const inputs = Array.from(box.querySelectorAll('input')).filter(vis)
      const inp = inputs.find((i) => !/~/.test(i.getAttribute('name') || '')) || inputs[0]
      if (!inp) return null
      inp.scrollIntoView({ block: 'center' })
      const r = inp.getBoundingClientRect()
      // 注：外部显式传了 coords 就优先（品牌等前面已算过一次坐标的场景）
      const cx = c && typeof c.x === 'number' ? c.x : Math.round(r.left + r.width / 2)
      const cy = c && typeof c.y === 'number' ? c.y : Math.round(r.top + r.height / 2)
      return {
        x: cx,
        y: cy,
        展开: inp.getAttribute('aria-expanded') === 'true',
      }
    }, { pid, coords })
    .catch(() => null)
  if (!pre) return { ok: false, why: 'no_input', how: 'none' }
  if (pre.展开) return { ok: true, how: 'already-open' }

  await mouseMove(page, pre.x, pre.y)
  await sleep(150)
  await mouseClick(page, pre.x, pre.y, 'open-select:' + pid)
  await sleep(300)
  const popped = await waitUntil(
    async () => {
      const state = await page
        .evaluate((p) => {
          const vis = (e) => {
            if (!e) return false
            const r = e.getBoundingClientRect()
            return r.width > 0 && r.height > 0
          }
          const box = document.querySelector('#sell-field-p-' + p)
          const inputs = box ? Array.from(box.querySelectorAll('input')).filter(vis) : []
          const inp = inputs.find((i) => !/~/.test(i.getAttribute('name') || '')) || inputs[0]
          if (inp && inp.getAttribute('aria-expanded') === 'true') return { 展开: true }
          const pops = Array.from(document.querySelectorAll('.sell-o-select-options,.sell-o-select-popup,.next-select-popup-wrap')).filter(vis)
          return { 展开: pops.length > 0 }
        }, pid)
        .catch(() => ({ 展开: false }))
      return state.展开 ? state : null
    },
    { timeoutMs, intervalMs: 250, label: 'open-select' },
  )
  if (popped.value) return { ok: true, how: 'mouse' }

  // 退回原脚本：合成 mousedown/mouseup/click（淘宝部分控件只认这个序列）
  const synth = await page
    .evaluate(async (p) => {
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const sl = (ms) => new Promise((r) => setTimeout(r, ms))
      const box = document.querySelector('#sell-field-p-' + p)
      if (!box) return { ok: false, why: 'no_box' }
      const inputs = Array.from(box.querySelectorAll('input')).filter(vis)
      const inp = inputs.find((i) => !/~/.test(i.getAttribute('name') || '')) || inputs[0]
      if (!inp) return { ok: false, why: 'no_input' }
      inp.focus()
      for (const ev of ['mousedown', 'mouseup', 'click']) {
        inp.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
      }
      await sl(2000)
      return { ok: true }
    }, pid)
    .catch((e) => ({ ok: false, why: msg(e) }))
  return { ok: !!synth.ok, how: 'synth', ...(synth.ok ? {} : { why: synth.why }) }
}

/**
 * 下拉选值（原 pickOption 的「弹层内」部分）：
 * ① 先直接找（不少 combobox 展开后就有全量/推荐列表）；
 * ② 没命中才用弹层自带搜索框过滤（setter + input 事件，等 2200）；
 * ③ 仍没命中 → 滚 `.options-content`（长列表，如「日式」要滚才出现）。
 * 弹层 class 不止一种（表单页是 `.sell-o-select-popup`，类目页 `.sell-o-select-options`），
 * 都认，且取**最后一个可见的**。命中后合成 mousedown/mouseup/click，再读回现值。
 */
export async function pickOptionInPopup(page, pid, want) {
  const w = String(want)
  return page
    .evaluate(
      async ({ pid: p, want: v }) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const vis = (e) => {
          if (!e) return false
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms))
        const box = document.querySelector('#sell-field-p-' + p)
        if (!box) return { ok: false, why: 'no_box' }
        const inputs = Array.from(box.querySelectorAll('input')).filter(vis)
        const inp = inputs.find((i) => !/~/.test(i.getAttribute('name') || '')) || inputs[0]
        if (!inp) return { ok: false, why: 'no_input' }
        // ⚠️ 单价要分两种读法：单选看 input.value；多选（tag 型）input.value 恒空、值在 tag 里。
        //    只判 input.value 会把已选值再点一次 = 取消（实测踩过）。
        const current = () => {
          const bodies = Array.from(box.querySelectorAll('.next-tag-body')).map((e) => clean(e.innerText)).filter(Boolean)
          if (bodies.length) return bodies
          const tags = Array.from(box.querySelectorAll('.next-tag')).map((e) => clean(e.innerText)).filter(Boolean)
          if (tags.length) return tags
          return inp.value ? [inp.value] : []
        }
        if (current().includes(v)) return { ok: true, already: true, 现值: current().join('/') }

        // 弹层可能重建 → 每次用取值函数重新拿
        const scopeOf = () => {
          const cands = Array.from(document.querySelectorAll('.sell-o-select-options,.sell-o-select-popup,.next-select-popup-wrap')).filter(vis)
          if (cands.length) return cands[cands.length - 1]
          const oc = document.querySelector('.options-content')
          return oc ? oc.closest('div') || oc : document
        }
        let scope = scopeOf()
        const items = () => Array.from(scope.querySelectorAll('.options-item')).filter(vis)
        const hitOf = () => items().find((e) => clean(e.innerText) === v) || items().find((e) => clean(e.innerText).includes(v))

        // ① 直接找
        let hit = hitOf()
        // ② 弹层自带搜索框过滤
        let usedSearch = false
        const search = () => Array.from(scope.querySelectorAll('input')).filter(vis).find((i) => i !== inp && !box.contains(i))
        if (!hit && search()) {
          usedSearch = true
          const s = search()
          s.focus()
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          setter.call(s, v)
          s.dispatchEvent(new Event('input', { bubbles: true }))
          await sleep2(2200)
          scope = scopeOf()
          hit = hitOf()
        }
        // ③ 滚 .options-content（长列表就靠这个）
        if (!hit) {
          const cont = scope.querySelector('.options-content') || scope
          if (cont && cont.scrollHeight > cont.clientHeight) {
            for (let y = 0; y <= cont.scrollHeight && !hit; y += 600) {
              cont.scrollTop = y
              await sleep2(160)
              hit = hitOf()
            }
            scope = scopeOf()
            hit = hitOf()
          }
        }
        if (!hit) {
          return {
            ok: false,
            why: 'option_not_found',
            读回: current().join('/') || inp.value || null,
            用过搜索: usedSearch,
            item数: items().length,
            候选: items().map((e) => clean(e.innerText)).slice(0, 24),
            弹层文本: clean(scope.innerText || '').slice(0, 180),
          }
        }
        for (const ev of ['mousedown', 'mouseup', 'click']) {
          hit.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
        }
        await sleep2(1500)
        const rr = hit.getBoundingClientRect()
        return {
          ok: true,
          选中: clean(hit.innerText),
          现值: current().join('/'),
          读回: current().join('/') || inp.value,
          // ★ 合成事件在淘宝 combobox 上不一定提交 → 调用方补一次**真实鼠标**点选项
          x: Math.round(rr.left + rr.width / 2),
          y: Math.round(rr.top + rr.height / 2),
        }
      },
      { pid, want: w },
    )
    .catch((e) => ({ ok: false, why: 'evaluate_failed', 详情: msg(e) }))
}

/**
 * 下拉/多选完整流程：预读现值（已选即跳过，避免多选被点成取消）→ 打开（真实鼠标优先，
 * 合成事件兜底）→ 弹层内选值（原 pickOption 顺序）→ 读回。
 */
export async function pickOption(page, pid, want) {
  const w = String(want)
  const pre = await page
    .evaluate(({ pid: p, want: v }) => {
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const box = document.querySelector('#sell-field-p-' + p)
      if (!box) return { ok: false, why: 'no_box' }
      const inputs = Array.from(box.querySelectorAll('input')).filter(vis)
      const inp = inputs.find((i) => !/~/.test(i.getAttribute('name') || '')) || inputs[0]
      if (!inp) return { ok: false, why: 'no_input' }
      const bodies = Array.from(box.querySelectorAll('.next-tag-body')).map((e) => clean(e.innerText)).filter(Boolean)
      const tags = bodies.length ? [] : Array.from(box.querySelectorAll('.next-tag')).map((e) => clean(e.innerText)).filter(Boolean)
      const 现值 = bodies.length ? bodies : tags.length ? tags : inp.value ? [inp.value] : []
      return { ok: true, 现值, 已选: 现值.includes(v) }
    }, { pid, want: w })
    .catch((e) => ({ ok: false, why: 'evaluate_failed', 详情: msg(e) }))
  if (!pre.ok) return { ...pre, 读回: null }
  if (pre.已选) return { ok: true, already: true, 现值: pre.现值.join('/'), 读回: pre.现值.join('/'), 读回一致: true }

  const opened = await openSelect(page, pid)
  const r = await pickOptionInPopup(page, pid, w)
  return { ...r, 打开: opened.how, ...(opened.ok ? {} : { 打开失败: opened.why }) }
}

/**
 * checkbox 组（多选）：点文本 == want 的那一项（原 pickCheckbox 原样）。
 * ⚠️ 原 tb_fill_basic.js 定义了它但主流程**从未调用**（实测「适用猫体型」class 标 checkbox、
 *    实际是多选下拉，走 pickOption）。这里保留并导出，供编排层按需显式调用；默认流程不变。
 */
export async function pickCheckbox(page, pid, want) {
  const w = String(want)
  return page
    .evaluate(
      async ({ pid: p, want: v }) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const vis = (e) => {
          if (!e) return false
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms))
        const box = document.querySelector('#sell-field-p-' + p)
        if (!box) return { ok: false, why: 'no_box' }
        const picked = () =>
          Array.from(box.querySelectorAll('[class*=selection-item],[class*=SelectionItem]'))
            .map((e) => clean(e.innerText))
            .filter(Boolean)
        if (picked().includes(v)) return { ok: true, already: true, 已选: picked() }
        const cands = Array.from(box.querySelectorAll('label,span,div,li'))
          .filter(vis)
          .filter((e) => clean(e.innerText) === v)
        if (!cands.length) {
          const more = Array.from(box.querySelectorAll('button,span,div'))
            .filter(vis)
            .find((e) => /更多|展开|全部/.test(clean(e.innerText)) && clean(e.innerText).length < 10)
          if (more) {
            for (const ev of ['mousedown', 'mouseup', 'click']) {
              more.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
            }
            await sleep2(1200)
          }
          const again = Array.from(box.querySelectorAll('label,span,div,li'))
            .filter(vis)
            .filter((e) => clean(e.innerText) === v)
          if (!again.length) {
            return { ok: false, why: 'option_not_found', 点过更多: !!more, 容器文本: clean(box.innerText).slice(0, 120) }
          }
          cands.push(...again)
        }
        const el = cands[cands.length - 1]
        for (const ev of ['mousedown', 'mouseup', 'click']) {
          el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
        }
        await sleep2(1300)
        return { ok: true, 已选: picked(), 容器文本: clean(box.innerText).slice(0, 80) }
      },
      { pid, want: w },
    )
    .catch((e) => ({ ok: false, why: 'evaluate_failed', 详情: msg(e) }))
}

// ── product.json 装载 ─────────────────────────────────────────────────────────
async function loadProduct(product) {
  if (product && typeof product === 'object') return product
  if (!product) return {}
  try {
    return JSON.parse(readFileSync(resolvePath(String(product)), 'utf8'))
  } catch (e) {
    return { __readError: msg(e) }
  }
}

/** 读回地图：属性名 → 读回值（多选 tag 拼 `/`，否则输入值/已选计数；都没有给 null）。 */
function readbackMap(fields, names) {
  const out = {}
  for (const name of names) {
    const f = byLabel(fields, name)
    if (!f) {
      out[name] = null
      continue
    }
    if (f.chips && f.chips.length) out[name] = f.chips.join('/')
    else out[name] = f.输入值 || f.已选计数 || null
  }
  return out
}

// ── 主流程：fillBasic ─────────────────────────────────────────────────────────
/**
 * 基础字段 + 必填属性填写。
 *
 * @param page ego page（由编排层 connectSpace 取好，勿在本函数里 goto 发品域名）。
 * @param product product.json 对象或**绝对/相对路径**。
 * @param opts.catId 期望类目 id：给了就和页面 URL 的 catId 核对，不一致立即失败（防填错表）。
 * @param opts.title 覆盖标题（原位 `--title`）。
 * @param opts.attributes 覆盖属性表（默认 product.attributes）。
 * @param opts.dry true = 只展开 + 读回，不填任何字段（原位 `--dry`）。
 * @param opts.strictReadback 收紧成功判据为「读回严格相等」；默认 false（保持原脚本判据）。
 * @param opts.requirePublishPage 默认 true：页面必须落在 publish.htm。
 * @param opts.pageUrl 给了就要求当前 URL 含该子串（原位 `--page-url`）。
 *
 * @returns 成功 `{ ok:true, 标题, 卖点, 属性, 货号, ... }`；失败 `{ ok:false, why, ...读回 }`。
 *          两种都带 `结果`（逐字段明细）、`读回`（属性区原样读回数组）、`缺失属性`、`警告`。
 */
export async function fillBasic(
  page,
  product,
  { catId = '', dry = false, title, attributes, strictReadback, pageUrl = '', requirePublishPage = true } = {},
) {
  const url0 = await getUrl(page)
  if (!page || typeof page.evaluate !== 'function') return { ok: false, why: 'no_page', 读回: [] }
  if (requirePublishPage && !/publish\.htm/.test(url0)) {
    say('★ 找不到可用的发布页（publish.htm）—— 先跑入口段（tb_enter_form.mjs / run_listing_tb.mjs）')
    return { ok: false, why: 'no_publish_page', 现有页: [url0.slice(0, 120)], 读回: [] }
  }
  if (pageUrl && !url0.includes(String(pageUrl))) {
    return { ok: false, why: 'page_url_mismatch', 现有页: [url0.slice(0, 160)], 期望页: String(pageUrl), 读回: [] }
  }
  const 页面catId = (url0.match(/catId=(\d+)/) || [])[1] || ''
  const 期望catId = String(catId || pick('catId', '') || '')
  const 警告 = []
  if (期望catId && 页面catId && 期望catId !== 页面catId) {
    return {
      ok: false,
      why: 'catId_mismatch',
      catId页面: 页面catId,
      catId期望: 期望catId,
      读回: [],
    }
  }
  if (期望catId && !页面catId) 警告.push('页面 URL 没有 catId，未做类目核对')

  const PRODUCT = await loadProduct(product)
  if (PRODUCT.__readError) return { ok: false, why: 'product_read_failed', 详情: PRODUCT.__readError, 读回: [] }

  const ATTRS = attributes && typeof attributes === 'object' ? attributes : PRODUCT.attributes || {}
  // ★ 必填属性名单（tb_build.py 从素材包 R4 的 required 元数据带过来的）：
  //   「源值不在本类目可选值里」时 —— 必填判失败、选填警告跳过。见下面 option_not_found 的分流。
  const ARRAY_REQ = Array.isArray(PRODUCT.required_attributes) ? PRODUCT.required_attributes : []
  const STRICT = strictReadback === undefined ? !!pick('strictReadback', false) : !!strictReadback

  const TITLE_RAW = String(title !== undefined && title !== null && title !== '' ? title : PRODUCT.title || '')
  const TITLE = clampTitle(TITLE_RAW)
  say('素材包给的：标题 =', TITLE)
  say('属性 =', json(ATTRS))

  // ★ 属性常被**折叠**（「展开补充更多信息」「展开」）→ 先反复点开到没有为止，
  //   否则读不到、更填不上（PE 木纹实测：15 个属性只读到 3 个）
  const expanded = await expandCollapsedSections(page, { passes: 5 })
  say('①b 展开折叠区:', json(expanded))
  await sleep(1500)

  const fields = await readFields(page)
  say('属性区块:', fields.map((f) => `${f.label}(p-${f.pid}|${f.kind})`).join('  '))

  if (dry) return { ok: true, dry: true, fields, 读回: fields, 属性: readbackMap(fields, Object.keys(ATTRS)) }

  const res = {}
  const missing = []

  // ① 宝贝标题（30 汉字 = 60 字符口径）
  res['宝贝标题'] = TITLE
    ? await fillTitle(page, TITLE, { strict: STRICT })
    : { ok: false, why: 'product.json 没有 title', 读回一致: false }
  if (TITLE && res['宝贝标题'].ok && res['宝贝标题'].读回一致 === false) 警告.push('宝贝标题 读回与期望不一致')

  // ② 导购标题 / 卖点（素材包有才填；原位 `ATTRS['导购标题']`，新增兼容 `卖点`）
  let 卖点读回 = null
  const 卖点源 = ATTRS['导购标题'] !== undefined ? ATTRS['导购标题'] : ATTRS['卖点']
  if (卖点源 !== undefined && 卖点源 !== null && String(卖点源).trim() !== '') {
    const r = await fillSellingPoint(page, String(卖点源))
    res['导购标题'] = r
    卖点读回 = r.读回 ?? null
    if (r.ok && r.读回一致 === false) 警告.push('导购标题/卖点 读回与期望不一致')
  }

  // ③ 素材包给了的属性**逐个填**。
  // ⚠️ 不按容器 class 分堆：实测「适用猫体型」class 标着 `checkbox`，实际控件是**多选下拉**
  //    （容器里是 `next-select-trigger` + `next-select-arrow`，没有内联勾选项）→ 与 combobox
  //    同样「点开下拉选 .options-item」。
  const INPUT_LIKE = new Set(['货号', '型号', '购买须知', '商家编码'])
  for (const [name, value] of Object.entries(ATTRS)) {
    // ★ 导购标题 / 卖点已在 ② 处理：别让同名属性再走一遍（原位会二次填充，且会把 ② 的读回覆盖掉）
    if (name === '导购标题' || name === '卖点') {
      if (res['导购标题']) continue
    }
    // ★ 空值 = 用户明确不上这个属性 → 跳过。
    //   ⚠️ 绝不能拿空串去搜下拉：`includes('')` 恒真 → 会点中列表里的第一个选项（静默填错值）。
    if (value === null || value === undefined || String(value).trim() === '') {
      res[name] = { ok: true, 跳过: '空值（用户口径不上）' }
      continue
    }
    const f = byLabel(fields, name)
    // ★ 幂等：3c 会再跑一遍 fillBasic；多选「标签型」属性（适用空间/编织工艺等）
    //   若已经含这些值，再点一次会把 tag 变成两份（实测 其他×2 / 户外×2 / 阳台×2）
    if (f && Array.isArray(f.chips) && f.chips.length) {
      const wantVals = String(value)
        .split(/[,，、]/)
        .map((s2) => s2.trim())
        .filter(Boolean)
      const chips = f.chips.map(String)
      if (wantVals.length && wantVals.every((v) => chips.some((c) => c === v || c.includes(v)))) {
        res[name] = { ok: true, already: true, 读回: chips.join('/'), 跳过: '已选中（避免重复 tag）' }
        continue
      }
    }
    let r
    if (!f) {
      r = await fillByName(page, name, value, { strict: STRICT }) // 不在属性区 → 按属性名兜底
    } else if (name === '品牌') {
      r = await pickAutoComplete(page, f.pid, String(value)) // 品牌是 auto-complete 型
    } else if (INPUT_LIKE.has(name) || f.kind === 'input') {
      r = await fillInputByPid(page, f.pid, String(value), { strict: STRICT })
      if (r.ok && r.读回一致 === false) 警告.push(`${name} 读回与期望不一致`)
    } else {
      // ★ 素材包口径：多值用**英文逗号**分隔（「多值内容 | 多个值使用英文逗号分隔」）。
      //   多选控件要**逐个值**分别点选 —— 把 `阳台,户外` 整串丢进搜索框只会得到「无选项」。
      const vals = String(value)
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean)
        // ★ 已有的标签值不再点（避免重复；只补缺的）
        .filter((v) => !(Array.isArray(f && f.chips) && f.chips.some((c) => String(c) === v || String(c).includes(v))))
      if (vals.length > 1) {
        const sub = []
        for (const v of vals) sub.push(await pickOption(page, f.pid, v))
        r = { ok: sub.every((x) => x.ok), 多值: vals, 结果: sub }
        if (sub.some((x) => x.ok && x.读回一致 === false)) 警告.push(`${name} 多值读回不一致`)
      } else {
        r = await pickOption(page, f.pid, String(value))
        if (r.ok && r.读回一致 === false) 警告.push(`${name} 读回与期望不一致`)
      }
    }
    // ★ `no_box` = **本类目页面上没有这个属性**（素材包属性集比现场表更宽，实测地毯类目
    //   的「适用场景」页面上就没有）→ 不算失败，但要显式报出来，不能静默吞掉。
    //   例外：**过半**属性都找不到 → 多半是类目/页面不对，仍然判失败。
    if (!r.ok && r.why === 'no_box') {
      r = { ok: true, 跳过: '本类目页面上没有这个属性（未填）' }
      missing.push(name)
    }
    // ★ 容器在、但里面没有 input（新版 UI 是下拉/开关/纯说明）→ 选填不拖垮整条链；必填仍失败
    if (!r.ok && r.why === 'no_input' && !ARRAY_REQ.includes(name)) {
      r = { ok: true, 跳过: '本类目该属性在新版 UI 里没有可填输入框（未填）', 容器: r.容器 }
      say(`⚠ [选填] 「${name}」在新版表单里没有 input 可填 → 跳过`)
    }
    // ★★ `option_not_found` = **素材包给的值不在这个类目的可选值里**（门禁 12：不许静默换近义词）。
    //   按**必填/选填**分流：
    //     · 必填（required_attributes 里有）→ 仍然判失败，并把可选值原样列出来给人改素材包；
    //     · 选填 → **警告 + 跳过**，不拖垮整条链。
    if (!r.ok && r.why === 'option_not_found') {
      const req = ARRAY_REQ.includes(name)
      const val = String(value)
      if (req) {
        r = { ...r, ok: false, 必填: true, 值: val, 提示: '★ 必填属性，但素材包给的值不在本类目可选值里 → 请改素材包' }
        say(`★ [必填] 「${name}」= ${val} 不在本类目可选值里；可选：${(r.候选 || []).join(' / ') || '（见上面弹层文本）'}`)
      } else {
        r = { ok: true, 跳过: `选填属性：值「${val}」不在本类目可选值里（未填）`, 可选: (r.候选 || []).slice(0, 12) }
        say(`⚠ [选填] 「${name}」= ${val} 不在本类目可选值里 → 跳过不填；可选：${(r.候选 || []).join(' / ') || '（无候选）'}`)
      }
    }
    res[name] = r
  }
  if (missing.length) say('⚠ 页面上没有这些属性（已跳过、未填）：' + missing.join('、'))

  await sleep(1200)
  const after = await readFields(page)
  const 属性 = readbackMap(after, Object.keys(ATTRS))
  // 属性区里读不到、但 fillByName 兜底填过的（宝贝类型 / 采购地 等）→ 用当时读回补上
  for (const name of Object.keys(ATTRS)) {
    if (属性[name] === null && res[name] && typeof res[name].读回 === 'string' && res[name].读回 !== '') 属性[name] = res[name].读回
  }
  let 标题 = await readTitleValue(page).catch(() => null)
  if (!标题) {
    // 读不到标题框（或已空）时退回填标题那一步的读回，避免把已经填上的值报成 null
    const t = res['宝贝标题'] && res['宝贝标题'].读回
    标题 = t || null
  }
  const 卖点 = 卖点读回
  const 货号字段 = byLabel(after, '货号')
  const 货号 = (货号字段 && 货号字段.输入值) || (res['货号'] && res['货号'].读回) || 属性['货号'] || null

  const 失败字段 = Object.entries(res)
    .filter(([, r]) => !r || !r.ok)
    .map(([k]) => k)
  const 过半缺失 = missing.length > Object.keys(ATTRS).length / 2
  if (过半缺失) say('★ 过半属性在页面上找不到 → 疑似类目/页面不对，请核对')
  const ok = 失败字段.length === 0 && !过半缺失
  const 读回 = after.filter((f) => Object.keys(res).some((k) => k === f.label))
  const base = { 标题, 卖点, 属性, 货号, 结果: res, 读回, 缺失属性: missing, 警告, catId页面: 页面catId || null }
  if (ok) return { ok: true, ...base }
  say('✗ 有字段没填上:', 失败字段.join('、'))
  return {
    ok: false,
    why: 失败字段.length ? '字段未填全' : '过半属性缺失（疑似类目/页面不对）',
    失败字段,
    ...base,
  }
}

export default { fillBasic, fillTitle, fillSellingPoint, fillInputByPid, fillByName, pickAutoComplete, pickOption, pickCheckbox, readFields, expandCollapsedSections, clickBlank, clearOverlayAt, openSelect, clampTitle }
