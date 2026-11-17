/**
 * 宝贝详情图上传（ego 版，完整闭环、分批）—— 移植自
 *   taobao-product-listing\scripts\tb_upload_detail.js
 *
 * 原脚本的链路（2026-10-10 实测）：
 *   ① 图文描述区「添加」→「图片」→ 打开图片空间面板（与主图同一个 `sucai-selector-ng`）
 *   ② 「本地上传」一次喂多张（filechooser 支持数组）
 *   ③ **关掉「上传结果」对话框**（点它右下角「完成」）—— 不关会盖住列表、认错卡片
 *   ④ 列表里**按文件名逐张**真实鼠标点（**多选累加**，底部「确定」变「确定(N)」）
 *   ⑤ 点底部 `Footer…` 的「确定(N)」→ 详情图铺上
 *   ⑥ 读回 `lite-decoration-editor` 里的 img 数
 *
 * 与 Playwright/CDP 原版的差异（只换执行层，不改硬规则）：
 *   - 面板定位：原版 `page.frames().filter(...).filter(f => f.name() !== 'mainImagesGroup')` 取最后一个。
 *     ego 的 page 没有 frames → 在 `page.evaluate` 里按 src/name/id 找 `<iframe>`，
 *     **显式排除 `mainImagesGroup`（主图那组 max=1、底部没有「确定」，挂错就整步崩）**，取 DOM 里最后一个；
 *     内部元素经 `iframe.contentDocument` 访问（同源），返回 iframe 偏移后
 *     点击一律 `page.mouse.click(iframe.left + x, iframe.top + y)`。
 *   - iframe 句柄不再复用：原版读过 `Frame was detached` 的坑 —— 这里**每次读都重新按 page 解析 iframe**
 *     （面板被重建时自然拿到新的那个，等价于原版的「每轮重解析 + 重试 3 次」）。
 *   - 上传：原版 `waitForEvent('filechooser')` + `locator(...).click()` → ego 用共享库 `uploadFiles`
 *     （`page.waitForFileChooser()` + `chooser.setFiles(files)`；无 filechooser 时退回 input[type=file]+setInputFiles）。
 *   - 轮询：原版在 iframe 内 `evaluate(async …)` 边滚边等；ego 的 evaluate 不保证支持 async 函数
 *     → 改成 Node 侧一轮一个同步 evaluate（`scan` / `scrollBy` / `card`）+ sleep，判据不变。
 *   - 截图：原版会 `page.screenshot()`；ego 没有截图接口 → 改成打印读回 JSON（不影响判定）。
 *
 * 仍依赖的硬规则（原文实测，逐条保留）：
 *   1. **每批 ≤ 20 张**（一次喂 26 张只进 18 张，其余静默丢失）；每批各自「上传 → 自动全选 → 点确定(N)」；
 *   2. 上传完先关「上传结果」的「完成」，再认图；认图**按文件名**，`确定(N)` 的数字是**权威判据**；
 *   3. **已经勾上的卡片绝不点**（点一下 = 取消勾选；实测就是这样把自动全选一张张取消掉的）；
 *   4. 面板停在「确定(N)」待确定状态 → 只点「确定」把它提交掉；**绝不刷新页面**
 *      （2026-10-13 实测：reload 后标题 / 属性 / 99 行 SKU / 主图 / 26 张详情图全丢）；
 *   5. 面板 iframe 会被重建：所有读都重新解析，绝不持旧句柄；
 *   6. 开面板前先关掉**任何**残留素材面板（含主图 `mainImagesGroup`）——「详情图整步崩」的根因。
 *
 * 导出（由 run_listing_tb.mjs 在同一 ego 进程内顺序调用）：
 *   `uploadDetail(page, dir, { skip, limit, batch })`
 *     → `{ ok, uploaded, want, failedImgs, counted, ...读回 }`
 *   - `uploaded` = 底部 `确定(N)` 认定已选的张数；`want` = 本批切片张数；
 *   - `failedImgs` = 走勾选路径时未能选中的文件名（自动全选已齐时为空）；
 *   - 失败：`{ ok:false, why, uploaded, want, failedImgs: [], ...读回 }`
 *   可选（与 cfg 同名，默认关，保持原版默认行为）：
 *     `globalThis.__TB_CFG` 里 `detailCheckExists` / `detailSearchFallback` / `detailNoSelect`
 *     分别对应原版 `--check-exists` / `--search-fallback` / `--no-select`。
 *   不写 main/CLI，不打印 JSON 行（由编排层负责）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { say, sleep, uploadFiles, frameEvalShim } from '../lib/tb_ego.mjs'

const PANEL_KEY = 'sucai-selector-ng'
/** 主图那组面板：max=1、底部没有「确定」→ 详情步绝不能挂到它上面（原版硬排除）。 */
const MAIN_PANEL_NAME = 'mainImagesGroup'
/** ★ 每批上限：实测一批喂 >20 张会被截断（26 张只进 18 张）。 */
const MAX_BATCH = 20
const IMG_RE = /\.(jpe?g|png|webp)$/i

