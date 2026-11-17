/**
 * 下拉 / 单选类类目属性（ego 版）—— 移植自原 Playwright/CDP 脚本 `tb_fill_selects.js`。
 *
 * ── 原脚本 ──────────────────────────────────────────────────────────────
 *   taobao-product-listing\scripts\tb_fill_selects.js
 *   为什么单独一个脚本：原 `tb_fill_basic.js` 的通用填法只覆盖文本框；下拉类
 *   （库存类型 / 功能 / 适用空间 / 风格 / 图案 / 材质 / 面层工艺 …）要
 *   **先展开折叠区 → 按属性名找到下拉 → 真实鼠标点开 → 点选项 → 点空白触发 blur**。
 *   实测结论（保留）：页面上多数属性**没有**独立下拉，由 SKU 表决定 → 这是「备用件」。
 *
 * ── 移植差异（locator→evaluate、真实鼠标） ──────────────────────────────
 *   1) 取页：不连 CDP —— page 由编排层（run_listing_tb.mjs）传进来；原「没有发布页就退出」
 *      的守卫保留为 `{ok:false, why:'no_publish_page'}`。
 *   2) 定位：ego 无 locator → 全部在 `page.evaluate` 里按「属性名开头的容器」找
 *      （原位 `div,label` + 文本长度 < 34 + 取最短的那个，原样保留）。
 *   3) 点击：`page.mouse.move`（没有就跳过）+ `page.mouse.click` 真实鼠标点开下拉；
 *      选值仍是原脚本的合成 `mousedown/mouseup/click`；最后点空白触发 blur（真实鼠标）。
 *   4) 等弹层：原位固定 `sleep(1600)` → ego 版改成「轮询到选项出现为止（上限 4s）」，
 *      弹层没出现也继续往下走（结果同样是 `no_option`，候选为空）。
 *   5) 读回：原脚本只把「点中了哪个选项」当成功判据；这里**额外**回读该属性容器的
 *      `输入值` / `chips` / `容器文本`（放在 `读回` 字段，**不参与 ok 判定**，判据仍是原样）。
 *   6) 空值：原脚本没挡空串 —— 空串会 `includes('')` 命中第一个选项（静默填错）。这里按
 *      `tb_fill_basic` 的同一条硬规则「空值 = 用户口径不上 → 跳过」，**绝不用空串搜选项**。
 *   7) DRY：原脚本在 dry 模式下 `hit.ok=false` → 整步必判失败；ego 版 dry 只做定位，
 *      未定位到的才算失败（dry 是给人看「会点哪里」的，不该自己被判失败）。
 *   8) 配置：ego 子进程不继承环境变量 → 只从 `globalThis.__TB_CFG` 惰性读（不读 process.env）。
 *      导出接口：`fillSelects(page, product, opts?)`；第三参数可省略（`dry` / `attributes`）。
 *
 * ── 仍然依赖的硬规则 ────────────────────────────────────────────────────
 *   · 文本类属性（品牌 / 货号 / 型号 / 购买须知 / 商家编码）已由 `tb_fill_basic` 处理 → 这里 SKIP。
 *   · 属性容器按「文本以 `*属性名` 开头」+ 长度上限筛，**取最短的那个**（否则会拿到整块属性区）。
 *   · 容器里没有 input 时向**上**最多 3 层找（next-select 的触发框常在父容器里）。
 *   · 选项池是全局的 `li / [class*=option-item] / [class*=menu-item] / [class*=select-item]`：
 *     先全等，再 includes，再 includes 值的 `/` 前第一段（素材包里 `A/B` 这种写法）。
 *   · 选完必须点空白触发 blur（不点值不生效）。
 *   · 点开下拉前先 `scrollIntoView({block:'center'})` —— 否则算出来的坐标点不到控件。
 *
 * 不要在本文件里连浏览器/开进程；只导出函数，由同一个 ego 进程里的编排脚本调用。
 */
import { sleep, say, waitUntil } from '../lib/tb_ego.mjs'

/** ego 子进程不继承自定义环境变量 → 配置只从 globalThis.__TB_CFG 惰性读。 */
const cfg = () => (typeof globalThis !== 'undefined' && globalThis.__TB_CFG) || {}
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

const getUrl = async (page) => {
  try {
    return String(await page.url())
  } catch {
    return ''
  }
}

// ── 真实鼠标 / 键盘的安全封装（ego 不保证 mouse.move 存在） ─────────────────────
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

/** 点空白触发 blur（原位两处候选点；真实鼠标）。重复点无害，所以允许 plain 重试。
 *  ⚠️ 候选点先夹进视口（ego 窗口可能比 1250 窄；越界时 elementFromPoint 返回 null）。 */
