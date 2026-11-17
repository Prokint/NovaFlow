/**
 * 规格图逐格填充（ego 版）—— 移植自
 *   taobao-product-listing\scripts\tb_fill_spec_images.js
 * 同时把原编排里单独的 `tests/verify_spec_images.js`（规格图 src 不重复核对）合进来 —— 本函数签名要求
 * 自带 `dupSrc` 判据，且原编排正是「fill → verify → 确认创建」三步，合并后不再需要额外脚本。
 *
 * 原脚本的链路（2026-10-10 实测，MZB-001 72/72）：
 *   ① 勾过「编辑规格 → 颜色分类 → ☑添加图片」并「确认创建」后，抽屉里每个规格值旁出现
 *      `.sell-color-option-image-upload`（32px 图位，空态 `.sell-color-option-image-empty`）
 *   ② 点图位 → 打开「批量填充规格主图」：右侧规格值可多选、左侧素材区（iframe）、底部确定
 *   ③ 逐个颜色：右侧选中该颜色名下全部规格值 → 左侧搜图 → 点「图片右上角的小框」→ 自动填入当前值并跳到下一个
 *   ④ 点面板「确定」→ 抽屉里点「确认创建」（确认创建留给 specAddImage 的 confirm 分支）
 *
 * 与 Playwright/CDP 原版的差异（只换执行层，不改硬规则）：
 *   - 左侧素材区：原版 `page.frames().filter(f => /sucai-selector-ng|handleId=/.test(f.url())).pop()`
 *     → ego 没有 frames；改为在 `page.evaluate` 里按 src/name/id 找 `<iframe>`（取 DOM 最后一个），
 *     经 `iframe.contentDocument`（同源）读图片/搜索框/「本地上传」，返回 iframe 偏移后
 *     点击一律 `page.mouse.click(iframe.left + x, iframe.top + y)`。
 *   - 上传：原版 `waitForEvent('filechooser')` + `locator('input[type=file]').setInputFiles` 兜底
 *     → ego 用共享库 `uploadFiles`（`waitForFileChooser()` + `chooser.setFiles(paths)`，无 filechooser
 *     时退回主文档 input[type=file]+setInputFiles）。
 *   - 滚动：原版在 iframe 内 `frame.evaluate(async …)` 滚列表 + 等加载；ego 的 evaluate 不保证支持
 *     async 函数 → 改成 Node 侧循环（`imageBox` / `listMeta` / `scrollTo` 每次一个同步 evaluate）+ sleep。
 *   - 截图/日志文件：原版写 `_upload_name.log` 之类；ego 子进程不保证可写任意路径 → 只打印。
 *
 * 仍依赖的硬规则（原文实测，逐条保留）：
 *   1. **先把本商品的规格图传进图片空间** —— 否则搜索会命中**别的商品的同名图**（实测踩到）。
 *   2. 点**图片右上角的小框**（`x = img.right - 9, y = img.top + 9`），不是图片本体；
 *      点一下 = 填入「当前规格值」并**自动跳到下一个值**。
 *   3. 同一张图给下一个值用时，**先点一次取消、再点一次选中**（原版自适应：点一下读回已填数，没增加就补点一次）。
 *   4. 面板**只打开一次** —— 重开会把「当前值」重置回列表第 1 项，第二色起会把图填到第一色的值上（实测）。
 *   5. 形态自适应：该颜色名下 **1 个值** → 右侧先单选再点图；**N 个值** → 不碰右侧，靠自动前进 + 补点。
 *      （踩过：只做单选 → 米白只填 1 个槽、其余颜色 `cannot_single_select` 跳过 → 54 槽只填 1 个还报 exit 0）
 *   6. 实增 < 期望 **必须明确报出来**，绝不假绿。
 *   7. 规格图命名要可区分（`<商品号>规格图-<颜色>.jpg`；`product.json.spec_images` 显式映射优先）；
 *      只写「卡其色.jpg」会撞上 SKU 搜索主图的命名 → 搜错图。
 *   8. 核对：每个图位要有图（img.complete && naturalWidth>0，先逐个 scrollIntoView 触发懒加载），
 *      **不同颜色不能共用同一张图（串位）**；同色各行共用一张是正常语义（6 色 × 9 尺寸 = 6 个唯一 src）。
 *   9. 不要对规格抽屉按 Escape；不要刷新页面。
 *
 * 导出（由 run_listing_tb.mjs 在同一 ego 进程内顺序调用；确认创建由 specAddImage({confirm:true}) 负责）：
 *   `fillSpecImages(page, dir, product)`
 *     → `{ ok, filled, want, dupSrc, counted, ...读回 }`
 *   - `product`：product.json 解析后的对象（也兼容传路径字符串）；**颜色集合只取 `product.colors`**，
 *     原版写死的 MZB-001 默认颜色已去掉 —— 缺 colors 直接报 `no_colors`，避免填错商品。
 *   - `filled` = 图位里有图的数量；`want` = 图位总数；`dupSrc` = 是否跨颜色共用同一张图（串位，布尔）。
 *   可选：`globalThis.__TB_CFG.specColor`（只试一个颜色，对应原版 `--color` / `TB_COLOR`）。
 *   不写 main/CLI，不打印 JSON 行（由编排层负责）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { say, sleep, uploadFiles, frameEvalShim, waitUntil } from '../lib/tb_ego.mjs'

/** 素材区 iframe 的两种 src（原版用 `/sucai-selector-ng|handleId=/` 匹配）。 */
const PANEL_KEYS = ['sucai-selector-ng', 'handleId=']
const IMG_EXT = /\.(jpe?g|png|webp|bmp|gif)$/i

/**
 * ego 子进程不继承自定义环境变量 → 配置只从 `globalThis.__TB_CFG` 读（与 tb_enter_form.mjs 的 INLINE 同源）。
 * ★ 每次调用时现读：本模块可能被 run_listing_tb.mjs **静态 import**，那一刻 `__TB_CFG` 还没赋值。
 */
const tbCfg = () => (typeof globalThis !== 'undefined' && globalThis.__TB_CFG) || {}
const cfgVal = (key, dflt) => {
  const c = tbCfg()
  return c[key] === undefined || c[key] === null || c[key] === '' ? dflt : c[key]
}
/** ego 的 setFiles 用正斜杠路径更稳（PDD ego 版实测这里会先 `replace(/\\/g, "/")`）。 */
const posix = (p) => String(p).replace(/\\/g, '/')

/**
 * 左侧素材 iframe 内的一次读操作（ego 没有 page.frames()）。
 * 候选 = src/name/id 含 `sucai-selector-ng` 或 `handleId=` 的 iframe，取 DOM 最后一个（原版 `.pop()`）。
 * 返回的 x/y 是 **iframe 内坐标**；真实点击由调用方加 iframe 偏移后 `page.mouse.click`。
 * @param op - 'frame' | 'uploadBtn' | 'done' | 'search' | 'imageBox' | 'listMeta' | 'scrollTo'
 */
