/**
 * 销售信息段（ego 版）：**批量导入（AI识别导入 + 官方模板）→ SKU 表 → 跨窗口扫表对账 → 一口价 / 总库存读回**。
 *
 * 原脚本：taobao-product-listing\scripts\tb_import_sku.js
 *         （Playwright + CDP 版，只读参照，本文件不改它）
 *
 * 原脚本已验通的链路（2026-10-10，见 references/ops-notes.md）：
 *   官方模板表头是**单列规格** `颜色分类 | 价格 | 数量 | 商家编码 | 商品条形码`；
 *   两维合成一列填（`米白-宽30cm长1米`）→ 上传 → 「确认识别」→ **「在当前规格后添加」** → SKU 表就齐。
 * ⚠️ 「在当前规格后添加」是**追加**：同一页重复跑会把行数翻倍（实测攒出 78 行 = 6 个废颜色行 + 72 个正确行）
 *    → 所以本函数**先扫表，已是期望行数就跳过导入**；读数**接近但不等于**期望时**绝不自动追加**。
 *
 * 一口价：平台硬约束「必须等于某个**有库存** SKU 的价格」（SKILL 门禁 6），值取 product.json 的 list_price
 * （调用方可传 opts.listPrice 覆盖）。填完**读回**：① 读回值 == 期望值；② 期望值 ∈ 扫表得到的「有库存 SKU
 * 价格集合」；③ 页面无「一口价…错误/必须/大于」报错。
 * 总库存：页面提示「此处是商品所有销售规格总库存数量，若需修改请在销售规格表格内修改」→ 只读汇总，核对即可。
 *
 * ── 导出（只导出函数，由 run_listing_tb.mjs 在同一 ego 进程内调用；本文件没有 main/CLI）──────
 *   importSku(page, product, { listPrice, sizeSort, catId, … })   ← 主入口（契约见下）
 *   readLabelled(page)            ← 原版 readLabelled：按同一行左侧文案读「一口价 / 总库存 / 购买须知 / 商家编码」
 *   setListPrice(page, value)     ← 原版 ⑧ 里的 setter 填一口价
 *   readPriceError(page)          ← 原版 ⑧ 里的「一口价 报错」正则读回
 *   openBatchImportDialog(page)   ← 原版 ②（tb_download_template 也复用这一个）
 *   uploadTemplateFile(page,file) ← 原版 ③（filechooser / input[type=file]，带读回校验）
 *   confirmRecognition(page)      ← 原版 ④（合成点击「确认识别」）
 *   hardClickDialogButton(page,re)← 原版 ④b / 兜底：弹窗内按文本用**真实鼠标**点一次
 *   acceptAfterCurrentSpec(page)  ← 原版 ⑤（「在当前规格后添加」，追加不可逆 → 兜底前先判行数）
 *   importDialogState(page) / readImportDialogText(page) ← 读回弹窗
 *
 * ── 接口契约（Lead / 编排层）────────────────────────────────────────
 *   `importSku(page, product, { listPrice = 0, sizeSort = 'source', catId = '' } = {})`
 *   成功：`{ ok:true, skuCount, 一口价, 总库存, 对账, … }`
 *   失败：`{ ok:false, why, …读回 }`
 *   其中 一口价 / 总库存 = 读回的**值**（string），对账 = `{ 期望, 读到, 缺, 多, 缺列表, 多列表 }`。
 *   （原版最后一行 JSON 里 一口价/总库存 是 readLabelled 的 `{value,y}` 对象；编排层要的是值 → 这里拍平，
 *     原始对象仍保留在 `一口价_读回` / `总库存_读回`。）
 *
 * ── 移植差异（ego 版）──────────────────────────────────────────────
 * 1. 连接/页面：原版 `connectOverCDP` + 在多张 publish.htm 里挑页 → ego 版由编排层传入**当前 page**
 *    （一店一 space，一页）。本函数只读 `page.url()` 判「是否在 publish.htm」，不再自己找页。
 *    新增 opts.catId 读回守卫：给了 catId 且页面 catId 不同 → `why:'catid_mismatch'`（避免在别的类目页导入）。
 * 2. 定位：ego 没有 `locator` / `$`。原版 `page.$('input[type=file]')`、`.next-dialog button:has-text(...)`
 *    这类元素查询全部改到 `page.evaluate` 里算**坐标**，再用 `page.mouse.move/click`（真实鼠标）。
 * 3. 弹窗按钮：原版 ④「确认识别」先合成点击、失败再 `locator().click()`；ego 版合成点击不变，
 *    兜底换成「弹窗内坐标 + 真实鼠标」（`hardClickDialogButton`）。
 * 4. 上传：原版直接 `page.$('input[type=file]')` → `setInputFiles`；ego 版先 `waitForFileChooser` +
 *    真实点虚线框，拿不到 chooser 再退回 `setInputFiles`（多 input 时临时打 id `#__tb_fi_upload` 精确定位），
 *    并**读回弹窗文本确认文件真的登记上了**（原版是"点了就当成功"）。
 * 5. ⑤「在当前规格后添加」：原版合成点击后 sleep 8s；ego 版增加「效果判定」——只有**弹窗仍开着且表行数没变**
 *    才补一次真实鼠标点击（追加不可逆，宁可不补也不重复追加）。
 * 6. ⑥ 导入后扫表：原版扫一次；ego 版在行数不足时最多再扫 2 次（渲染/虚拟滚动延迟会把 72 行读成更少）。
 * 7. ⑧ 一口价：原版只填 + 读回 + 读「页面报错」；ego 版按契约补**门禁 6 校验**：
 *    期望值 ∈ 扫表得到的「有库存 SKU 价格集合」，且读回值 == 期望值。可用 `opts.strictPrice:false` 关掉
 *    这两条（原版口径）。
 * 8. 配置：ego 子进程**不继承自定义环境变量** → product.json / 模板路径 / 默认值优先从
 *    `globalThis.__TB_CFG` 读（`skuTemplate` / `product` / `catid`），`TB_*` env 只作本地开发兜底。
 * 9. 去掉 CLI（argv/process.exitCode）、`fs` 存在性检查改成返回 `{ok:false, why}`；不再最后一行 JSON，
 *    日志仍沿用原版的 ①…⑧ 编号与 `say` 风格。
 *
 * ── 仍依赖的硬规则（一条都不许改）─────────────────────────────────
 * A. 官方模板是**单列规格**（`颜色分类` 一列装 `颜色-尺寸`），两维**合成一列**填 —— 这是平台的权威格式。
 * B. 「在当前规格后添加」是**追加、不可逆**：先扫表；已是期望行数 → 跳过导入；读数
 *    `>= floor(期望 × 0.6)` 且 ≠ 期望 → **不自动追加**（要人工确认后传 forceImport）。
 * C. 读回必须**跨窗口扫并集**（虚拟滚动只渲染十几行）→ 一律走 `scanSkuTable`，不另写一套判据。
 * D. 一口价 ∈ 有库存 SKU 价格集合（门禁 6）；总库存是只读汇总，别去写。
 * E. 只填 SKU/价格，**绝不点「提交宝贝信息」**；本函数不碰保存/提交按钮。
 * F. 先读回、再动作；失败一律带 why + 读回值返回（不吞异常）。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { say, sleep, waitUntil } from '../lib/tb_ego.mjs'
import { scanSkuTable } from './sku_table.mjs'

/** ego 不继承调用方的自定义环境变量 → 配置必须来自 globalThis.__TB_CFG（env 只作本地开发兜底）。 */
function tbCfg() {
  return (typeof globalThis !== 'undefined' && globalThis.__TB_CFG) || {}
}
/** 同 tb_enter_form.mjs 的 pick：__TB_CFG > TB_* env > 默认值。 */
function pickCfg(key, envName, dflt) {
  const c = tbCfg()
  if (c[key] !== undefined && c[key] !== null && c[key] !== '') return c[key]
  if (envName && typeof process !== 'undefined' && process.env && process.env[envName]) return process.env[envName]
  return dflt
}
/** 金额/库存转数字（容忍 "31.60" / "￥83.8" / ""）。 */
function toNum(v) {
  if (v === null || v === undefined) return null
  const n = Number(String(v).replace(/[^\d.\-]/g, ''))
  return Number.isFinite(n) ? n : null
}

