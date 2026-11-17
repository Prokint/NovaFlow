/**
 * 3:4 主图上传（ego 版，2026-11-13 实测）。
 *
 * 与 1:1 主图**不同**：3:4 区的空槽点下去是**直接弹文件选择器**（不走图片空间 iframe）。
 * 所以这里不找 iframe，而是：
 *   ① 挂 `page.waitForFileChooser()`；
 *   ② 点第一个「上传图片」空槽（ego 选择器 / 真实鼠标兜底）；
 *   ③ `chooser.setFiles([file])`；
 *   ④ 轮询主文档里的「上传图片」叶子数是否 -1（填上才算成功）。
 *
 * 注意：1:1 区必须先填完，这样「第一个空槽」才落在 3:4 区（编排里 4 在 4c 之前）。
 * ego 子进程不继承环境变量 → 配置只从 __TB_CFG 读。
 */
import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import { say, sleep, waitUntil } from '../lib/tb_ego.mjs'

const IMG_EXT = /\.(jpe?g|png|webp|avif)$/i

/** 主文档里「上传图片」叶子数（1:1 填完后剩下的就是 3:4 区）。 */
export const slotLeaves = (page) =>
  page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const raw = [...document.querySelectorAll('div,span,li,p')].filter((e) => vis(e) && clean(e.innerText) === '上传图片')
      return raw.filter((e) => !raw.some((o) => o !== e && e.contains(o))).length
    })
    .catch(() => -1)

/** 第一个空槽的中心坐标（主文档坐标）。 */
const firstSlotPoint = (page) =>
  page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const raw = [...document.querySelectorAll('div,span,li,p')].filter((e) => vis(e) && clean(e.innerText) === '上传图片')
      const el = raw.filter((e) => !raw.some((o) => o !== e && e.contains(o)))[0]
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })
    .catch(() => null)

/**
 * 依次把一张 3:4 图塞进一个空槽。
 * @param page - ego page
 * @param files - 图片绝对路径数组（调用方已按文件名排序）
 * @param opts.limit - 最多传几张
 * @returns `{ ok, uploaded, want, before, after, 已完成, 未完成, 耗时ms }`
 */
export async function upload34(page, files, { limit = 5 } = {}) {
  const t0 = Date.now()
  const abs = (files || []).map(String).filter((f) => existsSync(f))
  const want = Math.min(limit > 0 ? limit : 5, abs.length)
  const before = await slotLeaves(page)
  say('   3:4 起始空槽:', before, '| 本次', want, '张')
  if (!want) return { ok: false, why: 'no_files', uploaded: 0, want: 0, before, after: before }

  const done = []
  for (let i = 0; i < want; i += 1) {
    const file = abs[i]
    const cur = await slotLeaves(page)
    if (cur <= 0) break
    say(`\n   === 3:4 ${i + 1}/${want}: ${basename(file)} ===`)
    let okThis = false
    for (let attempt = 0; attempt < 3 && !okThis; attempt += 1) {
      const pt = await firstSlotPoint(page)
      if (!pt) break
      const chooserP = page.waitForFileChooser({ timeout: 20000 }).catch(() => null)
      await page.mouse.move(pt.x, pt.y)
      await sleep(250)
      await page.mouse.click(pt.x, pt.y, { label: '3x4-slot' }).catch((e) => say('   点子槽失败:', String((e && e.message) || e).slice(0, 60)))
      const chooser = await chooserP
      if (!chooser) {
        say('   点了空槽但没弹 filechooser（第', attempt + 1, '次），重试')
        await sleep(1500)
        continue
      }
      await chooser.setFiles([file]).catch((e) => say('   setFiles 失败:', String((e && e.message) || e).slice(0, 60)))
      const waited = await waitUntil(async () => (await slotLeaves(page)) < cur, { timeoutMs: 25000, intervalMs: 1200, label: '3x4-filled' })
      okThis = waited.ok
      say('   填上:', okThis, '| 空槽', cur, '→', await slotLeaves(page))
      if (!okThis) await sleep(1500)
    }
    if (okThis) done.push(basename(file))
    else break
  }

  const after = await slotLeaves(page)
  const uploaded = done.length
  const result = {
    ok: uploaded >= want,
    uploaded,
    want,
    before,
    after,
    已完成: done,
    未完成: abs.slice(uploaded).map((f) => basename(f)),
    耗时ms: Date.now() - t0,
  }
  if (!result.ok) result.why = '3x4_incomplete'
  return result
}

/** 从目录挑图（按文件名排序）。 */
export function pickImages34(dir, limit = 5) {
  try {
    return readdirSync(dir)
      .filter((f) => IMG_EXT.test(f))
      .sort()
      .slice(0, limit)
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

export default { upload34, pickImages34, slotLeaves }
