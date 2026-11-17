/**
 * 入口段（ego 版）：搜索发品 → 按素材包路径选类目 → 本页选品牌 → 进 publish.htm 表单。
 *
 * 与 Playwright/CDP 原版的差异：
 *   - 连接：`connectSpace(spaceId)`（不再 connectOverCDP(port)）。
 *   - 页面：ego 一店一个活动页；已有 publish.htm 且 catId 匹配时直接读回复用。
 *   - 点击：类目级联/品牌下拉用 DOM 合成 mousedown/mouseup/click（ego 没有 locator）。
 *   - 受控输入框：先用 setter+event，再用真实鼠标点击 + 键盘输入兜底（原版同款顺序）。
 *   - 「确认，下一步」灰着 → 直连 publish.htm 跳过类目页（原版兜底逻辑保留）。
 *
 * 环境变量/参数：
 *   TB_SPACE / --space    ego space id（必填）
 *   TB_CAT / --cat        完整类目路径（> 或 >> 分隔）
 *   TB_CATID / --catid    类目 id
 *   TB_BRAND / --brand    品牌（默认 无品牌）
 *   --product             product.json 路径（用来补类目页的其它必填字段）
 *   --force               忽略已有表单页，重走入口
 */
import { connectSpace, gotoUrl, sleep, say, out, waitUntil } from '../lib/tb_ego.mjs'

/** 结果收集器：编排层调用时只记录；CLI 直跑时在结束时统一打印（ego 的 out 是一行 JSON）。 */
let entryResult = null
const emit = (value) => { entryResult = value; globalThis.__TB_ENTRY_RESULT = value }

const argv = process.argv
/** ego 不继承调用方的自定义环境变量 → 配置必须内联进 -e 脚本（globalThis.__TB_CFG），env 只作本地开发兜底。 */
const INLINE = (typeof globalThis !== 'undefined' && globalThis.__TB_CFG) || {}
const pick = (key, envName, dflt) => {
  if (INLINE[key] !== undefined && INLINE[key] !== null && INLINE[key] !== '') return INLINE[key]
  if (envName && process.env[envName]) return process.env[envName]
  return dflt
}
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  if (i === -1) return dflt
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}
// ★ CLI 直跑时的默认值；编排层调用 enterForm(page, opts) 时用 opts 覆盖（见文件末尾）。
let SPACE = Number(pick('space', 'TB_SPACE', arg('space', 0)))
let CAT = String(pick('cat', 'TB_CAT', ''))
let CATID = String(pick('catid', 'TB_CATID', ''))
let BRAND = String(pick('brand', 'TB_BRAND', '无品牌'))
let PRODUCT_PATH = String(pick('product', '', ''))
let FORCE = !!pick('force', '', false) || !!arg('force', false)
let DEBUG = String(pick('debug', 'TB_DEBUG', '')) === '1'
let LEVELS = CAT.split(/>|>>/).map((s) => s.trim()).filter(Boolean)

/** 入口页读回：是否已登录、级联树是否已展开。 */
const entryState = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const vis = (e) => {
    if (!e) return false
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const t = clean(document.body.innerText)
  return {
    url: location.href.slice(0, 160),
    在类目页: /category\.htm/.test(location.href),
    在表单: /publish\.htm/.test(location.href),
    已登录: /搜索发品/.test(t),
    店铺名: (t.match(/[\u4e00-\u9fa5]{2,}的小店\d*/) || [])[0] || null,
    级联项数: document.querySelectorAll('li.category-item').length,
    开启个数: [...document.querySelectorAll('*')].filter((e) => vis(e) && !e.children.length && clean(e.innerText) === '开启').length,
    有搜索框: [...document.querySelectorAll('input')].filter(vis).length > 0,
  }
}

