/**
 * 关掉残留的「图片空间」素材面板（ego 版，原 scripts/close_material_panel.js 移植）。
 *
 * 为什么需要：主图/详情/规格图都走同一个 `sucai-selector-ng` 面板；上一步没关干净时，
 * 下一步会误判"面板已开"，拿到的其实是上一步那个面板（实测详情步拿到主图面板 → 底部没有「确定」→ 上传入口不可用）。
 *
 * ego 没有 `frames()`：用 `document.querySelectorAll('iframe')` 的 src 判断面板是否存在，
 * 关闭按钮在主页面框架里（真实鼠标点击），最后用 Escape 兜底并复核。
 * 导出 `closeMaterialPanel(page)`，由 run_listing_tb.mjs 在图片类步骤前后调用。
 */
import { sleep, frameEvalShim } from '../lib/tb_ego.mjs'

/** 页面上是否还有 sucai-selector-ng 面板（含 iframe 或面板容器）。 */
const panelCount = (page) => page.evaluate(() => {
  // ★ 只算「真面板」：3:4 区有一个内联小 iframe（select-image-page）也带同样 src，尺寸很小、不是面板
  const frames = [...document.querySelectorAll('iframe')].filter((f) => {
    if (!/sucai-selector-ng/.test(f.getAttribute('src') || '')) return false
    const r = f.getBoundingClientRect()
    return r.width >= 600 && r.height >= 400
  })
  const containers = [...document.querySelectorAll('[class*=sucai-selector]')].filter((e) => e.offsetParent)
  return Math.max(frames.length, containers.length)
})

/**
 * 关闭残留素材面板。
 * @param page - ego page。
 * @param options - `rounds` 最多点几轮关闭按钮。
 * @returns `{ ok, before, after, closed, why? }`。
 */
export async function closeMaterialPanel(page, { rounds = 4 } = {}) {
  const before = await panelCount(page).catch(() => 0)
  if (!before) return { ok: true, before, after: 0, closed: 0 }

  let closed = 0
  for (let i = 0; i < rounds; i += 1) {
    const c = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const b = Array.from(document.querySelectorAll('button')).filter(vis).find((x) => /^(取消|关闭)/.test(clean(x.innerText)))
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 文本: clean(b.innerText) }
    }).catch(() => null)
    if (!c) break
    await page.mouse.click(c.x, c.y)
    closed += 1
    await sleep(2000)
    if ((await panelCount(page).catch(() => 0)) === 0) break
  }

  // ★ 关闭按钮在跨域 iframe 里（主文档的 取消/关闭 找得到但点不到面板）→ 用 CDP 在子 frame 里找并真实点
  if (await panelCount(page).catch(() => 0)) {
    const g = await page
      .evaluate(() => {
        const f = [...document.querySelectorAll('iframe')].find((x) => /sucai-selector-ng/.test(String(x.getAttribute('src') || '')))
        if (!f) return null
        const r = f.getBoundingClientRect()
        return { left: r.left, top: r.top }
      })
      .catch(() => null)
    const hit = await frameEvalShim(page, 'sucai-selector-ng', () => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const cands = [...document.querySelectorAll('button,a,span,div')]
        .filter(vis)
        .filter((e) => {
          const t = clean(e.innerText)
          return t === '取消' || t === '关闭' || t === '×' || /^关闭/.test(t)
        })
      const el = cands[cands.length - 1]
      if (!el) return { ok: false, why: 'no_close_btn' }
      const r = el.getBoundingClientRect()
      return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 文本: clean(el.innerText).slice(0, 8) }
    }).catch((e) => ({ ok: false, why: String((e && e.message) || e) }))
    if (g && hit && hit.ok) {
      await page.mouse.click(g.left + hit.x, g.top + hit.y).catch(() => {})
      closed += 1
      await sleep(2000)
    }
  }
  if (await panelCount(page).catch(() => 0)) {
    await page.keyboard.press('Escape').catch(() => {})
    await sleep(1800)
  }
  // ★ 有些图片空间面板没有关闭按钮（needClose=false）→ 点遮罩外侧常常能关（视频弹窗已证实）
  if (await panelCount(page).catch(() => 0)) {
    await page.mouse.click(20, 300).catch(() => {})
    await sleep(1500)
  }
  const after = await panelCount(page).catch(() => 0)
  return after === 0
    ? { ok: true, before, after, closed }
    : { ok: false, before, after, closed, why: 'panel_still_open' }
}

export default { closeMaterialPanel }
