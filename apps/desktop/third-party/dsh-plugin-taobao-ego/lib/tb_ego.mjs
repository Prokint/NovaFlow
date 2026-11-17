/**
 * 淘宝/千牛上架 · ego 版共享执行库。
 *
 * 与原版（Playwright + CDP 端口）的差异与替代做法：
 *   - 连接：不再用 `chromium.connectOverCDP(port)`，改为 ego 的 `claimTaskSpace(spaceId)` /
 *     `takeOverTaskSpace(spaceId)`，一店 = 一个 ego space。
 *   - 定位：ego 的 page 没有 `locator` / `frames`，所以所有查找都在 `page.evaluate` 里做；
 *     点击用「元素坐标 + page.mouse.click」或 DOM 合成事件（mousedown/mouseup/click）。
 *   - iframe（淘宝「图片空间」`sucai-selector-ng`）：用 `page.evaluate` 里通过
 *     `iframe.contentDocument` 取内部元素（同源），把 iframe 偏移量与元素坐标相加后真实鼠标点击。
 *   - 上传：`page.waitForFileChooser()` + 点击触发按钮 + `chooser.setFiles(files)`；
 *     若触发点没有出现 filechooser，再退回「监测 iframe 内新增 input[type=file] 并 setInputFiles」。
 *
 * 所有函数都按「先读回、再动作」的约定写：返回 `{ ok, ...读回值 }`，失败带 `why`。
 */
import { existsSync } from 'node:fs'

/** 冒烟等待。 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一行 JSON 输出，便于编排层解析最后一行。 */
export const out = (value) => console.log(JSON.stringify(value))

/** 带缩进的人类可读日志。 */
export const say = (...parts) => console.log('  ' + parts.join(' '))

/**
 * 轮询到条件为真再继续（替代固定 sleep）。
 * @param check - 返回真值的检查函数。
 * @param options - `timeoutMs` 上限、`intervalMs` 轮询间隔、`label` 日志标签。
 * @returns `{ ok, waitedMs, value }`；超时返回 `ok:false` 与最后一次结果。
 */
export async function waitUntil(check, { timeoutMs = 20000, intervalMs = 300, label = '' } = {}) {
  const started = Date.now()
  let value = null
  while (Date.now() - started < timeoutMs) {
    try {
      value = await check()
    } catch {
      value = null
    }
    if (value) return { ok: true, waitedMs: Date.now() - started, value, label }
    await sleep(intervalMs)
  }
  return { ok: false, waitedMs: Date.now() - started, value: null, label }
}

/**
 * 连接一个 ego space，返回该 space 的活动页。
 *
 * 淘宝这边要避开「千牛工作台」标签：导航它会把工作台会话带走并落到登录页，
 * 所以优先选已经是目标域名的标签，其次选非 myseller 的标签，最后才用活动页。
 * @param spaceId - ego space id（一店一个）。
 * @param options - `preferUrl` 正则：优先匹配该 URL 的标签。
 * @returns `{ task, page }`。
 */