/** 点「搜索发品」卡片里的「开启」，展开级联树（祖先文本含搜索发品、不含以图发品）。 */
const openSearchPublish = (page) =>
  page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const vis = (e) => {
      if (!e) return false
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const cands = [...document.querySelectorAll('*')].filter((e) => vis(e) && !e.children.length && clean(e.innerText) === '开启')
    for (const el of cands) {
      let p = el
      for (let k = 0; k < 6 && p; k++) {
        const txt = clean(p.innerText || '')
        if (/搜索发品/.test(txt) && !/以图发品/.test(txt)) {
          const r = el.getBoundingClientRect()
          return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
        }
        p = p.parentElement
      }
    }
    return { ok: false, why: 'no_open_in_search_card', count: cands.length }
  })

/** 表单页读回。 */
const formState = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const t = clean(document.body.innerText)
  const box = document.querySelector('#sell-field-p-20000')
  const brand = box ? Array.from(box.querySelectorAll('input')).map((i) => i.value).filter(Boolean)[0] : null
  return {
    url: location.href.slice(0, 200),
    在表单: /publish\.htm/.test(location.href),
    catId: (location.search.match(/catId=(\d+)/) || [])[1] || null,
    来自以图发品: /fromAIImage=true/.test(location.href),
    当前类目: (t.match(/当前类目\s*\*?\s*([^\n]{0,70})/) || [])[1] || null,
    品牌值: brand || null,
    红框报错: (t.match(/请发布前修改以下出错项[^\n]{0,80}/) || [])[0] || null,
  }
}

/** 类目页读回。 */
const catPageState = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const vis = (e) => {
    if (!e) return false
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const popup = document.querySelector('.sell-o-select-options')
  const brandInp = Array.from(document.querySelectorAll('input')).filter(vis)
    .find((i) => (i.getAttribute('placeholder') || '') === '请输入' && !(popup && popup.contains(i)))
  const nb = Array.from(document.querySelectorAll('button')).filter(vis).find((b) => clean(b.innerText).includes('确认，下一步'))
  const t = clean(document.body.innerText)
  return {
    url: location.href.slice(0, 90),
    在类目页: /category\.htm/.test(location.href),
    在表单: /publish\.htm/.test(location.href),
    品牌值: brandInp ? brandInp.value : null,
    下一步disabled: nb ? !!nb.disabled : null,
    底部路径: (t.match(/类目[:：]?\s*([^\n]{0,80})/) || [])[0] || (t.match(/[\u4e00-\u9fa5]{2,}[^\n]{0,60}确认，下一步/) || [])[0] || null,
  }
}

/** 点级联某一级（合成 mousedown/mouseup/click，el.click() 无效）。 */
const clickLevel = (page, lv) =>
  page.evaluate((want) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const vis = (e) => {
      if (!e) return false
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const el = Array.from(document.querySelectorAll('li.category-item')).filter((e) => vis(e) && clean(e.innerText) === want)[0]
    if (!el) {
      return { ok: false, why: 'no_item', want, 可见项: Array.from(document.querySelectorAll('li.category-item')).filter(vis).map((e) => clean(e.innerText)).slice(0, 12) }
    }
    for (const ev of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
    return { ok: true }
  }, lv)

/** 类目页选品牌：下拉自带搜索框过滤 → 点 div.options-item。 */
const pickBrand = (page, want) =>
  page.evaluate(async (brand) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const vis = (e) => {
      if (!e) return false
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const outside = () => {
      const pop = document.querySelector('.sell-o-select-options')
      const ok = (i) => (i.getAttribute('placeholder') || '') === '请输入' && !/~/.test(i.getAttribute('name') || '') && !(pop && pop.contains(i))
      const inBox = document.querySelector('#sell-field-p-20000')
      if (inBox) {
        const i2 = Array.from(inBox.querySelectorAll('input')).filter(vis).find(ok)
        if (i2) return i2
      }
      const cands = Array.from(document.querySelectorAll('div,label')).filter(vis)
        .filter((e) => /^\*?\s*品牌(\s|$)/.test(clean(e.innerText)) && clean(e.innerText).length < 200)
      cands.sort((a, b) => a.innerText.length - b.innerText.length)
      for (const c of cands) {
        let p = c
        for (let k = 0; k < 3 && p; k++) {
          const i3 = Array.from(p.querySelectorAll('input')).filter(vis).find(ok)
          if (i3) return i3
          p = p.parentElement
        }
      }
      return Array.from(document.querySelectorAll('input')).filter(vis).find(ok) || null
    }
    let inp = outside()
    if (!inp) return { ok: false, why: 'no_brand_input' }
    if (inp.value === brand) return { ok: true, already: true, 品牌值: inp.value }
    if (inp.getAttribute('aria-expanded') !== 'true') {
      inp.focus()
      for (const ev of ['mousedown', 'mouseup', 'click']) inp.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
      await new Promise((r) => setTimeout(r, 2500))
    }
    const pop = document.querySelector('.sell-o-select-options')
    if (!pop) return { ok: false, why: 'no_popup' }
    const search = Array.from(pop.querySelectorAll('input')).filter(vis)[0]
    if (!search) return { ok: false, why: 'no_search_input' }
    search.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(search, brand)
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 2500))
    const items = Array.from(pop.querySelectorAll('.options-item')).filter(vis)
    const hit = items.find((e) => clean(e.innerText) === brand) || items.find((e) => clean(e.innerText).includes(brand))
    if (!hit) return { ok: false, why: 'option_not_found', 过滤后: items.map((e) => clean(e.innerText)).slice(0, 20) }
    for (const ev of ['mousedown', 'mouseup', 'click']) hit.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
    await new Promise((r) => setTimeout(r, 1800))
    const after = outside()
    return { ok: true, 选中: clean(hit.innerText), 品牌值: after ? after.value : null }
  }, want)

