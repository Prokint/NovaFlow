/**
 * 类目搜索（只读）：在「搜索发品」入口页按关键词搜类目，返回候选类目路径；
 * 也可直接点第 N 个候选进该类目（拿 catId）。
 *
 * 用途：用户只说「上架个猫爬架/地垫」但没给类目路径时，先用它把候选类目找出来，
 * 再让用户挑（或按销量/常规口径挑一个），然后 tb_ego_category_profile 抓要求。
 */
import { sleep, waitUntil } from '../lib/tb_ego.mjs'

const ENTRY = 'https://item.upload.taobao.com/sell/ai/category.htm'

/** 找入口页的关键词输入框（返回视口坐标，点得到才算）。 */
const findKeywordBox = async (page) =>
  page
    .evaluate(() => {
      const vis = (e) => {
        const r = e.getBoundingClientRect()
        return r.width > 40 && r.height > 10
      }
      const inputs = [...document.querySelectorAll('input')].filter(vis)
      const scored = inputs
        .map((i) => ({
          i,
          ph: String(i.getAttribute('placeholder') || ''),
          score: /分类|类目|关键词|商品/.test(String(i.getAttribute('placeholder') || '')) ? 2 : 1,
        }))
        .sort((a, b) => b.score - a.score)
      const best = scored[0]
      if (!best) return { ok: false, why: 'no_input' }
      best.i.scrollIntoView({ block: 'center' })
      const r = best.i.getBoundingClientRect()
      return { ok: true, placeholder: best.ph, x: Math.round(r.left + Math.min(r.width, 240) / 2), y: Math.round(r.top + r.height / 2) }
    })
    .catch(() => ({ ok: false, why: 'eval_failed' }))

/** 读搜索出来的候选类目（文本含 ">>" 或 "/" 的路径行）。 */
const readCandidatePaths = async (page) =>
  page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const looksLikePath = (t) => t.length >= 4 && t.length <= 80 && (t.includes('>>') || t.split('>').length >= 2) && !/^(切换|搜索|最近|推荐)/.test(t)
      const seen = new Set()
      const out = []
      for (const el of [...document.querySelectorAll('div,li,span,a,p')].filter(vis)) {
        const t = clean(el.innerText)
        if (!looksLikePath(t)) continue
        if (seen.has(t)) continue
        seen.add(t)
        out.push({ text: t, tag: el.tagName })
      }
      return out.slice(0, 20)
    })
    .catch(() => [])

/** 点第 index 个候选（按文本精确匹配，返回点击后 URL 与 catId）。 */
const clickCandidate = async (page, text) =>
  page
    .evaluate((want) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const el = [...document.querySelectorAll('div,li,a,p')].filter(vis).find((e) => clean(e.innerText) === want)
      if (!el) return { ok: false, why: 'candidate_gone' }
      // ★ 候选行是纯文本容器，点行中心会落空（实测点了不跳）→ 优先点内部真正的链接/最深同名子节点
      const inner = [...el.querySelectorAll('a,button,span,div,p')]
        .filter(vis)
        .filter((x) => clean(x.innerText) === want)
        .pop()
      const target = el.querySelector('a') || inner || el
      target.scrollIntoView({ block: 'center' })
      const r = target.getBoundingClientRect()
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight
      return {
        ok: true,
        x: Math.round(Math.min(Math.max(r.left + Math.min(r.width, 420) / 2, 5), vw - 5)),
        y: Math.round(Math.min(Math.max(r.top + r.height / 2, 5), vh - 5)),
        tag: target.tagName,
      }
    }, text)
    .catch(() => ({ ok: false, why: 'eval_failed' }))

/** 等「真的进了类目」：URL 出现 catId 或落到 publish.htm（最多 timeoutMs）。 */
const waitEntered = async (page, timeoutMs = 9000) => {
  const t0 = Date.now()
  let last = { url: '', catId: null }
  while (Date.now() - t0 < timeoutMs) {
    last = await page
      .evaluate(() => ({
        url: location.href.slice(0, 200),
        catId: (location.search.match(/catId=(\d+)/) || [])[1] || null,
      }))
      .catch(() => last)
    if (last.catId || /publish\.htm/.test(String(last.url))) return { ok: true, ...last }
    await sleep(400)
  }
  return { ok: false, ...last }
}

