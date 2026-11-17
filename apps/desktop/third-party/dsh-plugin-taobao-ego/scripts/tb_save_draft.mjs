/**
 * 点「保存草稿」并读回（ego 版，原 scripts/tb_save_draft.js 1:1 移植）。
 *
 * ⚠️ 本技能只禁「提交宝贝信息」；「保存草稿」是安全的，自动化跑完就该点一下（防止刷新/关页丢内容）。
 * 移植差异：CDP → connectSpace（由调用方传入 page）；鼠标点击保留 page.mouse.move + click 的真实路径。
 * 导出 `saveDraft(page)`，由 run_listing_tb.mjs 在同一 ego 进程内调用。
 */
import { sleep } from '../lib/tb_ego.mjs'

/** 页面状态（最后保存时间 / 保存提示 / 标题 / 是否有 SKU 表）。 */
const readState = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const vis = (e) => {
    if (!e) return false
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const t = clean(document.body.innerText)
  return {
    最后保存: (t.match(/最后保存于[^\n]{0,26}/) || [])[0] || null,
    保存提示: (t.match(/草稿保存成功|保存成功[^\n]{0,20}/) || [])[0] || null,
    标题: (() => {
      const i = Array.from(document.querySelectorAll('input')).filter(vis).find((x) => (x.getAttribute('placeholder') || '').includes('30个汉字'))
      return i ? i.value : null
    })(),
    有SKU表: Array.from(document.querySelectorAll('table')).filter(vis).length > 0,
  }
}

/**
 * 关掉残留弹窗（「草稿箱最大保存 10 条草稿…」会叠好几个挡住保存按钮）。
 * @returns 关掉的弹窗数。
 */
const closeDialogs = (page) =>
  page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const vis = (e) => {
      if (!e) return false
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const dlgs = Array.from(document.querySelectorAll('.next-dialog,.next-overlay-inner,[class*=dialog],[class*=Dialog]')).filter(vis)
    for (const d of dlgs) {
      const b = Array.from(d.querySelectorAll('button')).filter(vis).find((x) => /^(确定|知道了|关闭|好的)/.test(clean(x.innerText)))
      if (b) {
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 按钮: clean(b.innerText), 弹窗: clean(d.innerText).slice(0, 44) }
      }
    }
    return null
  })

/**
 * 保存草稿。
 * @param page - ego page（发布表单页）。
 * @returns `{ ok, 状态, 提示节点, 出错项, 错误数, 上限拦截, 点击轮次 }`。
 */
export async function saveDraft(page) {
  const before = await page.evaluate(readState)

  // ⓪ 先关掉残留弹窗
  let closed = 0
  for (let i = 0; i < 6; i += 1) {
    const c = await closeDialogs(page).catch(() => null)
    if (!c) break
    await page.mouse.move(c.x, c.y)
    await sleep(200)
    await page.mouse.click(c.x, c.y)
    closed += 1
    await sleep(1500)
  }

  const findSaveBtn = () => page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const vis = (e) => {
      if (!e) return false
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const b = Array.from(document.querySelectorAll('button')).filter(vis).find((x) => /保存草稿/.test(clean(x.innerText)))
    if (!b) return null
    b.scrollIntoView({ block: 'center' })
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 文本: clean(b.innerText), disabled: !!b.disabled }
  })
  const readSaved = () => page.evaluate(() => {
    const t = (document.body.innerText || '').replace(/\s+/g, ' ')
    return (t.match(/最后保存于[^\n]{0,20}/) || [])[0] || null
  })

  // ★ 坐标会因懒加载回流而过期 → 重取坐标、点、轮询「最后保存于…」，最多 4 轮
  let clicked = { ok: false }
  let round = 0
  for (let k = 0; k < 4; k += 1) {
    const b = await findSaveBtn()
    if (!b) break
    if (b.disabled) { await sleep(3000); continue }
    await page.mouse.move(b.x, b.y)
    await sleep(300)
    await page.mouse.click(b.x, b.y)
    clicked = { ok: true, 文本: b.文本, x: b.x, y: b.y }
    round = k + 1
    // 点完常弹「草稿箱…」提示框 → 立刻「确定」关掉，否则会叠住下一次点击 / 盖住后续步骤
    const dlg = await closeDialogs(page).catch(() => null)
    if (dlg) {
      await page.mouse.move(dlg.x, dlg.y)
      await sleep(200)
      await page.mouse.click(dlg.x, dlg.y)
      closed += 1
      await sleep(1200)
    }
    let got = null
    for (let w = 0; w < 8 && !got; w += 1) {
      await sleep(1500)
      got = await readSaved()
    }
    if (got) break
    await page.evaluate(() => {
      const b2 = Array.from(document.querySelectorAll('button')).find((x) => /保存草稿/.test(x.innerText || ''))
      if (b2) b2.click()
    }).catch(() => {})
    await sleep(3000)
    const afterFallback = await readSaved()
    if (afterFallback) break
  }

  // 点击后立刻抓提示 / toast / 报错
  await sleep(2000)
  const toast = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const t = clean(document.body.innerText)
    const nodes = Array.from(document.querySelectorAll('.next-message,.next-toast,[class*=message],[class*=Message],[class*=toast]'))
      .map((e) => clean(e.innerText)).filter(Boolean).slice(0, 6)
    return {
      提示节点: nodes,
      出错项: (t.match(/请发布前修改以下出错项[^\n]{0,90}/) || [])[0] || null,
      错误数: (t.match(/错误\s*[（(]?\d+/) || [])[0] || null,
      页面尾部文本: t.slice(-160),
    }
  })

  await sleep(8000)
  const after = await page.evaluate(readState)
  let ok = !!(after.最后保存 || after.保存提示)

  // 二次确认：再点一次（草稿保存按钮有时第一次只触发校验）
  if (!ok) {
    await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const b = Array.from(document.querySelectorAll('button')).filter(vis).find((x) => /保存草稿/.test(clean(x.innerText)))
      if (!b) return { ok: false }
      for (const ev of ['mousedown', 'mouseup', 'click']) b.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
      return { ok: true }
    })
    await sleep(8000)
    const confirm = await page.evaluate(readState)
    ok = !!(confirm.最后保存 || confirm.保存提示)
  }

  // ★ 草稿数量上限拦截 → 翻译成人话
  let 上限拦截 = false
  if (!ok) {
    const bag = [].concat(toast.提示节点 || [], [toast.页面尾部文本 || '', toast.出错项 || ''])
    const all = bag.join(' ')
    // ★ 页面里「草稿箱最大保存 10 条草稿…」是常驻提示（0 条草稿时也显示），不能当上限拦截
    上限拦截 = (/已达|不能超过|已满/.test(all) || /草稿.{0,20}(上限|最多|最大|不能超过)/.test(all)) && !/0 条草稿/.test(all)
  }

  return {
    ok,
    状态: await page.evaluate(readState),
    提示节点: toast.提示节点,
    出错项: toast.出错项,
    错误数: toast.错误数,
    页面尾部文本: toast.页面尾部文本,
    上限拦截,
    关掉弹窗数: closed,
    点击轮次: round,
    点击: clicked,
    保存前: before,
  }
}

export default { saveDraft }
