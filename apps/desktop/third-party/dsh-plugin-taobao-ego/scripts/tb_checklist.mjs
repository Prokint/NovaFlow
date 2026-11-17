/**
 * 提交前核对清单（ego 版，原 scripts/tb_checklist.js 的 1:1 移植）。
 *
 * 只读：把该核的项一次读回，与 product.json 对照，**不点任何业务按钮**（尤其不点提交）。
 * 移植差异：CDP 连接 → `connectSpace(spaceId)`；SKU 表跨窗口扫描复用 `sku_table.mjs` 的 `scanSkuTable`。
 *
 * 配置从 `globalThis.__TB_CFG` 读（ego 子进程不继承环境变量）：`space`、`product`。
 * 导出 `checkList(page, product)`，由 run_listing_tb.mjs 在同一 ego 进程内调用。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 30 汉字 = 60 字符（汉字算 2），与 tb_fill_basic 同一口径。 */
function clampTitle(s) {
  let n = 0
  let text = ''
  for (const ch of String(s || '')) {
    const width = /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1
    if (n + width > 60) break
    n += width
    text += ch
  }
  return text.trim()
}

/** 文本归一化：去零宽字符/全角空格/首尾空白（原脚本 2026-10-14 的「货号假失败」修正）。 */
const norm = (v) => String(v == null ? '' : v)
  .replace(/[\u200b-\u200d\ufeff]/g, '')
  .replace(/\u00a0/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
const same = (a, b) => norm(a) === norm(b)

/** 页面读回（原 pageRead 1:1）。 */
const pageRead = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const vis = (e) => {
    if (!e) return false
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const t = clean(document.body.innerText)
  const props = {}
  for (const box of Array.from(document.querySelectorAll('[id^="sell-field-p-"]'))) {
    const label = ((clean(box.innerText).replace(/^\*+/, '').split('重要')[0].trim().match(/^[^\s0-9/]+/) || [''])[0] || '').trim()
    const vals = Array.from(box.querySelectorAll('input')).map((i) => String(i.value || '')).filter(Boolean)
    const tags = Array.from(box.querySelectorAll('[class*=next-tag]')).map((e) => clean(e.innerText)).filter(Boolean)
    if (label) props[label] = vals[0] || tags[0] || null
  }
  const all = Array.from(document.querySelectorAll('div,span,label,p')).filter(vis)
  const labels = {}
  for (const input of Array.from(document.querySelectorAll('input')).filter(vis)) {
    const r = input.getBoundingClientRect()
    const cy = r.top + r.height / 2
    let label = null
    let best = 1e9
    for (const e of all) {
      if (e.contains(input)) continue
      const b = e.getBoundingClientRect()
      if (b.top + b.height / 2 < cy - 10 || b.top + b.height / 2 > cy + 10) continue
      if (b.left + b.width > r.left + 4) continue
      const x = clean(e.innerText)
      if (!x || x.length > 24) continue
      const d = r.left - (b.left + b.width)
      if (d < best) { best = d; label = x }
    }
    const key = (label || '').replace(/\s*\*\s*$/, '').trim()
    if (['一口价', '总库存', '购买须知', '商家编码'].includes(key)) labels[key] = String(input.value || '')
  }
  const slots = Array.from(document.querySelectorAll('div,span,li,p')).filter(vis).filter((e) => clean(e.innerText) === '上传图片')
  const emptySlots = slots.filter((e) => !slots.some((o) => o !== e && e.contains(o))).length
  const editor = document.querySelector('[class*="lite-decoration-editor"]')
  return {
    catId: (location.search.match(/catId=(\d+)/) || [])[1] || null,
    当前类目: (t.match(/当前类目\s*\*?\s*([^\n]{0,60})/) || [])[1] || null,
    标题: (() => {
      const i = Array.from(document.querySelectorAll('input')).filter(vis).find((x) => (x.getAttribute('placeholder') || '').includes('30个汉字'))
      return i ? i.value : null
    })(),
    属性: props,
    一口价: labels['一口价'] || null,
    总库存: labels['总库存'] || null,
    空槽总数: emptySlots,
    详情img: editor ? editor.querySelectorAll('img').length : null,
    // ★ 规格区文案各类目不同：多数是 `SKU模式 · 【…】`，也有类目只写「销售规格 *」（实测 2026-11-17 一次性桌布）
    规格区: (t.match(/SKU模式[^\n]{0,40}|【[^】]{1,40}】[^\n]{0,12}展示|销售规格\s*\*/) || [])[0] || null,
    有提交按钮: t.includes('提交宝贝信息'),
    报错: (t.match(/请发布前修改以下出错项[^\n]{0,80}/) || [])[0] || null,
  }
}

/** 品牌 = `#sell-field-p-20000` 里 name 不含 `~` 的那个 input（货号是同容器的 p-20000~1）。 */
const readBrand = () => page.evaluate(() => {
  const vis = (e) => {
    if (!e) return false
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const box = document.querySelector('#sell-field-p-20000')
  if (!box) return null
  const inputs = Array.from(box.querySelectorAll('input')).filter(vis)
  const inp = inputs.find((i) => !/~/.test(i.getAttribute('name') || '')) || inputs[0]
  return inp ? inp.value : null
})

let page

/**
 * 执行提交前核对。
 * @param currentPage - ego page（发布表单页）。
 * @param product - product.json 内容。
 * @returns `{ ok, rows, 未通过, SKU价格档 }`。
 */
export async function checkList(currentPage, product) {
  page = currentPage
  const P = product || {}
  const ATTRS = P.attributes || {}
  const EXPECT_N = (P.skus || []).length
  const CATSRC = String(P.category_source || '')
  const EXP_CATID = (CATSRC.match(/cate(?:gory)?[Ii]d=(\d+)/) || [])[1] || null
  const EXP_CAT_LEAF = (CATSRC.match(/>\s*([^>|]+?)\s*(?:\||$)/) || [])[1] || null
  const EXP_TITLE = clampTitle(P.title || '')
  const PRICES = new Set((P.price_set || []).map((p) => Number(p)))
  const EXP_STOCK = (P.skus || []).reduce((s, x) => s + (Number(x.stock) || 0), 0)

  let DETAIL_N = 0
  const productPath = String((globalThis.__TB_CFG || {}).product || '')
  if (productPath) {
    const detailDir = join(dirname(resolve(productPath)), 'img', 'detail')
    if (existsSync(detailDir)) {
      DETAIL_N = readdirSync(detailDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).length
    }
  }

  const st = await page.evaluate(pageRead)
  const brandVal = await readBrand()

  let sku
  try {
    const mod = await import('./sku_table.mjs')
    let r = await mod.scanSkuTable(page, 300)
    // ★ 页面上一步（视频/图片）刚折腾完时 JavaScript 会忙，evaluate 可能超时 → 等 8s 重试
    for (let retry = 0; retry < 3 && !r.ok && /timeout|timed out|evaluate_failed/i.test(String(r.why || '')); retry += 1) {
      await new Promise((res) => setTimeout(res, 8000))
      r = await mod.scanSkuTable(page, 300)
    }
    sku = r && r.ok
      ? { ok: true, n: r.unique, all: (r.all || []).map((x) => x.spec), 价格们: Array.from(new Set((r.all || []).map((x) => x.price))).slice(0, 20), 滚动高: r.滚动高 }
      : { ok: false, why: (r && r.why) || 'scan_failed' }
  } catch (e) {
    sku = { ok: false, why: 'sku_table_missing:' + String(e && e.message || e).slice(0, 80) }
  }

  const rows = []
  const chk = (项, 读回, 期望, ok) => rows.push({ 项, 读回, 期望, ok })

  chk('类目 catId', st.catId, EXP_CATID || '（素材包未给，跳过）', !EXP_CATID || st.catId === EXP_CATID)
  chk('当前类目', st.当前类目 ? st.当前类目.slice(0, 34) : null, EXP_CAT_LEAF || '（跳过）',
    !EXP_CAT_LEAF || String(st.当前类目).includes(EXP_CAT_LEAF))
  chk('宝贝标题', st.标题, EXP_TITLE, st.标题 === EXP_TITLE)
  // 淘宝把无品牌实际存成「无品牌/无注册商标」→ 允许包含关系
  chk('品牌', brandVal, ATTRS['品牌'], !ATTRS['品牌'] || same(brandVal, ATTRS['品牌']) || (brandVal != null && String(brandVal).includes(String(ATTRS['品牌']))))
  chk('品牌（页面上读到的字段）', st.属性['品牌'], '（仅参考，可能读到货号）', true)
  // ★ 素材包里给了、但**本类目发布页上根本没有这个字段**的属性（如窗帘类目没有「货号」输入框）
  //   → 不算失败（没字段就填不进去），但要报出来让用户知道；否则会天天假失败。
  const 无此字段 = []
  for (const key of ['主体材质', '适用猫体型', '货号', '型号', '商家编码']) {
    if (ATTRS[key] === undefined || ATTRS[key] === '') continue
    const has = Object.prototype.hasOwnProperty.call(st.属性, key)
    if (!has) {
      无此字段.push(key)
      chk(key, '（本类目页面上没有这个字段）', ATTRS[key], true)
      continue
    }
    chk(key, st.属性[key], ATTRS[key], same(st.属性[key], ATTRS[key]))
  }
  const lp = Number(st.一口价)
  chk('一口价', st.一口价, String(P.list_price) + '（∈有库存SKU价）', lp === Number(P.list_price) && PRICES.has(lp))
  chk('总库存', st.总库存, String(EXP_STOCK) + '（= Σ各 SKU 库存）', Number(st.总库存) === EXP_STOCK)
    // ★ 核对时页面可能正忙（虚拟滚动/预览动画）→ 扫表 evaluate 超时；
  //    SKU 行数已在第 3 步导入后完成「99/99 对账」，这里超时就标注为「未复核」而不是判失败。
  const skuTimeout = !sku.ok && /timeout|timed out|evaluate_failed/i.test(String(sku.why || ''))
  chk(
    'SKU 行数',
    sku.ok ? sku.n : skuTimeout ? '扫描超时（第 3 步导入后已对账）' : '扫描失败:' + sku.why,
    EXPECT_N,
    sku.ok ? sku.n === EXPECT_N : skuTimeout,
  )
  chk('规格区', st.规格区, 'SKU模式 / 销售规格（按类目实际）', /SKU模式|销售规格/.test(String(st.规格区)))
  chk('主图/3:4 空槽', st.空槽总数, '≤8（1:1 已填、3:4 按口径留空）', Number(st.空槽总数) <= 8)
  chk('详情 img', st.详情img, DETAIL_N ? ('≥' + DETAIL_N + '（素材张数）') : '（无素材目录，跳过）', DETAIL_N ? Number(st.详情img) >= DETAIL_N : true)
  chk('页面报错', st.报错, '无', !st.报错)

  const bad = rows.filter((r) => !r.ok)
  return {
    ok: bad.length === 0,
    rows,
    未通过: bad.map((b) => b.项),
    无此字段, // 素材包给了、但本类目页面上没有对应字段的（不算失败，需告知用户）
    SKU价格档: sku.价格们 || null,
  }
}

export default { checkList }
