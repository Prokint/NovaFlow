/**
 * SKU 表的统一读取（ego 版）—— 虚拟滚动 → 跨窗口取并集（等价原 scripts/sku_table.js）。
 *
 * 原脚本：taobao-product-listing\scripts\sku_table.js
 *         （Playwright + CDP 版，只读参照，本文件不改它）
 *
 * 为什么单独成模块（原注释保留）：`tb_import_sku.js` 与 `tb_checklist.js` 原来各有一份扫表逻辑，
 * 两份都只认「颜色-尺寸挤在一列」的老格式（判据是「某个单元格文本里含 `-`」）。换成两层规格
 * （颜色分类 × 地毯尺寸各自一列）后：一份读到 0 行、另一份读到 9 行（把 9 个颜色当成了 9 行），
 * 而页面「总库存 6034」其实已经是 99 行之和 —— 读法不一致会造出「明明成功了却报失败」。
 *
 * 现场结构（2026-10-13 实测，地毯 catId 50000582，两层规格，行 18 个 td）：
 *   `sell-sku-cell-im`(图位) / 两个 `is-sale-prop`(**颜色、尺寸**，是文本不是 input) /
 *   `sell-sku-cell-mo*`(价格 input) / `sell-sku-cell-po*`(数量 input) / `sell-sku-cell-se*`(SKU分类) /
 *   若干空 `sk` 格 / 两个 `sell-sku-cell-co*`(隐藏回显 input，值与颜色/尺寸相同) / 上传素材 /
 *   两个 `sell-sku-cell-in*` input（**第一个 = 商家编码**，第二个 = 商品条形码）/ 去填写 / sw / 查看删除
 *   虚拟滚动容器 = **`.ver-scroll-wrap`**（99 行时 scrollHeight≈6481，DOM 只渲染 17 行）
 *
 * 键口径：**`颜色 + '-' + 尺寸`** —— 与 `tb_import_sku.js` 的 EXPECT_SET、`product.json` 的
 * `colors`/`styles` 对齐。单层规格（老格式）下没有尺寸列，键就是那一列的值本身。
 *
 * ── 移植差异（ego 版）───────────────────────────────────────────────
 * 1. 原版 `page.evaluate(SCAN_SRC, step)`（Playwright）→ ego 同签名保留。SCAN_SRC 仍是**完全自包含**的
 *    浏览器侧函数（不引用模块作用域任何变量、只吃一个 number），因为 ego 的 evaluate 会把函数源码
 *    序列化到页面里执行。
 * 2. 原版 `module.exports = { scanSkuTable }`（CommonJS + shebang + CLI）→ ego 版改 ESM named exports；
 *    另给两个等价别名：`readAllSkuRows(page, opts)` / `scanTable(page, step)`（沿用 tb_import_sku 的旧名）。
 *    ★ 接口约定（Lead/编排层）：`scanSkuTable(page, step = 300)` 成功返回
 *      `{ ok:true, unique, all:[{ spec, price, stock, code, … }], 滚动高 }`，失败 `{ ok:false, why }`。
 *      （原版默认 step=150，导入段显式传 400；ego 版默认取 300，导入段仍传 400。）
 * 3. 去掉 node 侧 fs/path 依赖、shebang、console.log —— 读回值一律 return，由编排层（run_listing_tb.mjs）打印。
 * 4. 新增两个**只读**便利函数（原版没有，供 tb_import_sku / 核对清单用）：
 *      findSkuRow(page, spec, opts)   单行定位：在虚拟滚动里滚到该行并读回价格/数量/编码/条形码
 *      skuTableGeometry(page)         表几何读回：表头 / DOM 行数 / 滚动容器与高度（失败诊断用）
 * 5. 新增 scrollLeft 归零（SKILL 门禁 9：「横向 scrollLeft 常在右侧 → 先归零」）；原脚本只归零 scrollTop。
 *    纯读操作，不动表内容。
 * 6. step 做下限保护（原版 step=0 会在 `for (y += 0)` 里死循环）→ 最小 40px。
 *
 * ── 仍依赖的硬规则（一条都不许改）───────────────────────────────────
 * A. 扫**多轮**直到连续两轮行数一致（最多 4 轮）：小步长 + 正反双向。
 *    实测同一张 99 行的表，一轮能读到 93、甚至 69 —— 少读会被误判「行数不够」，
 *    进而触发**重复导入**（「在当前规格后添加」是**追加**、不可逆，会把 72 行变成 198 行）。很危险。
 * B. sticky 继承（粘性单元格）：同色多行的颜色格可能被合并/隐藏 → 用上一行颜色前向填充
 *    （lastColor 在 collect 外层声明，**跨轮保留**）；只有一格有文本时按 `^\d+…[x×*]…` 判它是尺寸、
 *    颜色用 lastColor 补。
 * C. 行判据：`td.className` 含 `is-sale-prop` 才是规格值；价格/数量取 `sell-sku-cell-mo*`/`-po*` 里的
 *    input；商家编码/条形码取 `sell-sku-cell-in*` 的两个 input（ins[0]/ins[1]）。
 * D. 虚拟滚动容器优先 `.ver-scroll-wrap`，否则退回「scrollHeight-clientHeight 最大的祖先」。
 * E. **不许**按「单元格文本里含 `-`」判规格（老判据会把两层规格读成 0 行）。
 */

