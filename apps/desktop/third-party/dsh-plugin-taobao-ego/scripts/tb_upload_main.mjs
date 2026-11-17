/**
 * 1:1 主图上传（ego 版）—— 移植自
 *   taobao-product-listing\scripts\tb_upload_main.js
 *
 * 原脚本的链路（行为与判据全部保留）：
 *   · §4：点空位 → 打开 iframe `sucai-selector-ng` 图片空间面板 → 「本地上传」传一张 →
 *     `max=1` 一次填一个槽；
 *   · §9：认图**按文件名**（不按 t= 时间戳、不按列表顺序 —— 原注释里这两种都试错）；
 *   · 上传完会弹「上传结果」对话框 → **必须真实点它右下角的「完成」**把它关掉，
 *     否则它盖住图片列表，「按文件名找到的卡片」其实是弹窗里那条文件记录，点它永远不回填；
 *   · 失败退出前必须清掉残留素材面板（否则下一步详情图会挂到主图面板 mainImagesGroup 上整步崩）。
 *
 * 与 Playwright/CDP 原版的差异（只换执行层，不改硬规则）：
 *   - 面板定位：原版 `page.frames().find(f => /sucai-selector-ng/.test(f.url()))`。
 *     ego 的 page **没有** frames/mainFrame/locator/content → 改为 `page.evaluate` 里查 `<iframe>`，
 *     经 `iframe.contentDocument`（同源）访问内部元素；同时返回 iframe 的 `getBoundingClientRect()`
 *     偏移，点击一律 `page.mouse.click(iframe.left + 元素x, iframe.top + 元素y)`。
 *   - 点击：原版结论「Playwright 元素点击在这个 iframe 里无效」照旧执行 —— iframe 内
 *     全部用真实鼠标坐标点击，不做 dispatchEvent。
 *   - 上传：原版 `page.waitForEvent('filechooser')` + `locator('button:has-text("本地上传")').click()`
 *     → ego 用共享库 `uploadFiles`（内部是 `page.waitForFileChooser()` + `chooser.setFiles(files)`），
 *     没出现 filechooser 时退回「点后出现的 input[type=file] + setInputFiles」。
 *   - 滚动：原版在 iframe 内 `frame.evaluate(async …)` 边滚边等；ego 的 evaluate 不保证支持 async
 *     函数 → 改成 Node 侧循环（`card` / `scrollReset` / `scrollTo` 每次一个同步 evaluate + sleep），
 *     等价于原版「必要时滚列表找卡片」。
 *
 * 仍依赖的硬规则：
 *   1. 认图按文件名；
 *   2. 「上传结果」的「完成」必须真实鼠标点；
 *   3. 1:1 主图平台**至多 5 张**（本模块强制 `limit ≤ 5`，素材多只取前 5 张并显式报出）；
 *   4. 面板异步出现 → 轮询（12×2s），不能固定等 4.5s；
 *   5. 失败/收工都要清残留面板。
 *
 * 导出（由 run_listing_tb.mjs 在同一 ego 进程内顺序调用）：
 *   `uploadMain(page, dir, { limit })` → `{ ok, uploaded, want, counted, ...读回 }`
 *   - `uploaded` = 本次实际填上的槽数；`want` = 本次计划张数（= min(limit, 目录张数, 5)）
 *   - 失败：`{ ok:false, why, uploaded, want, ...读回 }`
 *   不写 main/CLI，不打印 JSON 行（由编排层负责）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { say, sleep, waitUntil, uploadFiles, frameEval } from '../lib/tb_ego.mjs'

/** 平台硬上限：1:1 主图至多 5 张（发布页原文「至多可上传5张」）。 */
const PLATFORM_MAIN_MAX = 5
const IMG_RE = /\.(jpe?g|png|webp)$/i
const PANEL_KEY = 'sucai-selector-ng'

/**
 * ego 子进程不继承自定义环境变量 → 配置只从 `globalThis.__TB_CFG` 读（与 tb_enter_form.mjs 的 INLINE 同源）。
 * ★ 每次调用时现读：本模块可能被 run_listing_tb.mjs **静态 import**，那一刻 `__TB_CFG` 还没赋值。
 */
const tbCfg = () => (typeof globalThis !== 'undefined' && globalThis.__TB_CFG) || {}
const cfgVal = (key, dflt) => {
  const c = tbCfg()
  return c[key] === undefined || c[key] === null || c[key] === '' ? dflt : c[key]
}
const debugOn = () => cfgVal('debug', '') === '1' || cfgVal('debug', false) === true
/** ego 的 setFiles 用正斜杠路径更稳（PDD ego 版实测这里会先 `replace(/\\/g, "/")`）。 */
const posix = (p) => String(p).replace(/\\/g, '/')

/**
 * 素材面板 iframe 内的一次读操作（ego 没有 page.frames()）。
 *
 * 在 `page.evaluate` 里：找 src/name/id 含 `sucai-selector-ng` 的 iframe → `iframe.contentDocument`
 * → 在 iframe 文档里按 op 读数据；返回的元素坐标都是 **iframe 内坐标**，并把 iframe 偏移一起带回来。
 * 真实点击由调用方算 `left + x / top + y` 后用 `page.mouse.click` 完成。
 * @param page - ego page
 * @param op - 'frame' | 'uploadBtn' | 'done' | 'card' | 'scrollReset' | 'scrollMeta' | 'scrollTo'
 * @param data - 该 op 的参数（`{ name }` / `{ y }`）
 * @returns `{ ok, why?, x?, y?, ..., geom:{left,top,width,height} }`；找不到 iframe 时 `ok:false why:'no_frame'`
 */
/** 主文档里读素材面板 iframe 的位置（iframe 跨域，只能读矩形；内部 DOM 走 CDP 子 frame）。 */
async function iframeGeom(page) {
  const r = await page
    .evaluate((key) => {
      const frames = [...document.querySelectorAll('iframe')]
      const hayOf = (f) =>
        String(f.getAttribute('src') || '') + ' ' + String(f.getAttribute('name') || '') + ' ' + String(f.id || '')
      // ★ 优先「大尺寸」iframe：3:4 区的小覆盖层（select-image-page）也会命中 src
      const cands = frames.filter((f) => hayOf(f).includes(key))
      const big = cands.filter((f) => {
        const r = f.getBoundingClientRect()
        return r.width >= 600 && r.height >= 400
      })
      const frame = big[0] || cands[0]
      if (!frame) {
        return {
          ok: false,
          why: 'no_frame',
          候选数: frames.length,
          帧样本: frames
            .map((f) => ({ name: String(f.getAttribute('name') || ''), src: String(f.getAttribute('src') || '').slice(0, 80) }))
            .slice(0, 6),
        }
      }
      const b = frame.getBoundingClientRect()
      return { ok: true, left: b.left, top: b.top, width: b.width, height: b.height }
    }, PANEL_KEY)
    .catch((e) => ({ ok: false, why: String((e && e.message) || e) }))
  return r && r.ok ? r : r || { ok: false, why: 'no_frame' }
}