async function clickBlank(page) {
  const blank = await page
    .evaluate(() => {
      const w = document.documentElement.clientWidth || window.innerWidth || 1280
      const h = document.documentElement.clientHeight || window.innerHeight || 800
      const clamp = (p) => ({
        x: Math.min(Math.max(2, p.x), Math.max(2, w - 2)),
        y: Math.min(Math.max(2, p.y), Math.max(2, h - 2)),
      })
      for (const p of [{ x: 1250, y: 60 }, { x: 300, y: 62 }]) {
        const q = clamp(p)
        const el = document.elementFromPoint(q.x, q.y)
        if (el && !el.closest('input,textarea,select,button,a')) return q
      }
      return clamp({ x: 1250, y: 60 })
    })
    .catch(() => ({ x: 1250, y: 60 }))
  const r = await mouseClick(page, blank.x, blank.y, 'blank', { retryPlain: true })
  return { ...r, at: blank }
}

// ── 浏览器侧函数（自包含，ego 会序列化进页面执行） ─────────────────────────────

/**
 * 反复点开所有折叠入口（原 expandAll，passes=6）。
 * 原位顺序：找可见的「展开补充更多信息|展开|更多属性|查看更多|展开全部」叶子 → 点掉 → 等 1.5s。
 */
export async function expandAllSections(page, { passes = 6 } = {}) {
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

/**
 * 找属性容器里的「下拉触发框」并返回中心坐标（原脚本 ① 原样）：
 * `div,label` 里文本以 `*属性名` 开头、长度 < 34、**取最短**；容器里第一个可见 input，
 * 没有就向上最多 3 层找。找不到返回 `{ok:false, why:'no_box'|'no_input', 容器}`。
 */
export async function locateSelect(page, name) {
  return page
    .evaluate((n) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const cands = Array.from(document.querySelectorAll('div,label'))
        .filter(vis)
        .filter((e) => new RegExp('^\\*?\\s*' + n + '(\\s|$)').test(clean(e.innerText)) && clean(e.innerText).length < 34)
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
      if (!inp) return { ok: false, why: 'no_input', 容器: clean(box.innerText).slice(0, 24) }
      const r = inp.getBoundingClientRect()
      return {
        ok: true,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        现: inp.value,
        只读: inp.readOnly,
        容器: clean(box.innerText).slice(0, 34),
      }
    }, String(name))
    .catch((e) => ({ ok: false, why: 'evaluate_failed', 详情: msg(e) }))
}

/**
 * 弹层里选值（原脚本 ② 原样）：
 * 池 = 可见的 `li / [class*=option-item] / [class*=menu-item] / [class*=select-item]`；
 * 先全等 → 再 includes → 再 includes 值的 `/` 前第一段。命中后合成 mousedown/mouseup/click。
 */
export async function pickInPopup(page, want) {
  return page
    .evaluate((v) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const pool = Array.from(document.querySelectorAll('li,[class*=option-item],[class*=menu-item],[class*=select-item]')).filter(vis)
      const h =
        pool.find((e) => clean(e.innerText) === v) ||
        pool.find((e) => clean(e.innerText).includes(v)) ||
        pool.find((e) => clean(e.innerText).includes(String(v).split('/')[0]))
      if (!h) return { ok: false, why: 'no_option', 候选: pool.map((e) => clean(e.innerText)).slice(0, 16) }
      for (const ev of ['mousedown', 'mouseup', 'click']) {
        h.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
      }
      return { ok: true, 选中: clean(h.innerText).slice(0, 16) }
    }, String(want))
    .catch((e) => ({ ok: false, why: 'evaluate_failed', 详情: msg(e) }))
}

/** 回读某属性容器（附加诊断，不参与 ok 判定）：输入值 / 多选 tag / 容器文本。 */
export async function readByName(page, name) {
  return page
    .evaluate((n) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const cands = Array.from(document.querySelectorAll('div,label'))
        .filter(vis)
        .filter((e) => new RegExp('^\\*?\\s*' + n + '(\\s|$)').test(clean(e.innerText)) && clean(e.innerText).length < 34)
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
      // 多选 tag 只读叶子 `.next-tag-body`（同 tb_fill_basic 的硬规则）；
      // 没有 tag 就别拼容器文本（会把「请选择」当成值）
      const bodies = Array.from(box.querySelectorAll('.next-tag-body')).map((e) => clean(e.innerText)).filter(Boolean)
      const 容器文本 = clean(box.innerText).slice(0, 80)
      return {
        容器文本,
        输入值: inp ? inp.value : null,
        chips: bodies.length ? bodies.join('/') : '',
        已选计数: (容器文本.match(/已选择\s*(\d+)\s*\/\s*(\d+)\s*项/) || []).slice(1).join('/') || null,
      }
    }, String(name))
    .catch(() => null)
}