/**
 * 原版 SCAN_SRC 原样移植（只加 scrollLeft 归零 + 一个 横向归零 读回字段）。
 * ★ 必须是自包含函数：ego 的 page.evaluate 会把它序列化后注入页面。
 * @param step - 纵向步长（px）。返回读回对象（对应原版 scanSkuTable 的返回值）。
 */
export const SCAN_SRC = async (step) => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const sl = (ms) => new Promise((r) => setTimeout(r, ms))
  const table = Array.from(document.querySelectorAll('table')).find((t) => t.querySelector('tbody tr'))
  if (!table) return { ok: false, why: 'no_table' }
  // 虚拟滚动容器：优先 `.ver-scroll-wrap`（实测就是它），否则退回到「可滚最高的祖先」
  let sc = table.closest('.ver-scroll-wrap')
  if (!sc || sc.scrollHeight - sc.clientHeight <= 0) {
    let best = 0
    let cur = table
    while (cur) {
      const can = cur.scrollHeight - cur.clientHeight
      if (can > best) {
        best = can
        sc = cur
      }
      cur = cur.parentElement
    }
  }
  if (!sc) return { ok: false, why: 'no_scroll_container' }

  const rows = new Map()
  let lastColor = null
  let 横向归零 = false
  const collect = () => {
    table.querySelectorAll('tbody tr').forEach((tr) => {
      const tds = Array.from(tr.querySelectorAll('td'))
      const props = tds
        .filter((td) => /is-sale-prop/.test(td.className))
        .map((td) => clean(td.innerText))
        .filter(Boolean)
      if (!props.length) return
      let color = null
      let size = null
      if (props.length >= 2) {
        color = props[0]
        size = props[1]
      } else {
        // 只有一列有文本：判断这列是尺寸还是颜色（尺寸形如 `30x100cm`）。
        // 颜色列在「同色多行」里可能被合并/隐藏 → 用上一行的颜色补（前向填充）。
        if (/^\d+(\.\d+)?\s*[x×*]\s*\d+/.test(props[0])) {
          size = props[0]
          color = lastColor
        } else {
          color = props[0]
        }
      }
      if (color) lastColor = color
      if (!color && !size) return
      const spec = size ? color + '-' + size : color || size
      const val = (re) => {
        const td = tds.find((t) => new RegExp(re).test(t.className))
        const i = td && td.querySelector('input')
        return i ? String(i.value || '').trim() : null
      }
      const ins = tds
        .filter((td) => /sell-sku-cell-in/.test(td.className))
        .map((td) => {
          const i = td.querySelector('input')
          return i ? String(i.value || '').trim() : ''
        })
      rows.set(spec, {
        spec,
        color,
        style: size,
        price: val('sell-sku-cell-mo'),
        stock: val('sell-sku-cell-po'),
        code: ins[0] || null,
        barcode: ins[1] || null,
      })
    })
  }
  // ★ 扫**多轮**直到连续两轮结果一致（虚拟滚动渲染有延迟，一轮会漏行）：
  //   实测同一张 99 行的表，一轮能读到 93、甚至 69 —— 少读会被误判成"行数不够"，
  //   进而触发**重复导入**（很危险）。所以：小步长 + 正反双向 + 多轮取稳定值。
  const trace = []
  const onePass = async () => {
    sc.scrollTop = 0
    // 门禁 9：横向 scrollLeft 常在右侧 → 先归零（纯读操作，不影响表内容）
    if (sc.scrollLeft) {
      sc.scrollLeft = 0
      横向归零 = true
    }
    await sl(350)
    collect()
    for (let y = 0; y <= sc.scrollHeight + step; y += step) {
      sc.scrollTop = y
      await sl(120)
      collect()
    }
    sc.scrollTop = sc.scrollHeight
    await sl(300)
    collect()
    for (let y = sc.scrollHeight; y >= 0; y -= step) {
      sc.scrollTop = y
      await sl(120)
      collect()
    }
    sc.scrollTop = 0
    await sl(200)
    collect()
  }
  let prev = -1
  for (let pass = 0; pass < 4; pass++) {
    await onePass()
    trace.push(rows.size)
    if (rows.size === prev) break // 连续两轮一致 → 认为读全了
    prev = rows.size
  }
  return {
    ok: true,
    unique: rows.size,
    all: Array.from(rows.values()),
    滚动容器: clean(sc.className).slice(0, 40),
    滚动高: sc.scrollHeight,
    可见高: sc.clientHeight,
    增长轨迹: trace,
    横向归零,
  }
}