/**
 * 素材面板 iframe 的 DOM 操作（在子 frame 里跑，等价原版 `page.frames().find(...).evaluate`）。
 * 返回坐标都是 **iframe 视口内坐标**，调用方再加 iframe 偏移后用真实鼠标点。
 */
const panelInFrame = (arg) => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const vis = (e) => {
    if (!e) return false
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const listEl = () => document.querySelector('[class*="PicturesShow_main"]') || document.scrollingElement
  const meta = () => {
    const l = listEl()
    return l ? { scrollTop: l.scrollTop, clientHeight: l.clientHeight, scrollHeight: l.scrollHeight } : null
  }
  const { op, data } = arg || {}
  switch (op) {
    case 'uploadBtn': {
      const inputs = document.querySelectorAll('input[type=file]').length
      const b = [...document.querySelectorAll('button')].filter(vis).find((x) => clean(x.innerText).includes('本地上传'))
      if (!b) return { ok: false, why: 'no_upload_entry', 文件输入数: inputs }
      const r = b.getBoundingClientRect()
      return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, 文件输入数: inputs }
    }
    case 'listReady': {
      // 本次要传的每个文件名，是否已在列表里出现且缩略图加载完（判据与 card 一致）
      const names = (data && data.names) || []
      const readyNames = []
      const missing = []
      for (const name of names) {
        const cards = [...document.querySelectorAll('div,li')].filter(vis).filter((e) => clean(e.innerText).includes(name))
        cards.sort((a, b) => clean(a.innerText).length - clean(b.innerText).length)
        let found = false
        for (const c of cards) {
          const img = c.querySelector('img') || (c.parentElement ? c.parentElement.querySelector('img') : null)
          if (!img) continue
          if (!(img.complete && img.naturalWidth > 0)) continue
          const r = img.getBoundingClientRect()
          if (r.width < 60 || r.height < 60) continue
          found = true
          break
        }
        if (found) readyNames.push(name)
        else missing.push(name)
      }
      return { ok: true, 就绪: readyNames.length, 需要: names.length, 缺: missing.map((n) => String(n).slice(0, 40)).slice(0, 6) }
    }
    case 'hit': {
      const p = data || {}
      const name = String(p.name || '')
      const aliases = (p.names && p.names.length ? p.names : [name]).map(String).filter(Boolean)
      const el = document.elementFromPoint(Number(p.x), Number(p.y))
      let card = null
      let cardText = null
      let cur = el
      for (let i = 0; i < 6 && cur; i += 1) {
        const t = clean(cur.innerText)
        if (/\.(jpe?g|png)/i.test(t) && t.length <= 90) {
          card = cur
          cardText = t.slice(0, 60)
          break
        }
        cur = cur.parentElement
      }
      return {
        ok: true,
        tag: el ? el.tagName : null,
        文字: el ? clean(el.innerText).slice(0, 24) : null,
        卡片: cardText,
        命中名字: !!cardText && aliases.some((a) => cardText.includes(a)),
      }
    }
    case 'done': {
      const b = [...document.querySelectorAll('button')].filter(vis).find((x) => /^完成$/.test(clean(x.innerText)))
      if (!b) return { ok: false, why: 'no_done_btn' }
      const r = b.getBoundingClientRect()
      return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) }
    }
    case 'card': {
      const name = String((data && data.name) || '')
      const aliases = (data && Array.isArray(data.names) && data.names.length ? data.names : [name]).map(String).filter(Boolean)
      const cards = [...document.querySelectorAll('div,li')]
        .filter(vis)
        .filter((e) => {
          const t = clean(e.innerText)
          return aliases.some((a) => t.includes(a))
        })
      cards.sort((a, b) => clean(a.innerText).length - clean(b.innerText).length)
      for (const c of cards) {
        const img = c.querySelector('img') || (c.parentElement ? c.parentElement.querySelector('img') : null)
        if (!img) continue
        // ★ 图片没加载完（上传中占位）时点它不会生效 → 必须等 naturalWidth > 0
        if (!(img.complete && img.naturalWidth > 0)) continue
        const r = img.getBoundingClientRect()
        if (r.width < 60 || r.height < 60) continue
        return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, 卡片: clean(c.innerText).slice(0, 36) }
      }
      const names = [...document.querySelectorAll('div')]
        .filter(vis)
        .map((e) => clean(e.innerText))
        .filter((t) => /\.(jpg|jpeg|png)$/i.test(t) && t.length < 26)
        .slice(0, 14)
      return { ok: false, why: 'no_card', 可见文件名样本: names, 是否找到列表容器: !!listEl() }
    }
    case 'scrollReset': {
      const l = listEl()
      if (l) l.scrollTop = 0
      return { ok: true, ...(meta() || {}), 是否找到列表容器: !!l }
    }
    case 'scrollTo': {
      const l = listEl()
      if (!l) return { ok: false, why: 'no_list' }
      l.scrollTop = Number((data && data.y) || 0)
      return { ok: true, ...(meta() || {}), 是否找到列表容器: true }
    }
    case 'scrollMeta': {
      const m = meta()
      if (!m) return { ok: false, why: 'no_list' }
      return { ok: true, ...m, 是否找到列表容器: true }
    }
    default:
      return { ok: false, why: 'unknown_op:' + op }
  }
}

/** 检查 iframe 内某坐标当前命中什么标签（用于「检测到能点再点」）。 */
async function sharedFrameEval(page, point) {
  const r = await frameEval(page, PANEL_KEY, (p) => {
    const el = document.elementFromPoint(p.x, p.y)
    return el ? el.tagName : null
  }, point).catch(() => null)
  return typeof r === 'string' ? r : null
}

/**
 * 素材面板的一次读/算坐标操作。
 * @returns `{ ok, ...读回, geom:{left,top,width,height} }`（坐标为 iframe 内坐标）。
 */
async function panelCall(page, op, data = {}) {
  const geom = await iframeGeom(page)
  if (!geom || geom.ok === false) return geom || { ok: false, why: 'no_frame' }
  if (op === 'frame') return { ok: true, left: geom.left, top: geom.top, width: geom.width, height: geom.height }
  const value = await frameEval(page, PANEL_KEY, panelInFrame, { op, data }).catch((e) => ({
    ok: false,
    why: String((e && e.message) || e),
  }))
  if (!value || value.ok === false) return { ok: false, ...(value || {}), geom }
  return { ...value, geom }
}