async function panelCall(page, op, data = {}) {
  const payload = await frameEvalShim(page, { needle: new RegExp(PANEL_KEYS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')), pick: 'last' }, ({ op, data, keys }) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const frames = [...document.querySelectorAll('iframe')]
      const hay = (f) =>
        String(f.getAttribute('src') || '') + ' ' + String(f.getAttribute('name') || '') + ' ' + String(f.id || '')
      const cands = frames.filter((f) => keys.some((k) => hay(f).includes(k)))
      const frame = cands.length ? cands[cands.length - 1] : null
      if (!frame) {
        return {
          ok: false,
          why: 'no_frame',
          候选数: cands.length,
          帧样本: frames
            .map((f) => ({ name: String(f.getAttribute('name') || ''), src: String(f.getAttribute('src') || '').slice(0, 90) }))
            .slice(0, 6),
        }
      }
      const doc = frame.contentDocument
      if (!doc) return { ok: false, why: 'no_content_document', 面板: String(frame.getAttribute('name') || '') }
      const rect = frame.getBoundingClientRect()
      const geom = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      const win = doc.defaultView || window
      const v = (value) => ({ ok: true, value: { ok: true, ...value }, geom })
      const listEl = () => doc.querySelector('[class*="PicturesShow_main"]') || doc.scrollingElement

      switch (op) {
        case 'frame':
          return v({ name: String(frame.getAttribute('name') || ''), 候选数: cands.length, left: rect.left, top: rect.top })
        case 'uploadBtn': {
          const inputs = doc.querySelectorAll('input[type=file]').length
          const b = [...doc.querySelectorAll('button')].filter(vis).find((x) => clean(x.innerText).includes('本地上传'))
          if (!b) return { ok: true, value: { ok: false, why: 'no_upload_entry', 文件输入数: inputs }, geom }
          const r = b.getBoundingClientRect()
          return v({ x: r.left + r.width / 2, y: r.top + r.height / 2, 文件输入数: inputs })
        }
        case 'done': {
          const b = [...doc.querySelectorAll('button')]
            .filter(vis)
            .find((x) => /^完成$/.test(clean(x.innerText)))
          if (!b) return { ok: true, value: { ok: false, why: 'no_done_btn' }, geom }
          const r = b.getBoundingClientRect()
          return v({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
        }
        case 'search': {
          // ★ 用户指路：**在搜索框里输入文件名 + 回车** → 列表立刻过滤出那一张（完整可见、小框好点）
          const kw = String(data.name || '')
          const i = [...doc.querySelectorAll('input')]
            .filter(vis)
            .find((x) => /搜索图片名称|请输入文件名称|搜索/.test(x.getAttribute('placeholder') || ''))
          if (!i) return { ok: true, value: { ok: false, why: 'no_search_input' }, geom }
          i.focus()
          const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set
          setter.call(i, kw)
          i.dispatchEvent(new win.Event('input', { bubbles: true }))
          for (const ev of ['keydown', 'keyup', 'keypress']) {
            i.dispatchEvent(new win.KeyboardEvent(ev, { key: 'Enter', keyCode: 13, which: 13, bubbles: true }))
          }
          return v({ 输入框值: i.value })
        }
        case 'imageBox': {
          // ★ 点**图片右上角的小框**（不是图片本体）：x = right - 9, y = top + 9
          const name = String(data.name || '')
          // ⚠️ 判"可见"必须在**iframe 视口内**（宽高>0 不够：元素可在滚动容器可视区外仍满足，
          //    实测拿到 y=956 这种视口外坐标 → 点空）
          const inView = (r) => r.top > 6 && r.bottom < geom.height - 6 && r.left > 0 && r.right < geom.width
          const imgs = [...doc.querySelectorAll('img')]
            .filter(vis)
            .filter((e) => {
              const r = e.getBoundingClientRect()
              return r.width >= 50 && r.height >= 50
            })
          for (const img of imgs) {
            let p = img
            for (let k = 0; k < 6 && p; k += 1) {
              p = p.parentElement
              if (!p) break
              const txt = clean(p.innerText)
              if (!txt.includes(name)) continue
              // ⚠️ 必须"这一层**只含这一个文件名**" —— 否则会命中「包含整个列表」的容器，
              //    结果点到列表第一张（实测点成了主图 main_0x，用户当场发现）
              const names = [...new Set((txt.match(/[\w\u4e00-\u9fa5.-]+\.(jpg|jpeg|png)/gi) || []).map((x) => x.toLowerCase()))]
              if (names.length !== 1) continue
              const r = img.getBoundingClientRect()
              if (!inView(r)) continue
              return v({ x: Math.round(r.right - 9), y: Math.round(r.top + 9), 卡片文件名: names[0], 顶部: Math.round(r.top) })
            }
          }
          return { ok: true, value: { ok: false, why: 'no_img' }, geom }
        }
        case 'imageAny': {
          // ★ 兜底：搜索之后结果里通常只剩本商品的图 → 直接取 iframe 视口内第一张 ≥50px 的图
          const inView2 = (r) => r.top > 6 && r.bottom < geom.height - 6 && r.left > 0 && r.right < geom.width
          const imgs2 = [...doc.querySelectorAll('img')]
            .filter(vis)
            .filter((e) => {
              const r = e.getBoundingClientRect()
              return r.width >= 50 && r.height >= 50 && inView2(r)
            })
          if (!imgs2.length) return { ok: true, value: { ok: false, why: 'no_img' }, geom }
          const r0 = imgs2[0].getBoundingClientRect()
          return v({ x: Math.round(r0.right - 9), y: Math.round(r0.top + 9), 卡片文件名: 'first_in_view', 顶部: Math.round(r0.top) })
        }
        case 'boxChecked': {
          // ★ 实测结构：IMG → DIV.PicList_pic_imgBox → **LABEL** → DIV.PicList_pic_background
          //   小框就是 LABEL 里的 checkbox：点完立刻读 input.checked，比主文档的「已填数」快得多
          const p = data || {}
          const el = doc.elementFromPoint(Number(p.x), Number(p.y))
          let cur = el
          let label = null
          for (let k = 0; k < 8 && cur; k += 1) {
            if (String(cur.tagName) === 'LABEL') {
              label = cur
              break
            }
            cur = cur.parentElement
          }
          const input = label ? label.querySelector('input[type=checkbox], input[type=radio]') : null
          const cls = String((label && label.className) || '')
          const checked = !!(input && input.checked) || /checked|selected|active/i.test(cls)
          return {
            ok: true,
            value: { checked, hasLabel: !!label, hasInput: !!input, cls: cls.slice(0, 60), tag: el ? el.tagName : null },
          }
        }
        case 'imageCount': {
          // 视口内 ≥50px 的图几张、卡片名有哪些（搜索过滤后可用来判断「搜到了」）
          const inView3 = (r) => r.top > 6 && r.bottom < geom.height - 6 && r.left > 0 && r.right < geom.width
          const imgs3 = [...doc.querySelectorAll('img')]
            .filter(vis)
            .filter((e) => {
              const r = e.getBoundingClientRect()
              return r.width >= 50 && r.height >= 50 && inView3(r)
            })
          const names = []
          for (const img of imgs3.slice(0, 6)) {
            let p = img
            for (let k = 0; k < 6 && p; k += 1) {
              p = p.parentElement
              if (!p) break
              const t = clean(p.innerText)
              const m = t.match(/[\w\u4e00-\u9fa5.-]+\.(jpg|jpeg|png)/i)
              if (m && t.length < 90) {
                names.push(String(m[0]).slice(0, 40))
                break
              }
            }
          }
          return { ok: true, value: { count: imgs3.length, names } }
        }
        case 'hit': {
          // 点下去会命中什么（用来确认点到的是图片卡片，不是空白/别的图）
          const p = data || {}
          const el = doc.elementFromPoint(Number(p.x), Number(p.y))
          return { ok: true, value: { tag: el ? el.tagName : null } }
        }
        case 'listMeta': {
          const l = listEl()
          if (!l) return { ok: true, value: { ok: false, why: 'no_list' }, geom }
          return v({ scrollTop: l.scrollTop, clientHeight: l.clientHeight, scrollHeight: l.scrollHeight })
        }
        case 'scrollTo': {
          const l = listEl()
          if (!l) return { ok: true, value: { ok: false, why: 'no_list' }, geom }
          l.scrollTop = Number(data.y) || 0
          return v({ scrollTop: l.scrollTop, scrollHeight: l.scrollHeight })
        }
        default:
          return { ok: false, why: 'unknown_op:' + op, geom }
      }
    }, { op, data, keys: PANEL_KEYS })
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

/** 编辑规格抽屉读回（原版 drawerState）。 */
const drawerState = (page) =>
  page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const d = ([...document.querySelectorAll('.sku-decouple-drawer-container')].filter(vis)[0] || (document.querySelector('[class*=option-image]') ? document.body : null))
      const dlg = [...document.querySelectorAll('.next-dialog')].filter(vis)[0]
      const slots = d ? [...d.querySelectorAll('.sell-color-option-image-upload')].filter(vis) : []
      return {
        抽屉在: !!d,
        图位总数: slots.length,
        已有图: slots.filter((e) => e.querySelector('img')).length,
        空图位: slots.filter((e) => !e.querySelector('img')).length,
        面板: dlg ? clean(dlg.innerText).slice(0, 200) : null,
        面板计数: dlg ? (clean(dlg.innerText).match(/(\d+)\s*\/\s*(\d+)/) || []).slice(1).join('/') || null : null,
        面板SKU项: dlg ? dlg.querySelectorAll('li.sku-item').length : 0,
      }
    })
    .catch(() => ({ 抽屉在: false, 图位总数: 0, 已有图: 0, 空图位: 0, 面板: null, 面板计数: null, 面板SKU项: 0 }))

/** 打开「编辑规格」抽屉（真实鼠标；元素点击在这个页面不一定生效）。 */
/** 确保在「销售信息」tab（详情图那步会把页面停在图文描述，SKU 区/编辑规格都不在那页）。 */
async function ensureSalesTab(page) {
  const hasSku = await page
    .evaluate(() => /SKU模式/.test((document.body.innerText || '').replace(/\s+/g, ' ')))
    .catch(() => true)
  if (hasSku) return { ok: true, 已在: true }
  const pt = await page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const el = [...document.querySelectorAll('div,span,a,li')]
        .filter(vis)
        .filter((e) => clean(e.innerText) === '销售信息')
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.top < 220)[0]
      return el ? { x: Math.round(el.left + el.width / 2), y: Math.round(el.top + el.height / 2) } : null
    })
    .catch(() => null)
  if (!pt) return { ok: false, why: 'sales_tab_not_found' }
  await page.mouse.move(pt.x, pt.y).catch(() => {})
  await sleep(120)
  await page.mouse.click(pt.x, pt.y, { label: 'tab:销售信息' }).catch(() => {})
  await sleep(2000)
  return { ok: true, 已在: false }
}