export async function connectSpace(spaceId, { preferUrl } = {}) {
  let task
  try {
    task = await claimTaskSpace(spaceId)
  } catch {
    task = await takeOverTaskSpace(spaceId)
  }
  const tabs = await task.tabs()
  if (tabs.length === 0) throw new Error(`no_tab_in_space_${spaceId}`)

  // ★ 登录页要**先排除**：淘宝登录页的 `redirectURL` 参数里就带着 `item.upload.taobao.com`，
  //   按 preferUrl 匹配会把「登录页」当成发品页选出来 → 之后每次 goto 都被弹回登录页，
  //   表现就是「插件根本没动浏览器」（实测 2026-11-17，space 里同时有千牛页和登录页）。
  const urls = tabs.map((t) => String(t.url || ''))
  const isLogin = (u) => /login\.(taobao|tmall|alibaba)\.com|havanaone|login\.htm/i.test(u)
  const isTaobao = (u) => /taobao\.com|tmall\.com/i.test(u)
  const live = tabs.filter((t, i) => !isLogin(urls[i]))
  if (live.length === 0) {
    throw new Error(
      'not_logged_in: space 里只有登录页（' +
        urls.map((u) => u.slice(0, 60)).join(' | ') +
        '）→ 请用户在 ego 里登录淘宝/千牛后重试（本插件不代登录）',
    )
  }
  let chosen = null
  if (preferUrl) chosen = live.find((tab) => preferUrl.test(String(tab.url || '')))
  // ★ 商家后台是千牛：优先用 qn.taobao.com 那个标签（登录态与发品页共享），
  //   其次才是任意非登录的淘宝系标签；最后才退回活动标签。
  if (!chosen) chosen = live.find((tab) => /qn\.taobao\.com|myseller\.taobao\.com/.test(String(tab.url || '')))
  if (!chosen) chosen = live.find((tab) => isTaobao(String(tab.url || '')))
  if (!chosen) chosen = live.find((tab) => tab.active) || live[0]
  const page = chosen.label ? task.page(chosen.label) : await task.adopt(chosen.page)
  return { task, page }
}

/**
 * 导航并等待可用状态；ego 的 goto 只等到 domcontentloaded。
 * @param page - ego page。
 * @param url - 目标地址。
 * @param settleMs - 导航后额外缓冲（SPA 首屏）。
 * @returns 最终 URL。
 */
export async function gotoUrl(page, url, settleMs = 1500) {
  const target = String(url)
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded' })
  } catch {
    try { await page.goto(target) } catch { /* 导航可能已提交 */ }
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await sleep(settleMs)
  return await page.url().catch(() => target)
}

/**
 * 在当前页执行 evaluate。
 * @param page - ego page。
 * @param fn - 浏览器侧函数（不要引用外部变量，参数走 `arg`）。
 * @param arg - 传入浏览器侧的单个参数。
 * @returns 浏览器侧返回值。
 */
export const evalIn = (page, fn, arg) => page.evaluate(fn, arg)

/**
 * 按可见文本点元素：先算中心坐标，再真实鼠标点击；坐标不稳时退回 DOM 合成事件。
 * @param page - ego page。
 * @param text - 期望的完整文本（会做空白归一化）。
 * @param options - `tag` 限定标签名、`exact` 是否全等、`timeoutMs`。
 * @returns `{ ok, how, reason? }`。
 */
export async function clickText(page, text, { tag = '', exact = true, timeoutMs = 15000 } = {}) {
  const want = String(text)
  const hit = await waitUntil(async () => {
    const pos = await page.evaluate(({ want, tag, exact }) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const nodes = [...document.querySelectorAll(tag || '*')].filter(vis)
      const match = nodes.find((e) => {
        const t = clean(e.innerText || e.textContent)
        return exact ? t === clean(want) : t.includes(clean(want))
      })
      if (!match) return null
      match.scrollIntoView({ block: 'center' })
      const r = match.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    }, { want, tag, exact }).catch(() => null)
    return pos
  }, { timeoutMs, intervalMs: 300, label: 'click:text:' + want.slice(0, 20) })
  if (!hit.value) return { ok: false, why: 'not_found', want }
  await page.mouse.click(hit.value.x, hit.value.y, { label: want.slice(0, 20) })
  return { ok: true, how: 'mouse' }
}

/**
 * 在页面里合成 mousedown/mouseup/click 三连（淘宝类目级联与部分控件只认这个序列）。
 * @param page - ego page。
 * @param selector - CSS 选择器。
 * @param matcher - 浏览器侧函数体字符串，参与筛选（在 evaluate 内以 `(el) => ...` 形式使用）。
 * @returns `{ ok, count }`。
 */