/**
 * 单行定位（新增函数，只读）：把虚拟滚动逐窗滚一遍，找到 spec 对应的那一行并读回单元格。
 * 精确命中优先；找不到精确值时接受「粘性继承推断」的候选（颜色列被合并/隐藏时只能这样认）。
 * @param page - ego page。
 * @param spec - 规格键 `颜色-尺寸`（单层规格时就是那一列的值）。
 * @param opts - `step` 步长（默认 300）。
 * @returns `{ ok, spec, 命中, 精确, 粘性继承?, 行号, 颜色, 尺寸, price, stock, code, barcode, 滚动位置 }`
 *          或 `{ ok:false, why:'no_table'|'no_scroll_container'|'row_not_found', … }`。
 */
export const FIND_ROW_SRC = async ({ spec, step }) => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const sl = (ms) => new Promise((r) => setTimeout(r, ms))
  const table = Array.from(document.querySelectorAll('table')).find((t) => t.querySelector('tbody tr'))
  if (!table) return { ok: false, why: 'no_table' }
  let sc = table.closest('.ver-scroll-wrap')
  if (!sc || sc.scrollHeight - sc.clientHeight <= 0) {
    let best = 0
    let cur = table
    while (cur) {
      const can = cur.scrollHeight - cur.clientHeight
      if (can > best) {
        best = can
        sc = cur
      }
      cur = cur.parentElement
    }
  }
  if (!sc) return { ok: false, why: 'no_scroll_container' }

  const want = String(spec)
  const dash = want.indexOf('-')
  const wantColor = dash > 0 ? want.slice(0, dash) : want
  const wantSize = dash > 0 ? want.slice(dash + 1) : null
  const readCells = (tds) => {
    const val = (re) => {
      const td = tds.find((t) => new RegExp(re).test(t.className))
      const i = td && td.querySelector('input')
      return i ? String(i.value || '').trim() : null
    }
    const ins = tds
      .filter((td) => /sell-sku-cell-in/.test(td.className))
      .map((td) => {
        const i = td.querySelector('input')
        return i ? String(i.value || '').trim() : ''
      })
    return { price: val('sell-sku-cell-mo'), stock: val('sell-sku-cell-po'), code: ins[0] || null, barcode: ins[1] || null }
  }
  let exact = null
  let stickyGuess = null
  const seen = new Set()
  const collect = () => {
    let lastColor = null
    table.querySelectorAll('tbody tr').forEach((tr, idx) => {
      const tds = Array.from(tr.querySelectorAll('td'))
      const props = tds
        .filter((td) => /is-sale-prop/.test(td.className))
        .map((td) => clean(td.innerText))
        .filter(Boolean)
      if (!props.length) return
      let color = null
      let size = null
      if (props.length >= 2) {
        color = props[0]
        size = props[1]
      } else if (/^\d+(\.\d+)?\s*[x×*]\s*\d+/.test(props[0])) {
        size = props[0]
        color = lastColor
      } else {
        color = props[0]
      }
      if (color) lastColor = color
      if (!color && !size) return
      const rowSpec = size ? color + '-' + size : color || size
      seen.add(rowSpec)
      if (rowSpec === want) {
        if (!exact) exact = Object.assign({ 行号: idx, 精确: true, 粘性继承: false, 行键: rowSpec, 颜色: color, 尺寸: size, 滚动位置: sc.scrollTop }, readCells(tds))
        return
      }
      // 窗口起点落在同色组中间时，首行颜色格为空、lastColor 为 null → 只能按「尺寸 + 期望颜色」估一个
      if (!stickyGuess && wantSize && size === wantSize && !color) {
        stickyGuess = Object.assign({ 行号: idx, 精确: false, 粘性继承: true, 行键: rowSpec, 颜色: null, 尺寸: size, 滚动位置: sc.scrollTop }, readCells(tds))
      }
    })
  }
  sc.scrollTop = 0
  if (sc.scrollLeft) sc.scrollLeft = 0
  await sl(300)
  collect()
  for (let y = 0; y <= sc.scrollHeight + step && !exact; y += step) {
    sc.scrollTop = y
    await sl(120)
    collect()
  }
  if (!exact) {
    sc.scrollTop = sc.scrollHeight
    await sl(250)
    collect()
  }
  const hit = exact || stickyGuess
  if (!hit) {
    return {
      ok: false,
      why: 'row_not_found',
      spec: want,
      期望颜色: wantColor,
      期望尺寸: wantSize,
      扫到: Array.from(seen).slice(0, 12),
      扫到数: seen.size,
    }
  }
  return { ok: true, spec: want, 命中: hit.行键, 备注: exact ? '精确命中' : '粘性继承推断（颜色格被合并/隐藏）', ...hit }
}