/** 打开「编辑规格」抽屉（真实鼠标；元素点击在这个页面不一定生效）。 */
async function openDrawer(page) {
  const c = await page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      if ([...document.querySelectorAll('.sku-decouple-drawer-container')].filter(vis).length) return { already: true }
      const pool = [...document.querySelectorAll('button,a,span,div')].filter(vis).filter((e) => ['编辑规格', '按规格单独设置'].includes(clean(e.innerText)))
      const el = pool.filter((e) => !pool.some((o) => o !== e && e.contains(o)))[0]
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })
    .catch(() => null)
  if (!c) return { ok: false, why: 'no_btn' }
  if (c.already) return { ok: true, already: true }
  await page.mouse.move(c.x, c.y)
  await sleep(250)
  await page.mouse.click(c.x, c.y, { label: '编辑规格' })
  await sleep(5000)
  return { ok: true }
}

/**
 * 点**第一个空图位** → 打开「批量填充规格主图」。
 * （不按文本找图位：规格值文本与图位不在同一条祖先链上，实测 `no_slot`）
 */
async function openFillPanel(page) {
  const c = await page
    .evaluate(() => {
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const d = ([...document.querySelectorAll('.sku-decouple-drawer-container')].filter(vis)[0] || (document.querySelector('[class*=option-image]') ? document.body : null))
      if (!d) return null
      const slot = [...d.querySelectorAll('.sell-color-option-image-upload')].filter(vis).find((e) => !e.querySelector('img'))
      if (!slot) return null
      slot.scrollIntoView({ block: 'center' })
      const r = slot.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })
    .catch(() => null)
  if (!c) return { ok: false, why: 'no_empty_slot' }
  await page.mouse.move(c.x, c.y)
  await sleep(250)
  await page.mouse.click(c.x, c.y, { label: 'open-fill-panel' })
  await sleep(5000)
  return { ok: true, 点: c }
}

/** 业务侧「已填上图的条目数」：面板右侧 `li.sku-item` 里 `.sku-image-container` 有 img 的个数（无面板 -1）。 */
const filledCount = (page) =>
  page
    .evaluate(() => {
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const dlg = [...document.querySelectorAll('.next-dialog')].filter(vis)[0]
      if (!dlg) return -1
      const items = [...dlg.querySelectorAll('li.sku-item')].filter(vis)
      return items.filter((e) => {
        const c = e.querySelector('.sku-image-container')
        return c && c.querySelector('img')
      }).length
    })
    .catch(() => -1)

/** 面板里某颜色名下的规格值文本（顺序 = 抽屉里图位顺序）。 */
const listValues = (page, color) =>
  page
    .evaluate((col) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const dlgs = [...document.querySelectorAll('.next-dialog')].filter(vis)
      const dlg = dlgs[dlgs.length - 1]
      if (!dlg) return []
      const hit = (t) => t === col || t.startsWith(col + '-') || t.startsWith(col + '_') || t.startsWith(col + ' ')
      return [...dlg.querySelectorAll('li.sku-item')]
        .filter(vis)
        .map((e) => clean(e.innerText))
        .filter((t) => hit(t))
    }, color)
    .catch(() => [])