/** 读主文档里的空槽数：可见且文本恰为「上传图片」的叶子元素（原版同款判据）。 */
const slotCount = (page, area = '') =>
  page
    .evaluate((areaArg) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const raw = [...document.querySelectorAll('div,span,li,p')]
        .filter(vis)
        .filter((e) => clean(e.innerText) === '上传图片')
      const leaves = raw.filter((e) => !raw.some((o) => o !== e && e.contains(o)))
      if (!areaArg) return leaves.length
      // ★ 只数「3:4区块」里的空槽：用区块标题（3:4主图）与下一个标题（商品视频）的 y 界定范围
      // ★ area 可以是字符串（3:4 这种用「从1:1主图裁剪」链接圈定），也可以是 {start,end} 两个标题文字
      const areaByLabels = () => {
        if (!areaArg || typeof areaArg !== 'object') return null
        const labels = [...document.querySelectorAll('div,span,p')]
          .filter(vis)
          .map((e) => ({ t: clean(e.innerText), top: e.getBoundingClientRect().top, left: e.getBoundingClientRect().left }))
        const pick = (t) => labels.find((x) => x.t === t && x.left > 350) || labels.find((x) => x.t === t)
        const a = pick(areaArg.start)
        const b = pick(areaArg.end)
        if (!a) return null
        return { top: a.top + 10, bottom: b ? b.top - 4 : 1e9 }
      }
      if (areaByLabels()) {
        const B = areaByLabels()
        return leaves.filter((e) => {
          const r = e.getBoundingClientRect()
          const cy = r.top + r.height / 2
          return cy > B.top && cy < B.bottom
        }).length
      }
      // ★ 用「3:4主图」区块里的「从1:1主图裁剪」链接所在**行容器**圈定范围（滚动不影响；且排除左侧帮助面板）
      const areaBox = () => {
        const link = [...document.querySelectorAll('a,span,div,p')]
          .filter(vis)
          .find((e) => clean(e.innerText) === '从1:1主图裁剪')
        if (!link) return null
        let box = link
        for (let k = 0; k < 6 && box; k += 1) {
          box = box.parentElement
          if (!box) break
          const r = box.getBoundingClientRect()
          if (r.height >= 150 && r.width >= 500) return box.getBoundingClientRect()
        }
        return null
      }
      const B = areaBox()
      if (!B) return leaves.length
      return leaves.filter((e) => {
        const r = e.getBoundingClientRect()
        const cy = r.top + r.height / 2
        return cy > B.top - 6 && cy < B.bottom + 6
      }).length
    }, area)
    .catch(() => null)

/** 图片上的「裁剪 / 替换 / 删除 / AI 作图」悬浮菜单是否还开着（它会盖住空槽，点了就落到别的元素上）。 */
const hoverMenuOn = (page) =>
  page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      return [...document.querySelectorAll('div,ul,li,section')].some((e) => {
        if (!vis(e)) return false
        const t = clean(e.innerText)
        return t.length <= 40 && /裁剪\s*替换\s*删除/.test(t)
      })
    })
    .catch(() => false)

/** 主文档层面「这一点击会命中什么」：`IFRAME`=素材面板本体、`MENU`=图片悬浮菜单，其他=被别的东西挡着。 */
const mainHitTag = (page, p) =>
  page
    .evaluate(({ x, y }) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const el = document.elementFromPoint(x, y)
      if (!el) return null
      const t = clean(el.innerText).slice(0, 60)
      if (/裁剪|替换|删除|AI作图/.test(t)) return 'MENU'
      if (el.tagName === 'IFRAME') {
        const src = String(el.getAttribute('src') || '')
        return src.includes('sucai-selector-ng') ? 'PANEL' : 'IFRAME:' + src.slice(0, 40)
      }
      if (el.tagName === 'IMG') return 'IMG'
      return el.tagName
    }, p)
    .catch(() => null)

/** 清掉悬浮菜单：鼠标挪到空白处 + Esc，并且**检测它真的消失了**（复选框：不清掉下一次点击会落到菜单上）。 */
async function dismissHoverMenu(page) {
  if (!(await hoverMenuOn(page))) return { ok: true, 本来就没有: true }
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.move(1240, 40 + i * 8).catch(() => {})
    await page.keyboard.press('Escape').catch(() => {})
    const gone = await waitUntil(async () => !(await hoverMenuOn(page)), {
      timeoutMs: 900,
      intervalMs: 150,
      label: 'hover-menu-gone',
    })
    if (gone.ok) return { ok: true, how: 'move+esc', 尝试: i + 1 }
    await page.mouse.move(6, 660 + i).catch(() => {})
  }
  return { ok: !(await hoverMenuOn(page)), how: 'move+esc' }
}

/**
 * 等素材面板 iframe 的几何**稳定**（面板是滑入/缩放出现的，动画途中读到的坐标会让点击落空）。
 * @returns `{ ok, left, top, width, height, stable }`
 */
async function stablePanelGeom(page, { timeoutMs = 8000, intervalMs = 120, stableMs = 360 } = {}) {
  const started = Date.now()
  let last = null
  let since = Date.now()
  while (Date.now() - started < timeoutMs) {
    const g = await panelCall(page, 'frame')
    if (!g.ok) {
      last = null
      await sleep(intervalMs)
      continue
    }
    if (!last || Math.abs(g.left - last.left) > 1 || Math.abs(g.top - last.top) > 1 || Math.abs(g.width - last.width) > 1) {
      last = g
      since = Date.now()
    } else if (Date.now() - since >= stableMs) {
      return { ...last, stable: true }
    }
    await sleep(intervalMs)
  }
  return last ? { ...last, stable: false } : { ok: false, why: 'no_frame' }
}

/** 这一点在不在**窗口内**（ego 窗口窄于面板时，面板右半截在窗口外，真实鼠标点过去等于点在窗口外）。 */
const pointInViewport = (page, p) =>
  page
    .evaluate(({ x, y }) => {
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight
      return { ok: x > 2 && y > 2 && x < vw - 2 && y < vh - 2, vw, vh, x, y }
    }, p)
    .catch(() => ({ ok: true, vw: 0, vh: 0 }))

/** 把面板里的「本地上传」按钮 focus 上（之后按 Enter = 可信用户激活，按钮在屏幕外也有效）。 */
const focusUploadBtn = (page) =>
  frameEval(page, PANEL_KEY, () => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const vis = (e) => {
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const btn = [...document.querySelectorAll('button')].filter(vis).find((b) => clean(b.innerText).includes('本地上传'))
    if (!btn) return { ok: false, why: 'no_btn' }
    btn.focus()
    return { ok: document.activeElement === btn, text: clean(btn.innerText).slice(0, 20) }
  })
    .then((v) => v || { ok: false })
    .catch(() => ({ ok: false }))