/** 表几何读回（新增函数，只读）：诊断「读不到表 / 读到 0 行」时到底卡在哪。 */
export const GEOMETRY_SRC = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const table = Array.from(document.querySelectorAll('table')).find((t) => t.querySelector('tbody tr'))
  if (!table) return { ok: false, why: 'no_table', 表数: document.querySelectorAll('table').length }
  let sc = table.closest('.ver-scroll-wrap')
  if (!sc || sc.scrollHeight - sc.clientHeight <= 0) {
    let best = 0
    let cur = table
    while (cur) {
      const can = cur.scrollHeight - cur.clientHeight
      if (can > best) {
        best = can
        sc = cur
      }
      cur = cur.parentElement
    }
  }
  const thead = Array.from(table.querySelectorAll('thead th, thead tr td')).map((e) => clean(e.innerText)).filter(Boolean)
  const rows = table.querySelectorAll('tbody tr')
  const first = rows[0] ? Array.from(rows[0].querySelectorAll('td')).map((td) => ({ 类名: clean(td.className).slice(0, 40), 文本: clean(td.innerText).slice(0, 20) })) : []
  return {
    ok: true,
    表头: thead,
    DOM行数: rows.length,
    滚动容器: sc ? clean(sc.className).slice(0, 40) : null,
    滚动高: sc ? sc.scrollHeight : null,
    可见高: sc ? sc.clientHeight : null,
    scrollTop: sc ? sc.scrollTop : null,
    scrollLeft: sc ? sc.scrollLeft : null,
    首行单元格: first,
  }
}

