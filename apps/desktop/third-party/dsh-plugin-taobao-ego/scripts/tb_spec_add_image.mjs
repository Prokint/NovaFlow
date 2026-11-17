/**
 * 规格区「添加图片」开槽 / 最后一击「确认创建」（ego 版）—— 移植自
 *   taobao-product-listing\scripts\tb_spec_add_image.js
 *
 * 原脚本的用途（playbook §7.5）：
 *   在「编辑规格」抽屉里勾上「添加图片」（给颜色行开规格图槽），必要时点「确认创建」。
 *   `tb_fill_spec_images.js` 负责往这些槽里填图；本步只负责开槽 + 收尾确认。
 *
 * 与 Playwright/CDP 原版的差异（只换执行层，不改硬规则）：
 *   - 本步**完全不碰图片空间 iframe**（按钮/勾选框都在主文档）→ 没有 frames→contentDocument 的替换；
 *     只是把原版 `page.mouse.move/click`（本来就是真实鼠标）原样保留，并加上 ego 的 `{ label }` 参数。
 *   - 原版用 `page.screenshot()` 留证（ego 没有截图接口）→ 改成打印状态 JSON。
 *   - 原版打开抽屉后仍拿**打开前**的旧状态决定要不要点勾选框；这里打开后重新读回再决定。
 *   - 原版读 `添加图片已勾` 只认「颜色分类」那一行；换类目/动态维度时会读回 null → 又点一次把已勾的取消。
 *     这里额外输出 `勾选维度`（所有带「添加图片」勾选框的维度行及其勾选态），**读回判据仍是 input.checked**。
 *   - 原版点「确认创建」是无条件的；这里若「添加图片」没勾上就**不点**（避免把已有规格图连坐清掉，
 *     原脚本自己也有「取消…会导致已上传的颜色分类图丢失」的警告弹窗）。
 *
 * 仍依赖的硬规则（原文实测）：
 *   1. 勾选框必须勾到**带「添加图片」的那一行**；有 4 个维度（图案/材质/面层工艺/颜色分类）时
 *      取第一个会勾到「图案」（用户 2026-10-10 截图指出）→ 动态判断该勾哪个维度：
 *      规格图的键 = product.json 的 colors → 取「其值里包含颜色名最多」的维度行，匹配不到回退「颜色分类」。
 *   2. 勾选态**优先读 `input.checked`**（只判 wrapper class 会读回 null → 主流程以为没勾 → 又点一次 → 取消）。
 *   3. 点完若弹出「取消…会导致已上传的颜色分类图丢失」→ 说明它**本来就是勾着**、被点掉了
 *      → 立刻按「取消」保住已有规格图，并如实报出来（别让 54 个槽的图白丢）。
 *   4. `--confirm`（这里 `{ confirm:true }`）才点「确认创建」；默认只勾选。
 *   5. 不要对规格抽屉按 Escape（会把正在用的抽屉一起关掉）。
 *
 * 导出（由 run_listing_tb.mjs 在同一 ego 进程内顺序调用）：
 *   `specAddImage(page, { confirm })` → `{ ok, slots, confirmed, ...读回 }`
 *   - `slots` = 抽屉里 `.sell-color-option-image-upload` 图位数（收尾读回，抽屉关了就用确认前的读数）
 *   - `confirmed`：`confirm:true` 时才点「确认创建」，为 true/false；未点时为 null
 *   - 可选 `colors`（数组）用于动态维度打分；未传时读 `globalThis.__TB_CFG.specColors`
 *     （数组或 `,` 分隔字符串），都没有就回退原脚本的「颜色分类」。
 *   不写 main/CLI，不打印 JSON 行（由编排层负责）。
 */
import { say, sleep } from '../lib/tb_ego.mjs'

/**
 * ego 子进程不继承自定义环境变量 → 配置只从 `globalThis.__TB_CFG` 读（与 tb_enter_form.mjs 的 INLINE 同源）。
 * ★ 每次调用时现读：本模块可能被 run_listing_tb.mjs **静态 import**，那一刻 `__TB_CFG` 还没赋值。
 */
const tbCfg = () => (typeof globalThis !== 'undefined' && globalThis.__TB_CFG) || {}
const cfgVal = (key, dflt) => {
  const c = tbCfg()
  return c[key] === undefined || c[key] === null || c[key] === '' ? dflt : c[key]
}

