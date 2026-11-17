/**
 * 商品视频上传（ego 版）。
 *
 * 链路（2026-11-13 实测）：
 *   ① 发布页点「上传视频」→ 打开视频选择器 iframe `//sucai.wangpu.taobao.com/videoSelector.htm?type=video...`
 *   ② 面板里点「本地上传」→ filechooser → 选一个 mp4/mov/mkv
 *   ③ 等列表出现该文件（后台要上传/转码，可能要几十秒）
 *   ④ 勾选这条视频（卡片左侧 checkbox）→ 点底部「确认上传 ( N )」
 *   ⑤ 面板关闭 → 读回表单里 <video> 数量/「N/5」
 *
 * 为什么不能用 page.evaluate：视频选择器是**跨域 iframe**，只能走 CDP 子 frame（frameEval）。
 * 点击一律用真实鼠标：page.mouse.click(iframe.left + x, iframe.top + y)。
 *
 * ego 子进程不继承自定义环境变量 → 配置只从 globalThis.__TB_CFG 读。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { frameEval, say, sleep, waitUntil } from '../lib/tb_ego.mjs'

const VIDEO_KEY = 'videoSelector'
const VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.webm']

/** 视频选择器 iframe 的位置（主文档里读矩形；内部 DOM 走 CDP）。 */
const iframeGeom = (page) =>
  page
    .evaluate(() => {
      const f = [...document.querySelectorAll('iframe')].find((x) => /videoSelector\.htm/.test(String(x.getAttribute('src') || '')))
      if (!f) return { ok: false, why: 'no_frame' }
      const r = f.getBoundingClientRect()
      return { ok: true, left: r.left, top: r.top, width: r.width, height: r.height }
    })
    .catch((e) => ({ ok: false, why: String((e && e.message) || e) }))


/**
 * 切到指定页签（图文描述/基础信息…）：先按文字找标签，校验「这一点点得中」，点完回读目标区块是否出现。
 * ego 的 `text=xxx` 在这页会「点了但没反应」（实测视频步因此读不到商品视频区块），所以用坐标 + 回读。
 */
const switchToTab = async (page, label) => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const pt = await page
      .evaluate((want) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const vis = (e) => {
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const cands = [...document.querySelectorAll('div,span,a,li')]
          .filter(vis)
          .filter((e) => clean(e.innerText) === want)
          .map((e) => ({ e, r: e.getBoundingClientRect() }))
          .filter((x) => x.r.top < 120)
        if (!cands.length) return { ok: false, why: 'no_tab_label' }
        const c = cands[0]
        const x = Math.round(c.r.left + c.r.width / 2)
        const y = Math.round(c.r.top + c.r.height / 2)
        const top = document.elementsFromPoint(x, y) || []
        const t = clean(top[0] && top[0].innerText).slice(0, 40)
        return { ok: true, x, y, 顶层: top[0] ? top[0].tagName : null, 顶层文字: t }
      }, label)
      .catch(() => ({ ok: false, why: 'eval_failed' }))
    if (!pt.ok) {
      // 文字找标签失败 → 退回 ego 选择器
      await page.click('text=' + label, { force: true, timeout: 6000 }).catch(() => {})
    } else {
      await page.mouse.move(pt.x, pt.y).catch(() => {})
      await sleep(120)
      await page.mouse.click(pt.x, pt.y, { label: 'switch-tab' }).catch(() => {})
    }
    await sleep(1200)
    // 回读：目标区块出现即视为切换成功
    const ok = await waitUntil(
      async () => {
        const r = await page.evaluate((want) => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
          const vis = (e) => {
            const rr = e.getBoundingClientRect()
            return rr.width > 0 && rr.height > 0
          }
          const want2 = want === '图文描述' ? '商品视频' : '商品类目'
          const hit = [...document.querySelectorAll('div,span,p')].filter(vis).some((e) => clean(e.innerText).startsWith(want2))
          return { ok: hit }
        }, label)
        return r.ok ? r : null
      },
      { timeoutMs: 6000, intervalMs: 400, label: 'tab-' + label }
    )
    if (ok.ok) return { ok: true, 尝试: attempt, 点: pt.ok ? { x: pt.x, y: pt.y } : 'selector' }
  }
  return { ok: false, why: 'tab_switch_failed', label }
}