/** 合成点击兜底：鼠标点落空时直接对节点派发 click。 */
const synthClick = async (page, text) =>
  page
    .evaluate((want) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const el = [...document.querySelectorAll('div,li,a,p')].find((e) => clean(e.innerText) === want)
      if (!el) return { ok: false, why: 'candidate_gone' }
      const a = el.querySelector('a')
      const t = a || el
      t.click()
      return { ok: true, tag: t.tagName }
    }, text)
    .catch(() => ({ ok: false, why: 'eval_failed' }))

/**
 * 搜索类目。
 * @param page - ego page（可停在任意淘宝页；会自己导航到搜索发品入口）
 * @param keyword - 关键词，如「猫爬架」「地垫」
 * @param options - `{ clickIndex }`：给了就点第 index+1 个候选并返回 catId
 * @returns `{ ok, keyword, placeholder, candidates, entered? }`
 */
export async function searchCategory(page, keyword, options = {}) {
  const kw = String(keyword || '').trim()
  if (!kw) return { ok: false, why: 'no_keyword' }
  const url = String(await page.url().catch(() => ''))
  if (!/sell\/ai\/category\.htm|sell\/(?:ai|v2)\/category/.test(url)) {
    // ego 的 goto 只认 `{ timeout, waitUntil, referer }`；写 `{ timeoutMs }` 会 throw 并被 catch 吞掉 → 静默不导航
    await page.goto(ENTRY, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    await sleep(2200)
  }
  const box = await findKeywordBox(page)
  if (!box.ok) return { ok: false, why: box.why || 'no_input' }

  await page.mouse.move(box.x, box.y).catch(() => {})
  await sleep(120)
  await page.mouse.click(box.x, box.y, { label: 'cat-search-focus' }).catch(() => {})
  await sleep(250)
  // ★ 必须先清空：框里可能还留着上一次的关键词，直接 type 会变成「旧词+新词」的拼接
  //   → 两次搜索返回同一批候选（实测 2026-11-17：搜「门帘」拿回「桌布」的结果）
  await page.keyboard.press('Control+A').catch(() => {})
  await page.keyboard.press('Backspace').catch(() => {})
  await sleep(200)
  await page.keyboard.type(kw, { delay: 40 }).catch(() => {})
  await sleep(200)
  await page.keyboard.press('Enter').catch(() => {})
  await sleep(1200)

  const ready = await waitUntil(
    async () => {
      const cards = await readCandidatePaths(page)
      return cards.length ? cards : null
    },
    { timeoutMs: 12000, intervalMs: 500, label: 'cat-search-results' }
  )
  const candidates = ready.ok ? ready.value : await readCandidatePaths(page)
  const out = { ok: true, keyword: kw, placeholder: box.placeholder, candidates }

  const idx = Number(options.clickIndex)
  if (Number.isInteger(idx) && idx >= 0 && idx < candidates.length) {
    const picked = candidates[idx].text
    const clicked = await clickCandidate(page, picked)
    if (!clicked.ok) {
      out.entered = { ok: false, why: clicked.why || 'click_failed', picked }
      return out
    }
    await page.mouse.move(clicked.x, clicked.y).catch(() => {})
    await sleep(150)
    await page.mouse.click(clicked.x, clicked.y, { label: 'cat-pick' }).catch(() => {})
    // ★ 真鼠标点经常落空 → 等 URL 真变化；没变化就合成点击兜底一次
    let state = await waitEntered(page, 9000)
    let 合成点击 = null
    if (!state.ok) {
      合成点击 = await synthClick(page, picked)
      state = await waitEntered(page, 10000)
    }
    out.entered = { ...state, picked, 目标节点: clicked.tag || null, 合成点击 }
  }
  return out
}

export default { searchCategory }