/** 把 CFG 里的颜色写成数组（数组直接用，字符串按 `,` / `，` / `、` / `|` 拆）。 */
function colorsFromCfg() {
  const v = cfgVal('specColors', null)
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string' && v.trim()) return v.split(/[,，、|]/).map((s) => s.trim()).filter(Boolean)
  return []
}

/**
 * 抽屉 + 勾选态读回（原版 `state`）。
 * 判据沿用：抽屉 = `.sku-decouple-drawer-container` 可见；勾选 = **input.checked** 优先。
 */
const drawerState = (page) =>
  page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const panes = [...document.querySelectorAll('.next-dialog,.next-drawer,[class*=drawer]')].filter(vis)
      // ★ 勾选框必须勾到「颜色分类」那一行：这个类目有 4 个维度（图案/材质/面层工艺/颜色分类），
      //   取第一个「添加图片」会勾到「图案」（用户 2026-10-10 截图指出）
      const paneEl =
        panes
          .slice()
          .sort((a, b) => clean(a.innerText).length - clean(b.innerText).length)
          .find((e) => /添加图片|颜色分类/.test(clean(e.innerText))) || null
      const rows = paneEl
        ? [...paneEl.querySelectorAll('div')]
            .filter(vis)
            // ★ 颜色维度名各类目不同：有叫「颜色分类」的，也有就叫「颜色」的（实测 2026-11-17 文化墙贴 201884208）；
            //   以前硬编码 `^颜色分类` → 找不到行 → 勾选框点不动（报 add_image_not_checked）
            .filter((e) => /^(颜色分类|颜色|色)\s*[（(]/.test(clean(e.innerText)) && clean(e.innerText).length < 40)
        : []
      rows.sort((a, b) => a.innerText.length - b.innerText.length)
      const findCb = (row) => {
        let p = row
        for (let k = 0; k < 4 && p; k += 1) {
          const direct = [...p.querySelectorAll('.next-checkbox-wrapper,[class*=checkbox]')]
            .filter(vis)
            .find((e) => /添加图片/.test(clean(e.innerText)))
          if (direct) return direct
          // ★ 新版 UI：勾选框本身没有文字（文字「添加图片」在旁边 label）→ 按 label 找最近的勾选/开关
          const lbl = [...p.querySelectorAll('div,span,label')].filter(vis).find((e) => clean(e.innerText) === '添加图片')
          if (lbl) {
            let q = lbl.parentElement
            for (let j = 0; j < 3 && q; j += 1) {
              const cands = [...q.querySelectorAll('.next-checkbox-wrapper,[class*=checkbox],[class*=switch],[role=switch]')].filter(vis)
              if (cands.length) return cands[0]
              q = q.parentElement
            }
          }
          p = p.parentElement
        }
        return null
      }
      // ★ 勾选态**优先读 input.checked**：原来只判 wrapper 的 class 里有没有 checked，
      //   实测读回 null（找不到/className 不含 checked）→ 主流程以为"没勾"→ 又点一次 → **把已勾的取消掉**
      const readCb = (cb) => {
        const inp = cb.querySelector('input')
        if (inp) return !!inp.checked
        const aria = cb.getAttribute && cb.getAttribute('aria-checked')
        if (aria != null) return aria === 'true'
        return /checked|selected|active/i.test(String(cb.className))
      }
      const box = rows.length ? findCb(rows[0]) : null
      let 添加图片已勾 = box ? readCb(box) : null
      // 扩展读回：所有带「添加图片」勾选框的维度行（动态维度换类目时也能看到真实勾选态）
      const 勾选维度 = []
      if (paneEl) {
        const heads = [...paneEl.querySelectorAll('div,span')]
          .filter(vis)
          .filter((e) => /^[^()（）]{1,14}\s*[（(]\d+[)）]\s*$/.test(clean(e.innerText)))
        for (const h of heads) {
          const cb = findCb(h)
          if (cb) 勾选维度.push({ 维度: clean(h.innerText).slice(0, 24), 已勾: readCb(cb) })
        }
      }
      // ★ 兜底：单行读回拿不到时，用「勾选维度」里颜色那行的勾选态（新版 UI 勾选框和 label 不在同一层）
      if (添加图片已勾 === null && 勾选维度.length) {
        const colorRow =
          勾选维度.find((v) => /^(颜色分类|颜色|色)\s*[（(]/.test(String(v.维度))) || 勾选维度[勾选维度.length - 1]
        添加图片已勾 = colorRow ? !!colorRow.已勾 : null
      }
      const d = [...document.querySelectorAll('.sku-decouple-drawer-container')].filter(vis)[0]
      const slots = d
        ? [...d.querySelectorAll('.sell-color-option-image-upload')].filter(vis).length
        : 0
      return {
        抽屉在: !!d,
        抽屉文本: paneEl ? clean(paneEl.innerText).slice(0, 200) : null,
        添加图片已勾,
        勾选维度,
        有警告弹窗: [...document.querySelectorAll('.next-dialog')]
          .filter(vis)
          .map((e) => clean(e.innerText).slice(0, 90))
          .filter((t) => /清空|警告|确认|切换|丢失/.test(t)),
        SKU表行数: [...document.querySelectorAll('tbody tr')].filter(vis).length,
        规格区: (clean(document.body.innerText).match(/SKU模式[^\n]{0,50}/) || [])[0] || null,
        图格数: document.querySelectorAll('.sell-sku-cell-image').length,
        规格图位数: slots,
      }
    })
    .catch(() => ({ 抽屉在: false, 添加图片已勾: null, 勾选维度: [], 有警告弹窗: [], SKU表行数: 0, 规格区: null, 图格数: 0, 规格图位数: 0 }))

