/**
 * 类目资料抓取（只读）——「没有素材包但用户要上架」时的第一步。
 *
 * 做的事：
 *   1) 确保停在目标类目的发布页（给了 catid+cat 就走「搜索发品→级联选类目」，没给就复用当前页）；
 *   2) 读属性区：属性名 / p-id / 是否必填 / 控件类型 / 当前值 / **可选值**（展开下拉再收，只读不动数据）；
 *   3) 切到「图文描述」页，读 1:1 / 3:4 / 白底 / 视频 的页面原文要求（尺寸、张数、时长、比例）；
 *   4) 报该类目官方 SKU 模板是否已在本地下载（路径），没有就提示可自动下载。
 *
 * 全程**不点提交、不保存草稿**；下拉展开后点空白关闭，不写任何值。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { say, sleep, waitUntil } from '../lib/tb_ego.mjs'
import { readFields, expandCollapsedSections, openSelect, clickBlank } from './tb_fill_basic.mjs'

/** 从页面读属性（带必填标记）。 */
const readAttrList = async (page) => {
  const rows = await page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      return Array.from(document.querySelectorAll('[id^="sell-field-p-"]'))
        .filter(vis)
        .map((box) => {
          const t = clean(box.innerText)
          const cls = String(box.className || '')
          const kind = ['combobox', 'select', 'checkbox', 'input', 'taoSirProp'].find((k) => new RegExp('(^|\\s)' + k).test(cls)) || '?'
          const required = t.startsWith('*') || /重要|必填/.test(t)
          const label = ((t.replace(/^\*+/, '').split('重要')[0].trim().match(/^[^\s0-9/]+/) || [''])[0] || '').trim()
          const vals = Array.from(box.querySelectorAll('input'))
            .filter(vis)
            .map((i) => String(i.value || ''))
            .filter(Boolean)
          const chips = Array.from(box.querySelectorAll('.next-tag-body')).map((e) => clean(e.innerText)).filter(Boolean)
          const 已选计数 = (t.match(/已选择\s*(\d+)\s*\/\s*(\d+)\s*项/) || []).slice(1).join('/') || null
          return {
            pid: (box.id.match(/p-(\d+)/) || [])[1] || null,
            name: label,
            required,
            kind,
            current: vals[0] || null,
            chips: chips.slice(0, 6),
            selectedCount: 已选计数,
            hint: t.slice(0, 90),
          }
        })
    })
    .catch(() => [])
  return rows
}

/** 展开某个属性的下拉，读出候选值（只读；读完点空白关掉）。 */
const readOptions = async (page, pid, { limit = 80 } = {}) => {
  let opened = await openSelect(page, pid).catch(() => ({ ok: false }))
  if (!opened || opened.ok === false) {
    // 有些属性（如「适用猫体型」）class 写 checkbox，实际是 next-select 多选 → openSelect 打不开，
    // 这里退回「点字段盒子中心」再读弹层
    const box = await page
      .evaluate((id) => {
        const el = document.querySelector('[id^="sell-field-p-' + id + '"]')
        if (!el) return { ok: false }
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        if (r.width < 10) return { ok: false }
        return { ok: true, x: Math.round(r.left + Math.min(r.width, 320) / 2), y: Math.round(r.top + r.height / 2) }
      }, pid)
      .catch(() => ({ ok: false }))
    if (box.ok) {
      await page.mouse.move(box.x, box.y).catch(() => {})
      await sleep(120)
      await page.mouse.click(box.x, box.y, { label: 'open-attr-popup' }).catch(() => {})
      await sleep(400)
    }
  }
  await sleep(350)
  const readOnce = () =>
    page
      .evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const vis = (e) => {
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const scope =
          document.querySelector('.sell-o-select-popup') ||
          document.querySelector('.sell-o-select-options') ||
          document.querySelector('.next-select-popup-wrap') ||
          document.querySelector('.next-overlay-wrapper')
        if (!scope) return { ok: false, items: [] }
        const items = Array.from(scope.querySelectorAll('.options-item, [class*=option-item], li'))
          .filter(vis)
          .map((e) => clean(e.innerText))
          .filter((t) => t && t.length <= 60)
        return { ok: true, items, scrollable: !!scope.querySelector('.options-content') }
      })
      .catch(() => ({ ok: false, items: [] }))

  let r = await readOnce()
  const seen = new Set(r.items || [])
  // 长列表（如「日式」）要滚一下才能出现 → 最多滚 6 屏，边滚边收
  for (let i = 0; i < 6 && r.ok; i += 1) {
    const more = await page
      .evaluate(() => {
        const scope =
          document.querySelector('.sell-o-select-popup') ||
          document.querySelector('.sell-o-select-options') ||
          document.querySelector('.next-select-popup-wrap')
        const content = scope && scope.querySelector('.options-content')
        if (!content) return false
        const before = content.scrollTop
        content.scrollTop = before + content.clientHeight
        return content.scrollTop !== before
      })
      .catch(() => false)
    if (!more) break
    await sleep(250)
    r = await readOnce()
    for (const t of r.items || []) seen.add(t)
    if (seen.size >= limit) break
  }
  await clickBlank(page).catch(() => {})
  await sleep(200)
  return { ok: true, options: [...seen].slice(0, limit), total: seen.size, scrollable: r.scrollable }
}