/**
 * 扫 SKU 表（等价原版 scanSkuTable；编排层 / checklist 直接 import 这个名字）。
 *
 * 读回口径（Lead 约定）：成功 `{ ok:true, unique:<去重行数>, all:[{ spec, price, stock, code, … }], 滚动高:<number> }`；
 * 失败 `{ ok:false, why }`。这里**额外**带回原版的 滚动容器 / 可见高 / 增长轨迹 / 横向归零 诊断字段
 * （原版就有，只是不参与判定），消费方可忽略。
 * @param page - ego page。
 * @param step - 步长（默认 300；tb_import_sku 内部用 400 粗扫 —— 原版导入段就是 400）。
 * @returns 见上。
 */
export async function scanSkuTable(page, step = 300) {
  const stepPx = Math.max(40, Number(step) || 300) // ★ 原版 step=0 会死循环
  try {
    return await page.evaluate(SCAN_SRC, stepPx)
  } catch (e) {
    return { ok: false, why: 'evaluate_failed: ' + String((e && e.message) || e) }
  }
}

/**
 * 读全表（run_listing_tb.mjs / checklist 约定名）—— 等价 scanSkuTable(page, opts.step)。
 * @param page - ego page。
 * @param opts - `{ step = 300 }`。
 * @returns 同 scanSkuTable。
 */
export async function readAllSkuRows(page, opts = {}) {
  return scanSkuTable(page, opts.step === undefined ? 300 : opts.step)
}

/**
 * 兼容 tb_import_sku 旧名（原版本地 wrapper `scanTable(page, step = 400)`）。
 * @param page - ego page。
 * @param step - 步长（默认 400 = 导入段用的粗扫步长）。
 * @returns 同 scanSkuTable。
 */
export async function scanTable(page, step = 400) {
  return scanSkuTable(page, step)
}

/**
 * 单行定位（只读；新增，非原版函数）。
 * @param page - ego page。
 * @param spec - 规格键 `颜色-尺寸`。
 * @param opts - `{ step = 300 }`。
 * @returns 见 FIND_ROW_SRC。
 */
export async function findSkuRow(page, spec, opts = {}) {
  const stepPx = Math.max(40, Number(opts.step) || 300)
  try {
    return await page.evaluate(FIND_ROW_SRC, { spec: String(spec), step: stepPx })
  } catch (e) {
    return { ok: false, why: 'evaluate_failed: ' + String((e && e.message) || e) }
  }
}

/**
 * 表几何读回（只读；新增）。
 * @param page - ego page。
 * @returns `{ ok, 表头, DOM行数, 滚动容器, 滚动高, 可见高, scrollTop, scrollLeft, 首行单元格 }`。
 */
export async function skuTableGeometry(page) {
  try {
    return await page.evaluate(GEOMETRY_SRC)
  } catch (e) {
    return { ok: false, why: 'evaluate_failed: ' + String((e && e.message) || e) }
  }
}

export default {
  SCAN_SRC,
  FIND_ROW_SRC,
  GEOMETRY_SRC,
  scanSkuTable,
  readAllSkuRows,
  scanTable,
  findSkuRow,
  skuTableGeometry,
}