/** 按可见文本点元素（主文档）：先算中心坐标，再真实鼠标点击。 */
async function clickText(page, text) {
  const c = await page
    .evaluate((t) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const pool = [...document.querySelectorAll('button,a,span,div,label,li')].filter(vis)
      const hit = pool.filter((e) => clean(e.innerText) === t)
      if (!hit.length) return null
      const el = hit.filter((e) => !hit.some((o) => o !== e && e.contains(o)))[0]
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase() }
    }, text)
    .catch(() => null)
  if (!c) return { ok: false, why: 'no_match', text }
  await page.mouse.move(c.x, c.y)
  await sleep(250)
  await page.mouse.click(c.x, c.y, { label: text })
  return { ok: true, ...c }
}

/**
 * ② 动态判断该勾哪个维度（原版同一套打分）：
 * 规格图的键 = colors → 遍历抽屉里所有「名称 (N)」维度行，取"其值里包含颜色名最多"的那一行；
 * 匹配不到再回退「颜色分类」。
 * @returns `{ ok, 维度, 命中颜色数, 候选维度, x, y }`（坐标是主文档视口坐标）
 */
const pickCheckbox = (page, colors) =>
  page
    .evaluate((colors) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const drawer = document.querySelector('.sku-decouple-drawer-container') || document
      const heads = [...drawer.querySelectorAll('div,span')]
        .filter(vis)
        .filter((e) => /^[^()（）]{1,14}\s*[（(]\d+[)）]\s*$/.test(clean(e.innerText)))
      let best = null
      let bestScore = 0
      for (const h of heads) {
        let scope = h.parentElement
        for (let k = 0; k < 3 && scope; k += 1) {
          if (scope.querySelectorAll('input').length > 1) break
          scope = scope.parentElement
        }
        const txts = [...(scope || h).querySelectorAll('input')].map((i) => String(i.value || ''))
        if (!txts.length) continue
        const score = colors.filter((c) => txts.some((tx) => tx.includes(c))).length
        if (score > bestScore) {
          best = { h, 名称: clean(h.innerText).slice(0, 20), 分数: score, 值数: txts.length }
          bestScore = score
        }
      }
      let rowEl = best ? best.h : null
      if (!rowEl) {
        const rows = [...drawer.querySelectorAll('div')]
          .filter(vis)
          // ★ 同 drawerState：颜色维度可能叫「颜色分类」也可能就叫「颜色」（2026-11-17 文化墙贴）
          .filter((e) => /^(颜色分类|颜色|色)\s*[（(]/.test(clean(e.innerText)) && clean(e.innerText).length < 40)
        rows.sort((a, b) => a.innerText.length - b.innerText.length)
        rowEl = rows[0] || null
      }
      if (!rowEl) return { ok: false, why: 'no_row' }
      let p = rowEl
      for (let k = 0; k < 4 && p; k += 1) {
        const cb = [...p.querySelectorAll('.next-checkbox-wrapper,[class*=checkbox]')]
          .filter(vis)
          .find((e) => /添加图片/.test(clean(e.innerText)))
        if (cb) {
          const r = cb.getBoundingClientRect()
          return {
            ok: true,
            维度: best ? best.名称 : '颜色分类(回退)',
            命中颜色数: best ? best.分数 : null,
            候选维度: heads.length,
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
          }
        }
        // ★ 新版 UI 兜底：文字「添加图片」旁边的勾选/开关
        const lbl = [...p.querySelectorAll('div,span,label')].filter(vis).find((e) => clean(e.innerText) === '添加图片')
        if (lbl) {
          let q = lbl.parentElement
          for (let j = 0; j < 3 && q; j += 1) {
            const c2 = [...q.querySelectorAll('.next-checkbox-wrapper,[class*=checkbox],[class*=switch],[role=switch]')].filter(vis)
            if (c2.length) {
              const r = c2[0].getBoundingClientRect()
              return {
                ok: true,
                维度: best ? best.名称 : '颜色分类(回退)',
                命中颜色数: best ? best.分数 : null,
                候选维度: heads.length,
                方式: 'label_near',
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2),
              }
            }
            q = q.parentElement
          }
        }
        p = p.parentElement
      }
      // ★ 兜底：整个抽屉里找带「添加图片」字样的勾选框（单维度时就是它；多维度时优先颜色分类行）
      const any = [...drawer.querySelectorAll('.next-checkbox-wrapper,[class*=checkbox]')]
        .filter(vis)
        .find((e) => /添加图片/.test(clean(e.innerText)))
      if (any) {
        const r = any.getBoundingClientRect()
        return {
          ok: true,
          维度: best ? best.名称 : '抽屉兜底',
          命中颜色数: best ? best.分数 : null,
          候选维度: heads.length,
          方式: 'drawer_fallback',
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
        }
      }
      // ★ 最后兜底：这个 UI 里「添加图片」可能既不是 checkbox 也不是 switch，而是**可点击的文字**
      //   （实测 2026-11-17 文化墙贴：抽屉里只有 `颜色(2) 添加图片 排序` 这种文本行）→ 直接点这段文字
      const lblAny = [...drawer.querySelectorAll('div,span,label,a')]
        .filter(vis)
        .filter((e) => clean(e.innerText) === '添加图片')
        .map((e) => ({ e, r: e.getBoundingClientRect() }))
        .sort((a, b) => a.r.top - b.r.top)[0]
      if (lblAny) {
        return {
          ok: true,
          维度: best ? best.名称 : '文字控件兜底',
          命中颜色数: best ? best.分数 : null,
          候选维度: heads.length,
          方式: 'label_text',
          x: Math.round(lblAny.r.left + lblAny.r.width / 2),
          y: Math.round(lblAny.r.top + lblAny.r.height / 2),
        }
      }
      return { ok: false, why: 'no_checkbox', 维度: best ? best.名称 : null }
    }, colors)
    .catch((e) => ({ ok: false, why: String((e && e.message) || e) }))