/** 弹窗状态读回（原版散落在各段的 `.next-dialog` 查询合成一个）。 */
export async function importDialogState(page) {
  try {
    return await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const dlgs = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)
      const dlg = dlgs[0] || null
      const buttons = dlg ? Array.from(dlg.querySelectorAll('button')).filter(vis) : []
      const confirm = buttons.find((b) => clean(b.innerText).includes('确认识别'))
      return {
        开了: !!dlg,
        文本: dlg ? clean(dlg.innerText).slice(0, 260) : null,
        按钮: buttons.map((b) => clean(b.innerText)).filter(Boolean).slice(0, 8),
        确认识别: confirm ? clean(confirm.innerText) : null,
        确认识别可用: confirm ? !confirm.disabled : false,
        fileInputs: document.querySelectorAll('input[type=file]').length,
        弹窗数: dlgs.length,
      }
    })
  } catch (e) {
    return { 开了: false, 文本: null, 按钮: [], 确认识别: null, 确认识别可用: false, fileInputs: 0, 弹窗数: 0, why: String((e && e.message) || e) }
  }
}

/** 原版 ④ 里那句「识别结果」读回（弹窗文本，260 字截断）。 */
export async function readImportDialogText(page) {
  const st = await importDialogState(page)
  return st.文本 || null
}

/** 页面上 SKU 表的「DOM 行数」（只反映当前虚拟滚动窗口，不能用它当总行数）。 */
async function domRowCount(page) {
  try {
    return await page.evaluate(() => {
      const t = Array.from(document.querySelectorAll('table')).find((x) => x.querySelector('tbody tr'))
      return t ? t.querySelectorAll('tbody tr').length : 0
    })
  } catch {
    return 0
  }
}

/**
 * 原版 readLabelled：按页面上「同一行左侧的文案」找字段（一口价 / 总库存 / 购买须知 / 商家编码
 * 既没有 id、也没有可识别 placeholder）。
 * @returns `{ 一口价?: {value,y}, 总库存?: {value,y}, … }`（原版同口径）。
 */
export async function readLabelled(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const vis = (e) => {
      if (!e) return false
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const all = Array.from(document.querySelectorAll('div,span,label,p')).filter(vis)
    const found = {}
    for (const i of Array.from(document.querySelectorAll('input')).filter(vis)) {
      const r = i.getBoundingClientRect()
      const cy = r.top + r.height / 2
      let lbl = null
      let best = 1e9
      for (const e of all) {
        if (e.contains(i)) continue
        const b = e.getBoundingClientRect()
        if (b.top + b.height / 2 < cy - 10 || b.top + b.height / 2 > cy + 10) continue
        if (b.left + b.width > r.left + 4) continue
        const t = clean(e.innerText)
        if (!t || t.length > 24) continue
        const d = r.left - (b.left + b.width)
        if (d < best) {
          best = d
          lbl = t
        }
      }
      if (!lbl) continue
      const key = lbl.replace(/\s*\*\s*$/, '').trim()
      if (['一口价', '总库存', '购买须知', '商家编码'].includes(key)) found[key] = { value: String(i.value || ''), y: Math.round(r.top) }
    }
    return found
  })
}

/**
 * 原版 ⑧ 的填一口价：setter 写值 + input/change/blur（不做选项点击 —— 它是裸 input）。
 * @returns `{ ok, why?, already?, 读回?, 位置? }`。
 */