/** 读右侧所有值 + 哪些已选（原版 readRightState）。 */
const readRightState = (page, color) =>
  page
    .evaluate((col) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const cls = (e) => String((e && e.getAttribute && e.getAttribute('class')) || '')
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const dlgs = [...document.querySelectorAll('.next-dialog')].filter(vis)
      const dlg = dlgs[dlgs.length - 1]
      if (!dlg) return { ok: false, why: 'no_dialog' }
      const all = [...dlg.querySelectorAll('li.sku-item')]
        .filter(vis)
        .map((e) => {
          const box = e.querySelector('.sku-image-container') || e
          const t = clean(e.innerText)
          return { 文本: t, 已选: /selected/i.test(cls(box)) || /selected/i.test(cls(e)) }
        })
      const hit = (t) => t === col || t.startsWith(col + '-') || t.startsWith(col + '_') || t.startsWith(col + ' ')
      const 目标集 = all.filter((x) => hit(x.文本)).map((x) => x.文本)
      if (!目标集.length) return { ok: false, why: 'no_item', 候选: all.map((x) => x.文本.slice(0, 16)).slice(0, 12) }
      return { ok: true, 项数: all.length, 全部: all, 目标集 }
    }, color)
    .catch(() => ({ ok: false, why: 'read_failed' }))

/** 点右侧表格里**某一个值**（点 li 行中心；实测点行内 36px 图区不会改变选中态）。 */
async function clickRightItem(page, text) {
  const c = await page
    .evaluate((t) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const dlgs = [...document.querySelectorAll('.next-dialog')].filter(vis)
      const dlg = dlgs[dlgs.length - 1]
      if (!dlg) return { ok: false, why: 'no_dialog' }
      const el = [...dlg.querySelectorAll('li.sku-item')].find((e) => clean(e.innerText) === t)
      if (!el) return { ok: false, why: 'no_item' }
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    }, text)
    .catch(() => ({ ok: false, why: 'read_failed' }))
  if (!c.ok) return c
  await page.mouse.move(c.x, c.y).catch(() => {})
  await sleep(60)
  await page.mouse.click(c.x, c.y, { label: 'select-right-value' }).catch(() => {})
  // 不再固定等 800ms：调用方下一轮会读状态，状态没变就再点一次
  await sleep(120)
  return { ok: true }
}

/**
 * 把该颜色名下的**所有值**选成「唯一被选中的一组」（多选形态的关键）。
 * 先取消不该选的、再补选该选的，最多 40 轮（原版同款）。
 */
async function selectRightValue(page, color) {
  let lastErr = null
  for (let k = 0; k < 40; k += 1) {
    const st = await readRightState(page, color)
    if (!st.ok) return st
    const want = new Set(st.目标集)
    const 别的 = st.全部.filter((x) => x.已选 && !want.has(x.文本)) // 不该选却选着的
    const 该选 = st.全部.filter((x) => !x.已选 && want.has(x.文本)) // 该选还没选的
    if (!别的.length && !该选.length) {
      return { ok: true, 选中数: st.目标集.length, 目标: st.目标集.slice(0, 3).map((x) => x.slice(0, 18)) }
    }
    const target = (别的[0] || 该选[0] || {}).文本
    if (!target) break
    const r = await clickRightItem(page, target)
    if (!r.ok) {
      lastErr = r
      await sleep(700)
    }
  }
  return { ok: false, why: 'cannot_select_set', 最后: lastErr }
}

/** 等主文档面板里的确定按钮（填充面板的「确定」，不是 iframe 底部那个）。 */
const fillPanelConfirm = (page) =>
  page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const dlg = [...document.querySelectorAll('.next-dialog')].filter(vis)[0]
      if (!dlg) return { ok: false, why: 'no_dialog' }
      const b = [...dlg.querySelectorAll('button')].filter(vis).find((x) => /^确定/.test(clean(x.innerText)))
      if (!b || b.disabled) return { ok: false, 文本: b ? clean(b.innerText) : null }
      const r = b.getBoundingClientRect()
      return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 文本: clean(b.innerText) }
    })
    .catch((e) => ({ ok: false, why: String((e && e.message) || e) }))

/**
 * 在素材 iframe 里搜图（输入文件名 + 回车），把目标图顶到列表最前面。
 * 搜索是异步的，原版等 3s；这里再在页面层按一次回车（焦点已在 iframe 搜索框上）。
 */
async function searchInPanel(page, kw) {
  // 先记一下过滤前的图数（搜索生效后列表会大幅收缩）
  const before = await panelCall(page, 'imageCount')
  const beforeCount = before.ok ? Number(before.count) || 0 : 0
  const t0 = Date.now()
  const r = await panelCall(page, 'search', { name: kw })
  if (!r.ok) return r
  await page.keyboard.press('Enter').catch(() => {})
  let last = null
  // ★ 就绪判据（任一成立就立刻走，不再固定等 3s）：
  //   ① 按文件名精确命中的卡片可点了；② 列表已被过滤到「比原来少很多、且至少还剩 1 张」
  //   （长中文名/带【】的卡片文本会被截断导致 ① 永远不成立 → 靠 ② 兜住，否则每张白等 6s）
  const ready = await waitUntil(
    async () => {
      const box = await panelCall(page, 'imageBox', { name: kw })
      if (box.ok) {
        last = { how: 'named', 卡片文件名: box.卡片文件名 }
        return last
      }
      const now = await panelCall(page, 'imageCount')
      const cnt = now.ok ? Number(now.count) || 0 : 0
      last = { how: 'filtered', count: cnt, names: now.ok ? now.names : null }
      const shrunk = cnt >= 1 && (beforeCount === 0 || cnt < beforeCount)
      return shrunk ? last : null
    },
    // 关键词在卡片文本里被截断时（PE 这类超长中文名）两个判据都不成立 →
    // 最多等 2.5s 就往下走（findImageBox 有「视口内第一张」兜底），别在这白等 6s
    { timeoutMs: 2500, intervalMs: 200, label: 'search-ready' }
  )
  if (!ready.ok) say('   （搜索就绪判据没成立 → 用「视口内第一张」兜底点图）')
  return { ...r, 就绪: ready.ok, 就绪方式: last, 搜索ms: Date.now() - t0 }
}

/**
 * 在素材 iframe 里找图片右上角小框；找不到就从**列表底部**往上一屏屏找。
 * ⚠️ 步长必须**远小于视口高**（这里 120 < iframe 视口高）：步长太大时图总是「跨在视口边界上」、
 *    永远不满足"完整可见" → 大量点击落空（实测 72 次只落 24 个的真因）。
 */
async function findImageBox(page, name) {
  let r = await panelCall(page, 'imageBox', { name })
  if (r.ok) return r
  // ★ 文件名匹配不上（长中文名/带【】/卡片文本被截断）→ 搜索后取视口内第一张图
  const any = await panelCall(page, 'imageAny')
  if (any.ok) return any
  const meta = await panelCall(page, 'listMeta')
  if (!meta.ok) return r
  const bottom = Number(meta.scrollHeight) || 0
  // 规格图排在列表最底部（144 张图里规格图最早上传）→ 先滚到底再往上找最快
  await panelCall(page, 'scrollTo', { y: bottom })
  await sleep(500)
  r = await panelCall(page, 'imageBox', { name })
  if (r.ok) return r
  for (let y = bottom; y >= 0; y -= 120) {
    await panelCall(page, 'scrollTo', { y })
    await sleep(200)
    r = await panelCall(page, 'imageBox', { name })
    if (r.ok) return r
  }
  return r
}