const inFrame = (page, fn, arg) => frameEval(page, VIDEO_KEY, fn, arg)

/** 在视频面板里找按钮中心（iframe 内坐标）。 */
const findBtn = (page, label) =>
  inFrame(page, (want) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const vis = (e) => {
      if (!e) return false
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const b = [...document.querySelectorAll('button,a,span,div')]
      .filter(vis)
      .map((e) => ({ el: e, txt: clean(e.innerText) }))
      .filter((x) => x.txt === want || x.txt.startsWith(want))
      .sort((a, b2) => a.txt.length - b2.txt.length)[0]
    if (!b) return { ok: false, why: 'not_found', want }
    const r = b.el.getBoundingClientRect()
    return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 文本: b.txt.slice(0, 20), disabled: !!b.el.disabled }
  }, label)

/** 找「完成」按钮（上传列表弹窗里的，关掉它才能点到卡片）。 */
const findDoneBtn = (page) =>
  inFrame(page, () => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const vis = (e) => {
      if (!e) return false
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const b = [...document.querySelectorAll('button')].filter(vis).find((x) => clean(x.innerText) === '完成')
    if (!b) return { ok: false, why: 'no_done_btn' }
    const r = b.getBoundingClientRect()
    return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })

/** 找「确认上传 ( N )」按钮：只认 <button>，并优先带括号计数的那个（避免命中说明文字）。 */
const findConfirmBtn = (page) =>
  inFrame(page, () => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const vis = (e) => {
      if (!e) return false
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const cands = [...document.querySelectorAll('button')]
      .filter(vis)
      .map((e) => ({ e, t: clean(e.innerText) }))
      .filter((x) => /确认上传/.test(x.t))
      .sort((a, b) => b.t.length - a.t.length)
    const hit = cands[0]
    if (!hit) return { ok: false, why: 'no_confirm_btn' }
    const r = hit.e.getBoundingClientRect()
    const n = Number(((hit.t.match(/\d+/) || [])[0] || 0))
    return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 文本: hit.t, 数量: n, disabled: !!hit.e.disabled }
  })

/** 面板列表里是否已出现该文件名。 */
const hasFile = (page, name) =>
  inFrame(page, (n) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    return { ok: true, hit: clean(document.body.innerText).includes(n) }
  }, name)

/** 面板里所有「视频卡片」的文本（便于排错）。 */
const listText = (page) =>
  inFrame(page, () => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    return { ok: true, text: clean(document.body.innerText).slice(0, 400) }
  }).catch(() => ({ ok: false }))

/** 勾选文件名对应的视频卡片（点卡片里的 checkbox / 卡片本体）。 */
/**
 * 找「只含该文件名」的视频 item 矩形（iframe 内坐标）。
 * 面板里的卡片结构：div.VideoList--videoItem--xxx > itemCover > label.checkbox（hover 才显示勾选框）。
 */
const locateCard = (page, name) =>
  inFrame(page, (n) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const vis = (e) => {
      if (!e) return false
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    // ★ 视频列表里文件名在 img[title|alt] 上（卡片标题 div 往往只剩时长/分辨率）
    const img = [...document.querySelectorAll('img')].filter(vis).find((e) => {
      const t = String(e.getAttribute('title') || '') + ' ' + String(e.getAttribute('alt') || '')
      return t.includes(n)
    })
    if (!img) return { ok: false, why: 'no_img' }
    let p = img
    for (let k = 0; k < 6 && p; k += 1) {
      if (/videoItem/i.test(String(p.className || ''))) break
      p = p.parentElement
    }
    const el = p || img
    const r = el.getBoundingClientRect()
    const ir = img.getBoundingClientRect()
    return {
      ok: true,
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
      imgX: Math.round(ir.left + ir.width / 2),
      imgY: Math.round(ir.top + ir.height / 2),
      卡片: clean(String(img.getAttribute('title') || img.getAttribute('alt') || '')).slice(0, 40),
    }
  }, name)