/** 点最后一个可见 `.next-dialog` 里的「取消」（保住已上传的规格图）。 */
async function cancelLossDialog(page) {
  const cx = await page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const dlgs = [...document.querySelectorAll('.next-dialog')].filter(vis)
      const d = dlgs[dlgs.length - 1]
      if (!d) return null
      const b = [...d.querySelectorAll('button')].filter(vis).find((x) => clean(x.innerText) === '取消')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })
    .catch(() => null)
  if (!cx) return { ok: false, why: 'no_cancel' }
  await page.mouse.move(cx.x, cx.y)
  await sleep(200)
  await page.mouse.click(cx.x, cx.y, { label: 'cancel-keep-spec-images' })
  return { ok: true, ...cx }
}

/**
 * 规格区「添加图片」开槽 / 确认创建。
 * @param page - ego page（已在 publish.htm 发布表单页）
 * @param options.confirm - true 才点「确认创建」
 * @param options.colors - 可选：规格值颜色集合（用于动态选维度）；缺省读 `__TB_CFG.specColors`
 * @returns `{ ok, slots, confirmed, 添加图片已勾, 抽屉在, 维度, 保留现状, 警告, 状态 }`
 */
export async function specAddImage(page, options = {}) {
  try {
    return await specAddImageImpl(page, options)
  } catch (e) {
    // 编排层约定：失败也返回对象，绝不把异常抛给 run_listing_tb
    return {
      ok: false,
      why: 'exception:' + String((e && e.message) || e),
      slots: 0,
      counted: 0,
      confirmed: options.confirm ? false : null,
    }
  }
}