export async function synthClick(page, selector, matcher) {
  return page.evaluate(({ selector, matcher }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const vis = (e) => {
      if (!e) return false
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const test = matcher ? new Function('el', 'clean', 'return (' + matcher + ')(el, clean)') : () => true
    const els = [...document.querySelectorAll(selector)].filter((e) => vis(e) && test(e, clean))
    for (const el of els) {
      for (const type of ['mousedown', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
      }
    }
    return { ok: els.length > 0, count: els.length }
  }, { selector, matcher })
}

/**
 * 关闭常见遮罩/弹窗（淘宝发布页的「上传结果」、图片预览 lightbox、切换显示模式确认框）。
 * 只点明确的「完成 / 确定 / 关闭 / 知道了」，不按 Escape（会把规格抽屉一起关掉）。
 * @param page - ego page。
 * @param options - `timeoutMs` 单次尝试上限。
 * @returns `{ closed, remaining }`。
 */
export async function dismissDialogs(page, { rounds = 4 } = {}) {
  let closed = 0
  for (let i = 0; i < rounds; i += 1) {
    const r = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const words = ['完成', '确定', '关闭', '知道了']
      const nodes = [...document.querySelectorAll('button, [role=button], span, div, a')]
        .filter((e) => vis(e) && !e.children.length)
        .filter((e) => {
          const t = clean(e.innerText)
          if (!t || t.length > 8) return false
          return words.includes(t.replace(/（\d+）$/, '').trim())
        })
      const el = nodes[nodes.length - 1]
      if (!el) return 0
      for (const type of ['mousedown', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
      }
      return 1
    }).catch(() => 0)
    closed += r
    if (!r) break
    await sleep(700)
  }
  return { closed }
}

/**
 * 在指定 iframe 内执行 evaluate（同源时通过 contentDocument 访问）。
 * @param page - ego page。
 * @param frameNeedle - iframe 的定位关键字（匹配 src/name/id）。
 * @param fn - 在 iframe 文档里执行的函数。
 * @param arg - 传给该函数的参数。
 * @returns 执行结果；找不到 iframe 时返回 `{ ok:false, why:'no_frame' }`。
 */
export async function evalInFrame(page, frameNeedle, fn, arg) {
  const payload = await page.evaluate(async ({ needle, source, arg }) => {
    const frames = [...document.querySelectorAll('iframe')]
    const frame = frames.find((f) => {
      const hay = f.getAttribute('src') + ' ' + f.getAttribute('name') + ' ' + f.id
      return hay.includes(needle)
    })
    if (!frame) return { ok: false, why: 'no_frame', frames: frames.map((f) => (f.getAttribute('src') || '').slice(0, 80)).slice(0, 6) }
    const doc = frame.contentDocument
    if (!doc) return { ok: false, why: 'no_content_document' }
    const r = frame.getBoundingClientRect()
    const body = new Function('doc', 'frameRect', 'arg', source)
    try {
      const value = await body(doc, { x: r.x, y: r.y, width: r.width, height: r.height }, arg)
      return { ok: true, value }
    } catch (e) {
      return { ok: false, why: String(e && e.message || e) }
    }
  }, { needle: frameNeedle, source: fn.toString(), arg }).catch((e) => ({ ok: false, why: String(e && e.message || e) }))
  return payload
}

/**
 * 触发上传并接收文件：优先 filechooser，其次退回「点击后出现的新 input[type=file]」。
 * @param page - ego page。
 * @param trigger - 触发上传的浏览器侧动作（在 main frame 里执行，点 iframe 用坐标）。
 * @param files - 要上传的绝对路径数组。
 * @param options - `timeoutMs`。
 * @returns `{ ok, how, count }`。
 */
export async function uploadFiles(page, trigger, files, { timeoutMs = 15000 } = {}) {
  const list = Array.isArray(files) ? files.map(String) : [String(files)]
  const before = await page.evaluate(() => document.querySelectorAll('input[type=file]').length).catch(() => 0)
  let chooser = null
  try {
    const pending = page.waitForFileChooser({ timeout: timeoutMs })
    await trigger()
    chooser = await pending
  } catch {
    chooser = null
  }
  if (chooser) {
    await chooser.setFiles(list)
    return { ok: true, how: 'filechooser', count: list.length }
  }
  // 退回：点击后页面内新增的 file input（含 iframe 内）
  const target = await waitUntil(async () => {
    const sel = await page.evaluate((beforeCount) => {
      const collect = (doc, prefix) => [...doc.querySelectorAll('input[type=file]')].map((_, index) => ({ index, prefix }))
      const all = [...collect(document, 'main')]
      for (const frame of [...document.querySelectorAll('iframe')]) {
        try { all.push(...collect(frame.contentDocument, 'iframe:' + (frame.getAttribute('src') || ''))) } catch { /* 跨域忽略 */ }
      }
      return all[beforeCount] || null
    }, before).catch(() => null)
    return sel
  }, { timeoutMs, intervalMs: 300, label: 'file-input-appear' })
  if (target.value && target.value.prefix === 'main') {
    const sel = 'input[type=file]'
    await page.setInputFiles(sel, list).catch(() => {})
    return { ok: true, how: 'main_input', count: list.length }
  }
  return { ok: false, why: 'no_filechooser_no_input', count: 0 }
}

/** 读取当前页 URL 的简短形式。 */
export const currentUrl = async (page) => String(await page.url()).slice(0, 200)

/** 判断页面是否为发布表单页。 */
export async function isPublishForm(page) {
  return /publish\.htm/.test(await currentUrl(page))
}

/** 等到发布表单页就绪（读回 catId 与「确认，下一步」消失）。 */
export async function waitPublishForm(page, { timeoutMs = 30000 } = {}) {
  return waitUntil(async () => {
    const state = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      return {
        url: location.href.slice(0, 200),
        inForm: /publish\.htm/.test(location.href),
        catId: (location.search.match(/catId=(\d+)/) || [])[1] || null,
        hasBrand: !!document.querySelector('#sell-field-p-20000'),
        text: clean(document.body.innerText).slice(0, 200),
      }
    }).catch(() => null)
    return state && state.inForm ? state : null
  }, { timeoutMs, intervalMs: 400, label: 'publish-form-ready' })
}