/** 把「完成」按钮 focus 上（同上，窗口太窄时用键盘激活）。 */
const focusDoneBtn = (page) =>
  frameEval(page, PANEL_KEY, () => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const btn = [...document.querySelectorAll('button')].find((b) => /^完成$/.test(clean(b.innerText)))
    if (!btn) return { ok: false, why: 'no_done' }
    btn.focus()
    return { ok: document.activeElement === btn }
  })
    .then((v) => v || { ok: false })
    .catch(() => ({ ok: false }))

/** 面板 iframe 内「这一点命中的元素文字里有没有 needle」——用来确认点击真的落在「本地上传」上。 */
const frameHitHas = (page, p, needle) =>
  frameEval(page, PANEL_KEY, ({ x, y, needle: n }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const el = document.elementFromPoint(x, y)
    if (!el) return false
    let cur = el
    for (let i = 0; i < 4 && cur; i += 1) {
      if (clean(cur.innerText).includes(n)) return true
      cur = cur.parentElement
    }
    return false
  }, { ...p, needle })
    .then((v) => v === true)
    .catch(() => false)

/** 主文档里所有 iframe 的 src/位置/尺寸（失败时登现场用）。 */
const frameDump = (page) =>
  page
    .evaluate(() =>
      [...document.querySelectorAll('iframe')].map((f) => {
        const r = f.getBoundingClientRect()
        return [String(f.getAttribute('src') || '').slice(0, 55), Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join('|')
      })
    )
    .catch(() => [])

/**
 * 主文档层面「这一点最上面是谁」：只有面板 iframe 在最顶层时，点击才会真正落到面板里。
 * （透明遮罩 / 悬浮菜单压在上面时，点下去看着像点到了按钮，其实什么都没发生——上传不弹文件选择框就是这个原因。）
 * @returns `{ top, panelOnTop, panelInStack, menu, unknown }`
 */
const mainHitTop = (page, p) =>
  page
    .evaluate(({ x, y, key }) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const stack = document.elementsFromPoint(x, y) || []
      const isPanel = (el) => !!el && el.tagName === 'IFRAME' && String(el.getAttribute('src') || '').includes(key)
      if (!stack.length) return { top: null, panelOnTop: false, panelInStack: false, menu: false, unknown: true }
      const t = clean(stack[0].innerText).slice(0, 60)
      return {
        top: stack[0].tagName,
        panelOnTop: isPanel(stack[0]),
        panelInStack: stack.some(isPanel),
        menu: /裁剪|替换|删除|AI作图/.test(t),
        unknown: false,
      }
    }, { ...p, key: PANEL_KEY })
    .catch(() => ({ top: null, panelOnTop: false, panelInStack: false, menu: false, unknown: true }))

/**
 * 取某区域内第 `index` 个空槽的坐标，并**校验该点此刻真的能点到空槽**。
 * 两个关键点（都是实测踩出来的）：
 *   ① 必须 `scrollIntoView({ behavior: 'instant' })`：默认的平滑滚动会让坐标取到滚动前的旧值，
 *      结果点下去的坐标落在**之前上传的那张图**上（弹「裁剪/替换/删除/AI作图」菜单，面板打不开）；
 *   ② 必须用 `elementFromPoint` 命中校验：命中的要能归到「上传图片」空槽，
 *      命中已上传的图片、悬浮菜单、遮罩层 → 判定不可点，换下一个空槽。
 * @returns `{ ok, x?, y?, why?, 空槽数, 命中?, 命中标签? }`（坐标为视口坐标）
 */
const slotPointFor = (page, { pick = 'first', area = '', index = 0 } = {}) =>
  page
    .evaluate(({ pickArg, areaArg, indexArg }) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const raw = [...document.querySelectorAll('div,span,li,p')]
        .filter(vis)
        .filter((e) => clean(e.innerText) === '上传图片')
      let leaves = raw.filter((e) => !raw.some((o) => o !== e && e.contains(o)))
      const count = leaves.length
      if (areaArg) {
        // ★ 只在指定区块里找空槽（否则最后一个空槽会落到「白底图」区块）
        if (areaArg && typeof areaArg === 'object') {
          const labels = [...document.querySelectorAll('div,span,p')]
            .filter(vis)
            .map((e) => ({ t: clean(e.innerText), top: e.getBoundingClientRect().top, left: e.getBoundingClientRect().left }))
          const pickLbl = (t) => labels.find((x) => x.t === t && x.left > 350) || labels.find((x) => x.t === t)
          const a = pickLbl(areaArg.start)
          const b = pickLbl(areaArg.end)
          if (a) leaves = leaves.filter((e) => {
            const r = e.getBoundingClientRect()
            const cy = r.top + r.height / 2
            return cy > a.top + 10 && cy < (b ? b.top - 4 : 1e9)
          })
        } else {
          const link = [...document.querySelectorAll('a,span,div,p')]
            .filter(vis)
            .find((e) => clean(e.innerText) === '从1:1主图裁剪')
          if (link) {
            let box = link
            for (let k = 0; k < 6 && box; k += 1) {
              box = box.parentElement
              if (!box) break
              const r = box.getBoundingClientRect()
              if (r.height >= 150 && r.width >= 500) {
                const B = box.getBoundingClientRect()
                leaves = leaves.filter((e) => {
                  const r = e.getBoundingClientRect()
                  const cy = r.top + r.height / 2
                  return cy > B.top - 6 && cy < B.bottom + 6
                })
                break
              }
            }
          }
        }
      }
      const ordered = pickArg === 'last' ? [...leaves].reverse() : leaves
      const el = ordered[Math.min(Math.max(0, indexArg), Math.max(0, ordered.length - 1))]
      if (!el) return { ok: false, why: 'no_empty_slot', 空槽数: leaves.length }
      try {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
      } catch {
        el.scrollIntoView({ block: 'center', inline: 'nearest' })
      }
      const r = el.getBoundingClientRect()
      if (r.width < 8 || r.height < 8) return { ok: false, why: 'slot_invisible', 空槽数: leaves.length }
      if (r.top < 24 || r.bottom > innerHeight - 12) return { ok: false, why: 'slot_out_of_view', 空槽数: leaves.length }
      const x = Math.round(r.left + r.width / 2)
      const y = Math.round(r.top + r.height / 2)
      const hit = document.elementFromPoint(x, y)
      const tag = (hit && hit.tagName) || ''
      const t = clean(hit && hit.innerText)
      const inSlot = !!hit && (el.contains(hit) || hit.contains(el))
      const ok = !!hit && tag !== 'IMG' && !/裁剪|替换|删除|AI作图/.test(t.slice(0, 60)) && (inSlot || /上传图片/.test(t.slice(0, 60)))
      return { ok, x, y, 空槽数: leaves.length, 命中标签: tag, 命中: t.slice(0, 40), why: ok ? undefined : 'point_blocked' }
    }, { pickArg: pick, areaArg: area, indexArg: index })
    .catch((e) => ({ ok: false, why: 'eval_failed:' + String((e && e.message) || e) }))