/**
 * 点图片右上角小框 `times` 次（每次重新定位：面板的当前值会前进）。
 * 同一张图给下一个值用时，原版「先点一次取消、再点一次选中」——调用方按「已填数没增加就补点一次」实现。
 */
async function clickImageBox(page, name, times) {
  if (!(await panelCall(page, 'frame')).ok) return { ok: false, why: 'no_frame' }
  let pos = await findImageBox(page, name)
  if (!pos.ok) return { ok: false, why: 'no_img' }
  // ★ 选完右侧值后左侧列表会重排一会儿：等「小框坐标稳定」（连续两次读数一致）再点，
  //   否则用重排前的坐标点下去会落到图片本体/空白上（实测这就是要补点的原因）
  let prev = null
  for (let k = 0; k < 8; k += 1) {
    const nx = Math.round(pos.x)
    const ny = Math.round(pos.y)
    if (prev && Math.abs(prev.x - nx) <= 2 && Math.abs(prev.y - ny) <= 2) break
    prev = { x: nx, y: ny }
    await sleep(120)
    pos = await findImageBox(page, name)
    if (!pos.ok) return { ok: false, why: 'no_img' }
  }
  const g = pos.geom
  const clicked = []
  for (let i = 0; i < times; i += 1) {
    const abs = { x: Math.round(g.left + pos.x), y: Math.round(g.top + pos.y) }
    // ★ 点之前确认「这一点命中的是图片卡片」（不是空白/别的图）→ 能点到就立刻点，不做固定等待
    const hit = await panelCall(page, 'hit', { x: pos.x, y: pos.y })
    await page.mouse.move(abs.x, abs.y).catch(() => {})
    await page.mouse.click(abs.x, abs.y, { label: 'pick-spec-image-box' }).catch(() => {})
    clicked.push({
      ...abs,
      命中: hit.tag || null,
      小框: { x: Math.round(pos.x), y: Math.round(pos.y) },
      卡片: pos.卡片文件名,
    })
    // ★ 小框是 <LABEL> 包着图片、读不到 checked（实测），别在这上面等；
    //   点没点上由调用方用「面板已填 +1」判断
    if (i + 1 < times) await sleep(350)
  }
  return {
    ok: true,
    点了几次: times,
    小框: { x: pos.x, y: pos.y },
    卡片文件名: pos.卡片文件名,
    点击: clicked,
    命中: clicked.length ? clicked[0].命中 : null,
  }
}

/** 读图位个数（懒加载触发前的计数）。 */
const specSlotCount = (page) =>
  page
    .evaluate(() => {
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const d = ([...document.querySelectorAll('.sku-decouple-drawer-container')].filter(vis)[0] || (document.querySelector('[class*=option-image]') ? document.body : null))
      if (!d) return 0
      return [...d.querySelectorAll('.sell-color-option-image-upload')].filter(vis).length
    })
    .catch(() => 0)

/**
 * 规格图 src 核对（合并原 `tests/verify_spec_images.js`）：
 *   ① 逐个图位 `scrollIntoView` 触发懒加载（抽屉有时内滚、有时全高展开 → 不能只依赖某一种容器）；
 *   ② 判「有图」用 `img.complete && img.naturalWidth > 0`，不只看有没有 `<img>`；
 *   ③ 按图位左侧同高度的规格值文本把图位映射回颜色，统计每色 src 与跨色共用（串位）。
 * @param colors - 期望颜色集合
 */