/**
 * ego 子进程不继承自定义环境变量 → 配置只从 `globalThis.__TB_CFG` 读（与 tb_enter_form.mjs 的 INLINE 同源）。
 * ★ 每次调用时现读：本模块可能被 run_listing_tb.mjs **静态 import**，那一刻 `__TB_CFG` 还没赋值。
 */
const tbCfg = () => (typeof globalThis !== 'undefined' && globalThis.__TB_CFG) || {}
const cfgVal = (key, dflt) => {
  const c = tbCfg()
  return c[key] === undefined || c[key] === null || c[key] === '' ? dflt : c[key]
}
const cfgFlag = (key) => {
  const v = tbCfg()[key]
  return v === true || v === 1 || String(v) === '1' || String(v).toLowerCase() === 'true'
}
/** ego 的 setFiles 用正斜杠路径更稳（PDD ego 版实测这里会先 `replace(/\\/g, "/")`）。 */
const posix = (p) => String(p).replace(/\\/g, '/')

/**
 * 素材面板 iframe 内的一次读操作（ego 没有 page.frames()；现在是每次重新解析 iframe，不持句柄）。
 * 面板候选 = src/name/id 含 `sucai-selector-ng` 的 iframe，且 **name !== mainImagesGroup**，取最后一个。
 * 返回的 x/y 都是 **iframe 内坐标**；真实点击由调用方 `page.mouse.click(geom.left+x, geom.top+y)`。
 * @param page - ego page
 * @param op - 'frame' | 'footerBtn' | 'done' | 'uploadBtn' | 'scan' | 'scrollBy' | 'search' | 'card'
 * @param data - 该 op 的参数
 */