/**
 * 点空槽打开图片空间面板：清悬浮菜单 → 取「此刻真能点到」的空槽坐标 → 点 → 检测面板出现。
 * 一次不成就换下一个空槽（最多 `tries` 次）；不盲点、不固定等待。
 * @returns `{ ok, 尝试?, x?, y?, panel?, detail }`
 */
async function openSlotPanel(page, { pick = 'first', area = '', tries = 3 } = {}) {
  const detail = []
  for (let i = 0; i < tries; i += 1) {
    await dismissHoverMenu(page)
    const pt = await waitUntil(
      async () => {
        const p = await slotPointFor(page, { pick, area, index: i })
        return p && p.ok ? p : null
      },
      { timeoutMs: 4000, intervalMs: 250, label: 'slot-clickable' }
    )
    const p = pt.value
    detail.push(p ? { 尝试: i + 1, x: p.x, y: p.y, 空槽数: p.空槽数 } : { 尝试: i + 1, 取点失败: true })
    if (!p) continue
    await page.mouse.move(p.x, p.y).catch(() => {})
    // 鼠标停上去可能又弹菜单盖住这个点 → 点之前再校验一次
    const still = await waitUntil(
      async () => {
        const q = await slotPointFor(page, { pick, area, index: i })
        return q && q.ok && Math.abs(q.x - p.x) <= 6 && Math.abs(q.y - p.y) <= 6 ? q : null
      },
      { timeoutMs: 1600, intervalMs: 130, label: 'slot-still-clickable' }
    )
    if (!still.ok) continue
    const q = still.value
    await page.mouse.click(q.x, q.y, { label: 'open-image-panel' })
    const opened = await waitUntil(async () => (await panelCall(page, 'frame')).ok, {
      timeoutMs: 7000,
      intervalMs: 300,
      label: 'open-image-panel',
    })
    if (opened.ok) return { ok: true, 尝试: i + 1, x: q.x, y: q.y, panel: await panelCall(page, 'frame'), detail }
    await dismissHoverMenu(page)
  }
  return { ok: false, why: 'panel_not_opened', detail }
}

/** 主文档里还有几个 sucai 素材面板 iframe。 */
const panelCount = (page) =>
  page
    .evaluate((key) => [...document.querySelectorAll('iframe')].filter((f) => String(f.getAttribute('src') || '').includes(key)).length, PANEL_KEY)
    .catch(() => 0)

/**
 * 关掉残留素材面板（原版注释：失败退出前必做；实测详情步会挂到主图面板上整步崩）。
 * 先真实鼠标点主文档里的「取消 / 关闭」，再退到 Escape（Escape 只在这里用，规格抽屉那步绝不用）。
 * @returns `{ closed, 剩余面板?, how? }`
 */
async function closeResidualPanel(page) {
  if (!(await panelCount(page))) return { closed: true, 本来就没有: true }
  say('   ⚠ 有残留素材面板，先关掉再退出')
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
    await page.mouse.click(c.x, c.y, { label: 'close-material-panel' }).catch(() => {})
    await sleep(2000)
    if (!(await panelCount(page))) {
      say('   已关掉 ✓')
      return { closed: true, how: 'button' }
    }
  }
  if (await panelCount(page)) {
    await page.mouse.click(20, 300).catch(() => {})
    await sleep(1500)
  }
  const left = await panelCount(page)
  say(left ? '   ★ 面板仍关不掉' : '   已关掉 ✓')
  return { closed: left === 0, 剩余面板: left }
}

/**
 * 在素材面板里传一张图：真实鼠标点「本地上传」触发 filechooser；共享库 `uploadFiles`
 * 负责 `waitForFileChooser` → `chooser.setFiles`，以及没有 filechooser 时的 input[type=file] 兜底。
 * @returns `{ ok, how?, why?, 文件输入数? }`
 */
async function uploadBatch(page, files) {
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean).map(posix)
  if (!list.length) return { ok: false, why: 'no_files' }

  const attempts = []
  for (let round = 1; round <= 3; round += 1) {
    // ① 面板是滑入出现的：先等 iframe 几何稳定，动画中算出来的坐标点下去会落空
    const stable = await stablePanelGeom(page, { timeoutMs: 10000 })
    if (!stable.ok) return { ok: false, why: 'no_frame', 尝试: attempts, 帧样本: await frameDump(page) }

    // ② 取「本地上传」的可点坐标：帧内命中按钮 + 主文档最顶层就是面板（不被透明遮罩/菜单压着）
    let hit = null
    let saw = null
    for (let i = 0; i < 30 && !hit; i += 1) {
      const b = await panelCall(page, 'uploadBtn')
      if (b.ok) {
        const abs0 = { x: Math.round(b.geom.left + b.x), y: Math.round(b.geom.top + b.y) }
        const h = await panelCall(page, 'hit', { x: b.x, y: b.y })
        const onBtn = h.ok && /本地上传/.test(String(h.文字 || ''))
        const top = await mainHitTop(page, abs0)
        saw = { 帧内: h.tag, 帧内文字: h.文字, 主文档顶层: top.top, 面板在顶层: top.panelOnTop, x: abs0.x, y: abs0.y }
        if (onBtn && !top.menu && (top.panelOnTop || top.unknown)) hit = { b, abs: abs0, 面板在顶层: top.panelOnTop }
      }
      if (!hit) await sleep(200)
    }
    if (!hit) {
      attempts.push({ 第几次: round, 取点失败: saw })
      await sleep(600)
      continue
    }

    // ③-1 首选：把按钮 focus 上再按 Enter —— 可信用户激活，**按钮在窗口外也能触发**
    //      （实测窗口窄到 946 时面板被切掉、坐标点在窗口外，只有这条路能弹文件选择框）
    const focused = await focusUploadBtn(page)
    let up = { ok: false }
    if (focused.ok) {
      up = await uploadFiles(page, () => page.keyboard.press('Enter'), list, { timeoutMs: 9000 }).catch((e) => ({
        ok: false,
        why: String((e && e.message) || e),
      }))
      if (up.ok) return { ok: true, how: up.how + '(focus+Enter)', count: up.count, 第几次: round }
      say('   按钮 focus+Enter 没弹文件选择框:', focused.text, up.why)
    }

    // ③-2 再用 ego 的跨 frame 选择器点「本地上传」
    up = await uploadFiles(page, () => page.click('text=本地上传', { timeout: 8000, force: true }), list, {
      timeoutMs: 9000,
    }).catch((e) => ({ ok: false, why: String((e && e.message) || e) }))
    if (up.ok) return { ok: true, how: up.how + '(选择器)', count: up.count, 第几次: round }

    // ③-3 最后用「校验过」的坐标点
    say('   选择器也没弹窗 → 改用校验过的坐标点:', JSON.stringify(saw))
    up = await uploadFiles(
      page,
      async () => {
        await page.mouse.move(hit.abs.x, hit.abs.y).catch(() => {})
        await page.mouse.click(hit.abs.x, hit.abs.y, { label: '本地上传' }).catch(() => {})
      },
      list,
      { timeoutMs: 7000 }
    ).catch((e) => ({ ok: false, why: String((e && e.message) || e) }))
    if (up.ok) return { ok: true, how: up.how + '(坐标)', count: up.count, 坐标: hit.abs, 第几次: round }

    attempts.push({ 第几次: round, why: up.why, 命中: saw })
    say(`   第 ${round} 次点「本地上传」没弹出文件选择框 → 清一下重试:`, JSON.stringify(saw))
    await dismissHoverMenu(page).catch(() => {})
    await sleep(800)
  }

  // ④ 最后兜底：主文档里有 file input 就直接喂文件
  const n2 = await page.evaluate(() => document.querySelectorAll('input[type=file]').length).catch(() => 0)
  if (n2) {
    await page.setInputFiles('input[type=file]', list).catch(() => {})
    return { ok: true, how: 'selector_input', count: list.length }
  }
  return { ok: false, why: 'no_filechooser_no_input', 尝试: attempts, 帧样本: await frameDump(page) }
}