// ── product 装载 ─────────────────────────────────────────────────────────────
async function loadProduct(product) {
  if (product && typeof product === 'object') return product
  if (!product) return {}
  try {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    return JSON.parse(readFileSync(resolve(String(product)), 'utf8'))
  } catch (e) {
    return { __readError: msg(e) }
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
/**
 * 下拉 / 单选类类目属性填写。
 *
 * @param page ego page（编排层 connectSpace 取好；本函数不 goto）。
 * @param product product.json 对象或路径。
 * @param opts.dry 只定位不点击（默认 false）。
 * @param opts.attributes 覆盖属性表（默认 product.attributes）。
 *
 * @returns 成功 `{ ok:true, 属性, 结果 }`；失败 `{ ok:false, why, 未填上, 属性, 结果, 读回 }`。
 *          两种都带 `未填上`（属性名数组）、`属性`（属性名 → 读回值）、`读回`（同 `属性`）。
 */
export async function fillSelects(page, product, opts = {}) {
  const dry = opts.dry === undefined ? !!pick('dry', false) : !!opts.dry
  const url0 = await getUrl(page)
  if (!page || typeof page.evaluate !== 'function') return { ok: false, why: 'no_page', 读回: {} }
  if (!/publish\.htm/.test(url0)) {
    say('没有发布页')
    return { ok: false, why: 'no_publish_page', 现有页: [url0.slice(0, 120)], 读回: {} }
  }
  say('工作页:', url0.slice(0, 90))

  const PRODUCT = await loadProduct(product)
  if (PRODUCT.__readError) return { ok: false, why: 'product_read_failed', 详情: PRODUCT.__readError, 读回: {} }
  const ATTRS = opts.attributes && typeof opts.attributes === 'object' ? opts.attributes : PRODUCT.attributes || {}

  // 已经在属性区由 tb_fill_basic 处理过的（文本类）不在这里重复；这里只做「选择类」
  const SKIP = new Set(['品牌', '货号', '型号', '购买须知', '商家编码'])

  const expanded = await expandAllSections(page, { passes: 6 })
  say('展开折叠区:', json(expanded))
  await sleep(1500)

  const todo = Object.entries(ATTRS).filter(([k]) => !SKIP.has(k))
  say('待填属性:', todo.map(([k]) => k).join(' / '))

  const result = {}
  const 跳过 = {}

  for (const [name, val] of todo) {
    // ★ 空值 = 用户口径不上 → 跳过。绝不能用空串去搜选项（includes('') 恒真 → 点中第一个）。
    if (val === null || val === undefined || String(val).trim() === '') {
      result[name] = { ok: true, 跳过: '空值（用户口径不上）' }
      跳过[name] = '空值'
      continue
    }
    // ① 找容器里那个「下拉触发框」
    const c = await locateSelect(page, name)
    if (!c.ok) {
      result[name] = { ...c, 读回: null }
      say(`✗ ${name}:`, json(c))
      continue
    }
    if (dry) {
      result[name] = { ok: true, dry: true, 坐标: { x: c.x, y: c.y }, 现: c.现, 只读: c.只读 }
      continue
    }

    // ② 真实鼠标点开（move → 200ms → click），再轮询弹层
    await mouseMove(page, c.x, c.y)
    await sleep(200)
    const opened = await mouseClick(page, c.x, c.y, 'select:' + name, { retryPlain: true })
    await sleep(200)
    await waitUntil(
      async () => {
        const n = await page
          .evaluate(() => {
            const vis = (e) => {
              if (!e) return false
              const r = e.getBoundingClientRect()
              return r.width > 0 && r.height > 0
            }
            // 只认下拉弹层/选项，别用裸 `li`（页面别处的列表会让这里恒真、等待失去意义）
            return Array.from(
              document.querySelectorAll(
                '.options-item,[class*=option-item],[class*=menu-item],[class*=select-item],.next-select-popup-wrap,.sell-o-select-popup,.sell-o-select-options',
              ),
            ).filter(vis).length
          })
          .catch(() => 0)
        return n > 0 ? n : null
      },
      { timeoutMs: 4000, intervalMs: 250, label: 'popup:' + name },
    )

    // ③ 弹层里选值
    const hit = await pickInPopup(page, val)
    // ④ 点空白触发 blur（不点值不生效）
    await sleep(700)
    const blank = await clickBlank(page)
    await sleep(600)

    const 读回 = await readByName(page, name)
    result[name] = {
      ...hit,
      打开: opened.ok ? opened.how || 'mouse' : opened.why,
      空白: blank.at,
      读回,
    }
    say(`${hit.ok ? '✓' : '✗'} ${name} = ${val}`, hit.ok ? json(hit.选中) : json(hit))
  }

  // 最终读回地图（属性名 → 读回值），既给编排层核对，也让失败结果带读回
  const 属性 = {}
  for (const [name] of todo) {
    const rb = await readByName(page, name)
    if (!rb) {
      属性[name] = null
      continue
    }
    属性[name] = rb.chips || rb.输入值 || rb.已选计数 || null
  }

  const bad = Object.entries(result)
    .filter(([, r]) => !r.ok)
    .map(([k]) => k)
  const ok = bad.length === 0
  const base = { 属性, 读回: 属性, 结果: result, 未填上: bad, 跳过 }
  if (ok) return { ok: true, ...base }
  say('✗ 下拉类属性没填上:', bad.join(' / ') || '（无）')
  return { ok: false, why: bad.length ? '下拉属性未填上' : '下拉属性定位失败', ...base }
}

export default { fillSelects, expandAllSections, locateSelect, pickInPopup, readByName }