async function readSpecSlots(page, colors) {
  const count = await specSlotCount(page)
  if (!count) {
    return { 图位数: 0, 有图: 0, 空图位: 0, 加载成功: 0, 唯一src数: 0, src分布: {}, 每色: [], 串位: [], 行: [], 抽屉不在: true }
  }
  const beforeY = await page.evaluate(() => window.scrollY).catch(() => 0)
  const step = Math.max(1, Math.ceil(count / 8))
  for (let i = 0; i < count; i += step) {
    await page
      .evaluate((i) => {
        const vis = (e) => {
          if (!e) return false
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const d = ([...document.querySelectorAll('.sku-decouple-drawer-container')].filter(vis)[0] || (document.querySelector('[class*=option-image]') ? document.body : null))
        if (!d) return
        const slots = [...d.querySelectorAll('.sell-color-option-image-upload')].filter(vis)
        const s = slots[Math.min(i, slots.length - 1)]
        if (s) s.scrollIntoView({ block: 'center' })
      }, i)
      .catch(() => {})
    await sleep(600)
  }
  await page.evaluate((y) => window.scrollTo(0, y), beforeY).catch(() => {})
  await sleep(500)

  const read = () =>
    page
      .evaluate((colors) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const vis = (e) => {
          if (!e) return false
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const d = ([...document.querySelectorAll('.sku-decouple-drawer-container')].filter(vis)[0] || (document.querySelector('[class*=option-image]') ? document.body : null))
        if (!d) return { 图位数: 0, 有图: 0, 空图位: 0, 加载成功: 0, 唯一src数: 0, src分布: {}, 每色: [], 串位: [], 行: [], 抽屉不在: true }
        const slots = [...d.querySelectorAll('.sell-color-option-image-upload')].filter(vis)
        const rows = slots.map((s, i) => {
          const img = s.querySelector('img')
          const rect = s.getBoundingClientRect()
          // 图位**左边**那一列通常是规格值文本；取同一 y 附近、x 在左的叶子文本
          const all = [...d.querySelectorAll('*')]
            .filter(vis)
            .filter((e) => e.children.length === 0 && clean(e.innerText))
            .map((e) => {
              const rr = e.getBoundingClientRect()
              return { t: clean(e.innerText), y: Math.round(rr.top + rr.height / 2), x: Math.round(rr.right) }
            })
            .filter((x) => Math.abs(x.y - Math.round(rect.top + rect.height / 2)) < 14 && x.x < rect.left)
            .sort((a, b) => b.x - a.x)
          return {
            序: i + 1,
            图位: { x: Math.round(rect.left), y: Math.round(rect.top) },
            有图: !!img,
            加载成功: !!(img && img.complete && img.naturalWidth > 0),
            尺寸: img ? `${img.naturalWidth}x${img.naturalHeight}` : null,
            src: img ? String(img.src) : null,
            左侧文本: all.slice(0, 2).map((x) => x.t),
          }
        })
        const srcs = rows.map((x) => x.src).filter(Boolean)
        const short = (s) => String(s || '').slice(-60)
        const hit = (t, col) => t === col || t.startsWith(col + '-') || t.startsWith(col + '_') || t.startsWith(col + ' ')
        const 每色 = colors.map((c) => {
          const mine = rows.filter((x) => (x.左侧文本 || []).some((t) => hit(t, c)))
          const ss = mine.map((x) => x.src).filter(Boolean)
          return {
            颜色: c,
            图位: mine.length,
            有图: ss.length,
            加载成功: mine.filter((x) => x.加载成功).length,
            唯一src数: new Set(ss).size,
            src样本: ss.length ? short(ss[0]) : null,
          }
        })
        const srcColors = new Map()
        for (const x of rows) {
          if (!x.src) continue
          const cs = colors.filter((c) => (x.左侧文本 || []).some((t) => hit(t, c)))
          if (!cs.length) continue
          if (!srcColors.has(x.src)) srcColors.set(x.src, new Set())
          for (const c of cs) srcColors.get(x.src).add(c)
        }
        const 串位 = [...srcColors.entries()]
          .filter(([, cs]) => cs.size > 1)
          .map(([s, cs]) => ({ src: short(s), 颜色: [...cs] }))
        return {
          图位数: slots.length,
          有图: srcs.length,
          空图位: slots.length - srcs.length,
          加载成功: rows.filter((x) => x.加载成功).length,
          唯一src数: new Set(srcs).size,
          src分布: Object.fromEntries([...new Set(srcs)].map((s) => [short(s), srcs.filter((x) => x === s).length])),
          每色,
          串位,
          行: rows.map((x) => ({ ...x, src: short(x.src) })),
        }
      }, colors)
      .catch(() => ({ 图位数: 0, 有图: 0, 空图位: 0, 加载成功: 0, 唯一src数: 0, src分布: {}, 每色: [], 串位: [], 行: [], 抽屉不在: true }))

  let r = await read()
  // 仍有没加载出来的，等一轮再读一次（图片空间转码偶尔慢；原 verify 脚本等 4s）
  if ((r.行 || []).some((x) => x.有图 && !x.加载成功)) {
    await sleep(4000)
    r = await read()
  }
  return r
}

/** ②b 把本商品要用的规格图先传进图片空间（否则搜索会命中别的商品的同名图）。 */
async function uploadSpecs(page, need, dir) {
  const fr = await panelCall(page, 'frame')
  if (!fr.ok) return { ok: false, why: 'no_frame' }
  if (!need.length) return { ok: true, 上传: 0, note: '没有规格图可传' }
  const paths = need.map((f) => posix(join(dir, f)))
  const btn = await panelCall(page, 'uploadBtn')
  if (!btn.ok) return { ok: false, why: 'no_upload_entry', 文件输入数: btn.文件输入数 }
  const abs = { x: Math.round(btn.geom.left + btn.x), y: Math.round(btn.geom.top + btn.y) }
  const trigger = async () => {
    await page.mouse.move(abs.x, abs.y)
    await sleep(200)
    await page.mouse.click(abs.x, abs.y, { label: 'spec-local-upload' })
  }
  const up = await uploadFiles(page, trigger, paths, { timeoutMs: 12000 }).catch((e) => ({
    ok: false,
    why: String((e && e.message) || e),
  }))
  if (!up.ok) return { ok: false, why: up.why || 'upload_failed', how: up.how, 上传: paths.length }
  await sleep(11000)
  // 关掉「上传结果」对话框（它会盖住列表）
  const done = await panelCall(page, 'done')
  if (done.ok) {
    const g = await panelCall(page, 'frame')
    if (g.ok) {
      await page.mouse.move(Math.round(g.geom.left + done.x), Math.round(g.geom.top + done.y))
      await sleep(200)
      await page.mouse.click(Math.round(g.geom.left + done.x), Math.round(g.geom.top + done.y), { label: 'close-upload-result' })
      await sleep(3500)
    }
  }
  return { ok: true, 上传: paths.length, how: up.how, 完成: !!done.ok }
}

/**
 * 规格图逐格填充。
 * @param page - ego page（已在 publish.htm 发布表单页，且已勾「添加图片」）
 * @param dir - 规格图片目录（本机绝对路径）
 * @param product - product.json 对象（兼容路径字符串）；颜色集合取 `product.colors`
 * @returns 成功 `{ ok:true, filled, want, dupSrc, counted, ...读回 }`；失败 `{ ok:false, why, ...读回 }`
 */
export async function fillSpecImages(page, dir, product) {
  try {
    return await fillSpecImagesImpl(page, dir, product)
  } catch (e) {
    // 编排层约定：失败也返回对象，绝不把异常抛给 run_listing_tb
    return { ok: false, why: 'exception:' + String((e && e.message) || e), filled: 0, want: 0, dupSrc: false, counted: 0 }
  }
}

/** fillSpecImages 的实际实现（异常统一由上面的 export 包住）。 */
async function fillSpecImagesImpl(page, dir, product) {
  const t0 = Date.now()
  const absDir = resolve(String(dir || ''))
  let P = product
  if (typeof P === 'string') {
    try {
      P = JSON.parse(readFileSync(resolve(P), 'utf8'))
    } catch (e) {
      return { ok: false, why: 'read_product_failed:' + String((e && e.message) || e), filled: 0, want: 0, dupSrc: false, counted: 0 }
    }
  }
  if (!P || typeof P !== 'object') return { ok: false, why: 'no_product', filled: 0, want: 0, dupSrc: false, counted: 0 }
  if (!existsSync(absDir)) return { ok: false, why: 'no_dir', filled: 0, want: 0, dupSrc: false, counted: 0, 目录: absDir }

  // ★ 颜色集合只取 product.colors（原版写死 MZB-001 默认颜色的兜底已去掉：宁可报错，别填错商品）
  const COLORS = Array.isArray(P.colors) ? P.colors.map(String) : []
  if (!COLORS.length) return { ok: false, why: 'no_colors', filled: 0, want: 0, dupSrc: false, counted: 0, 目录: absDir }
  const ONLY = String(cfgVal('specColor', '') || '').trim()
  let picked = ONLY ? COLORS.filter((c) => c === ONLY) : COLORS.slice()
  picked = [...new Set(picked)]
  if (!picked.length) return { ok: false, why: 'color_not_in_product', filled: 0, want: 0, dupSrc: false, counted: 0, 目录: absDir, 颜色: ONLY }
  // ★ 显式映射：素材包 Excel 的「规格图片文件名」列（tb_build.py 带进 product.json 的 spec_images）。
  //   比「文件名包含颜色名」可靠 —— 颜色值是长营销文案（含 emoji / `/` / 空格）时按子串永远猜不中。
  const SPEC_MAP = P.spec_images || {}

  const allImgs = readdirSync(absDir).filter((f) => IMG_EXT.test(f))
  // ★ 判据放宽（2026-10-14 实测）：任何图片文件都收；「带规格图-」或命中 product.json 映射的排在前面优先用。
  const specFiles = allImgs.slice().sort((a, b) => {
    const sa = /规格图-/.test(a) ? 0 : 1
    const sb = /规格图-/.test(b) ? 0 : 1
    return sa - sb || a.localeCompare(b)
  })
  const base = { 目录: absDir, 素材张数: allImgs.length, 颜色数: picked.length, 颜色: picked }
  if (!allImgs.length) {
    say(`   ★ 规格图片目录里没有图片（${absDir}）→ 本步无法填，直接失败（不空转）`)
    return { ok: false, why: 'no_spec_files', filled: 0, want: 0, dupSrc: false, counted: 0, ...base }
  }
  if (!specFiles.some((f) => /规格图-/.test(f))) {
    say(`   ⚠ 规格图片目录里 ${allImgs.length} 张图**都不含「规格图-」字样**：将按颜色名匹配 / product.json 映射来找图。`)
    say('     更稳的做法：文件名写成 `<商品号>规格图-<颜色>.jpg`，或在素材包 Excel 的「规格图片文件名」列里逐 SKU 写明。')
  }
  if (Object.keys(SPEC_MAP).length) say(`   规格图映射：product.json 指定了 ${Object.keys(SPEC_MAP).length} 个颜色`)

  /** 颜色 → 规格图文件名（原版 fileOf：显式映射优先；否则按颜色名匹配，带「规格图-」优先）。 */
  const fileOf = (c) => {
    const m = SPEC_MAP[c]
    if (m) {
      if (allImgs.includes(m)) return m
      const mBase = String(m).toLowerCase()
      const hit = allImgs.find((f) => f.toLowerCase() === mBase || f.toLowerCase().includes(mBase) || mBase.includes(f.toLowerCase()))
      if (hit) return hit
      say(`   ⚠ product.json 指定的规格图不在目录里：${m}（回退按颜色名匹配）`)
    }
    const byColor = allImgs.filter((f) => f.includes(c))
    return byColor.find((f) => /规格图-/.test(f)) || byColor[0] || (allImgs.length === 1 ? allImgs[0] : undefined)
  }

  // 开抽屉
  const st0 = await drawerState(page)
  say('① 打开编辑规格抽屉:', JSON.stringify({ 抽屉在: st0.抽屉在, 图位总数: st0.图位总数, 空图位: st0.空图位, 已有图: st0.已有图 }))
  if (!st0.抽屉在) {
    // ★ 详情图那步会把页面停在「图文描述」tab → SKU 区/编辑规格都不在那页，先切回「销售信息」
    const tab = await ensureSalesTab(page).catch(() => ({ ok: false }))
    if (tab && tab.ok && tab.已在 === false) say('   ①a 已切到「销售信息」tab')
    const opened = await openDrawer(page)
    if (!opened.ok) return { ok: false, why: 'open_drawer_failed:' + (opened.why || 'unknown'), filled: 0, want: 0, dupSrc: false, counted: 0, ...base }
  }
  const st = await drawerState(page)
  if (!st.抽屉在) return { ok: false, why: 'no_drawer', filled: 0, want: 0, dupSrc: false, counted: 0, ...base }
  say('   抽屉状态:', JSON.stringify({ 图位总数: st.图位总数, 空图位: st.空图位, 已有图: st.已有图 }))

  // ★ 幂等重跑：图位已全有图 → 不再开填充面板，只做 src 核对
  if (st.空图位 === 0 && st.已有图 > 0) {
    say('   抽屉里图位已全有图 → 不再开填充面板，只做 src 核对（幂等重跑）')
    const slots = await readSpecSlots(page, COLORS)
    const 期望唯一src数 = slots.每色.filter((x) => x.有图 > 0).length
    const dupSrc = (slots.串位 || []).length > 0 || (期望唯一src数 > 0 && slots.唯一src数 < 期望唯一src数)
    const ok = slots.图位数 > 0 && slots.空图位 === 0 && slots.有图 > 0 && !dupSrc
    const result = {
      ok,
      filled: slots.有图,
      want: slots.图位数,
      dupSrc,
      counted: slots.有图,
      图位数: slots.图位数,
      有图: slots.有图,
      空图位: slots.空图位,
      加载成功: slots.加载成功,
      唯一src数: slots.唯一src数,
      期望唯一src数,
      src分布: slots.src分布,
      串位: (slots.串位 || []).slice(0, 10),
      每色: slots.每色,
      行: slots.行,
      面板: { 跳过: 'already_filled', 确定: null },
      上传: { 跳过: 'already_filled' },
      颜色记录: [],
      ...base,
      耗时ms: Date.now() - t0,
    }
    if (!ok) return { ...result, why: dupSrc ? 'spec_image_shared_between_colors' : 'spec_slots_empty' }
    return result
  }

  // ② 点第一个空图位 → 打开「批量填充规格主图」（★ 只打开**一次**：重开会把当前值重置回列表第 1 项）
  const op = await openFillPanel(page)
  say('② 打开填充面板:', JSON.stringify(op))
  if (!op.ok) return { ok: false, why: op.why || 'open_fill_panel_failed', filled: st.已有图, want: st.图位总数, dupSrc: false, counted: st.已有图, ...base }
  if (!(await panelCall(page, 'frame')).ok) {
    say('   ✗ 左侧素材区没出现（没有 iframe）')
    return { ok: false, why: 'no_material_frame', filled: st.已有图, want: st.图位总数, dupSrc: false, counted: st.已有图, ...base }
  }
  // 等右侧 SKU 列表真的出来（面板 iframe 刚打开、右侧是异步渲染的）
  let fc0 = await filledCount(page)
  for (let k = 0; k < 2 && fc0 < 0; k += 1) {
    await sleep(2000)
    fc0 = await filledCount(page)
  }
  if (fc0 < 0) {
    return { ok: false, why: 'no_dialog', filled: st.已有图, want: st.图位总数, dupSrc: false, counted: st.已有图, ...base }
  }

  // ★ 先把本商品要用的规格图传进图片空间（否则搜索会命中别的商品的同名图 —— 实测踩到）
  const need = [...new Set(picked.map((c) => fileOf(c)).filter(Boolean))]
  const 上传 = await uploadSpecs(page, need, absDir)
  say('②b 上传本商品规格图:', JSON.stringify(上传))
  await sleep(1500)

  const records = []
  for (const color of picked) {
    const f = fileOf(color)
    if (!f) {
      // 没有图也要读右侧该颜色名下的值数：否则「缺文件」判据会被 值数=0 掩盖，
      // 只能落到「空图位」这个次要原因上（这里如实报 spec_file_missing）。
      const vals = await listValues(page, color)
      say(`   ✗ 没有「${color}」的图（该颜色名下值数 = ${vals.length}）`)
      records.push({ 颜色: color, 文件: null, 值数: vals.length, 实增: 0, 期望增加: vals.length, why: 'no_file' })
      continue
    }
    const nm = basename(f, '.jpg')
    const tC = Date.now()
    // ① 先把这张图**搜索**到列表最前面（否则它在最底部，滚过去又容易只露一半 → 小框点不中）
    const s = await searchInPanel(page, nm)
    const tSearch = Date.now() - tC
    // ② 先判断**形态**：这个颜色名下有几个规格值？
    //    · **1 个** → 两层规格（地毯「颜色分类 × 地毯尺寸」）：右侧就一个值 → 点中它 → 点图一次。
    //    · **N 个** → 单层规格（猫抓板这类「色-尺寸」挤成一列）：**不用碰右侧**，
    //                靠面板"点图后自动前进到下一个值"——同一张图给下一个值时要「先取消再选中」，
    //                所以第 1 个值点 1 次、其余每个点 2 次（自适应：没增加就补点一次）。
    const vals = await listValues(page, color)
    const n = vals.length
    const tVals = Date.now() - tC
    say(`   [${String(color).slice(0, 12)}] 搜图「${nm}」:${s.ok ? 'ok' : JSON.stringify(s)} | 该颜色名下值数 = ${n}`)
    if (!n) {
      say(`   ✗ 右侧找不到「${String(color).slice(0, 20)}」名下的值，跳过（不留错误映射）`)
      records.push({ 颜色: color, 文件: f, 值数: 0, 实增: 0, 期望增加: 0, why: 'no_values' })
      continue
    }
    const before = await filledCount(page)
    const 期望增加 = n
    const clicks = []
    if (n === 1) {
      const sel = await selectRightValue(page, color)
      if (!sel.ok) {
        say(`   ✗ 右侧选不中这个颜色，跳过：` + JSON.stringify(sel).slice(0, 90))
        records.push({ 颜色: color, 文件: f, 值数: n, 实增: 0, 期望增加: n, why: 'cannot_single_select', 目标集: vals })
        continue
      }
      clicks.push(await clickImageBox(page, nm, 1))
      // ★ 点完检测「面板已填 +1」：命中就立刻走（实测成功时 200ms 内就 +1），没命中才补点一次
      const inc1 = await waitUntil(async () => ((await filledCount(page)) > before ? true : null), {
        timeoutMs: 1200,
        intervalMs: 120,
        label: 'spec-filled+1',
      })
      if (!inc1.ok) {
        const firstClick = clicks[clicks.length - 1] || {}
        say(`     ↻ 点图后 1.2s 没 +1 → 补点一次（命中=${JSON.stringify(firstClick.命中)} 小框=${JSON.stringify(firstClick.小框 || '')}）`)
        clicks.push(await clickImageBox(page, nm, 1))
        await waitUntil(async () => ((await filledCount(page)) > before ? true : null), {
          timeoutMs: 2500,
          intervalMs: 150,
          label: 'spec-filled+1-retry',
        })
      }
    } else {
      for (let i = 0; i < n; i += 1) {
        const b2 = await filledCount(page)
        // ★ 同一张图连续给多个规格值：面板会自动前进到下一个值，而这张图在下一个值上
        //   是「已选中」状态 → 第 1 个值点 1 次，第 2 个起按实测规律**连点两次**（取消 + 选中）
        clicks.push(await clickImageBox(page, nm, i === 0 ? 1 : 2))
        const inc2 = await waitUntil(async () => ((await filledCount(page)) > b2 ? true : null), {
          timeoutMs: 1500,
          intervalMs: 120,
          label: 'spec-value-filled+1',
        })
        if (!inc2.ok) {
          say(`     ↻ 第 ${i + 1} 个值点图后没 +1 → 补点一次`)
          clicks.push(await clickImageBox(page, nm, 1))
          await waitUntil(async () => ((await filledCount(page)) > b2 ? true : null), {
            timeoutMs: 2500,
            intervalMs: 150,
            label: 'spec-value-filled+1-retry',
          })
        }
      }
    }
    const tClicks = Date.now() - tC
    const after = await filledCount(page)
    const tAfter = Date.now() - tC
    const dst = await drawerState(page)
    say(`     ⏱ 搜索 ${tSearch}ms | 读值 ${tVals - tSearch}ms | 选值+点图 ${tClicks - tVals}ms | 回读 ${tAfter - tClicks}ms | 抽屉读回 ${Date.now() - tC - tAfter}ms`)
    const 实增 = after - before
    say(`     点图后 面板已填 ${before} → ${after}（本组 ${期望增加} 个值，实增 ${实增}）`)
    // ★ 实增 < 期望 = 没填满 → 明确报出来，绝不假装成功
    //   （本轮 54 个槽只填 1 个、脚本却 exit 0 的假绿，就是因为没有这道检查）
    if (实增 < 期望增加) say(`   ⚠ 「${String(color).slice(0, 10)}」只填了 ${实增}/${期望增加} 个槽 —— 可重跑本步补齐`)
    say(`   ${String(color).slice(0, 12)} 填完:`, JSON.stringify({ 已有图: dst.已有图, 空图位: dst.空图位 }))
    records.push({
      颜色: color,
      文件: f,
      值数: n,
      面板已填前: before,
      面板已填后: after,
      实增,
      期望增加,
      点图: clicks,
      已有图: dst.已有图,
      空图位: dst.空图位,
    })
  }

  // ③ 点面板「确定」
  const okb = await fillPanelConfirm(page)
  let 确定 = { 文本: null, ok: false }
  if (okb.ok) {
    await page.mouse.move(okb.x, okb.y)
    await sleep(200)
    await page.mouse.click(okb.x, okb.y, { label: 'fill-panel-confirm' })
    say('③ 点面板「确定」:', okb.文本)
    await sleep(4000)
    确定 = { 文本: okb.文本, ok: true }
  } else {
    say('③ 确定按钮:', JSON.stringify(okb))
  }

  const fin = await drawerState(page)
  say('③ 结束状态:', JSON.stringify({ 图位总数: fin.图位总数, 已有图: fin.已有图, 空图位: fin.空图位 }))

  // ④ src 不重复核对（含懒加载触发）
  const slots = await readSpecSlots(page, COLORS)
  const 可填颜色 = records.filter((r) => r.值数 > 0)
  const 缺文件 = 可填颜色.filter((r) => !r.文件)
  const 未填满 = 可填颜色.filter((r) => r.实增 < r.期望增加)
  const 期望唯一src数 = 可填颜色.filter((r) => r.实增 > 0).length
  const dupSrc = (slots.串位 || []).length > 0 || (期望唯一src数 > 0 && slots.唯一src数 < 期望唯一src数)
  const 图位OK = slots.图位数 > 0 && slots.空图位 === 0 && slots.有图 > 0
  const coverageOK = 缺文件.length === 0 && 未填满.length === 0 && records.every((r) => r.文件 || r.值数 === 0)
  const ok = !!确定.ok && coverageOK && 图位OK && !dupSrc

  let why
  if (!确定.ok) why = 'panel_confirm_failed:' + (okb.why || 'unknown')
  else if (缺文件.length) why = 'spec_file_missing'
  else if (未填满.length) why = 'fill_incomplete'
  else if (!图位OK) why = 'spec_slots_empty'
  else if (dupSrc) why = 'spec_image_shared_between_colors'

  const result = {
    ok,
    filled: slots.有图,
    want: slots.图位数,
    dupSrc,
    counted: slots.有图,
    图位数: slots.图位数,
    有图: slots.有图,
    空图位: slots.空图位,
    加载成功: slots.加载成功,
    唯一src数: slots.唯一src数,
    期望唯一src数,
    src分布: slots.src分布,
    串位: (slots.串位 || []).slice(0, 10),
    每色: slots.每色,
    行: slots.行,
    面板: { 确定, 面板已填: records.map((r) => ({ 颜色: r.颜色, 前: r.面板已填前, 后: r.面板已填后 })) },
    颜色记录: records,
    上传,
    ...base,
    耗时ms: Date.now() - t0,
  }
  if (!ok) return { ...result, why }
  return result
}