/** 轮询等某张卡片的文件名出现且图片已加载（一就绪立刻返回；找完列表仍没有就返回最后一次结果）。 */
async function waitCard(page, name, { timeoutMs = 25000, intervalMs = 250 } = {}) {
  const hit = await waitUntil(
    async () => {
      const c = await findCard(page, name)
      return c && c.ok ? c : null
    },
    { timeoutMs, intervalMs, label: 'find-card' }
  )
  return hit.ok ? hit.value : await findCard(page, name)
}

/**
 * 关掉「上传结果」对话框：点它右下角的「完成」（原版硬规则：不关会盖住列表、认错卡片）。
 * @returns `{ ok, 完成? }`
 */
async function closeUploadResult(page) {
  const done = await panelCall(page, 'done')
  if (!done.ok) return { ok: false, why: done.why || 'no_done_btn', 没看到: true }
  const abs = {
    x: Math.round(done.geom.left + done.x),
    y: Math.round(done.geom.top + done.y),
  }
  const inView = await pointInViewport(page, abs)
  const clicked = { 坐标: abs, 窗口内: inView.ok, 窗口: inView.vw ? `${inView.vw}x${inView.vh}` : undefined }
  if (inView.ok) {
    await page.mouse.move(abs.x, abs.y).catch(() => {})
    await page.mouse.click(abs.x, abs.y, { label: 'close-upload-result' }).catch(() => {})
  }
  // ★ 坐标点没关掉（按钮落在窗口外 / 被遮罩挡住）→ focus+Enter 再试一次
  let gone = await waitUntil(async () => !(await panelCall(page, 'done')).ok, { timeoutMs: 2500, intervalMs: 250, label: 'result-dialog-gone' })
  if (!gone.ok) {
    const f = await focusDoneBtn(page)
    if (f.ok) {
      await page.keyboard.press('Enter').catch(() => {})
      gone = await waitUntil(async () => !(await panelCall(page, 'done')).ok, { timeoutMs: 4000, intervalMs: 250, label: 'result-dialog-gone-key' })
      clicked.键盘 = true
    }
  }
  return { ok: gone.ok, 完成: { x: Math.round(done.x), y: Math.round(done.y), w: done.w, h: done.h }, 点击: clicked }
}

/**
 * 在 iframe 列表里按文件名找卡片，找不到就滚列表（原版兜底顺序：先直接找 → 回顶部再找 →
 * 从顶部按 400px 逐步往下找）。
 * @returns `{ ok, x?, y?, 卡片?, geom?, why?, 可见文件名样本?, 是否找到列表容器? }`
 */
/**
 * 卡片名候选：淘宝会把 PNG 转成 JPG、列表里也可能不显示扩展名 →
 * 全名认不到时依次用「去扩展名」「换扩展名」的别名认（否则认不到就盲滚一整屏）。
 */
const cardAliases = (name) => {
  const base = String(name || '').replace(/\.(jpe?g|png|webp)$/i, '')
  const out = [String(name || ''), base]
  for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) out.push(base + ext)
  return [...new Set(out.filter(Boolean))]
}

const sweptNames = new Set()

async function findCard(page, name) {
  const wanted = cardAliases(name)
  let card = await panelCall(page, 'card', { name, names: wanted })
  if (card.ok) return card
  const reset = await panelCall(page, 'scrollReset')
  if (reset.ok) await sleep(200)
  card = await panelCall(page, 'card', { name, names: wanted })
  if (card.ok) return card
  // ★ 同一个文件名**只盲滚一遍**：认不到名时从底部往上滚很费时，
  //   原来重试 3 次就滚 3 遍（实测 100s+ 全花在滚动上，一次点击都没有）
  if (sweptNames.has(name)) return card
  sweptNames.add(name)
  const meta = await panelCall(page, 'scrollMeta')
  const bottom = meta.ok ? meta.scrollHeight : 0
  const steps = Math.min(40, Math.ceil(bottom / 120) + 1)
  for (let i = 0; i <= steps && !card.ok; i += 1) {
    const y = Math.max(0, bottom - i * 120)
    const moved = await panelCall(page, 'scrollTo', { y })
    if (!moved.ok) break
    await sleep(120)
    card = await panelCall(page, 'card', { name, names: wanted })
  }
  return card
}

/**
 * 1:1 主图上传（一次一张填一个槽）。
 * @param page - ego page（已在 publish.htm 发布表单页）
 * @param dir - 1:1 主图目录（本机绝对路径）
 * @param options.limit - 本次最多传几张；**强制 ≤ 5**（平台上限）
 * @returns 成功 `{ ok:true, uploaded, want, counted, ...读回 }`；失败 `{ ok:false, why, ...读回 }`
 */
export async function uploadMain(page, dir, options = {}) {
  try {
    return await uploadMainImpl(page, dir, options)
  } catch (e) {
    // 编排层约定：失败也返回对象，绝不把异常抛给 run_listing_tb
    return { ok: false, why: 'exception:' + String((e && e.message) || e), uploaded: 0, want: 0, counted: 0 }
  }
}