/**
 * **一次 evaluate** 读完所有下拉的候选值（不再一个属性一次往返 + 固定 sleep）。
 * 页面内部：逐个触发控件 → 轮询弹层渲染 → 收 `.options-item` → 点空白关掉 → 下一个。
 * @param pids - 要展开的属性 pid 列表
 * @param options - `{ limitPerAttr }`
 * @returns `{ [pid]: string[] }`
 */
async function readAllOptions(page, pids, { limitPerAttr = 80 } = {}) {
  if (!pids.length) return {}
  const r = await page
    .evaluate(
      async ({ pids: want, limit: lim }) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const vis = (e) => {
          if (!e) return false
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
        const popup = () =>
          document.querySelector('.sell-o-select-popup') ||
          document.querySelector('.sell-o-select-options') ||
          document.querySelector('.next-select-popup-wrap') ||
          document.querySelector('.next-overlay-wrapper')
        const out = {}
        for (const pid of want) {
          const box = document.querySelector('[id^="sell-field-p-' + pid + '"]')
          if (!box) continue
          box.scrollIntoView({ block: 'center' })
          await sleep(60)
          const r = box.getBoundingClientRect()
          const x = Math.min(Math.max(r.left + Math.min(r.width, 320) / 2, 4), document.documentElement.clientWidth - 4)
          const y = Math.min(Math.max(r.top + r.height / 2, 4), document.documentElement.clientHeight - 4)
          const hit = document.elementFromPoint(x, y) || box
          // 合成鼠标事件（多数受控组件都响应 mousedown/mouseup/click）
          for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            try {
              hit.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }))
            } catch (e) {}
          }
          let items = []
          let sc = null
          for (let k = 0; k < 8; k += 1) {
            await sleep(150)
            sc = popup()
            if (!sc) continue
            const got = [...sc.querySelectorAll('.options-item, [class*=option-item], li')]
              .filter(vis)
              .map((e) => clean(e.innerText))
              .filter((t) => t && t.length <= 60)
            if (got.length) {
              items = got
              break
            }
          }
          // 长列表：滚一下再收（最多 4 屏）
          if (sc && items.length) {
            for (let k = 0; k < 4; k += 1) {
              const content = sc.querySelector('.options-content')
              if (!content) break
              const before = content.scrollTop
              content.scrollTop = before + content.clientHeight
              if (content.scrollTop === before) break
              await sleep(180)
              const more = [...sc.querySelectorAll('.options-item, [class*=option-item], li')]
                .filter(vis)
                .map((e) => clean(e.innerText))
                .filter((t) => t && t.length <= 60)
              for (const t of more) if (!items.includes(t)) items.push(t)
              if (items.length >= lim) break
            }
          }
          // 关闭：点空白 + Esc
          const vw = document.documentElement.clientWidth
          const vy = Math.max(8, Math.min(60, document.documentElement.clientHeight - 8))
          for (const type of ['mousedown', 'mouseup', 'click']) {
            try {
              document.body.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: vw - 8, clientY: vy, view: window }))
            } catch (e) {}
          }
          out[pid] = items.slice(0, lim)
        }
        return out
      },
      { pids, limit: limitPerAttr }
    )
    .catch(() => null)
  return r && typeof r === 'object' ? r : {}
}