/**
 * 找到跨域子 frame 的执行上下文（例如淘宝「图片空间」sucai-selector-ng）。
 *
 * ego 的 `page.evaluate()` 只跑在主文档，拿不到跨域 iframe 的 `contentDocument`；
 * 但 `page.cdp()` 可以做 Playwright `page.frames().find(...)` 的等价物：
 * `Page.getFrameTree` 拿到 frameId → `Page.createIsolatedWorld` 建隔离世界 →
 * `Runtime.evaluate` 在那个 frame 的 executionContextId 里执行。
 *
 * @param page - ego page。
 * @param needle - iframe src/name/id 关键字（字符串或 RegExp）。
 * @returns `{ ok, frameId, contextId }` 或 `{ ok:false, why }`。
 */
export async function frameContext(page, needle) {
  const opt = normalizeFrameOpt(needle)
  if (!page.__tbFrames) {
    page.__tbFrames = {}
    try {
      await page.cdp('Page.enable')
      await page.cdp('Runtime.enable')
    } catch (e) {
      /* CDP 不可用时让下面的 getFrameTree 报出来 */
    }
  }
  let tree
  try {
    tree = await page.cdp('Page.getFrameTree')
  } catch (e) {
    return { ok: false, why: 'cdp_unavailable', 错误: String((e && e.message) || e).slice(0, 160) }
  }
  const flat = []
  const walk = (n) => {
    flat.push({ id: n.frame.id, url: String(n.frame.url || ''), name: String(n.frame.name || '') })
    for (const c of n.childFrames || []) walk(c)
  }
  walk(tree.frameTree)
  const hits = flat.filter((f) => opt.re.test(f.url) && !(opt.excludeName && new RegExp(opt.excludeName).test(f.name)))
  const hit = opt.pick === 'last' ? hits[hits.length - 1] : hits[0]
  if (!hit) return { ok: false, why: 'no_frame', 帧样本: flat.map((f) => f.url.slice(0, 80)).slice(-6) }
  if (page.__tbFrames[hit.id]) return { ok: true, frameId: hit.id, contextId: page.__tbFrames[hit.id] }
  const world = await page.cdp('Page.createIsolatedWorld', { frameId: hit.id, worldName: 'tb-ego', grantUniveralAccess: true })
  page.__tbFrames[hit.id] = world.executionContextId
  return { ok: true, frameId: hit.id, contextId: world.executionContextId, name: hit.name }
}