export async function setListPrice(page, value) {
  return page.evaluate((v) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const vis = (e) => {
      if (!e) return false
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const all = Array.from(document.querySelectorAll('div,span,label,p')).filter(vis)
    let target = null
    for (const i of Array.from(document.querySelectorAll('input')).filter(vis)) {
      const r = i.getBoundingClientRect()
      const cy = r.top + r.height / 2
      let lbl = null
      let best = 1e9
      for (const e of all) {
        if (e.contains(i)) continue
        const b = e.getBoundingClientRect()
        if (b.top + b.height / 2 < cy - 10 || b.top + b.height / 2 > cy + 10) continue
        if (b.left + b.width > r.left + 4) continue
        const t = clean(e.innerText)
        if (!t || t.length > 24) continue
        const d = r.left - (b.left + b.width)
        if (d < best) {
          best = d
          lbl = t
        }
      }
      if (lbl && lbl.replace(/\s*\*\s*$/, '').trim() === '一口价') {
        target = i
        break
      }
    }
    if (!target) return { ok: false, why: 'no_price_input' }
    if (String(target.value) === String(v)) return { ok: true, already: true, 读回: target.value }
    target.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(target, String(v))
    for (const ev of ['input', 'change', 'blur']) target.dispatchEvent(new Event(ev, { bubbles: true }))
    return { ok: true, 读回: target.value }
  }, value)
}

/** 原版 ⑧ 的「一口价 报错」读回（页面原文：一口价…错误/必须/大于）。 */
export async function readPriceError(page) {
  try {
    return await page.evaluate(() => {
      const t = (document.body.innerText || '').replace(/\s+/g, ' ')
      return (t.match(/一口价[^。\n]{0,40}(错误|必须|大于)[^。\n]{0,40}/) || [])[0] || null
    })
  } catch {
    return null
  }
}

/**
 * 原版 ②：打开「批量导入」弹窗（弹窗已开就直接用）。
 * 合成 mousedown/mouseup/click 先来一遍；ego 里 React 偶尔不接合成事件 → 再补一次真实鼠标。
 * @returns `{ ok, 方式:'already'|'synth'|'mouse', 已开?, 点了?, why?, 位置? }`
 */
export async function openBatchImportDialog(page) {
  const first = await page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const dlgs = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)
      if (dlgs.length) return { ok: true, already: '弹窗已开', 弹窗文本: clean(dlgs[0].innerText).slice(0, 120) }
      const wrap = document.querySelector('.sell-component-sku-excel-upload') || document
      const btn = Array.from(wrap.querySelectorAll('button')).filter(vis).find((b) => clean(b.innerText).includes('批量导入'))
      if (!btn) return { ok: false, why: 'no_import_btn' }
      btn.scrollIntoView({ block: 'center' })
      const r = btn.getBoundingClientRect()
      const 位置 = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      for (const ev of ['mousedown', 'mouseup', 'click']) btn.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
      return { ok: true, 点了: clean(btn.innerText), 位置 }
    })
    .catch((e) => ({ ok: false, why: 'evaluate_failed: ' + String((e && e.message) || e) }))

  const opened = await waitUntil(
    async () => {
      const st = await importDialogState(page)
      return st.开了 ? st : null
    },
    { timeoutMs: first.ok ? 8000 : 1000, intervalMs: 400, label: 'import-dialog' }
  )
  if (opened.value) {
    return { ok: true, 方式: first.already ? 'already' : 'synth', 已开: opened.value, 点了: first.点了 || null, 弹窗文本: first.弹窗文本 || null }
  }
  if (first.ok && first.位置) {
    // 兜底：真实鼠标补一次（ego 里合成事件偶尔不触发弹窗）
    await page.mouse.click(first.位置.x, first.位置.y, { label: '批量导入' }).catch(() => {})
    const again = await waitUntil(
      async () => {
        const st = await importDialogState(page)
        return st.开了 ? st : null
      },
      { timeoutMs: 6000, intervalMs: 400, label: 'import-dialog-real' }
    )
    if (again.value) return { ok: true, 方式: 'mouse', 已开: again.value, 点了: first.点了, 弹窗文本: again.value.文本 }
  }
  return { ok: false, why: first.ok ? 'dialog_not_open' : first.why, 点了: first.点了 || null, 读回: await importDialogState(page) }
}

/**
 * 原版 ③：上传官方模板文件。
 * ego 差异：先 filechooser（真实点弹窗虚线框），拿不到再退回 input[type=file]；最后**读回弹窗**确认登记成功。
 * @returns `{ ok, how:'filechooser'|'main_input'|'tagged_input', 读回?, 显示文件?, 确认识别可用?, 输入框?, why? }`
 */