async function panelCall(page, op, data = {}) {
  const payload = await frameEvalShim(page, { needle: PANEL_KEY, excludeName: MAIN_PANEL_NAME, pick: 'last' }, ({ op, data, key, excludeName }) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const frames = [...document.querySelectorAll('iframe')]
      const hay = (f) =>
        String(f.getAttribute('src') || '') + ' ' + String(f.getAttribute('name') || '') + ' ' + String(f.id || '')
      // ★ 原版硬排除 mainImagesGroup（主图面板 max=1、底部没有「确定」）
      const cands = frames.filter((f) => hay(f).includes(key) && String(f.getAttribute('name') || '') !== excludeName)
      const frame = cands.length ? cands[cands.length - 1] : null
      if (!frame) {
        return {
          ok: false,
          why: 'no_frame',
          候选数: cands.length,
          帧样本: frames
            .map((f) => ({ name: String(f.getAttribute('name') || ''), src: String(f.getAttribute('src') || '').slice(0, 80) }))
            .slice(0, 6),
        }
      }
      const doc = frame.contentDocument
      if (!doc) return { ok: false, why: 'no_content_document', 面板: String(frame.getAttribute('name') || '') }
      const rect = frame.getBoundingClientRect()
      const geom = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      const v = (value) => ({ ok: true, value: { ok: true, ...value }, geom })
      const win = doc.defaultView || window
      const listEl = () => doc.querySelector('[class*="PicturesShow_main"]')

      switch (op) {
        case 'frame':
          return v({ name: String(frame.getAttribute('name') || ''), 候选数: cands.length, left: rect.left, top: rect.top })
        case 'footerBtn': {
          const b = [...doc.querySelectorAll('button')]
            .filter(vis)
            .find((x) => /^确定/.test(clean(x.innerText)))
          if (!b) return { ok: true, value: { ok: false, why: 'no_confirm', 文本: null }, geom }
          const r = b.getBoundingClientRect()
          return v({
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
            文本: clean(b.innerText),
            disabled: !!b.disabled,
          })
        }
        case 'done': {
          const b = [...doc.querySelectorAll('button')]
            .filter(vis)
            .find((x) => /^完成$/.test(clean(x.innerText)))
          if (!b) return { ok: true, value: { ok: false, why: 'no_done_btn' }, geom }
          const r = b.getBoundingClientRect()
          return v({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
        }
        case 'uploadBtn': {
          const inputs = doc.querySelectorAll('input[type=file]').length
          const b = [...doc.querySelectorAll('button')].filter(vis).find((x) => clean(x.innerText).includes('本地上传'))
          if (!b) return { ok: true, value: { ok: false, why: 'no_upload_entry', 文件输入数: inputs }, geom }
          const r = b.getBoundingClientRect()
          return v({ x: r.left + r.width / 2, y: r.top + r.height / 2, 文件输入数: inputs })
        }
        case 'scan': {
          // ★ 勾选主力路径的读法：扫当前可见卡片（不用搜索框 —— 实测搜索会让 iframe 重载）
          const out = []
          doc.querySelectorAll('[class*="PicList_PicturesShow_main-show"]').forEach((card) => {
            const t = clean(card.innerText)
            const m = t.match(/[\w\u4e00-\u9fa5.-]+\.(jpe?g|png|gif|webp)/i)
            if (!m) return
            const box = card.querySelector('.next-checkbox')
            const inp = card.querySelector('.next-checkbox input')
            const checked = inp ? !!inp.checked : /checked/i.test(String(box && box.className))
            const img = card.querySelector('img')
            const el = box || img || card
            const r = el.getBoundingClientRect()
            const ir = img ? img.getBoundingClientRect() : r
            if (r.width === 0 && ir.width === 0) return // 完全没渲染
            // 不在 iframe 可视区的不点（原版只排除「y > 2000」的极端值；ego 视口更小 → 用 iframe 自身视口判）
            const cx = r.left + r.width / 2
            const cy = r.top + r.height / 2
            const 可视 = r.width > 0 && r.height > 0 && cx > 0 && cx < geom.width && cy > 0 && cy < geom.height
            out.push({ name: m[0], x: cx, y: cy, imgTop: ir.top, 已选: checked, 可视 })
          })
          const l = listEl()
          return v({ cards: out, 滚动: l ? { top: l.scrollTop, ch: l.clientHeight, sh: l.scrollHeight } : null })
        }
        case 'scrollBy': {
          const l = listEl()
          if (!l) return { ok: true, value: { ok: false, why: 'no_list' }, geom }
          l.scrollTop += Math.max(200, Number(data.delta) || 0)
          return v({ top: l.scrollTop, ch: l.clientHeight, sh: l.scrollHeight })
        }
        case 'search': {
          // ★ 面板搜索框：输入文件名 + 回车（搜索是异步的，调用方还要再等）
          const kw = String(data.name || '')
          const i = [...doc.querySelectorAll('input')]
            .filter(vis)
            .find((x) => /搜索图片名称|请输入文件名称|搜索/.test(x.getAttribute('placeholder') || ''))
          if (!i) return { ok: true, value: { ok: false, why: 'no_search_input' }, geom }
          i.focus()
          // 受控输入：setter + input 事件（写 el.value 不算）
          const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set
          setter.call(i, kw)
          i.dispatchEvent(new win.Event('input', { bubbles: true }))
          for (const ev of ['keydown', 'keyup', 'keypress']) {
            i.dispatchEvent(new win.KeyboardEvent(ev, { key: 'Enter', keyCode: 13, which: 13, bubbles: true }))
          }
          return v({ 输入框值: i.value })
        }
        case 'card': {
          // 按文件名找「只含这一个文件名」的最近祖先卡片 → 点它右上角的勾选框
          const name = String(data.name || '')
          const cands = [...doc.querySelectorAll('div,li')]
            .filter(vis)
            .filter((e) => {
              const t = clean(e.innerText)
              if (!t.includes(name)) return false
              const names = [...new Set((t.match(/[\w\u4e00-\u9fa5.-]+\.(jpe?g|png|gif|webp)/gi) || []).map((x) => x.toLowerCase()))]
              return names.length === 1 // 这一层只含一个文件名 ⇒ 卡片本体
            })
          cands.sort((a, b) => a.innerText.length - b.innerText.length)
          const e = cands[0]
          if (!e) return { ok: true, value: { ok: false, why: 'no_card' }, geom }
          // ★ 真正可点的是卡片右上角的勾选框 `.next-checkbox`（点文件名标题那层选不中）
          const box = e.querySelector('.next-checkbox') || (e.parentElement ? e.parentElement.querySelector('.next-checkbox') : null)
          const target = box || e.querySelector('img') || e
          const r = target.getBoundingClientRect()
          return v({ 卡片: clean(e.innerText).slice(0, 30), 勾选框: !!box, x: r.left + r.width / 2, y: r.top + r.height / 2 })
        }
        default:
          return { ok: false, why: 'unknown_op:' + op, geom }
      }
    }, { op, data, key: PANEL_KEY, excludeName: MAIN_PANEL_NAME })
    .catch((e) => ({ ok: false, why: String((e && e.message) || e) }))
  if (!payload || payload.ok === false) {
    return {
      ok: false,
      why: (payload && payload.why) || 'panel_eval_failed',
      候选数: payload ? payload.候选数 : undefined,
      帧样本: payload ? payload.帧样本 : undefined,
    }
  }
  return { ...(payload.value || { ok: true }), geom: payload.geom }
}

/** 面板底部「确定」按钮文本（读不到就重试 3 次；面板 iframe 重建时不持旧句柄）。 */
async function panelFooter(page) {
  for (let k = 0; k < 3; k += 1) {
    const r = await panelCall(page, 'footerBtn')
    if (r.ok) return { 文本: r.文本, disabled: r.disabled }
    await sleep(1000)
  }
  return { 文本: null, disabled: null }
}

/** 「确定（N）」里的 N —— **权威判据**（别用 class 猜已选）。 */
async function panelSelCount(page) {
  const t = (await panelFooter(page)).文本 || ''
  const m = String(t).match(/[（(]\d+[)）]/)
  return m ? parseInt(m[0].replace(/[^\d]/g, ''), 10) || 0 : 0
}

/** 取当前素材面板 iframe 的偏移（每次重新解析；面板重建后仍然对）。 */
const frameGeom = async (page) => {
  const fr = await panelCall(page, 'frame')
  return fr.ok ? { ok: true, geom: fr.geom, name: fr.name, 候选数: fr.候选数 } : fr
}

/**
 * 在 iframe 内某点做真实鼠标点击；顺带回读「该坐标在主文档里命中了哪个元素」（被遮挡时能看出来）。
 * @param x - iframe 内 x
 * @param y - iframe 内 y
 */
async function mouseClickIn(page, x, y) {
  const g = await frameGeom(page)
  if (!g.ok) return { ok: false, why: 'no_geom' }
  const abs = { x: Math.round(g.geom.left + x), y: Math.round(g.geom.top + y) }
  const hit = await page
    .evaluate((p) => {
      const e = document.elementFromPoint(p.x, p.y)
      return e ? e.tagName.toLowerCase() + '.' + String(e.className).slice(0, 46) : null
    }, abs)
    .catch(() => null)
  await page.mouse.move(abs.x, abs.y)
  await sleep(250)
  await page.mouse.click(abs.x, abs.y, { label: 'panel-click' })
  return { ok: true, abs, geom: { left: Math.round(g.geom.left), top: Math.round(g.geom.top) }, 命中: hit }
}

/** 读回详情编辑器里的 img 数（`lite-decoration-editor`）；没有编辑器返回 null。 */
const editorImgs = (page) =>
  page
    .evaluate(() => {
      const ed = document.querySelector('[class*="lite-decoration-editor"]')
      return ed ? ed.querySelectorAll('img').length : null
    })
    .catch(() => null)

/** 主文档里还有几个 sucai 素材面板 iframe（含主图那组）。 */
const panelInfo = (page) =>
  page
    .evaluate(() => {
      const fs = [...document.querySelectorAll('iframe')].filter((f) => /sucai-selector-ng/.test(String(f.getAttribute('src') || '')))
      return { n: fs.length, names: fs.map((f) => String(f.getAttribute('name') || '(无名)')) }
    })
    .catch(() => ({ n: 0, names: [] }))

/**
 * ⓪b 关掉**任何**残留素材面板（含主图 `mainImagesGroup`）。
 * 原版注释：这是「详情图整步崩」的根因 —— 主图步失败后面板留在页面上，详情步挂到它上面，
 * footer 读不到、上传入口不可用 → 整批全崩。
 * @returns `{ closed, 本来就没有?, how? }`
 */
async function closeStalePanel(page) {
  const st = await panelInfo(page)
  if (!st.n) return { closed: true, 本来就没有: true }
  say(`⓪b 有残留素材面板（${st.names.join(',')}）→ 先关掉`)
  for (let i = 0; i < 3; i += 1) {
    const c = await page
      .evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const vis = (e) => {
          if (!e) return false
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const b = [...document.querySelectorAll('button')].filter(vis).find((x) => /^(取消|关闭)/.test(clean(x.innerText)))
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })
      .catch(() => null)
    if (!c) break
    await page.mouse.click(c.x, c.y, { label: 'close-stale-panel' }).catch(() => {})
    await sleep(2000)
    const now = await panelInfo(page)
    if (!now.n) {
      say('   已关掉 ✓')
      return { closed: true, how: 'button' }
    }
  }
  await page.keyboard.press('Escape').catch(() => {})
  await sleep(1800)
  const left = await panelInfo(page)
  say(left.n ? '   ★ 面板仍关不掉（继续尝试开正确面板）' : '   已关掉 ✓')
  return { closed: left.n === 0, 剩余面板: left.n }
}