/** 点「确认，下一步」。 */
const nextStep = (page) =>
  page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const vis = (e) => {
      if (!e) return false
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const nb = Array.from(document.querySelectorAll('button')).filter(vis).find((b) => clean(b.innerText).includes('确认，下一步'))
    if (!nb) return { ok: false, why: 'no_next_btn' }
    if (nb.disabled) return { ok: false, why: 'still_disabled' }
    for (const ev of ['mousedown', 'mouseup', 'click']) nb.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
    return { ok: true }
  })

/**
 * 入口段主函数（供 run_listing_tb.mjs 在同一 ego 进程内调用；页面由调用方连好后传进来）。
 * @param page - ego page。
 * @param opts - `cat` / `catid` / `brand` / `product` / `force` / `debug` 覆盖（缺省用 __TB_CFG 或 CLI 参数）。
 * @returns `{ ok, 步骤, 状态?, reused?, why? }`。
 */
export async function enterForm(page, opts = {}) {
  if (opts.cat !== undefined) { CAT = String(opts.cat); LEVELS = CAT.split(/>|>>/).map((s) => s.trim()).filter(Boolean) }
  if (opts.catid !== undefined) CATID = String(opts.catid)
  if (opts.brand !== undefined) BRAND = String(opts.brand)
  if (opts.product !== undefined) PRODUCT_PATH = String(opts.product)
  if (opts.force !== undefined) FORCE = !!opts.force
  if (opts.debug !== undefined) DEBUG = opts.debug === true || String(opts.debug) === '1'
  entryResult = null
  try {
  if (DEBUG) {
    say('chosen =', String(await page.url().catch(() => '?')))
  }

  // ① 幂等：当前页已是目标 catId 的表单页 → 直接读回复用
  const before = await page.evaluate(formState).catch(() => null)
  if (!FORCE && before && before.在表单 && (!CATID || before.catId === CATID) && !before.来自以图发品) {
    say('已有可用表单页 → 直接读回，不重开')
    emit({ ok: true, reused: true, 步骤: 'reuse', 状态: before })
    process.exitCode = 0
  } else {
    // ② 入口页：已在发品域名的类目页就直接用（**重复 goto 会掉登录**）；否则导航一次，再等就绪
    let entry = await page.evaluate(entryState).catch(() => null)
    if (!(entry && entry.在类目页)) {
      await gotoUrl(page, 'https://item.upload.taobao.com/sell/ai/category.htm', 1500)
    }
    const checkEntry = async () => {
      const st = await page.evaluate(entryState).catch(() => null)
      if (!st) return null
      if (st.在表单) return st
      if (!(st.在类目页 && st.已登录)) return null
      return (st.级联项数 > 0 || st.开启个数 > 0) ? st : null
    }
    let ready = await waitUntil(checkEntry, { timeoutMs: 12000, intervalMs: 1000, label: 'entry-page-ready' })
    if (!ready.ok) {
      // ★ 恢复：跑过「类目搜索」之后页面会停在**搜索结果面板**（级联树没渲染、也没有「开启」卡片），
      //   这时先试 Escape/清空搜索框；再不行 reload 一次把入口页重置成「两张卡片」状态（实测有效）。
      say('   入口页不是「卡片/级联树」状态（可能停在搜索结果面板）→ 尝试重置')
      await page.keyboard.press('Escape').catch(() => {})
      await sleep(600)
      ready = await waitUntil(checkEntry, { timeoutMs: 6000, intervalMs: 800, label: 'entry-reset-esc' })
      if (!ready.ok) {
        say('   Escape 无效 → reload 入口页重置')
        await page.reload().catch(() => {})
        await sleep(7000)
        ready = await waitUntil(checkEntry, { timeoutMs: 30000, intervalMs: 1000, label: 'entry-reset-reload' })
      }
    }
    entry = ready.value
    if (!entry) {
      const diag = await page.evaluate(entryState).catch((e) => ({ ERR: String(e && e.message || e) }))
      say('✗ 入口页未就绪，诊断 =', JSON.stringify(diag))
      throw new Error('entry_page_not_ready')
    }
    say('① 入口页:', entry.在类目页 ? '在类目页 ✓' : '不在类目页 ✗', '| 店铺 =', entry.店铺名, '| 级联项数 =', entry.级联项数)

    // ①b 这版入口页先给两张卡片（搜索发品 / 以图发品）：必须点「搜索发品」的开启，级联树才渲染
    if (entry.级联项数 === 0) {
      const opened = await openSearchPublish(page)
      say('①b 点「搜索发品」开启:', JSON.stringify(opened))
      if (!opened.ok) throw new Error('open_search_publish_failed')
      await page.mouse.click(opened.x, opened.y, { label: 'open search publish' })
      const grew = await waitUntil(async () => {
        const n = await page.evaluate(() => document.querySelectorAll('li.category-item').length).catch(() => 0)
        return n > 0 ? n : null
      }, { timeoutMs: 25000, intervalMs: 800, label: 'cascade-tree' })
      say('   级联树项数 =', grew.value || 0)
      if (!grew.value) throw new Error('cascade_tree_not_rendered')
    }

    // ③ 逐级点类目
    for (const lv of LEVELS) {
      const r = await clickLevel(page, lv)
      say(`② 点级联「${lv}」:`, r.ok ? 'ok' : JSON.stringify(r))
      if (!r.ok) { emit({ ok: false, 步骤: '类目级联', 层级: lv, ...r }); process.exitCode = 1; throw new Error('cascade_failed') }
      await sleep(2500)
    }
    const afterCat = await page.evaluate(catPageState)
    say('③ 类目已选:', afterCat.底部路径, '| 下一步disabled =', afterCat.下一步disabled)

    // ④ 选品牌（类目页可能没有品牌字段：地毯类目实测如此）
    let brandSkipped = false
    const brandRes = await pickBrand(page, BRAND)
    say('④ 选品牌:', JSON.stringify(brandRes))
    if (!brandRes.ok) {
      const st = brandRes.why === 'no_brand_input' ? await page.evaluate(catPageState) : null
      if (st && st.下一步disabled === false) {
        brandSkipped = true
        say('   类目页无品牌字段，但「确认，下一步」已点亮 → 本类目品牌非必选，跳过（品牌到表单页处理）')
      } else {
        emit({ ok: false, 步骤: '品牌', ...brandRes, ...(st || {}) })
        process.exitCode = 1
        throw new Error('brand_failed')
      }
    }
    await sleep(2000)

    // ④b/④c 其它必填（墙纸类目的「货号」等）：setter 先填，再用真实鼠标+键盘兜底
    if (PRODUCT_PATH) {
      const { readFileSync } = await import('node:fs')
      const { resolve } = await import('node:path')
      const attrs = JSON.parse(readFileSync(resolve(PRODUCT_PATH), 'utf8')).attributes || {}
      const filled = await page.evaluate(async (want) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const vis = (e) => {
          if (!e) return false
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const sl = (ms) => new Promise((r) => setTimeout(r, ms))
        const done = []
        for (const [label, val] of Object.entries(want)) {
          if (label === '品牌') continue
          let box = Array.from(document.querySelectorAll('[id^="sell-field-p-"]')).find((b) => clean(b.innerText).includes(label))
          if (!box) {
            const cands = Array.from(document.querySelectorAll('div')).filter(vis)
              .filter((e) => new RegExp('^\\*?\\s*' + label).test(clean(e.innerText)) && clean(e.innerText).length < 20)
            cands.sort((a, b) => a.innerText.length - b.innerText.length)
            box = cands[0] || null
          }
          if (!box) { done.push({ label, 跳过: '找不到容器' }); continue }
          let inp = Array.from(box.querySelectorAll('input')).filter(vis)[0]
          if (!inp) {
            let p = box.parentElement
            for (let k = 0; k < 4 && p && !inp; k++) {
              inp = Array.from(p.querySelectorAll('input')).filter(vis)[0]
              if (!inp) p = p.parentElement
            }
          }
          if (!inp) { done.push({ label, 跳过: '无输入框' }); continue }
          if (inp.value === String(val)) { done.push({ label, 已是: val }); continue }
          inp.focus()
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          setter.call(inp, String(val))
          for (const ev of ['input', 'change', 'blur']) inp.dispatchEvent(new Event(ev, { bubbles: true }))
          await sl(450)
          done.push({ label, 填入: String(val), 读回: inp.value })
        }
        return done
      }, attrs)
      say('④b 类目页其它必填:', JSON.stringify(filled))
      for (const [label, val] of Object.entries(attrs)) {
        if (label === '品牌') continue
        const c = await page.evaluate((lb) => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
          const vis = (e) => {
            if (!e) return false
            const r = e.getBoundingClientRect()
            return r.width > 0 && r.height > 0
          }
          const cands = Array.from(document.querySelectorAll('div')).filter(vis)
            .filter((e) => new RegExp('^\\*?\\s*' + lb).test(clean(e.innerText)) && clean(e.innerText).length < 20)
          cands.sort((a, b) => a.innerText.length - b.innerText.length)
          let p = cands[0]
          for (let k = 0; k < 4 && p; k++) {
            const i = Array.from(p.querySelectorAll('input')).filter(vis)[0]
            if (i) {
              const r = i.getBoundingClientRect()
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
            }
            p = p.parentElement
          }
          return null
        }, label)
        if (!c) continue
        await page.mouse.click(c.x, c.y)
        await sleep(300)
        await page.keyboard.press('Control+A').catch(() => {})
        await page.keyboard.insertText(String(val)).catch(() => {})
        await sleep(700)
        await page.keyboard.press('Tab').catch(() => {})
        await sleep(300)
        await page.mouse.click(1250, 60)
        await sleep(900)
      }
      await sleep(1200)
    }

    const afterBrand = await page.evaluate(catPageState)
    say('⑤ 品牌后: 品牌值 =', afterBrand.品牌值, '| 下一步disabled =', afterBrand.下一步disabled)

    // ★ 用户口径（2026-11-16）：有些类目的类目页除了品牌还要求「型号」这类必填项，
    //   不填「确认，下一步」就一直是灰的 → 以前只能直连 publish.htm，没给 catid 时还会落成空页。
    //   这里把页面上**标 * 且仍为空的文本输入**统一填一个占位值，并把占位清单带回报告，
    //   让上层「拿到素材包后再问用户」确认（绝不静默把占位值当真实数据提交）。
    let 占位填写 = []
    if (afterBrand.下一步disabled) {
      try {
        const PLACEHOLDER = String(pick('placeholder', 'TB_PLACEHOLDER', '') || '通用款')
        const cleanOf = (s) => (s || '').replace(/\s+/g, ' ').trim()
        // ① 先只**定位**目标输入框（判断放 evaluate 里，写入用真实鼠标+键盘）
        const targets = await page.evaluate(() => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
          const vis = (e) => {
            if (!e) return false
            const r = e.getBoundingClientRect()
            return r.width > 0 && r.height > 0
          }
          const out = []
          const seen = new Set()
          const push = (inp, label) => {
            if (!inp || String(inp.value || '').trim() || inp.readOnly || inp.disabled) return
            if (seen.has(inp)) return
            seen.add(inp)
            const r = inp.getBoundingClientRect()
            const vw = document.documentElement.clientWidth
            const vh = document.documentElement.clientHeight
            out.push({
              字段: label || '',
              name: String(inp.getAttribute('name') || ''),
              x: Math.round(Math.min(Math.max(r.left + r.width / 2, 5), vw - 5)),
              y: Math.round(Math.min(Math.max(r.top + r.height / 2, 5), vh - 5)),
            })
          }
          // ① 表单页式：sell-field-p-<id> 容器里标 * 的必填
          for (const box of Array.from(document.querySelectorAll('[id^="sell-field-p-"]'))) {
            const label = clean(box.innerText).split('重要')[0].trim()
            if (!/^\*/.test(label)) continue
            push(Array.from(box.querySelectorAll('input')).filter(vis)[0], label.replace(/^\*+\s*/, '').split(/[\s0-9/]/)[0])
          }
          // ② 类目页式：没有 sell-field-p 容器，只有 name="p-<id>" / "p-<id>~1"
          //    （实测「型号」= p-20000~1，是品牌 p-20000 的子字段；不扫这里永远填不上 → 下一步一直灰）
          for (const inp of Array.from(document.querySelectorAll('input')).filter(vis)) {
            const nm = String(inp.getAttribute('name') || '')
            if (/^p-\d/.test(nm)) push(inp, nm)
          }
          return out
        })
        // ② 真实鼠标逐项填 + Tab + 点空白处（React 受控输入必须真 blur 才提交，合成事件不算）
        for (const t of targets) {
          await page.mouse.move(t.x, t.y).catch(() => {})
          await sleep(120)
          await page.mouse.click(t.x, t.y, { label: 'ph-focus:' + t.字段 })
          await sleep(200)
          await page.keyboard.press('Control+A').catch(() => {})
          await page.keyboard.insertText(PLACEHOLDER).catch(() => {})
          await sleep(250)
          await page.keyboard.press('Tab').catch(() => {})
          await sleep(250)
          占位填写.push({ ...t, 占位值: PLACEHOLDER })
        }
        // ★ 用户口径：填完必须点一下空白处（真实鼠标 blur），否则「确认，下一步」不会点亮
        await page.mouse.click(1250, 60, { label: 'click-blank' }).catch(() => {})
        await sleep(1500)
        // ③ 读回（按 name 精确取值）
        const names = targets.map((t) => t.name).filter(Boolean)
        const 读回 = names.length
          ? await page
              .evaluate((ns) => {
                const map = {}
                for (const n of ns) {
                  const i = document.querySelector(`input[name="${n}"]`)
                  map[n] = i ? String(i.value || '') : null
                }
                return map
              }, names)
              .catch(() => ({}))
          : {}
        占位填写 = 占位填写.map((r) => ({ ...r, 读回: r.name && names.includes(r.name) ? 读回[r.name] : undefined }))
        if (占位填写.length) say('④d 类目页必填占位填写（**待用户确认**）:', JSON.stringify(占位填写))
      } catch (e) {
        say('④d 占位填写失败（继续走直连兜底）:', String((e && e.message) || e).slice(0, 120))
      }
    }

    const afterFill = await page.evaluate(catPageState)
    say('⑤b 占位后: 下一步disabled =', afterFill.下一步disabled)
    const afterBrand2 = afterFill
    afterBrand.下一步disabled = afterFill.下一步disabled

    if (afterBrand2.下一步disabled) {
      say('  ⚠ 类目页「确认，下一步」仍灰着 → 改用直连 publish.htm 跳过类目页')
      if (!CATID) {
        emit({ ok: false, 步骤: '下一步', why: 'next_disabled_no_catid', 状态: afterBrand2, 占位填写,
          提示: '类目页还有必填没满足，且本次没给 catid → 无法安全直连。请把「品牌/型号」等必填补齐，或直接给 catid+cat。' })
        process.exitCode = 1
        throw new Error('next_disabled_no_catid')
      }
      const jump = 'https://item.upload.taobao.com/sell/v2/publish.htm?catId=' + CATID +
        '&fromAICategory=true&keyProps=%7B%7D&fromAIPublish=true&newRouter=1'
      await page.goto(jump, { waitUntil: 'domcontentloaded' }).catch((e) => say('  直连 goto 失败:', String(e.message).slice(0, 50)))
      await sleep(12000)
      const afterJump = await page.evaluate(formState)
      say('  直连落地:', String(afterJump.url).slice(0, 90), '| 在表单 =', afterJump.在表单, '| catId =', afterJump.catId)
      if (!(afterJump.在表单 && (!CATID || afterJump.catId === CATID))) {
        emit({ ok: false, 步骤: '下一步', why: 'still_disabled', 状态: afterBrand2, 占位填写 })
        process.exitCode = 1
        throw new Error('next_step_failed')
      }
      say('  ✓ 已直连进入表单（类目页那批必填留给表单页）')
      brandSkipped = true
    } else {
      const nx = await nextStep(page)
      say('⑥ 点「确认，下一步」:', JSON.stringify(nx))
      await sleep(15000)
    }

    const st = await page.evaluate(formState)
    say('⑦ 落地:', String(st.url).slice(0, 90))
    const ok = st.在表单 && (!CATID || st.catId === CATID) && (brandSkipped || st.品牌值 === BRAND) && !st.红框报错
    emit({
      ok,
      步骤: 'done',
      状态: st,
      期望: { catId: CATID || 'any', 品牌: brandSkipped ? '（类目页无此字段，表单页处理）' : BRAND },
      // ★ 类目页用占位值补的必填（如「型号」）——上层要提示用户「拿到素材包后确认/改成真实值」
      占位填写,
      占位提示: 占位填写.length ? '这些字段是类目页必填、当时用了占位值，需用户确认并改成真实值' : null,
    })
    process.exitCode = ok ? 0 : 1
  }
} catch (e) {
  emit({ ok: false, 步骤: 'exception', why: String(e && e.message || e) })
}
  return entryResult || { ok: false, 步骤: 'exception', why: 'no_result' }
}

// ── CLI 直跑（ego 不继承自定义环境变量：配置走 globalThis.__TB_CFG）──────────────────
//   ego nodejs -e "globalThis.__TB_CFG={space:5,cat:'...',catid:'...'}; await import('file:///<插件目录>/scripts/tb_enter_form.mjs')"
// 由 run_listing_tb.mjs 调用时（globalThis.__TB_ORCHESTRATOR=true），不执行这里。
if (!globalThis.__TB_ORCHESTRATOR) {
  try {
    const connected = await connectSpace(SPACE, { preferUrl: /item\.upload\.taobao\.com|login\.taobao\.com/ })
    const res = await enterForm(connected.page)
    out(res)
    process.exitCode = res && res.ok ? 0 : 1
  } catch (e) {
    out({ ok: false, 步骤: 'exception', why: String(e && e.message || e) })
    process.exitCode = 1
  }
}