/** specAddImage 的实际实现（异常统一由上面的 export 包住）。 */

/**
 * 是否为「内联销售属性」形态：页面上没有编辑规格抽屉，但销售属性行里直接有「添加图片」勾选框 / 图位。
 * ★ 只有这个分支用新逻辑；抽屉形态一律走原来的流程（2026-11-17 用户口径）。
 */
async function isInlineMode(page) {
  return page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const hasDrawer = [...document.querySelectorAll('.sku-decouple-drawer-container')].filter(vis).length > 0
      const slots = [...document.querySelectorAll('[class*=option-image]')].filter(vis).length
      const inlineCb = [...document.querySelectorAll('label,[class*=checkbox-wrapper]')]
        .filter(vis)
        .some((e) => /next-checkbox/.test(String(e.className || '')) && /添加图片/.test(clean((e.parentElement || e).innerText)))
      return !hasDrawer && (slots > 0 || inlineCb)
    })
    .catch(() => false)
}

/** 内联形态专用：勾「添加图片」→ 图位出现即算成功；confirm 时「有图图位已存在」即算完成。 */
async function specAddImageInline(page, { confirm = false, colors, t0 = Date.now() } = {}) {
  const probe = () =>
    page
      .evaluate(() => {
        const vis = (e) => {
          if (!e) return false
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const slots = [...document.querySelectorAll('[class*=option-image]')].filter(vis)
        const filled = slots.filter((e) => {
          if (e.querySelector('img')) return true
          const bg = (e.ownerDocument.defaultView || window).getComputedStyle(e).backgroundImage || ''
          return bg && bg !== 'none'
        }).length
        return { slots: slots.length, filled }
      })
      .catch(() => ({ slots: 0, filled: 0 }))

  let st = await probe()
  say('内联分支 起始:', JSON.stringify(st))

  // confirm 阶段：页面已有「带图」图位 → 说明填充早已生效（内联没有「确认创建」按钮）
  if (confirm) {
    if (st.filled > 0 || st.slots > 0) {
      say('内联分支 confirm：已有图位/已带图 → 视为已完成（不点任何按钮）')
      return { ok: true, slots: st.slots, counted: st.filled || st.slots, confirmed: true, 已存在: st.filled > 0, 添加图片已勾: true, 抽屉在: false, 维度: '内联销售属性', 保留现状: false, 警告: [], 勾选维度: [], 内联: true, 耗时ms: Date.now() - t0 }
    }
    return { ok: false, why: 'confirm_failed', slots: 0, counted: 0, confirmed: false, 已存在: false, 添加图片已勾: null, 抽屉在: false, 维度: '内联销售属性', 内联: true, 耗时ms: Date.now() - t0 }
  }

  // 开图位阶段：已有图位 → 说明本来就开着，绝不再点（点了会关掉并弹「会丢失已上传图」）
  if (st.slots > 0) {
    say('内联分支：页面已有', st.slots, '个图位 → 视为「添加图片」已开启，不点击')
    return { ok: true, slots: st.slots, counted: st.slots, confirmed: null, 添加图片已勾: true, 抽屉在: false, 维度: '内联销售属性', 保留现状: false, 已存在: true, 警告: [], 勾选维度: [], 内联: true, 耗时ms: Date.now() - t0 }
  }

  // 没有图位 → 点一次「添加图片」（真实鼠标；先把勾选框滚进视口）
  const pt = await page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const lbl = [...document.querySelectorAll('label,span,div')].filter(vis).find((e) => clean(e.innerText) === '添加图片')
      // ★ 优先点「勾选框方框」本身：label.next-checkbox-wrapper（文字只是它的兄弟标签）
      const wrappers = [...document.querySelectorAll('label,[class*=next-checkbox-wrapper]')]
        .filter(vis)
        .filter((e) => /next-checkbox/.test(String(e.className || '')))
      const row = lbl && (lbl.closest('[class*=props],[class*=field],[class*=item]') || lbl.parentElement)
      const cb =
        (row && [...row.querySelectorAll('label,[class*=next-checkbox-wrapper]')].filter(vis).find((e) => /next-checkbox/.test(String(e.className || ''))) ||
        wrappers[0] ||
        (lbl && lbl.previousElementSibling))
      const el = cb && vis(cb) ? cb : lbl
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight
      return { x: Math.round(Math.min(Math.max(r.left + r.width / 2, 5), vw - 5)), y: Math.round(Math.min(Math.max(r.top + r.height / 2, 5), vh - 5)) }
    })
    .catch(() => null)
  if (!pt) return { ok: false, why: 'no_inline_checkbox', slots: 0, counted: 0, 添加图片已勾: null, 抽屉在: false, 内联: true, 耗时ms: Date.now() - t0 }
  say('内联分支：点「添加图片」方框一次 →', JSON.stringify(pt))
  await page.mouse.move(pt.x, pt.y).catch(() => {})
  await sleep(200)
  await page.mouse.click(pt.x, pt.y, { label: '内联勾选添加图片' }).catch(() => {})
  // ★ 点一次就够（**绝不重复点**，否则会把刚勾上的又点掉）：之后只轮询等图位出现
  for (let i = 0; i < 12 && st.slots === 0; i += 1) {
    await sleep(800)
    st = await probe()
  }
  say('内联分支 点击后（轮询结束）:', JSON.stringify(st))
  const ok = st.slots > 0
  return { ok, why: ok ? undefined : 'add_image_not_checked', slots: st.slots, counted: st.slots, confirmed: null, 添加图片已勾: ok ? true : null, 抽屉在: false, 维度: '内联销售属性', 保留现状: false, 已存在: st.filled > 0, 警告: [], 勾选维度: [], 内联: true, 耗时ms: Date.now() - t0 }
}