export async function uploadTemplateFile(page, file) {
  const files = [String(file)]
  const before = await page
    .evaluate(() => {
      const infos = []
      const collect = (doc, prefix) => {
        Array.from(doc.querySelectorAll('input[type=file]')).forEach((el, idx) => infos.push({ idx, frame: prefix }))
      }
      collect(document, 'main')
      for (const f of Array.from(document.querySelectorAll('iframe'))) {
        try {
          if (f.contentDocument) collect(f.contentDocument, 'iframe:' + String(f.getAttribute('src') || '').slice(0, 40))
        } catch {
          /* 跨域忽略 */
        }
      }
      return { count: infos.length, infos, 主文档: document.querySelectorAll('input[type=file]').length }
    })
    .catch(() => ({ count: 0, infos: [], 主文档: 0 }))

  // ① 弹窗里的虚线框（原版是 setInputFiles；ego 优先走真实用户手势的 filechooser）
  const box = await page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const vis2 = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)
      const dlg = vis2[0] || null
      const scope = dlg || document
      const pool = Array.from(scope.querySelectorAll('div,span,p,button,a')).filter(vis)
      const hit = pool.find((e) => /拖拽|粘贴|上传文件|选择文件|点击.*上传/.test(clean(e.innerText)) && clean(e.innerText).length < 80)
      if (!hit) return null
      const r = hit.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 文本: clean(hit.innerText).slice(0, 40) }
    })
    .catch(() => null)

  let chooser = null
  if (box) {
    // ★ pending 一定要挂 catch：点击若抛错、chooser 没等到，15s 后它自己 reject 会变成未处理拒绝
    const pending = page.waitForFileChooser({ timeout: 15000 }).catch(() => null)
    try {
      await page.mouse.click(box.x, box.y, { label: 'import-dropzone' })
    } catch {
      /* 点击失败就走下面的 input 兜底 */
    }
    chooser = await pending
  }
  if (chooser) {
    let setErr = null
    try {
      await chooser.setFiles(files)
    } catch (e) {
      setErr = String((e && e.message) || e)
    }
    if (!setErr) return verifyUpload(page, file, 'filechooser', box)
  }

  // ② 退回 input[type=file]（原版就是直接 setInputFiles）
  const info = await page
    .evaluate(() => ({ 主文档: document.querySelectorAll('input[type=file]').length }))
    .catch(() => ({ 主文档: 0 }))
  if (!info.主文档) {
    return { ok: false, why: 'no_file_input', 载入框: box, 输入框: before, 点击后: await page.evaluate(() => document.querySelectorAll('input[type=file]').length).catch(() => 0) }
  }
  let how = 'main_input'
  try {
    if (info.主文档 === 1) {
      await page.setInputFiles('input[type=file]', files)
    } else {
      // 多个 file input：给「弹窗里的那个」临时打 id，精确喂进去再撤掉（ego 的 setInputFiles 只吃选择器）
      const tagged = await page.evaluate(() => {
        const list = Array.from(document.querySelectorAll('input[type=file]'))
        const dlg = Array.from(document.querySelectorAll('.next-dialog'))[0]
        const pick = dlg ? list.find((i) => dlg.contains(i)) || list[0] : list[0]
        pick.id = '__tb_fi_upload'
        return { 全页: list.length, 已打标: true }
      })
      await page.setInputFiles('#__tb_fi_upload', files)
      await page.evaluate(() => {
        const el = document.getElementById('__tb_fi_upload')
        if (el) el.removeAttribute('id')
      }).catch(() => {})
      how = 'tagged_input(' + tagged.全页 + ')'
    }
  } catch (e) {
    return { ok: false, why: 'set_input_files_failed', 错误: String((e && e.message) || e), 载入框: box, 输入框: before }
  }
  return verifyUpload(page, file, how, box)
}

/** 上传后的读回校验：弹窗文本里出现文件名 / 「确认识别」变为可用。 */
async function verifyUpload(page, file, how, box) {
  const base = path.basename(String(file)).replace(/\.[^.]+$/, '')
  const verified = await waitUntil(
    async () => {
      const st = await importDialogState(page)
      const text = st.文本 || ''
      return text.includes(base) || st.确认识别可用 ? st : null
    },
    { timeoutMs: 15000, intervalMs: 500, label: 'template-upload-registered' }
  )
  if (verified.value) {
    return {
      ok: true,
      how,
      读回: verified.value.文本,
      显示文件: String(verified.value.文本 || '').includes(base),
      确认识别可用: verified.value.确认识别可用,
      载入框: box,
    }
  }
  const st = await importDialogState(page)
  return { ok: false, why: 'upload_not_registered', how, 读回: st.文本, 确认识别可用: st.确认识别可用, 载入框: box }
}

/**
 * 原版 ④：确认识别（先合成点击；是否真识别由调用方读「识别结果」文本判定）。
 * @returns `{ ok, 点了?, 位置?, why?, 弹窗文本? }`
 */
export async function confirmRecognition(page) {
  return page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0]
      if (!dlg) return { ok: false, why: 'no_dialog' }
      const btn = Array.from(dlg.querySelectorAll('button')).filter(vis).find((b) => clean(b.innerText).includes('确认识别'))
      if (!btn) return { ok: false, why: 'no_confirm_btn', 弹窗文本: clean(dlg.innerText).slice(0, 120) }
      if (btn.disabled) return { ok: false, why: 'disabled' }
      btn.scrollIntoView({ block: 'center' })
      const r = btn.getBoundingClientRect()
      const 位置 = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      for (const ev of ['mousedown', 'mouseup', 'click']) btn.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
      return { ok: true, 点了: clean(btn.innerText), 位置 }
    })
    .catch((e) => ({ ok: false, why: 'evaluate_failed: ' + String((e && e.message) || e) }))
}

/**
 * 弹窗内按文本用**真实鼠标**点一次（原版 ④b 的 locator 兜底在 ego 里的替代）。
 * @param page - ego page。
 * @param pattern - 按钮文本正则**源码**（字符串，如 `'确认识别'` / `'在当前规格后添加|添加'`）。
 * @param opts - `{ scopedToDialog = true }`。
 * @returns `{ ok, 点了?, why?, 弹窗文本? }`
 */
export async function hardClickDialogButton(page, pattern, opts = {}) {
  const scopedToDialog = opts.scopedToDialog === undefined ? true : !!opts.scopedToDialog
  const pos = await page
    .evaluate(
      ({ src, scopedToDialog }) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const vis = (e) => {
          if (!e) return false
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const re = new RegExp(src)
        const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0]
        const scope = scopedToDialog && dlg ? dlg : document
        const btn = Array.from(scope.querySelectorAll('button')).filter(vis).find((b) => re.test(clean(b.innerText)))
        if (!btn) return { ok: false, why: 'no_btn', 弹窗文本: dlg ? clean(dlg.innerText).slice(0, 160) : null }
        if (btn.disabled) return { ok: false, why: 'disabled', 弹窗文本: dlg ? clean(dlg.innerText).slice(0, 160) : null }
        btn.scrollIntoView({ block: 'center' })
        const r = btn.getBoundingClientRect()
        return { ok: true, 点了: clean(btn.innerText).slice(0, 24), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      },
      { src: String(pattern), scopedToDialog }
    )
    .catch((e) => ({ ok: false, why: 'evaluate_failed: ' + String((e && e.message) || e) }))
  if (!pos.ok) return pos
  if (page.mouse && typeof page.mouse.move === 'function') await page.mouse.move(pos.x, pos.y).catch(() => {})
  await sleep(300)
  await page.mouse.click(pos.x, pos.y, { label: 'dialog-btn' }).catch(() => {})
  return { ok: true, 点了: pos.点了, 方式: 'mouse', 位置: { x: pos.x, y: pos.y } }
}