/** 切到「图文描述」页（ego 的 text= 选择器在这页会点了没反应 → 用坐标点 + 回读）。 */
const switchToDescTab = async (page) => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const pt = await page
      .evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const vis = (e) => {
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const tab = [...document.querySelectorAll('div,span,a,li')]
          .filter(vis)
          .filter((e) => clean(e.innerText) === '图文描述')
          .map((e) => e.getBoundingClientRect())
          .filter((r) => r.top < 120)[0]
        if (!tab) return { ok: false }
        return { ok: true, x: Math.round(tab.left + tab.width / 2), y: Math.round(tab.top + tab.height / 2) }
      })
      .catch(() => ({ ok: false }))
    if (pt.ok) {
      await page.mouse.move(pt.x, pt.y).catch(() => {})
      await sleep(120)
      await page.mouse.click(pt.x, pt.y, { label: 'switch-desc-tab' }).catch(() => {})
    } else {
      await page.click('text=图文描述', { force: true, timeout: 6000 }).catch(() => {})
    }
    await sleep(1200)
    const ready = await waitUntil(
      async () =>
        (await page
          .evaluate(() => {
            const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
            return [...document.querySelectorAll('div,span,p')].some((e) => {
              const r = e.getBoundingClientRect()
              return r.width > 0 && clean(e.innerText).startsWith('1:1主图')
            })
          })
          .catch(() => false))
          ? true
          : null,
      { timeoutMs: 6000, intervalMs: 400, label: 'desc-tab-ready' }
    )
    if (ready.ok) return { ok: true, attempt }
  }
  return { ok: false }
}

/** 读图文描述区的原文要求（1:1 / 3:4 / 白底 / 视频）。 */
const readMediaHints = async (page) =>
  page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const body = clean(document.body.innerText)
      const grab = (startRe) => {
        const m = body.match(startRe)
        return m ? body.slice(m.index, m.index + 220) : null
      }
      const num = (text, re) => (text ? ((text.match(re) || [])[1] || null) : null)
      // 文案在不同类目/版本里不一样：有的写「至多可上传5张」，有的写「最多可上传5张」
      const maxCards = (text) => num(text, /(?:至多|最多)可?上传\s*(\d+)\s*张/) || num(text, /最多可上传\s*(\d+)/)
      // 3:4 区块的锚点不能只认「3:4主图」（「3:4主图裁剪」链接会先命中）→ 优先按「宽高比为3:4」定位
      const one = grab(/1:1主图 ?\*\s*图片要求|比例为1:1|宽高比为1:1/) || grab(/1:1主图/)
      const three = grab(/宽高比为3:4/) || grab(/3:4主图 ?\*?\s*已设置/) || grab(/3:4主图\s*图片要求/)
      const white = grab(/白底图\s*图片要求/) || grab(/白底图/)
      const video = grab(/商品视频\s*视频要求/) || grab(/商品视频/)
      return {
        '1:1': one,
        '3:4': three,
        白底图: white,
        商品视频: video,
        解析: {
          '1:1最多张数': maxCards(one),
          '3:4最多张数': maxCards(three),
          '1:1比例': num(one, /(?:宽高比|比例)为\s*([0-9:：]+)/),
          '3:4比例': num(three, /(?:宽高比|比例)为\s*([0-9:：]+)/),
          '白底尺寸': num(white, /尺寸\s*(\d+x\d+)/) || num(white, /(\d+x\d+)/),
          '视频时长': video ? (video.match(/时长\s*([\d.]+秒-[\d.]+分钟)/) || [])[1] || null : null,
          '视频比例': video ? (video.match(/宽高比支持\s*([0-9:,，、\s]+)/) || [])[1] || null : null,
          '视频最多': maxCards(video),
        },
      }
    })
    .catch(() => ({}))

/** 该类目官方 SKU 模板本地是否已下载。 */
const findLocalTemplate = (catid, templateOut) => {
  const dir = templateOut || join(homedir(), '.dsh', 'taobao-ego', 'output', '_downloads')
  if (!catid || !existsSync(dir)) return { dir, found: null, hint: '本地没有下载目录，首次跑 SKU 步会自动下载' }
  try {
    const hit = readdirSync(dir)
      .filter((f) => f.startsWith(`SKU模板_${catid}_`) && /\.(xlsx|xls)$/i.test(f))
      .sort()
      .pop()
    return hit
      ? { dir, found: join(dir, hit), hint: '已下载（跑 SKU 步会直接用）' }
      : { dir, found: null, hint: '尚未下载；跑 SKU 步时会按类目自动下载' }
  } catch (e) {
    return { dir, found: null, hint: '读目录失败：' + String((e && e.message) || e) }
  }
}