/**
 * 等面板 iframe **真正就绪**（原版判据：连续两次能读到底部按钮文本）。
 * 刚打开的一瞬间 iframe 在初始化，读不到/抛错就重新计时。
 */
async function waitPanelReady(page, timeoutMs = 90000) {
  const t0 = Date.now()
  let stable = 0
  while (Date.now() - t0 < timeoutMs) {
    const fr = await panelCall(page, 'frame')
    if (fr.ok) {
      const fbt = await panelCall(page, 'footerBtn')
      if (fbt.ok) {
        stable += 1
        if (stable >= 2) return true
      } else stable = 0
    } else stable = 0
    await sleep(2500)
  }
  return false
}

/**
 * ① 打开详情图面板：图文描述区「添加」→「图片」。
 * （原版在 evaluate 内 dispatch 合成事件 + 等 2s；这里拆成两次同步 evaluate，中间 Node 侧 sleep。）
 */
async function openDetailPanel(page) {
  const first = await page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const hasPanel = [...document.querySelectorAll('iframe')].some((f) => /sucai-selector-ng/.test(String(f.getAttribute('src') || '')))
      if (hasPanel) return { ok: true, already: true }
      const add = [...document.querySelectorAll('div,span,button,a')].filter(vis).filter((e) => clean(e.innerText) === '添加')
      const a = add.filter((e) => !add.some((o) => o !== e && e.contains(o)))[0]
      if (!a) return { ok: false, why: 'no_add' }
      a.scrollIntoView({ block: 'center' })
      for (const ev of ['mousedown', 'mouseup', 'click']) {
        a.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
      }
      return { ok: true, 点了: '添加' }
    })
    .catch((e) => ({ ok: false, why: String((e && e.message) || e) }))
  if (!first.ok) return first
  if (first.already) return { ok: true, already: true }
  await sleep(2000)
  const second = await page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const pics = [...document.querySelectorAll('[class*="add_item"],[class*="add-item"],div,span,li')]
        .filter(vis)
        .filter((e) => clean(e.innerText) === '图片')
      const p = pics.filter((e) => !pics.some((o) => o !== e && e.contains(o)))[0]
      if (!p) return { ok: false, why: 'no_pic_item' }
      for (const ev of ['mousedown', 'mouseup', 'click']) {
        p.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
      }
      return { ok: true, 点了: '图片' }
    })
    .catch((e) => ({ ok: false, why: String((e && e.message) || e) }))
  return second
}