/**
 * 原版 ⑤：「在当前规格后添加」（★ 追加、不可逆）。
 * ego 差异：合成点击后先判「弹窗关了 / 表 DOM 行数增加」；两者都没发生才补一次真实鼠标（避免重复追加）。
 * @returns `{ ok, 点了?, 方式?, 兜底?, 效果?, 弹窗文本?, why? }`
 */
export async function acceptAfterCurrentSpec(page) {
  const beforeRows = await domRowCount(page)
  const synth = await page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const dlg = Array.from(document.querySelectorAll('.next-dialog')).filter(vis)[0]
      const scope = dlg || document
      const btn = Array.from(scope.querySelectorAll('button')).filter(vis).find((b) => /在当前规格后添加|添加/.test(clean(b.innerText)))
      if (!btn) return { ok: false, why: 'no_accept_btn', 弹窗文本: dlg ? clean(dlg.innerText).slice(0, 160) : null }
      btn.scrollIntoView({ block: 'center' })
      const r = btn.getBoundingClientRect()
      const 位置 = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      for (const ev of ['mousedown', 'mouseup', 'click']) btn.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
      return { ok: true, 点了: clean(btn.innerText), 位置 }
    })
    .catch((e) => ({ ok: false, why: 'evaluate_failed: ' + String((e && e.message) || e) }))
  if (!synth.ok) return synth

  const effect = await waitUntil(
    async () => {
      const st = await importDialogState(page)
      if (!st.开了) return { 原因: '弹窗已关' }
      const n = await domRowCount(page)
      if (n > beforeRows) return { 原因: '表行数增加', 行数: n }
      return null
    },
    { timeoutMs: 8000, intervalMs: 500, label: 'accept-effect' }
  )
  if (effect.value) {
    return { ok: true, 点了: synth.点了, 方式: 'synth', 效果: effect.value, 弹窗仍在: effect.value.原因 === '表行数增加' ? true : false }
  }
  // ★ 兜底：只在「弹窗还开着且行数没动」时补一次真实鼠标 —— 追加不可逆，绝不盲目多点
  const hard = await hardClickDialogButton(page, '在当前规格后添加|添加')
  return { ok: true, 点了: synth.点了, 方式: 'mouse', 兜底: hard, 效果: { 原因: '合成点击无效果，补真实鼠标' }, 弹窗仍在: true }
}

/**
 * 主入口（契约）：批量导入官方模板 → 扫表对账 → 一口价 / 总库存读回校验。
 *
 * @param page - ego page（应在 publish.htm 表单页）。
 * @param product - product.json 的**对象**或**绝对路径**；也可用 opts.productPath 指定，
 *                  或由 __TB_CFG.product 提供。
 * @param opts - 见下：
 *   listPrice    - 一口价覆盖（>0 时优先于 product.json 的 list_price；默认 0 = 用 product.json）。
 *   sizeSort     - 'source'（默认）按 product.skus 顺序对账；原版无此参数，这里只作排序/读回元数据。
 *   catId        - 给了就校验页面 catId，不一致 → `why:'catid_mismatch'`（默认 '' = 不校验）。
 *   file         - 官方模板绝对路径（默认 = product.json 同目录 `sku_import_官方模板.xlsx`，原版口径）。
 *   expect       - 期望行数覆盖（默认 product.skus.length）。
 *   skipPrice    - 原版 --skip-price：只导 SKU、不动一口价。
 *   forceImport  - 原版 --force-import：读数接近期望也强制追加（危险，人工确认后才给）。
 *   strictPrice  - true（默认）：门禁 6 校验（一口价 ∈ 有库存 SKU 价格集合 + 读回一致）；false = 原版口径。
 *   step         - 扫表步长（默认 400，原版导入段粗扫）。
 * @returns 成功 `{ ok:true, skuCount, 一口价, 总库存, 对账, 价格集合, 有库存价格集合, … }`；
 *          失败 `{ ok:false, why, 步骤?, …读回 }`。
 */
export async function importSku(page, product, opts = {}) {
  const t0 = Date.now()
  try {
    const res = await importSkuInner(page, product, opts)
    if (res && res.ok === false) res.耗时ms = Date.now() - t0
    return res
  } catch (e) {
    const url = page ? await Promise.resolve(page.url()).catch(() => '') : ''
    return { ok: false, why: 'exception', 错误: String((e && e.message) || e), 工作页: String(url).slice(0, 200), 耗时ms: Date.now() - t0 }
  }
}