/**
 * 抓取类目资料。
 * @param page - ego page
 * @param options - `{ catid, cat, brand, force, withOptions, templateOut }`
 * @returns 结构化清单（属性、必填、可选值、媒体要求、模板状态）
 */
export async function categoryProfile(page, options = {}) {
  const t0 = Date.now()
  const catid = String(options.catid || '')
  const cat = String(options.cat || '')
  // ★ 只给 cat（没 catid）也允许进类目：类目搜索/用户只报路径时就需要这条路
  const wantEnter = !!cat
  let entered = { skipped: true }

  if (wantEnter) {
    const before = await page.evaluate(() => ({ url: location.href, catId: (location.search.match(/catId=(\d+)/) || [])[1] || null })).catch(() => ({ url: '', catId: null }))
    if (catid && before.catId === catid && /publish\.htm/.test(before.url || '')) {
      entered = { skipped: true, why: 'already_on_category_page' }
    } else {
      const mod = await import('./tb_enter_form.mjs')
      globalThis.__TB_ORCHESTRATOR = true
      // ★ 没给 catid 时必须强制重走入口：enterForm 在「当前已停在某个 publish 表单页」时会复用，
      //   不给 catid 就没有可比对的类目 → 会一直复用上一页（四个类目抓出同一个 catId 的坑）。
      const forceEntry = options.force === true || !catid
      const r = await mod.enterForm(page, { cat, catid, brand: options.brand || '无品牌', force: forceEntry })
      entered = r
      if (!r || r.ok === false) {
        return { ok: false, why: 'category_entry_failed', 入口: r, 耗时ms: Date.now() - t0 }
      }
    }
  }

  const state = await page
    .evaluate(() => ({
      url: location.href,
      catId: (location.search.match(/catId=(\d+)/) || [])[1] || null,
      catText:
        (() => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
          const el = [...document.querySelectorAll('div,span,p')].find((e) => /当前类目/.test(clean(e.innerText)) && clean(e.innerText).length < 80)
          return el
            ? clean(el.innerText)
                .replace('当前类目', '')
                .replace('切换类目', '')
                .trim()
                .replace(/\s*[\*＊]\s*/, '')
                .trim()
            : null
        })(),
      inPublish: /publish\.htm/.test(location.href),
    }))
    .catch(() => ({}))

  await expandCollapsedSections(page, { passes: 4 }).catch(() => {})
  const attributes = await readAttrList(page)

  // 可选值：**一次 evaluate 全部读完**（不再一个属性一次往返）；读不到的再退回逐个真鼠标展开
  let optionBudget = Number.isFinite(Number(options.withOptions)) ? Math.max(0, Number(options.withOptions)) : 12
  const targets = attributes
    .filter((a) => ['select', 'combobox', 'checkbox', 'taoSirProp'].includes(a.kind))
    .slice(0, optionBudget)
  const batch = await readAllOptions(page, targets.map((a) => a.pid), { limitPerAttr: 80 })
  const withOpts = targets.map((a) => {
    const opts = Array.isArray(batch[a.pid]) ? batch[a.pid] : []
    return { pid: a.pid, name: a.name, kind: a.kind, ok: opts.length > 0, total: opts.length, options: opts }
  })
  // 兜底：批量没读到的（个别控件只吃真实鼠标）逐个补
  for (const w of withOpts) {
    if (w.ok) continue
    const r = await readOptions(page, w.pid).catch(() => ({ ok: false, options: [] }))
    if (r.ok && r.options.length) {
      w.ok = true
      w.options = r.options
      w.total = r.total || r.options.length
    }
  }

  // ★ 规格维度以**页面「销售信息」**为准（如 `SKU模式 · 【颜色分类】单层展示`）。
  //   官方模板里的列并不都是规格维度：`尺寸（长×宽）` / `厚度` 这类在单层类目里是**每个 SKU 自己的属性列**。
  //   不读这个，就会把「尺寸」误当第二层规格 → 平台只建出一层 → SKU 对账 缺N多N（实测 2026-11-16 卫浴地垫）。
  //   ⚠️ 必须在**切到「图文描述」之前**读：切走后页面里就没有「销售信息」那段文字了（实测 2026-11-17 读到 null）
  const readSkuDims = () =>
    page
      .evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const t = clean(document.body.innerText)
        const m = t.match(/SKU模式\s*·*\s*【([^】]{1,80})】/)
        if (!m) return null
        return m[1]
          .split(/[、,，×]/)
          .map((s) => s.trim())
          .filter(Boolean)
      })
      .catch(() => null)
  /** 点顶部 tab（图文描述 / 基础信息 / 销售信息 / 物流服务）。 */
  const clickTab = async (name) => {
    const pt = await page
      .evaluate((want) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const vis = (e) => {
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const el = [...document.querySelectorAll('div,span,a,li')]
          .filter(vis)
          .filter((e) => clean(e.innerText) === want)
          .map((e) => ({ e, r: e.getBoundingClientRect() }))
          .filter((o) => o.r.top < 220)
          .sort((a, b) => a.r.top - b.r.top)[0]
        if (!el) return null
        const vw = document.documentElement.clientWidth
        const vh = document.documentElement.clientHeight
        return {
          x: Math.round(Math.min(Math.max(el.r.left + el.r.width / 2, 5), vw - 5)),
          y: Math.round(Math.min(Math.max(el.r.top + el.r.height / 2, 5), vh - 5)),
        }
      }, name)
      .catch(() => null)
    if (!pt) return { ok: false, why: 'tab_not_found', name }
    await page.mouse.move(pt.x, pt.y).catch(() => {})
    await sleep(120)
    await page.mouse.click(pt.x, pt.y, { label: 'tab:' + name }).catch(() => {})
    await sleep(1500)
    return { ok: true, name }
  }

  const tab = await switchToDescTab(page).catch(() => ({ ok: false }))
  const media = await readMediaHints(page)

  // ★ 「销售信息」里才有 `SKU模式 · 【…】`：先直接读；读不到就显式点「销售信息」，
  //   然后**轮询等待**（SKU 区是异步渲染的，固定 sleep 1.5s 不够 → 之前读到 null）。
  //   最后**一定切回「基础信息」**（下载模板的「批量导入」按钮在那页）。
  let skuDims = await readSkuDims()
  let c1 = null
  if (!skuDims) {
    c1 = await clickTab('销售信息')
    for (let i = 0; i < 16 && !skuDims; i += 1) {
      await sleep(500)
      skuDims = await readSkuDims()
    }
    say('①c 读规格维度（点销售信息）:', JSON.stringify({ 切tab: c1, 读到: skuDims }))
  }
  const c2 = await clickTab('基础信息')
  if (!skuDims) skuDims = await readSkuDims()
  say('①c 页面规格维度 =', skuDims && skuDims.length ? skuDims.join(' × ') : '（未读到）', '| 回切基础信息 =', JSON.stringify(c2))

  const template = findLocalTemplate(state.catId || catid, options.templateOut)

  const requiredNames = attributes.filter((a) => a.required).map((a) => a.name)
  return {
    ok: true,
    catId: state.catId || catid || null,
    catText: state.catText || cat || null,
    url: String((state.url || '').slice(0, 200)),
    入口: entered,
    规格维度: skuDims || null,
    标题: {
      // 淘宝发布页的硬限制（页面文案「标题长度不能超过30个汉字/60个字符」）
      汉字上限: 30,
      字符上限: 60,
      hint: '标题 ≤30 个汉字（60 字符）',
    },
    属性: attributes.map((a) => ({
      ...a,
      可选值: (withOpts.find((w) => w.pid === a.pid) || {}).options || [],
      候选总数: (withOpts.find((w) => w.pid === a.pid) || {}).total || null,
    })),
    必填属性: requiredNames,
    下拉已展开: withOpts.length,
    媒体要求: media,
    图文描述页: tab,
    SKU模板: template,
    缺什么: {
      提示: '属性区里没有的字段只能由用户给（标题/价格/库存/编码/品牌/图片是页面不会提供的）',
      必填属性: requiredNames,
      还需要用户提供: ['标题文案', '一口价（必须等于某个有库存 SKU 的价）', '颜色/尺寸规格与库存', '商家编码', '至少 1 张 1:1 主图'],
    },
    耗时ms: Date.now() - t0,
  }
}

export default { categoryProfile }