/**
 * ② 上传一批：真实鼠标点「本地上传」→ 共享库 `uploadFiles`（filechooser → chooser.setFiles，
 * 没有则退回 input[type=file] + setInputFiles）。原版 filechooser 超时 12s。
 */
async function uploadChunk(page, paths) {
  const btn = await panelCall(page, 'uploadBtn')
  if (!btn.ok) return { ok: false, why: 'no_upload_entry', 文件输入数: btn.文件输入数 }
  const abs = { x: Math.round(btn.geom.left + btn.x), y: Math.round(btn.geom.top + btn.y) }
  const trigger = async () => {
    await page.mouse.move(abs.x, abs.y)
    await sleep(200)
    await page.mouse.click(abs.x, abs.y, { label: 'detail-local-upload' })
  }
  const up = await uploadFiles(page, trigger, paths, { timeoutMs: 12000 }).catch((e) => ({
    ok: false,
    why: String((e && e.message) || e),
  }))
  if (!up.ok) return { ok: false, why: up.why || 'upload_failed', how: up.how, 文件输入数: btn.文件输入数 }
  return { ok: true, how: up.how, count: up.count }
}

/** ③ 关「上传结果」：点右下角「完成」（原版硬规则）。 */
async function closeUploadResult(page) {
  const done = await panelCall(page, 'done')
  if (!done.ok) return { ok: false, why: done.why || 'no_done_btn' }
  const hit = await mouseClickIn(page, done.x, done.y)
  return { ok: hit.ok, abs: hit.abs }
}

/**
 * ★ 勾选主力路径：**不用搜索框**，扫当前可见卡片 → 点它右上角的勾选框 → 需要时往下滚一屏。
 * 放弃搜索的原由（原版注释）：实测「输入文件名 + 回车」会让素材选择器 iframe 重载，
 * 第一个文件之后每张都抛 `Frame was detached`，26 张全崩；刚上传的图本来就在列表最前面。
 * ⚠️ 已勾选的**绝不点**（点一下就是取消勾选）。
 */
async function selectByVisibleScan(page, wantSet, maxScrolls = 14) {
  const picked = new Set()
  for (let s = 0; s <= maxScrolls && picked.size < wantSet.size; s += 1) {
    const st = await panelCall(page, 'scan')
    if (!st.ok) {
      await sleep(1800)
      continue // frame 被重建 → 下一轮重扫
    }
    for (const c of st.cards) {
      if (!wantSet.has(c.name) || picked.has(c.name)) continue
      // ★ 已经勾上的绝不点；记进 picked 防止后面重复判断
      if (c.已选) {
        picked.add(c.name)
        continue
      }
      if (!c.可视) continue
      await page.mouse.move(Math.round(st.geom.left + c.x), Math.round(st.geom.top + c.y))
      await sleep(250)
      await page.mouse.click(Math.round(st.geom.left + c.x), Math.round(st.geom.top + c.y), { label: 'pick-detail-card' })
      picked.add(c.name)
      await sleep(350)
    }
    if (picked.size >= wantSet.size) break
    await panelCall(page, 'scrollBy', { delta: Math.max(200, (st.滚动 ? st.滚动.ch : 300) - 140) })
    await sleep(1200)
  }
  return picked
}

/** ★ 兜底：搜索框定位 + 点勾选框（慢，且可能触发 iframe 重载 → 原版默认关闭）。 */
async function findCardBySearch(page, fname) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const searched = await panelCall(page, 'search', { name: fname })
    if (!searched.ok) {
      await sleep(1500)
      continue
    }
    // 双保险：焦点已在 iframe 搜索框上，再在页面层按一次回车
    await page.keyboard.press('Enter').catch(() => {})
    await sleep(4500)
    let found = await panelCall(page, 'card', { name: fname })
    if (found.ok) return found
    // 搜索是异步的，3~4s 有时不够 → 再等一会儿重搜一次（假阴性）
    await sleep(3500)
    found = await panelCall(page, 'card', { name: fname })
    if (found.ok) return found
    say(`   （第 ${attempt + 1} 次搜索没找到卡片，重试）`)
    await sleep(2500)
  }
  return { ok: false, why: 'frame_detached_x3' }
}

async function selectBySearch(page, fname) {
  const card = await findCardBySearch(page, fname)
  if (!card.ok) return card
  const hit = await mouseClickIn(page, card.x, card.y)
  return { ok: !!hit.ok, 卡片: card.卡片, 坐标: hit.abs }
}