/** uploadMain 的实际实现（异常统一由上面的 export 包住）。 */
async function uploadMainImpl(page, dir, { limit = PLATFORM_MAIN_MAX, slot = 'first', area = '' } = {}) {
  const t0 = Date.now()
  const absDir = resolve(String(dir || ''))
  if (debugOn()) say('debug: uploadMain 开始', absDir)
  const readback = { 目录: absDir }

  if (!existsSync(absDir)) return { ok: false, why: 'no_dir', counted: 0, uploaded: 0, want: 0, ...readback }
  let files
  try {
    files = readdirSync(absDir).filter((f) => IMG_RE.test(f)).sort()
  } catch (e) {
    return { ok: false, why: 'read_dir_failed:' + String((e && e.message) || e), counted: 0, uploaded: 0, want: 0, ...readback }
  }
  readback.素材张数 = files.length

  let want = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Math.floor(Number(limit)), files.length) : Math.min(files.length, PLATFORM_MAIN_MAX)
  const 素材多于本次 = files.length > want
  const clamped = Math.min(want, PLATFORM_MAIN_MAX)
  if (want > PLATFORM_MAIN_MAX) say(`   ⚠ limit=${want} 超过 1:1 主图平台上限 → 本次只传 ${PLATFORM_MAIN_MAX} 张`)
  want = clamped
  const picked = files.slice(0, want)
  readback.本次 = picked

  if (!picked.length) {
    say('   ℹ️ 1:1 主图目录里没有图 → 本步空转')
    return { ok: true, uploaded: 0, want: 0, counted: 0, note: '目录里没有图片', ...readback, 耗时ms: Date.now() - t0 }
  }
  if (素材多于本次) {
    say(`   ℹ️ 1:1 主图目录 ${files.length} 张，本次传前 ${want} 张（平台上限 ${PLATFORM_MAIN_MAX} 张；要改顺序就调整文件名）`)
  }

  const startSlots = await slotCount(page, area)
  if (startSlots === null) return { ok: false, why: 'no_slot_read', uploaded: 0, want, counted: 0, ...readback }
  say(`   起始空槽: ${startSlots} | 本次 ${want} 张: ${picked.join(', ')}`)
  if (startSlots < want) {
    return { ok: false, why: 'not_enough_slots', uploaded: 0, want, counted: 0, 起始空槽: startSlots, ...readback }
  }

  const doneFiles = []
  let failure = null
  /**
   * 鼠标离开图片（快路径：只挪走 + Esc，约 20ms）。
   * ★ 不再每次做「菜单检测循环」——那个检测在这页会误判成一直有菜单，一张图白等 6.5 秒；
   *   真正会不会点到菜单上，由点之前的命中校验（panelCall('hit') + 卡片名 + 主文档顶层）兜住。
   */
  const awayFromImages = async () => {
    await page.mouse.move(1250, 60).catch(() => {})
    await page.keyboard.press('Escape').catch(() => {})
  }
  /** 点不中时才做的「重活」：清掉「裁剪/替换/删除」悬浮菜单（带校验，最多 6 次）。 */
  const clearMenuHard = async () => {
    const r = await dismissHoverMenu(page)
    await page.mouse.move(1250, 60).catch(() => {})
    return r
  }

  /** 确保图片空间面板开着（没开就点空槽打开，并等「本地上传」渲染出来）。 */
  const ensurePanel = async () => {
    const pnl = await panelCall(page, 'frame')
    if (pnl.ok) return pnl
    const opened = await openSlotPanel(page, { pick: slot, area })
    if (!opened.ok) return { ok: false, why: 'panel_not_opened', detail: opened.detail }
    await waitUntil(async () => (await panelCall(page, 'uploadBtn')).ok, {
      timeoutMs: 25000,
      intervalMs: 500,
      label: 'panel-ready',
    })
    return await panelCall(page, 'frame')
  }

  const phase = {}
  const mark = (k, t) => {
    phase[k] = Date.now() - t
  }

  // ★ 一次把这批图全传进去（只开一次面板、只弹一次文件选择框）
  const tPhase = Date.now()
  const pnl = await ensurePanel()
  mark('打开面板', tPhase)
  say('   打开面板:', pnl.ok, pnl.ok ? '' : JSON.stringify(pnl.detail || pnl.why || ''))
  if (!pnl.ok) return { ok: false, why: 'panel_not_opened', uploaded: 0, want, counted: 0, 点空槽: pnl.detail, ...readback }

  const emptyBefore = await slotCount(page, area)
  if (emptyBefore === null) return { ok: false, why: 'no_slot_read', uploaded: 0, want, counted: 0, ...readback }

  const tUp = Date.now()
  const up = await uploadBatch(page, picked.map((f) => posix(join(absDir, f))))
  mark('触发上传', tUp)
  say('   批量上传:', up.ok ? `${up.how} ×${picked.length}` : JSON.stringify(up))
  if (!up.ok) {
    await closeResidualPanel(page)
    return {
      ok: false,
      why: 'upload_failed:' + (up.why || 'unknown'),
      uploaded: 0,
      want,
      counted: 0,
      文件输入数: up.文件输入数,
      how: up.how,
      尝试: up.尝试,
      ...readback,
    }
  }

  // ★★ 关键：**上传完先别急着点「完成」**。用户实测：立刻点「完成」，图片空间里只会显示第一张；
  //    等几秒让这几张先渲染进列表，再点「完成」，5 张才会都在。
  // 等待时长可配：__TB_CFG.uploadSettleMs（默认 5000；实测 <2s 时图片空间常常只显示第一张）
  const settleMs = Math.max(1000, Number(cfgVal('uploadSettleMs', 5000)) || 5000)
  say(`   等 ${(settleMs / 1000).toFixed(1)} 秒让图片空间把这批图渲染出来，再点「完成」…`)
  const tWait = Date.now()
  await sleep(settleMs)
  mark('等渲染', tWait)
  const appeared = await waitUntil(async () => (await panelCall(page, 'done')).ok, {
    timeoutMs: 15000,
    intervalMs: 300,
    label: 'upload-result-dialog',
  })
  const tDone = Date.now()
  if (appeared.ok) {
    const closed = await closeUploadResult(page)
    say('   点「完成」关闭「上传结果」:', closed.ok ? '✓' : JSON.stringify(closed).slice(0, 200))
    await waitUntil(async () => !(await panelCall(page, 'done')).ok, {
      timeoutMs: 6000,
      intervalMs: 250,
      label: 'upload-result-closed',
    })
  } else {
    say('   （没看到「上传结果」的「完成」—— 可能已自动关闭）')
  }
  mark('点完成', tDone)
  await awayFromImages()

  // 有的区（3:4 / 白底，max=1）传完会**自动填槽** → 自动占掉的不用再点
  const afterUp = await slotCount(page, area)
  const autoApplied = afterUp !== null && emptyBefore !== null && afterUp < emptyBefore ? emptyBefore - afterUp : 0
  if (autoApplied) say(`   ↑ 上传后自动应用 ${autoApplied} 个槽（空槽 ${emptyBefore} → ${afterUp}），这些跳过点击`)

  // ★ 等图片空间把「本次所有图」都列出来（缩略图加载完）再开始点，避免点空/点错
  //   （若是「传完自动应用」把面板关了，就不用等——点卡片时会自己重开面板）
  const tReady = Date.now()
  let lastReady = { 就绪: 0, 缺: [] }
  let gateSkipped = false
  const cardsReady = await waitUntil(
    async () => {
      if (!(await panelCall(page, 'frame')).ok) {
        if (autoApplied) gateSkipped = true
        return gateSkipped ? [] : null
      }
      const res = []
      for (const f of picked) res.push({ f, c: await findCard(page, f) })
      const okList = res.filter((r) => r.c && r.c.ok)
      lastReady = { 就绪: okList.length, 缺: res.filter((r) => !(r.c && r.c.ok)).map((r) => r.f.slice(0, 26)) }
      if (gateSkipped) return []
      return okList.length >= picked.length ? res : null
    },
    { timeoutMs: 45000, intervalMs: 500, label: 'cards-ready' }
  )
  mark('就绪检测', tReady)
  if (gateSkipped) say('   面板已被自动应用关掉 → 跳过就绪检测（点卡片时会自己重开面板）')
  else
    say(
      cardsReady.ok
        ? `   图片空间已列出 ${picked.length}/${picked.length} 张 ✓`
        : `   ⚠ 图片空间只列出 ${lastReady.就绪}/${picked.length} 张（继续点，缺的每次点前会重找） 缺:${lastReady.缺.join(',')}`
    )

  // 逐个点卡片填槽
  const tCards = Date.now()
  for (let idx = autoApplied; idx < picked.length; idx += 1) {
    const f = picked[idx]
    say(`\n   === ${idx + 1}/${picked.length}: ${f} ===`)
    let placed = false
    const tIter = Date.now()
    for (let attempt = 1; attempt <= 3 && !placed; attempt += 1) {
      const t0 = Date.now()
      const pnl2 = await ensurePanel()
      if (!pnl2.ok) {
        say('   面板不在了，也打不开 → 放弃这张')
        break
      }
      const tPanel = Date.now()
      await awayFromImages()
      const tAway = Date.now()
      const before = await slotCount(page, area)
      const tCount = Date.now()
      if (before === null) break
      let lastSee = null
      const target = await waitUntil(
        async () => {
          // 列表会随图片加载/滚动重排 → 每次都用最新坐标
          const card = await findCard(page, f)
          if (!card.ok || !card.geom) {
            lastSee = { 找卡片: (card && card.why) || 'no_card', 可见文件名样本: card && card.可见文件名样本 }
            return null
          }
          const abs0 = { x: Math.round(card.geom.left + card.x), y: Math.round(card.geom.top + card.y) }
          const pnlHit = await panelCall(page, 'hit', { x: card.x, y: card.y, name: f, names: cardAliases(f) })
          const top = await mainHitTop(page, abs0)
          lastSee = { 帧内: pnlHit.tag, 卡片: pnlHit.卡片, 命中名字: pnlHit.命中名字, 主文档顶层: top.top, 菜单: top.menu }
          if (pnlHit.tag !== 'IMG' || !pnlHit.命中名字 || top.menu) return null
          return { card, abs: abs0 }
        },
        { timeoutMs: 25000, intervalMs: 250, label: 'card-clickable' }
      )
      const tHit = Date.now()
      if (!target.ok) {
        say('   卡片没就绪/不好点 → 清菜单再试:', JSON.stringify(lastSee), `（耗时 ${tHit - tCount}ms）`)
        await clearMenuHard()
        continue
      }
      const { abs } = target.value
      const inView = await pointInViewport(page, abs)
      if (!inView.ok) say(`   ⚠ 卡片在窗口外（点 ${abs.x},${abs.y} / 窗口 ${inView.vw}x${inView.vh}）→ 请把 ego 窗口拉宽`)
      await page.mouse.move(abs.x, abs.y).catch(() => {})
      await page.mouse.click(abs.x, abs.y, { label: 'pick-main-card' }).catch(() => {})
      const filled = await waitUntil(
        async () => {
          const n = await slotCount(page, area)
          return n !== null && n < before ? n : null
        },
        // 填最后一个槽时面板会自动关，槽位回填慢；不必等满 8s，2.5s 后直接回读确认
        { timeoutMs: before <= 1 ? 2500 : 8000, intervalMs: 200, label: 'slot-filled' }
      )
      const now = filled.ok ? filled.value : await slotCount(page, area)
      const tEnd = Date.now()
      if (filled.ok || (now !== null && before !== null && now < before)) {
        placed = true
        say(
          `   点卡片填槽: 空槽 ${before} → ${now} ✓${filled.ok ? '' : '（慢半拍，已回读确认）'}` +
            `  [面板 ${tPanel - t0}ms | 挪鼠标/清菜单 ${tAway - tPanel}ms | 读空槽 ${tCount - tAway}ms | 定位+命中 ${tHit - tCount}ms | 点+回读 ${tEnd - tHit}ms]`
        )
        doneFiles.push(f)
      } else {
        say('   没填上（可能点到已填的图上）→ 清菜单重试:', `空槽 ${before} → ${now} / 第 ${attempt} 次`)
        await clearMenuHard()
      }
    }
    if (!placed) {
      failure = { why: 'slot_not_filled', 文件: f }
      break
    }
  }
  mark('逐张点击', tCards)
  say(
    '   阶段耗时:',
    Object.entries(phase)
      .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`)
      .join(' | ')
  )

  const endSlots = await slotCount(page, area)
  // ★ 收工/失败都清残留面板（原版注释：失败退出前必做；残留会让下一步认错面板）
  const cleanup = await closeResidualPanel(page)

  // ★ 有的区会「传完自动应用」，那几个文件不在 doneFiles 里 → 用空槽差再算一遍，别把成功的活算成失败
  const autoFiles = picked.slice(0, Math.min(Math.max(0, autoApplied), picked.length))
  const appliedFiles = [...autoFiles, ...doneFiles.filter((f) => !autoFiles.includes(f))]
  const bySlots = emptyBefore !== null && endSlots !== null ? Math.max(0, emptyBefore - endSlots) : appliedFiles.length
  const uploaded = Math.min(want, Math.max(bySlots, appliedFiles.length))
  const ok = !failure && uploaded === want
  say(`   终态空槽: ${endSlots} | 填上 ${uploaded}/${want}`)

  const base = {
    ...readback,
    起始空槽: startSlots,
    终态空槽: endSlots,
    已完成: appliedFiles,
    未完成: picked.filter((f) => !appliedFiles.includes(f)),
    清理残留面板: cleanup,
    耗时明细: phase,
    耗时ms: Date.now() - t0,
  }
  if (!ok) {
    return {
      ok: false,
      why: (failure && failure.why) || 'not_all_slots_filled',
      uploaded,
      want,
      counted: uploaded,
      ...base,
      ...(failure || {}),
    }
  }
  return { ok: true, uploaded, want, counted: uploaded, ...base }
}