/** 归一化 frame 选择参数：字符串/RegExp 或 { needle, excludeName, pick }。 */
function normalizeFrameOpt(needle) {
  const o = needle && typeof needle === 'object' && !(needle instanceof RegExp) && !(needle instanceof Function) ? needle : { needle }
  const src = o.needle instanceof RegExp ? o.needle.source : String(o.needle || '').replace(/[.*+?^${}()|[\\]]/g, '\\$&')
  return { re: new RegExp(src), excludeName: o.excludeName || '', pick: o.pick === 'last' ? 'last' : 'first' }
}

/**
 * 主文档里按同一套选择规则读 iframe 的矩形（跨域只能读位置，不能读 DOM）。
 * @returns `{ ok, left, top, width, height, name }`
 */
async function mainFrameRect(page, needle) {
  const opt = normalizeFrameOpt(needle)
  return page
    .evaluate(({ src, excludeName, pick }) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const frames = [...document.querySelectorAll('iframe')]
      const hay = (f) =>
        String(f.getAttribute('src') || '') + ' ' + String(f.getAttribute('name') || '') + ' ' + String(f.id || '')
      const re = new RegExp(src)
      const cands0 = frames.filter((f) => re.test(hay(f)) && (!excludeName || String(f.getAttribute('name') || '') !== excludeName))
      // ★ 只要「真面板」：3:4 区会有一个内联的小 iframe（class select-image-page）也匹配 src，
      //   尺寸小、会挡住点击；用尺寸过滤掉它（>=200x200 才算真面板）
      const big = cands0.filter((f) => {
        const r = f.getBoundingClientRect()
        return r.width >= 600 && r.height >= 400
      })
      const cands = big.length ? big : cands0
      const frame = pick === 'last' ? cands[cands.length - 1] : cands[0]
      if (!frame) {
        return {
          ok: false,
          why: 'no_frame',
          候选数: cands.length,
          帧样本: frames.map((f) => ({ name: String(f.getAttribute('name') || ''), src: String(f.getAttribute('src') || '').slice(0, 80) })).slice(0, 6),
        }
      }
      const r = frame.getBoundingClientRect()
      return { ok: true, left: r.left, top: r.top, width: r.width, height: r.height, name: String(frame.getAttribute('name') || '') }
    }, { src: opt.re.source, excludeName: opt.excludeName, pick: opt.pick })
    .catch((e) => ({ ok: false, why: String((e && e.message) || e) }))
}

/**
 * 「假 iframe」版 frameEval：给那些**已经按 page.evaluate 写好**（在子 frame 里找 `<iframe>` 再读 contentDocument）的模块用。
 * 在子 frame 内把 document.querySelectorAll('iframe') 临时替换成「一个 contentDocument=document 的假 iframe」，
 * 于是原代码里的 frames.find/contentDocument/geom 全部照原样工作 —— 等价于原版 frame.evaluate，不需要改业务流程。
 */