/**
 * 宝贝详情图（本批切片）：分批上传 → 关闭上传结果 → 逐张按文件名勾选 → 点「确定(N)」→ 读回 img 数。
 * @param page - ego page（已在 publish.htm 发布表单页）
 * @param dir - 详情图目录（本机绝对路径）
 * @param options.skip - 跳过前 N 张（分批闭环时传已完成的张数）
 * @param options.limit - 本批最多取几张（**每批 ≤20**，多了会被截断）
 * @param options.batch - 一次喂几张（默认 20，强制 ≤20）
 * @returns 成功 `{ ok:true, uploaded, want, failedImgs, counted, ...读回 }`；失败 `{ ok:false, why, ...读回 }`
 */
export async function uploadDetail(page, dir, options = {}) {
  try {
    return await uploadDetailImpl(page, dir, options)
  } catch (e) {
    // 编排层约定：失败也返回对象，绝不把异常抛给 run_listing_tb
    return { ok: false, why: 'exception:' + String((e && e.message) || e), uploaded: 0, want: 0, failedImgs: [], counted: 0 }
  }
}

/** uploadDetail 的实际实现（异常统一由上面的 export 包住）。 */
async function uploadDetailImpl(page, dir, { skip = 0, limit = MAX_BATCH, batch = MAX_BATCH } = {}) {
  const t0 = Date.now()
  const absDir = resolve(String(dir || ''))
  if (!existsSync(absDir)) return { ok: false, why: 'no_dir', uploaded: 0, want: 0, failedImgs: [], counted: 0, 目录: absDir }
  let ALL
  try {
    ALL = readdirSync(absDir).filter((f) => IMG_RE.test(f)).sort()
  } catch (e) {
    return { ok: false, why: 'read_dir_failed:' + String((e && e.message) || e), uploaded: 0, want: 0, failedImgs: [], counted: 0, 目录: absDir }
  }
  const skipN = Math.max(0, Math.floor(Number(skip) || 0))
  const limitN = Math.max(0, Math.floor(Number(limit) || 0))
  // ★ 硬规则：详情图**每批 ≤20**（一次喂 26 张实测只进 18 张，其余静默丢失）。
  //   跨批必须由编排层用 skip 分批再调本函数 —— 每批各自走完「上传 → 自动全选 → 点确定(N)」，
  //   不在一批里挂两次待确定状态。
  if (limitN > MAX_BATCH) {
    return {
      ok: false,
      why: 'limit_over_batch_max',
      uploaded: 0,
      want: 0,
      failedImgs: [],
      counted: 0,
      目录: absDir,
      skip: skipN,
      limit: limitN,
      提示: `详情图每批最多 ${MAX_BATCH} 张：请按 skip 分批调用（例如 limit=${MAX_BATCH}）`,
    }
  }
  const files = ALL.slice(skipN, skipN + limitN)
  const base = { 目录: absDir, 素材张数: ALL.length, skip: skipN, limit: limitN, 本次: files }
  if (!files.length) {
    // 原版这里 exit 2（空切片），编排按实数分批就是为了不踩它
    return { ok: false, why: 'empty_slice', uploaded: 0, want: 0, failedImgs: [], counted: 0, ...base }
  }
  const want = files.length
  say(`目录共 ${ALL.length} 张，本批取第 ${skipN + 1}~${skipN + files.length} 张`)
  const startImgs = await editorImgs(page)
  say('工作页详情编辑器起始 img =', startImgs)

  // ⓪b ★ 先关掉**任何**残留素材面板（含主图 mainImagesGroup）—— 「详情图整步崩」的根因
  await closeStalePanel(page)

  // ⓪ 面板若停在「已选中待确定」状态 → 点「确定」提交掉；**绝不刷新**（刷新会丢全部已填内容）
  {
    const fr0 = await panelCall(page, 'frame')
    if (fr0.ok) {
      const st = await panelCall(page, 'footerBtn')
      if (st.ok && /[（(]\d+[)）]/.test(String(st.文本 || ''))) {
        say(`⓪ 面板停在「${st.文本}」（待确定）→ 点「确定」把它提交掉`)
        if (st.disabled) {
          say('   ★ 面板停在待确定状态且点不动「确定」→ 不刷新（刷新会丢全部内容），请人工关掉面板后重跑')
          return { ok: false, why: 'panel_pending_confirm', uploaded: 0, want, failedImgs: [], counted: startImgs, ...base }
        }
        const hit = await mouseClickIn(page, st.x, st.y)
        say('   点了确定:', JSON.stringify(hit.abs || hit))
        await sleep(5000)
        say('   已提交，详情 img =', await editorImgs(page))
      }
    }
  }

  // ① 打开面板：添加 → 图片
  const opened = await openDetailPanel(page)
  say('① 打开详情图面板:', JSON.stringify(opened))
  if (!opened.ok) return { ok: false, why: 'open_panel_failed:' + (opened.why || 'unknown'), uploaded: 0, want, failedImgs: [], counted: startImgs, ...base }

  // ★ 刚打开的 iframe 还在初始化，句柄会失效 → 轮询到就绪（原版 90s）
  const ready = await waitPanelReady(page, 90000)
  say('   面板就绪:', ready)
  if (!ready) return { ok: false, why: 'panel_not_ready', uploaded: 0, want, failedImgs: [], counted: startImgs, ...base }
  const fr = await panelCall(page, 'frame')
  if (!fr.ok) return { ok: false, why: 'no_panel', uploaded: 0, want, failedImgs: [], counted: startImgs, ...base, 帧样本: fr.帧样本 }
  say('   面板:', fr.name || '(无名)', '| 底部:', JSON.stringify(await panelFooter(page)))

  // ② 决定传哪些：默认**直接传**（逐张搜索查存在性会让 iframe 重载，极脆；要省副本才开 checkExists）
  const CHECK_EXISTS = cfgFlag('detailCheckExists')
  const FORCE_UPLOAD = cfgFlag('detailForceUpload')
  let toUpload = files.slice()
  if (FORCE_UPLOAD || !CHECK_EXISTS) {
    say(`② 直接上传 ${files.length} 张${FORCE_UPLOAD ? '（force）' : ''}`)
  } else {
    const missing = []
    for (const f of files) {
      const exists = await findCardBySearch(page, f)
      if (!exists.ok) missing.push(f)
    }
    toUpload = missing
    say(
      `② 图片空间里已有 ${files.length - missing.length} 张，待上传 ${missing.length} 张` +
        (missing.length ? `：${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' …' : ''}` : ''),
    )
  }

  // ③ 分批上传：**每批 ≤20**，每批各自走完「上传 → 自动全选 → 点确定(N)」，不跨批挂待确定状态
  const batchN = Math.max(1, Math.min(MAX_BATCH, Math.floor(Number(batch) || MAX_BATCH)))
  if (Number(batch) > MAX_BATCH) say(`   ⚠ batch=${batch} 超过每批上限 → 按 ${MAX_BATCH} 张/批`)
  const 批次 = []
  if (toUpload.length) {
    say(`③ 分批上传 ${toUpload.length} 张（每批 ≤${MAX_BATCH}，本批 ${batchN} 张）`)
    for (let i = 0; i < toUpload.length; i += batchN) {
      const chunk = toUpload.slice(i, i + batchN)
      const paths = chunk.map((f) => posix(join(absDir, f)))
      let selected = 0
      let how = null
      // ★★ 每个批次最多试 3 次：触发"自动全选"的是"上传动作"本身；实测有时不触发（已选 0），
      //    把同一批再传一次通常就触发了。不拿"逐张点勾选框"当主力（点已勾选的 = 取消勾选）。
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const up = await uploadChunk(page, paths)
        if (!up.ok) {
          // ★ 不要在这里中止：图很可能**本来就在**图片空间（存在性判断是搜索式的，会有假阴性）
          say(`   ⚠ 上传入口不可用（${up.why}）→ 跳过上传，直接进入勾选环节`)
          how = up.how
          break
        }
        how = up.how
        say(
          `② 批次 ${Math.floor(i / batchN) + 1}/${Math.ceil(toUpload.length / batchN)} · 第 ${attempt} 次：上传 ${chunk.length} 张（${how}）`,
        )
        await sleep(6000 + chunk.length * 1500) // 按张数等（12 张 ≈ 24s）

        // ③ 关掉「上传结果」（点右下角「完成」）
        const done = await closeUploadResult(page)
        if (done.ok) say('   点「完成」关闭「上传结果」')
        else say('   （没看到「上传结果」的完成按钮，可能已自动关）')
        await sleep(3000)

        say('   批次后底部:', JSON.stringify(await panelFooter(page)))
        selected = await panelSelCount(page)
        if (selected > 0) break
        say(`   ⚠ 这一批没触发自动全选（已选 0）→ 重传同一批（第 ${attempt + 1} 次）`)
      }
      批次.push({ 批次: Math.floor(i / batchN) + 1, 张数: chunk.length, 已选: selected, 上传方式: how })
      // ★ 一旦自动全选已经齐了，**立刻收工去点确定**，别再做任何多余动作
      if (selected >= files.length) {
        say('   ✓ 自动全选已齐，停止上传，直接去点「确定」')
        break
      }
    }
  } else {
    say('③ 本批 0 张需要上传（都在图片空间里）')
  }

  // ④ 逐张勾选：**以底部「确定（N）」的数字变化为准**
  //    （`[class*=selected]` 判"已选"会命中左侧文件夹树的 next-selected → 每张都误判成已选）
  let selN = await panelSelCount(page)
  if (selN < files.length) {
    // ★★ 上传完成后**先等底部计数稳定**再决定要不要逐张勾：自动全选是**延迟生效**的，
    //     抢在它生效前把「已选 N」误读成 0，就会去逐张点 → 把自动全选一张张取消掉（实测踩到）
    let last = -1
    let same = 0
    for (let k = 0; k < 12 && same < 3; k += 1) {
      await sleep(1500)
      const n = await panelSelCount(page)
      if (n === last) same += 1
      else {
        same = 0
        last = n
      }
      if (n > selN) selN = n
    }
  }
  say(`④ 上传后底部: 已选 ${selN} / 期望 ${files.length}（已等自动全选稳定）`)

  let okCount = selN
  const rec = []
  const NO_SELECT = cfgFlag('detailNoSelect')
  const SEARCH_FALLBACK = cfgFlag('detailSearchFallback')
  let pickedSeen = new Set()
  let ranScan = false
  if (!NO_SELECT && selN < files.length) {
    ranScan = true
    // ① 主力路径：扫可见卡片 + 点勾选框（快且稳；已勾选的会跳过）
    pickedSeen = await selectByVisibleScan(page, new Set(files))
    await sleep(1200)
    okCount = Math.max(okCount, await panelSelCount(page))
    say('④a 扫可见卡片勾选', pickedSeen.size, '张 → 底部已选', okCount, '/', files.length)
    // ② 兜底：仍没勾上的才用「搜索定位 + 点勾选框」（慢，且可能触发 iframe 重载）→ 默认关
    const 还差 = SEARCH_FALLBACK ? files.filter((f) => !pickedSeen.has(f)) : []
    if (还差.length) say('④b 还有', 还差.length, '张走搜索兜底:', 还差.slice(0, 6).join(', '))
    for (const f of 还差) {
      if (okCount >= files.length) break
      let n0 = await panelSelCount(page)
      let pick = await selectBySearch(page, f)
      if (!pick.ok) {
        await sleep(1500) // frame 被重建时重试一次
        n0 = await panelSelCount(page)
        pick = await selectBySearch(page, f)
      }
      if (!pick.ok) {
        rec.push({ f, r: pick.why || '没找到卡片' })
        continue
      }
      await sleep(1500)
      let n1 = await panelSelCount(page)
      if (n1 === n0 - 1) {
        // 点下去把原有的选中取消了 ⇒ 这张本来就已选 → 补点回来
        await selectBySearch(page, f)
        await sleep(1500)
        n1 = await panelSelCount(page)
        rec.push({ f, r: '本就已选(已补回)', n: n1 })
      } else if (n1 > n0) {
        rec.push({ f, r: '新选中', n: n1 })
      } else {
        rec.push({ f, r: '计数未变', n: n1 })
      }
      okCount = n1
      if (rec.length % 6 === 0) say('   进度', rec.length, '| 已选', n1, '|', JSON.stringify(rec.slice(-1)[0]))
    }
  }

  const selectedSet = new Set(pickedSeen)
  for (const x of rec) if (x.r === '新选中' || x.r === '本就已选(已补回)') selectedSet.add(x.f)
  const failedImgs = ranScan ? files.filter((f) => !selectedSet.has(f)) : []

  const beforeConfirm = await panelFooter(page)
  say('④ 底部:', JSON.stringify(beforeConfirm), '（已选', okCount, '/ 期望', files.length, '）')
  const 没勾上的 = rec.filter((x) => x.r !== '新选中' && x.r !== '本就已选(已补回)')
  if (没勾上的.length) say('   ⚠ 没勾上的:', JSON.stringify(没勾上的.slice(0, 10)))

  // ⑤ 点「确定(N)」（面板 iframe 可能正在重建 → 重试 3 次重新解析）
  let confirm = { ok: false, why: 'no_panel' }
  for (let k = 0; k < 3; k += 1) {
    const f2 = await panelCall(page, 'frame')
    if (!f2.ok) {
      await sleep(1000)
      continue
    }
    const fbt = await panelCall(page, 'footerBtn')
    if (fbt.ok) {
      confirm = fbt.disabled
        ? { ok: false, why: 'disabled', 文本: fbt.文本 }
        : { ok: true, x: fbt.x, y: fbt.y, 文本: fbt.文本 }
      break
    }
    confirm = { ok: false, why: fbt.why || 'no_confirm' }
    await sleep(1200)
  }
  say('⑤ 底部确定按钮:', JSON.stringify(confirm))
  if (confirm.ok) {
    const hit = await mouseClickIn(page, confirm.x, confirm.y)
    say('   点了确定:', JSON.stringify(hit.abs || hit))
    if (!hit.ok) confirm = { ok: false, why: 'click_failed' }
    else await sleep(6000)
  }

  // ⑥ 读回详情编辑器 img 数
  const finalImgs = await editorImgs(page)
  const delta = finalImgs !== null && startImgs !== null ? finalImgs - startImgs : null
  const 图片达标 = finalImgs !== null && (delta !== null ? delta >= want : finalImgs >= want)
  say(`⑥ 详情编辑器 img = ${finalImgs}（起始 ${startImgs} → +${delta}，期望 +${want}）`)

  const ok = !!confirm.ok && 图片达标
  const why = !confirm.ok ? 'confirm_failed:' + (confirm.why || 'unknown') : 'detail_imgs_not_expected'
  const result = {
    ok,
    uploaded: okCount,
    want,
    failedImgs,
    counted: finalImgs === null ? okCount : finalImgs,
    详情img: finalImgs,
    起始详情img: startImgs,
    详情新增: delta,
    点了: okCount,
    期望: want,
    已选: selN,
    确认: confirm,
    批次,
    没勾上的,
    ...base,
    耗时ms: Date.now() - t0,
  }
  if (!ok) return { ...result, why }
  return result
}