/** hover 之后，在卡片矩形内找可见 checkbox 的坐标（iframe 内坐标）。 */
const checkboxInCard = (page, card) =>
  inFrame(page, (c) => {
    const vis = (e) => {
      if (!e) return false
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const inRect = (r) => r.left >= c.x - 2 && r.right <= c.x + c.w + 2 && r.top >= c.y - 2 && r.bottom <= c.y + c.h + 2
    const cbs = [...document.querySelectorAll('input[type=checkbox], label.next-checkbox-wrapper, .next-checkbox, [class*=checkbox]')].filter(vis)
    const hit = cbs.find((e) => inRect(e.getBoundingClientRect()))
    if (!hit) return { ok: false, why: 'no_checkbox_in_card', 可见勾选框数: cbs.length }
    const r = hit.getBoundingClientRect()
    return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), checked: hit.checked !== undefined ? !!hit.checked : null }
  }, card)

/** 表单里已选视频的读回（主文档）。 */
const formVideoCount = (page) =>
  page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const labels = [...document.querySelectorAll('div,span,p')]
        .filter(vis)
        .map((e) => ({ e, t: clean(e.innerText), r: e.getBoundingClientRect() }))
      // 左侧「填写助手」面板也有同名标题 → 取左边距最靠右的那个（表单区）
      const pickByLeft = (t) => labels.filter((x) => x.t === t).sort((a, b) => b.r.left - a.r.left)[0]
      const head = pickByLeft('商品视频')
      const next = pickByLeft('导购素材')
      if (!head) return { videos: -1, 缩略图: 0, 空槽: -1, 片段: '', 计数: '' }
      const top = head.r.top
      const bot = next ? next.r.top : top + 500
      // ★ 表单里的商品视频是**缩略图卡片**（img），不是 <video> → 按区块数缩略图
      // 缩略图可能是 img 也可能是 video/poster → 两种都算
      const thumbs = [...document.querySelectorAll('img,video')]
        .filter(vis)
        .filter((im) => {
          const r = im.getBoundingClientRect()
          return r.top > top && r.top < bot && r.width > 40
        }).length
      const textsAll = [...document.querySelectorAll('div,span')]
        .filter(vis)
        .filter((e) => {
          const r = e.getBoundingClientRect()
          return r.top > top && r.top < bot
        })
        .map((e) => clean(e.innerText))
      const texts = textsAll
      // 「上传视频」空槽（没视频时=1，传上后就没了）——只数**表单区**（左侧填写助手也提到这个词）
      const 空槽 = [...document.querySelectorAll('div,span')]
        .filter(vis)
        .filter((e) => {
          const r = e.getBoundingClientRect()
          return r.top > top && r.top < bot && r.left > 300 && clean(e.innerText) === '上传视频'
        }).length
      const 讲解 = texts.filter((t) => /宝贝讲解/.test(t)).length
      const 片段 = texts.find((t) => /上传视频|宝贝讲解/.test(t) && t.length < 30) || ''
      const 计数 = (texts.find((t) => /^\d+\s*\/\s*5/.test(t)) || '')
      return { videos: thumbs, 缩略图: thumbs, 空槽, 讲解数: 讲解, 片段, 计数 }
    })
    .catch(() => ({ videos: -1, 缩略图: 0, 片段: '', 计数: '' }))