async function importSkuInner(page, product, opts) {
  const STEP = Number(opts.step) > 0 ? Number(opts.step) : 400 // 原版本地 wrapper：scanTable(page) → step 400
  const SKIP_PRICE = !!opts.skipPrice
  const FORCE_IMPORT = !!opts.forceImport
  const STRICT_PRICE = opts.strictPrice === undefined ? true : !!opts.strictPrice
  const RESCAN_AFTER_IMPORT = opts.rescanAfterImport === undefined ? 2 : Math.max(0, Number(opts.rescanAfterImport) || 0)
  const CATID = String(opts.catId || pickCfg('catid', 'TB_CATID', '') || '').trim()
  const SIZE_SORT = String(opts.sizeSort || 'source')

  // ── product.json（对象或路径）──────────────────────────────────
  let PRODUCT = product
  let PRODUCT_PATH = String(opts.productPath || '')
  if (typeof PRODUCT === 'string') {
    PRODUCT_PATH = PRODUCT_PATH || PRODUCT
    PRODUCT = null
  }
  if (!PRODUCT) {
    const guessed = PRODUCT_PATH || String(pickCfg('product', 'TB_PRODUCT', '') || '')
    if (!guessed) return { ok: false, why: 'no_product', 提示: '传 product.json 对象/路径，或用 __TB_CFG.product' }
    PRODUCT_PATH = guessed
    try {
      PRODUCT = JSON.parse(readFileSync(path.resolve(guessed), 'utf8'))
    } catch (e) {
      return { ok: false, why: 'bad_product_json', file: String(guessed), 错误: String((e && e.message) || e) }
    }
  }
  PRODUCT = PRODUCT || {}
  PRODUCT_PATH = PRODUCT_PATH ? path.resolve(PRODUCT_PATH) : ''

  const SKUS = PRODUCT.skus || []
  const EXPECT = parseInt(String(opts.expect !== undefined && opts.expect !== null ? opts.expect : (SKUS.length || 0)), 10)
  const OVERRIDE_PRICE = toNum(opts.listPrice)
  const LIST_PRICE = OVERRIDE_PRICE !== null && OVERRIDE_PRICE > 0 ? opts.listPrice : PRODUCT.list_price
  // ★ 单层类目（只有颜色分类一层）时 style 为空：对账 key 不能拼成「米白-」（页面读回是「米白」）
  const EXPECT_SET = new Set(SKUS.map((s) => (String(s.style || '').trim() ? `${s.color}-${s.style}` : String(s.color))))
  // sizeSort 只影响对账清单的呈现顺序；'source' = 按 product.skus（原版口径）
  const 期望规格顺序 = Array.from(EXPECT_SET)

  // 模板文件：opts.file > product.sku_import（字符串路径，相对 product.json 目录）> 同目录 `sku_import_官方模板.xlsx`
  let FILE = String(opts.file || opts.skuTemplate || '')
  if (!FILE && typeof PRODUCT.sku_import === 'string' && PRODUCT.sku_import) {
    FILE = PRODUCT_PATH ? path.resolve(path.dirname(PRODUCT_PATH), PRODUCT.sku_import) : PRODUCT.sku_import
  }
  if (!FILE) {
    const fromCfg = String(pickCfg('skuTemplate', 'TB_SKU_TEMPLATE', '') || '')
    FILE = fromCfg || (PRODUCT_PATH ? path.join(path.dirname(PRODUCT_PATH), 'sku_import_官方模板.xlsx') : '')
  }

  say('期望 SKU 行 =', EXPECT, '| 一口价 =', LIST_PRICE, '| 模板文件 =', FILE || '（未提供）')
  if (!FILE) {
    return { ok: false, why: 'no_template_path', 期望: EXPECT, 一口价: LIST_PRICE, 提示: '给 opts.file，或用 __TB_CFG.skuTemplate，或把模板放在 product.json 同目录' }
  }
  if (!existsSync(FILE)) {
    say('★ 模板文件不存在：', FILE)
    return {
      ok: false,
      why: 'no_template_file',
      file: FILE,
      期望: EXPECT,
      一口价: LIST_PRICE,
      提示: '官方模板是**按类目**的：先调 downloadTemplate(page, { catId, out }) 下该类目模板，或用 tb_build.py --from-template 产出 sku_import_官方模板.xlsx',
    }
  }
  if (!page) return { ok: false, why: 'no_page', file: FILE, 期望: EXPECT }

  const url = String(await Promise.resolve(page.url()).catch(() => '')).slice(0, 200)
  if (!/publish\.htm/.test(url)) {
    say('★ 当前页不是 publish.htm：', url)
    return { ok: false, why: 'not_publish_page', url, file: FILE, 期望: EXPECT }
  }
  const 页面catId = (url.match(/catId=(\d+)/) || [])[1] || null
  if (CATID && 页面catId && CATID !== 页面catId) {
    say('★ 页面 catId 与期望不一致：', 页面catId, '≠', CATID)
    return { ok: false, why: 'catid_mismatch', 页面catId, catId: CATID, url, 期望: EXPECT }
  }
  say('工作页:', url.slice(0, 96))

  // ── ① 先扫表：已经是期望行数就不重复导入（「在当前规格后添加」是**追加**！）──
  let scan = await scanSkuTable(page, STEP)
  // ★ AI 识别/「在当前规格后添加」后页面会忙十几秒，evaluate 可能超时 → 等 8s 重试最多 3 次
  for (let retry = 0; retry < 3 && !scan.ok && /timeout|timed out|evaluate_failed/i.test(String(scan.why || scan.错误 || '')); retry += 1) {
    say(`   扫表超时（页面忙），等 8s 重试 ${retry + 1}/3`)
    await new Promise((r) => setTimeout(r, 8000))
    scan = await scanSkuTable(page, STEP)
  }
  say('① 当前 SKU 表:', scan.ok ? `读到 ${scan.unique} 行` : scan.why)
  if (!scan.ok && scan.why === 'no_table') {
    // ★ 新版发布页在「还没创建规格」时不渲染 SKU 表（旧版会渲染空表）→ 不能当扫描失败，
    //   而是先走模板导入：导入成功后规格与 SKU 表才出现（"模板上传（请先创建sku）"那句提示就是这个意思）。
    say('① 空表单还没有 SKU 表 → 先走模板导入（导入成功后规格/SKU 表才出现）')
    scan = { ok: true, unique: 0, all: [], 空表: true }
  }
  if (!scan.ok) {
    return { ok: false, why: scan.why || 'scan_failed', 步骤: '① 扫 SKU 表', SKU行数: 0, skuCount: 0, 期望: EXPECT, 对账: null, 扫描: scan, 工作页: url }
  }
  // ★ 复扫一次：虚拟滚动偶尔少读 1 行（实测同一张 99 行的表读到过 98 / 93 / 69）
  if (scan.unique !== EXPECT) {
    const again = await scanSkuTable(page, STEP)
    say('①b 复扫:', again.ok ? `读到 ${again.unique} 行` : again.why)
    if (again.ok && again.unique > scan.unique) scan = again
  }
  // ★★ 追加**不可逆**（「在当前规格后添加」会累加）→ 读数接近期望时**绝不自动追加**：
  //    否则"少读 1 行"会被当成"缺行"，再导一次就变成 198 行（实测这坑差点踩到）。
  //    只有明确**表基本是空的**才导入；确实缺行要人工确认后传 forceImport。
  if (scan.unique !== EXPECT && scan.unique >= Math.floor(EXPECT * 0.6) && !FORCE_IMPORT) {
    say(`★★ 读到 ${scan.unique} / 期望 ${EXPECT}，**接近但不等于** → 不自动追加（追加不可逆）`)
    say('   先人工确认到底缺不缺行；确认要重导再加 forceImport:true')
    const got0 = new Set((scan.all || []).map((r) => r.spec))
    const missing0 = 期望规格顺序.filter((k) => !got0.has(k))
    const extra0 = Array.from(got0).filter((k) => !EXPECT_SET.has(k))
    return {
      ok: false,
      why: 'near_expected_rows_no_auto_append',
      原因: '读数接近期望，未自动追加',
      步骤: '① 扫 SKU 表',
      SKU行数: scan.unique,
      skuCount: scan.unique,
      期望: EXPECT,
      对账: { 期望: EXPECT_SET.size, 读到: got0.size, 缺: missing0.length, 多: extra0.length, 缺列表: missing0.slice(0, 8), 多列表: extra0.slice(0, 8) },
      缺: missing0.length,
      多: extra0.length,
      扫描: scan,
      工作页: url,
    }
  }

  // ── ②③④⑤ 导入 ───────────────────────────────────────────────
  let 导入 = null
  let scanTimeout = false
  if (scan.unique !== EXPECT) {
    const open = await openBatchImportDialog(page)
    say('② 打开批量导入:', JSON.stringify({ ok: open.ok, 方式: open.方式, 弹窗文本: open.已开 ? open.已开.文本 : null, why: open.why }))
    if (!open.ok) {
      return { ok: false, why: open.why || 'no_import_btn', 步骤: '② 打开批量导入', SKU行数: scan.unique, 期望: EXPECT, 对账: null, 读回: open, 工作页: url }
    }
    await sleep(3000)

    const up = await uploadTemplateFile(page, FILE)
    say('③ 已上传:', path.basename(FILE), JSON.stringify({ ok: up.ok, 方式: up.how, 显示文件: up.显示文件, 确认识别可用: up.确认识别可用 }))
    if (!up.ok) {
      return { ok: false, why: up.why || 'upload_failed', 步骤: '③ 上传模板', file: FILE, 上传: up, SKU行数: scan.unique, 期望: EXPECT, 对账: null, 工作页: url }
    }
    await sleep(3500)

    const confirm = await confirmRecognition(page)
    say('④ 确认识别（合成点击）:', JSON.stringify(confirm))
    await sleep(6000)
    let dialogText = await readImportDialogText(page)
    say('   识别结果:', dialogText)
    let confirm2 = null
    if (dialogText && !/识别|添加|属性/.test(dialogText)) {
      // 换真实点击再试一次（原版同款兜底顺序；ego 用坐标 + 真实鼠标）
      confirm2 = await hardClickDialogButton(page, '确认识别')
      say('④b 真实点击确认识别:', JSON.stringify(confirm2))
      await sleep(6000)
      dialogText = await readImportDialogText(page)
      say('   识别结果(2):', dialogText)
    }

    const accept = await acceptAfterCurrentSpec(page)
    say('⑤ 在当前规格后添加:', JSON.stringify({ ok: accept.ok, 点了: accept.点了, 方式: accept.方式, 效果: accept.效果, why: accept.why }))
    await sleep(8000)
    let scan2 = await scanSkuTable(page, STEP)
    // ★ 识别/「在当前规格后添加」后页面会忙 >15s，扫表 evaluate 可能超时 → 等 8s 重试最多 3 次
    for (let retry = 0; retry < 3 && !scan2.ok && /timeout|timed out|evaluate_failed/i.test(String(scan2.why || scan2.错误 || '')); retry += 1) {
      say(`   ⑥ 扫表超时（页面忙），等 8s 重试 ${retry + 1}/3`)
      await new Promise((r) => setTimeout(r, 8000))
      scan2 = await scanSkuTable(page, STEP)
    }
    // ego 差异：渲染/虚拟滚动延迟会把行数读少 → 行数不足时最多再扫 2 次（不会重复追加，纯读）
    for (let i = 0; i < RESCAN_AFTER_IMPORT && scan2.ok && scan2.unique < EXPECT; i += 1) {
      await sleep(2000)
      const again = await scanSkuTable(page, STEP)
      if (again.ok && again.unique > scan2.unique) scan2 = again
    }
    // ★ 若重试后仍因「页面忙」超时：导入动作已经成功，但读表读不了 →
    //   不把整步判死（对账留给第 9 步核对；一口价照常设置）
    scanTimeout = !scan2.ok && /timeout|timed out|evaluate_failed/i.test(String(scan2.why || scan2.错误 || ''))
    if (scanTimeout) say('   ⚠ 导入后扫表超时（页面忙）→ 跳过对账，改由「第 9 步核对」复核')
    say('⑥ 导入后 SKU 表:', scan2.ok ? `读到 ${scan2.unique} 行` : scan2.why)
    scan = scan2.ok ? scan2 : scan
    导入 = {
      打开: open,
      上传: up,
      确认识别: confirm,
      确认识别复点: confirm2,
      识别结果: dialogText,
      接受: accept,
      导入后扫描: scan2,
    }
  } else {
    say('   → 已是期望行数，跳过导入（避免重复追加）')
    导入 = { 跳过: true, 原因: '已是期望行数' }
  }

  // ── ⑦ 对账（跨窗口扫表 → 与 product.json 逐行比对，0 缺 0 多才算齐）──
  const got = new Set((scan.all || []).map((r) => r.spec))
  const missing = 期望规格顺序.filter((k) => !got.has(k))
  const extra = Array.from(got).filter((k) => !EXPECT_SET.has(k))
  const 行对象 = Object.fromEntries((scan.all || []).map((r) => [r.spec, r]))
  const 对账 = {
    期望: EXPECT_SET.size,
    读到: got.size,
    缺: missing.length,
    多: extra.length,
    缺列表: missing.slice(0, 8),
    多列表: extra.slice(0, 8),
    期望规格: 期望规格顺序.slice(0, 8),
    sizeSort: SIZE_SORT,
    缺行明细: missing.slice(0, 20).map((k) => ({ spec: k, 读到: 行对象[k] || null })),
  }
  say(`⑦ 对账：期望 ${EXPECT_SET.size} | 读到 ${got.size} | 缺 ${missing.length} | 多 ${extra.length}`)
  if (missing.length) say('   缺:', JSON.stringify(missing.slice(0, 8)))
  if (extra.length) say('   多:', JSON.stringify(extra.slice(0, 8)))

  // ── ⑧ 一口价 + 总库存（门禁 6：一口价必须等于某个**有库存** SKU 的价格）──
  let price = null
  if (!SKIP_PRICE && LIST_PRICE != null) {
    const before = await readLabelled(page)
    say('⑧ 一口价/总库存（填之前）:', JSON.stringify(before))
    const set = await setListPrice(page, LIST_PRICE)
    say('   → 填一口价:', JSON.stringify(set))
    await sleep(2500)
    const after = await readLabelled(page)
    say('   读回:', JSON.stringify(after))
    const err = await readPriceError(page)
    if (err) say('   ⚠ 页面报错:', err)

    // 有库存价格集合：来自刚扫出来的表（price + stock 都在同一行，才是权威读回）
    const rows = scan.all || []
    const 价格集合 = Array.from(new Set(rows.map((r) => toNum(r.price)).filter((v) => v !== null))).sort((a, b) => a - b)
    const 有库存价格集合 = Array.from(
      new Set(rows.filter((r) => toNum(r.stock) !== null && toNum(r.stock) > 0).map((r) => toNum(r.price)).filter((v) => v !== null && v > 0))
    ).sort((a, b) => a - b)
    const 期望价 = toNum(LIST_PRICE)
    const 一口价合法 = 有库存价格集合.length && 期望价 !== null ? 有库存价格集合.some((p) => Math.abs(p - 期望价) < 1e-9) : null
    const 读回值 = after && after['一口价'] ? String(after['一口价'].value || '') : null
    const 一口价读回一致 = 读回值 === null || 期望价 === null ? null : Math.abs(toNum(读回值) - 期望价) < 1e-9
    if (一口价合法 === false) say('   ⚠ 一口价不在「有库存 SKU 价格集合」里（门禁 6）：', JSON.stringify(有库存价格集合))
    if (一口价读回一致 === false) say('   ⚠ 一口价读回与期望不一致：读回 =', 读回值, '| 期望 =', LIST_PRICE)
    price = { set, before, after, 报错: err, 期望价: LIST_PRICE, 价格集合, 有库存价格集合, 一口价合法, 一口价读回一致 }
  } else {
    say('⑧ 跳过一口价（skipPrice 或 product.json 无 list_price）')
  }

  // ── 判定 ─────────────────────────────────────────────────────
  const rowsOk = scanTimeout || (scan.ok && missing.length === 0 && extra.length === 0)
  const priceSetOk = !price || price.set.ok
  const priceErrOk = !(price && price.报错)
  const priceLegalOk = !price || !STRICT_PRICE || price.一口价合法 !== false
  const priceReadOk = !price || price.一口价读回一致 !== false
  const ok = rowsOk && priceSetOk && priceErrOk && priceLegalOk && priceReadOk

  let why = null
  let 失败步骤 = null
  if (!rowsOk) {
    why = scan.ok ? 'reconcile_mismatch' : 'scan_failed'
    失败步骤 = '⑦ 对账'
  } else if (!priceSetOk) {
    why = 'price_not_set'
    失败步骤 = '⑧ 一口价'
  } else if (!priceErrOk) {
    why = 'price_page_error'
    失败步骤 = '⑧ 一口价'
  } else if (!priceLegalOk) {
    why = 'price_not_in_stocked_set'
    失败步骤 = '⑧ 一口价'
  } else if (!priceReadOk) {
    why = 'price_readback_mismatch'
    失败步骤 = '⑧ 一口价读回'
  }

  const result = {
    ok,
    skuCount: scan.unique,
    SKU行数: scan.unique,
    期望: EXPECT,
    缺: missing.length,
    多: extra.length,
    一口价: price && price.after && price.after['一口价'] ? String(price.after['一口价'].value || '') : null,
    总库存: price && price.after && price.after['总库存'] ? String(price.after['总库存'].value || '') : null,
    对账,
    价格集合: price ? price.价格集合 : null,
    有库存价格集合: price ? price.有库存价格集合 : null,
    一口价合法: price ? price.一口价合法 : null,
    一口价读回一致: price ? price.一口价读回一致 : null,
    一口价报错: price ? price.报错 : null,
    一口价_读回: price ? price.after && price.after['一口价'] : null,
    总库存_读回: price ? price.after && price.after['总库存'] : null,
    商家编码_读回: price && price.after ? price.after['商家编码'] || null : null,
    导入,
    工作页: url,
    catId: 页面catId,
    sizeSort: SIZE_SORT,
    扫描: scan,
  }
  if (!ok) {
    result.why = why
    result.失败步骤 = 失败步骤
  }
  return result
}

export default {
  importSku,
  readLabelled,
  setListPrice,
  readPriceError,
  openBatchImportDialog,
  uploadTemplateFile,
  confirmRecognition,
  hardClickDialogButton,
  acceptAfterCurrentSpec,
  importDialogState,
  readImportDialogText,
}