export async function frameEvalShim(page, needle, fn, arg = null) {
  const geom = await mainFrameRect(page, needle)
  if (!geom || geom.ok === false) return geom || { ok: false, why: 'no_frame' }
  let ctx = await frameContext(page, needle)
  if (!ctx.ok) return ctx
  const source = String(fn)
  const build = () =>
    '(async () => {\n' +
    'const __r = ' + JSON.stringify({ left: geom.left, top: geom.top, width: geom.width, height: geom.height, name: geom.name }) + ';\n' +
    'const __fake = { getAttribute: (n) => (n === "src" ? "sucai-selector-ng" : ""), id: "", contentDocument: document, getBoundingClientRect: () => ({ left: __r.left, top: __r.top, width: __r.width, height: __r.height }) };\n' +
    'const __q = document.querySelectorAll.bind(document);\n' +
    'document.querySelectorAll = (sel, ...rest) => (typeof sel === "string" && String(sel).indexOf("iframe") >= 0) ? [__fake] : __q(sel, ...rest);\n' +
    'try { const __fn = (' + source + '); return await __fn(' + JSON.stringify(arg) + '); } finally { document.querySelectorAll = __q; }\n' +
    '})()'
  const run = () =>
    page.cdp('Runtime.evaluate', { expression: build(), contextId: ctx.contextId, returnByValue: true, awaitPromise: true })
  let res
  try {
    res = await run()
  } catch (e) {
    const msg = String((e && e.message) || e)
    if (!/context|Context|execution/i.test(msg)) return { ok: false, why: 'cdp_error', 错误: msg.slice(0, 160) }
    delete page.__tbFrames[ctx.frameId]
    ctx = await frameContext(page, needle)
    if (!ctx.ok) return ctx
    res = await run().catch((e2) => ({ exceptionDetails: { text: String((e2 && e2.message) || e2) } }))
  }
  if (res && res.exceptionDetails) {
    const d = res.exceptionDetails
    return { ok: false, why: 'frame_eval_error', 错误: String((d.exception && (d.exception.description || d.exception.value)) || d.text || '').slice(0, 200) }
  }
  return res && res.result ? res.result.value : { ok: false, why: 'no_value' }
}

/**
 * 在跨域子 frame 里执行函数（等价 Playwright 的 `frame.evaluate(fn, arg)`）。
 * @param page - ego page。
 * @param needle - iframe 关键字。
 * @param fn - 浏览器侧函数（可 async），只能引用浏览器 API。
 * @param arg - 传给该函数的 JSON 参数。
 * @returns 函数返回值；失败返回 `{ ok:false, why }`（context 失效会自动重建重试一次）。
 */
export async function frameEval(page, needle, fn, arg = null) {
  let ctx = await frameContext(page, needle)
  if (!ctx.ok) return ctx
  const source = String(fn)
  const expr = '(async () => { const __f = (' + source + '); return await __f(' + JSON.stringify(arg) + '); })()'
  const run = () =>
    page.cdp('Runtime.evaluate', { expression: expr, contextId: ctx.contextId, returnByValue: true, awaitPromise: true })
  let res
  try {
    res = await run()
  } catch (e) {
    // iframe 重建（详情步会换 panel）→ 隔离世界里的 contextId 失效，重建后重试一次
    const msg = String((e && e.message) || e)
    if (!/context|Context|execution/i.test(msg)) return { ok: false, why: 'cdp_error', 错误: msg.slice(0, 160) }
    delete page.__tbFrames[ctx.frameId]
    ctx = await frameContext(page, needle)
    if (!ctx.ok) return ctx
    res = await run().catch((e2) => ({ exceptionDetails: { text: String((e2 && e2.message) || e2) } }))
  }
  if (res && res.exceptionDetails) {
    const d = res.exceptionDetails
    const text = String((d.exception && (d.exception.description || d.exception.value)) || d.text || '').slice(0, 200)
    return { ok: false, why: 'frame_eval_error', 错误: text }
  }
  return res && res.result ? res.result.value : { ok: false, why: 'no_value' }
}

export default {
  sleep, out, say, waitUntil, connectSpace, gotoUrl, evalIn, clickText, synthClick,
  dismissDialogs, evalInFrame, uploadFiles, currentUrl, isPublishForm, waitPublishForm, frameContext, frameEval, frameEvalShim,
}