/**
 * 上传一个商品视频并勾选确认。
 * @param page - ego page（publish.htm）。
 * @param opts.file - 视频绝对路径（必填）。
 * @param opts.timeoutMs - 等「列表出现该文件」的上限（默认 180s，视频要转码）。
 * @returns `{ ok, file, 上传方式, 列表出现, 勾选, 确认, 面板关闭, 表单, 耗时ms }`
 */
export async function uploadVideo(page, opts = {}) {
  const t0 = Date.now()
  const file = String(opts.file || '')
  if (!file || !existsSync(file)) return { ok: false, why: 'no_video_file', file }
  const name = basename(file)
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (!VIDEO_EXT.includes(ext)) return { ok: false, why: 'bad_video_ext', file, ext }

  // ★ 商品视频区在「图文描述」页 → 先切过去，后面读缩略图才准（否则读不到区块）
  const tab = await switchToTab(page, '图文描述')
  say(tab.ok ? '   已切到「图文描述」页' : '   ⚠ 未能切到「图文描述」页（继续）: ' + JSON.stringify(tab))
  await sleep(1200)
  const before = await formVideoCount(page)
  if (before.videos === -1) say('   ⚠ 页面上读不到「商品视频」区块（可能还停在别的页签）')
  say('视频:', name, '| 大小 =', (statSync(file) || {}).size, '| 表单当前:', JSON.stringify(before))

  // ① 打开视频选择器（已开就直接复用）
  let g = await iframeGeom(page)
  if (!g.ok) {
    // ★ 按钮可能被页面浮层/滚动干扰（ego 报 "none can receive input"）→ 先滚到它，再 force 点
    await page
      .evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const el = [...document.querySelectorAll('button,span,div,a')].find((e) => clean(e.innerText) === '上传视频')
        if (el) el.scrollIntoView({ block: 'center' })
      })
      .catch(() => {})
    await sleep(600)
    let opened = await page
      .click('text=上传视频', { force: true, timeout: 12000 })
      .then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, why: String((e && e.message) || e).slice(0, 100) }))
    if (!opened.ok) {
      await sleep(1000)
      opened = await page
        .click('text=上传视频', { force: true, timeout: 12000 })
        .then(() => ({ ok: true }))
        .catch((e) => ({ ok: false, why: String((e && e.message) || e).slice(0, 100) }))
    }
    say('① 点「上传视频」:', JSON.stringify(opened))
    await waitUntil(async () => (await iframeGeom(page)).ok, {
      timeoutMs: 25000,
      intervalMs: 800,
      label: 'video-panel',
    })
    g = await iframeGeom(page)
  }
  if (!g.ok) return { ok: false, why: 'video_panel_not_opened', file, 表单: before, 耗时ms: Date.now() - t0 }
  say('   视频面板:', JSON.stringify({ left: Math.round(g.left), top: Math.round(g.top), w: Math.round(g.width), h: Math.round(g.height) }))

  /** 失败/退出前必须关掉视频面板（否则它会挡住后面的规格/品牌点击）。 */
  const closePanel = async () => {
    if (!(await iframeGeom(page)).ok) return true
    await page.mouse.click(20, 300).catch(() => {})
    await sleep(1500)
    if ((await iframeGeom(page)).ok) {
      await page.keyboard.press('Escape').catch(() => {})
      await sleep(1200)
    }
    return !(await iframeGeom(page)).ok
  }
  const fail = async (obj) => {
    await closePanel()
    return obj
  }

  // ② 「本地上传」→ filechooser → setFiles
  let up = null
  for (let attempt = 0; attempt < 3 && !up; attempt += 1) {
    await waitUntil(async () => (await findBtn(page, '本地上传')).ok, { timeoutMs: 15000, intervalMs: 800 })
    const btn = await findBtn(page, '本地上传')
    if (!btn.ok) continue
    g = await iframeGeom(page)
    if (!g.ok) continue
    const abs = { x: Math.round(g.left + btn.x), y: Math.round(g.top + btn.y) }
    const chooserP = page.waitForFileChooser({ timeout: 15000 }).catch(() => null)
    await page.mouse.move(abs.x, abs.y)
    await sleep(200)
    await page.mouse.click(abs.x, abs.y, { label: 'video-upload' }).catch((e) => say('   真实点击失败:', String((e && e.message) || e).slice(0, 80)))
    const chooser = await chooserP
    if (chooser) {
      await chooser.setFiles([file]).catch(() => {})
      up = { how: 'filechooser' }
      break
    }
    // 兜底：ego 跨 frame 选择器
    const chooser2P = page.waitForFileChooser({ timeout: 15000 }).catch(() => null)
    const clicked = await page.click('text=本地上传', { timeout: 8000 }).then(() => 'ok').catch(() => 'no')
    const chooser2 = await chooser2P
    if (chooser2) {
      await chooser2.setFiles([file]).catch(() => {})
      up = { how: 'selector_filechooser' }
    } else if (clicked === 'ok') {
      up = null
      await sleep(2000)
    }
  }
  say('② 上传:', JSON.stringify(up))
  if (!up) return { ok: false, why: 'video_upload_trigger_failed', file, 面板文本: (await listText(page)).text, 耗时ms: Date.now() - t0 }

  // ③ 等列表出现该文件（视频要转码，放宽到 timeoutMs）
  const land = await waitUntil(async () => (await hasFile(page, name)).hit, {
    timeoutMs: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 180000,
    intervalMs: 3000,
    label: 'video-landed',
  })
  say('③ 列表出现:', land.ok, '| 等待', land.waitedMs, 'ms')
  if (!land.ok) {
    return { ok: false, why: 'video_not_in_list', file, 等待ms: land.waitedMs, 面板文本: (await listText(page)).text, 上传方式: up.how, 耗时ms: Date.now() - t0 }
  }

  // ③b ★ 上传后**会弹出**「上传列表 / 发布成功」对话框（右下角「完成」）：
  //     必须等它出现 → 点「完成」→ **核实弹窗真的关掉**（每次点击都重新读 iframe 位置，别用旧坐标）
  const dialogOpen = () =>
    inFrame(page, () => {
      const vis = (e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      return { ok: true, n: [...document.querySelectorAll('.next-dialog')].filter(vis).length }
    }).then((r) => (r && r.n) || 0).catch(() => 0)
  await waitUntil(async () => (await dialogOpen()) > 0, { timeoutMs: 40000, intervalMs: 1200, label: 'video-upload-dialog' })
  let dialogsClosed = false
  for (let i = 0; i < 5; i += 1) {
    if ((await dialogOpen()) === 0) {
      dialogsClosed = true
      break
    }
    const done = await findDoneBtn(page)
    g = await iframeGeom(page)
    if (!done.ok || !g.ok) {
      // 坐标版找不到时，用选择器兜底
      const r = await page
        .click('text="完成"', { force: true, timeout: 5000 })
        .then(() => 'selector')
        .catch(() => 'fail')
      say('③b 关闭上传对话框（兜底选择器）:', r, '| 剩余弹窗 =', await dialogOpen())
      await sleep(1500)
      continue
    }
    await page.mouse.move(g.left + done.x, g.top + done.y)
    await sleep(250)
    await page.mouse.click(g.left + done.x, g.top + done.y, { label: 'video-done' }).catch(() => {})
    await sleep(1500)
    say('③b 点「完成」关闭上传对话框: 第', i + 1, '次 | 剩余弹窗 =', await dialogOpen())
  }
  if (!dialogsClosed && (await dialogOpen()) > 0) {
    return await fail({ ok: false, why: 'upload_dialog_still_open', 面板文本: (await listText(page)).text, 耗时ms: Date.now() - t0 })
  }

  // ④ 勾选：★ ego 选择器直接点卡片（`div[class*="VideoList--videoItem"] >> nth=N`）最稳；
  //    先把已勾选的全部取消，只选中第 0 张 → 读「确认上传 ( N )」= 1
  let tick = null
  const selectedIdx = () =>
    inFrame(page, () => {
      const vis = (e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const items = [...document.querySelectorAll('div[class*="VideoList--videoItem"]')]
      return {
        ok: true,
        idx: items.map((e, i) => ({ i, checked: !!e.querySelector('input[type=checkbox]')?.checked, vis: vis(e) })).filter((x) => x.checked).map((x) => x.i),
      }
    }).catch(() => ({ ok: false, idx: [] }))
  for (let attempt = 0; attempt < 4 && !tick; attempt += 1) {
    const sel = await selectedIdx()
    for (const i of sel.idx || []) {
      await page.click(`loc=css:div[class*="VideoList--videoItem"] >> nth=${i}`, { force: true, timeout: 5000 }).catch(() => {})
      await sleep(600)
    }
    const clicked = await page
      .click('loc=css:div[class*="VideoList--videoItem"] >> nth=0', { force: true, timeout: 6000 })
      .then(() => 'ok')
      .catch((e) => 'ERR ' + String((e && e.message) || e).slice(0, 60))
    await sleep(1200)
    const conf = await findConfirmBtn(page)
    const n2 = Number(conf.数量 || 0)
    say('   选卡片:', clicked, '| 确认上传:', JSON.stringify(conf.文本 || ''), '| N =', n2)
    if (conf.ok && n2 === 1) tick = { 卡片: 'first', 确认: conf.文本 }
    else if (conf.ok && n2 > 1) {
      // 多选了：把除第 0 张外的都取消
      const sel2 = await selectedIdx()
      for (const i of (sel2.idx || []).filter((x) => x !== 0)) {
        await page.click(`loc=css:div[class*="VideoList--videoItem"] >> nth=${i}`, { force: true, timeout: 5000 }).catch(() => {})
        await sleep(500)
      }
    }
  }

  // ⑤ 「确认上传」：用 ego 选择器点（坐标会飘），点完**轮询缩略图真的出现**才算过
  let applied = false
  for (let i = 0; i < 4 && !applied; i += 1) {
    const conf = await findConfirmBtn(page)
    if (!conf.ok || Number(conf.数量 || 0) <= 0) {
      // 面板已经关了（多半是上一步「点遮罩外」关的）→ 去表单里再确认一次，别把已点过的算成没勾选
      const again = await formVideoCount(page)
      if (again.videos > before.videos) {
        applied = true
        break
      }
      const why = i > 0 ? 'video_not_applied' : 'nothing_selected'
      return await fail({
        ok: false,
        why,
        file,
        确认文本: conf.文本 || null,
        表单: again,
        面板文本: (await listText(page)).text,
        耗时ms: Date.now() - t0,
      })
    }
    say('⑤ 确认上传:', JSON.stringify(conf.文本 || ''), '| N =', conf.数量)
    // ★ 首选：**在 frame 内直接 .click()**（实测唯一 100% 生效的方式）
    //   ego 的 role 选择器打进去「点了但没反应」；坐标点击在某些状态下也会落空（面板不关、表单 0 个视频）
    const domClick = await inFrame(page, () => {
      const clean = (s2) => (s2 || '').replace(/\s+/g, ' ').trim()
      const btn = [...document.querySelectorAll('button')].find((x) => /确认上传/.test(clean(x.innerText)))
      if (!btn) return { ok: false, why: 'no_confirm_btn' }
      const text = clean(btn.innerText)
      btn.click()
      return { ok: true, text }
    }).catch((e) => ({ ok: false, why: String((e && e.message) || e).slice(0, 80) }))
    say('   确认按钮点击(dom):', JSON.stringify(domClick), '| 进度 =', i + 1, '/4')
    await sleep(1000)

    // 等「面板关闭 或 表单出现视频」；没动静再依次用坐标点、选择器兜底
    const settle = async (ms) =>
      waitUntil(
        async () => {
          const c = await formVideoCount(page)
          if (c.videos > before.videos || (before.空槽 > 0 && c.空槽 >= 0 && c.空槽 < before.空槽)) {
            applied = true
            return { via: 'thumb' }
          }
          if (!(await iframeGeom(page)).ok) return { via: 'panel-closed' }
          return null
        },
        { timeoutMs: ms, intervalMs: 700, label: 'confirm-settle' }
      )
    let settled = await settle(domClick.ok ? 9000 : 2000)
    say('   确认后面板/缩略图状态:', JSON.stringify(settled.value || null), '| applied =', applied)

    if (!applied && (await iframeGeom(page)).ok) {
      const gg = await iframeGeom(page)
      if (gg.ok) {
        const abs = { x: Math.round(gg.left + conf.x), y: Math.round(gg.top + conf.y) }
        await page.mouse.move(abs.x, abs.y).catch(() => {})
        await sleep(150)
        await page.mouse.click(abs.x, abs.y, { label: 'video-confirm' }).catch(() => {})
        say('   确认按钮点击(坐标):', JSON.stringify(abs))
        settled = await settle(6000)
        say('   坐标点击后状态:', JSON.stringify(settled.value || null), '| applied =', applied)
      }
    }
    if (!applied && (await iframeGeom(page)).ok) {
      await page
        .click('loc=role:button[name*="确认上传"]', { force: true, timeout: 6000 })
        .then(() => 'selector')
        .catch(() => 'selector-fail')
      settled = await settle(5000)
      say('   选择器点击后状态:', JSON.stringify(settled.value || null), '| applied =', applied)
    }
    // 仍开着面板才点遮罩外（先让确认请求提交完，否则会把请求点断）
    if ((await iframeGeom(page)).ok) {
      await page.mouse.click(20, 300).catch(() => {})
      await sleep(1200)
    }
    say('   确认后视频缩略图:', JSON.stringify(await formVideoCount(page)), '| applied =', applied)
  }
  await sleep(2000)
  const after = await formVideoCount(page)
  const panelClosed = !(await iframeGeom(page)).ok
  const changed = applied || after.videos > before.videos
  return {
    ok: changed,
    file,
    上传方式: up.how,
    列表出现: true,
    勾选: tick,
    确认: tick ? tick.确认 : null,
    面板关闭: panelClosed,
    表单: after,
    ...(changed ? {} : { why: 'video_not_applied', 提示: '确认上传点了但表单里没出现视频缩略图（很可能点到了弹窗/坐标漂移）' }),
    耗时ms: Date.now() - t0,
  }
}

/** 从目录里挑第一个视频（img/video 或配置 videoFile）。 */
export function pickVideoFile(opts = {}) {
  if (opts.file && existsSync(opts.file)) return String(opts.file)
  const dir = String(opts.dir || '')
  if (!dir || !existsSync(dir)) return ''
  const f = readdirSync(dir)
    .filter((x) => VIDEO_EXT.includes(x.slice(x.lastIndexOf('.')).toLowerCase()))
    .sort()[0]
  return f ? join(dir, f) : ''
}

/**
 * 关掉「选择视频」面板（成功/失败都要调；它会挡住后面的规格/品牌点击）。
 * 实测：点弹层外面的空白能关掉。
 */
export async function closeVideoPanel(page) {
  if (!(await iframeGeom(page)).ok) return true
  await page.mouse.click(20, 300).catch(() => {})
  await sleep(1500)
  if ((await iframeGeom(page)).ok) {
    await page.keyboard.press('Escape').catch(() => {})
    await sleep(1200)
  }
  return !(await iframeGeom(page)).ok
}

export default { uploadVideo, pickVideoFile, closeVideoPanel }