async function specAddImageImpl(page, { confirm = false, colors } = {}) {
  const t0 = Date.now()

  // ★★ 分支隔离（用户 2026-11-17 口径）：**检测到内联形态才走新逻辑，抽屉形态原样不动**。
  const inline = await isInlineMode(page).catch(() => false)
  if (inline) return await specAddImageInline(page, { confirm, colors, t0 })
  const COLORS = Array.isArray(colors) && colors.length ? colors.map(String) : colorsFromCfg()
  let st = await drawerState(page)
  say('起始:', JSON.stringify({ 抽屉在: st.抽屉在, 添加图片已勾: st.添加图片已勾, SKU表行数: st.SKU表行数, 规格区: st.规格区, 规格图位数: st.规格图位数 }))

  // ★ 详情图那步会把页面停在「图文描述」tab，而 SKU 区/「编辑规格」在「销售信息」tab。
  //   抽屉找不到时先切「销售信息」再试一次（实测 2026-11-17 一次性桌布 50022531：规格区读回 null → no_drawer）
  if (!st.抽屉在 && (st.规格区 == null || st.SKU表行数 > 0)) {
    const switched = await clickText(page, '销售信息').catch(() => ({ ok: false }))
    if (switched && switched.ok) {
      say('①a 切到「销售信息」tab:', JSON.stringify(switched))
      await sleep(2000)
      st = await drawerState(page)
    }
  }

  if (!st.抽屉在) {
    // ★ 抽屉入口文案各类目不同：常见「编辑规格」，也有「按规格单独设置」（实测 2026-11-17 一次性桌布 50022531）
    let opened = await clickText(page, '编辑规格')
    if (!opened || !opened.ok) opened = await clickText(page, '按规格单独设置')
    say('① 打开抽屉:', JSON.stringify(opened))
    await sleep(5000)
    st = await drawerState(page)
    if (!st.抽屉在) {
      return { ok: false, why: 'no_drawer', slots: 0, counted: 0, confirmed: confirm ? false : null, 添加图片已勾: null, 抽屉在: false, 状态: st, 耗时ms: Date.now() - t0 }
    }
  }

  let 维度 = null
  let 保留现状 = false
  let 勾选 = st.添加图片已勾 === true
  if (st.添加图片已勾 !== true) {
    const cbPos = await pickCheckbox(page, COLORS)
    if (cbPos && cbPos.ok) {
      await page.mouse.move(cbPos.x, cbPos.y)
      await sleep(250)
      await page.mouse.click(cbPos.x, cbPos.y, { label: '勾选添加图片' })
      维度 = cbPos.维度
    }
    say('② 勾「添加图片」→ 维度:', JSON.stringify(cbPos))
    await sleep(2500)
    st = await drawerState(page)
    say('   勾后:', JSON.stringify({ 添加图片已勾: st.添加图片已勾, 有警告弹窗: st.有警告弹窗, 勾选维度: st.勾选维度 }))

    // ★ 点完若弹出「取消…会导致已上传的颜色分类图丢失」→ 说明它**本来就是勾着**、被我们点掉了
    //   → 立刻按**取消**保住已有的规格图，并如实报出来（别让 54 个槽的图白丢）。
    const warn = (st.有警告弹窗 || []).find((t) => /丢失/.test(t))
    if (warn) {
      const cx = await cancelLossDialog(page)
      if (cx.ok) await sleep(2200)
      say(
        cx.ok
          ? '   ⚠ 点「添加图片」弹出了「会丢失已上传规格图」的确认 → 已按「取消」保住现状（它本来就是勾着的）'
          : '   ★ 弹出了「会丢失已上传规格图」的确认，但没找到「取消」按钮 → 请人工确认后再继续',
      )
      保留现状 = true
      st = await drawerState(page)
      say('   取消后:', JSON.stringify({ 添加图片已勾: st.添加图片已勾, 有警告弹窗: st.有警告弹窗 }))
    }
    // ★ 成功判据放宽：勾选框读不回来（新版 UI 常读不到 checked），但**规格图槽位已经出现**就算成功。
    //   实测 2026-11-17 文化墙贴：抽屉里是 `颜色(2) 添加图片 排序` 文字控件，点了有槽位、但 input.checked 读不到
    勾选 = st.添加图片已勾 === true || st.规格图位数 > 0
    if (勾选 && st.添加图片已勾 !== true) say('   ℹ 勾选框读不回，但规格图位数 =', st.规格图位数, '→ 视为已开启')
  } else {
    say('② 「添加图片」已是勾选状态')
    勾选 = true
  }

  const slotsBefore = st.规格图位数
  let confirmed = confirm ? false : null
  let 已存在 = false
  if (confirm) {
    if (!勾选) {
      // 原版会直接点「确认创建」；这里不点 —— 没勾「添加图片」时点确认创建可能把已有规格图连坐清掉
      say('③ ★ 「添加图片」未勾上 → 不点「确认创建」（防止把已有规格图清掉）')
    } else {
      const clicked = await clickText(page, '确认创建')
      say('③ 点「确认创建」:', JSON.stringify(clicked))
      if (clicked.ok) {
        await sleep(7000)
        confirmed = true
      } else {
        st = await drawerState(page)
        if (st.规格图位数 > 0) {
          confirmed = true
          已存在 = true
          say('   没找到「确认创建」但图位已在 → 视为已创建（幂等，不重复点）')
        }
      }
      st = await drawerState(page)
      say(
        '   创建后:',
        JSON.stringify({ 抽屉在: st.抽屉在, 规格图位数: st.规格图位数, 图格数: st.图格数, 有警告弹窗: st.有警告弹窗 }),
      )
    }
  } else {
    say('③ （未加 confirm，没点「确认创建」）')
  }

  const slots = st.规格图位数 > 0 ? st.规格图位数 : slotsBefore
  const ok = confirm ? 勾选 && confirmed === true : 勾选
  const why = !勾选 ? 'add_image_not_checked' : !ok && confirm ? 'confirm_failed' : undefined
  const result = {
    ok,
    slots,
    counted: slots,
    confirmed,
    添加图片已勾: 勾选,
    抽屉在: st.抽屉在,
    维度,
    保留现状,
    已存在,
    警告: st.有警告弹窗,
    勾选维度: st.勾选维度,
    状态: st,
    耗时ms: Date.now() - t0,
  }
  if (!ok) return { ...result, why }
  return result
}
