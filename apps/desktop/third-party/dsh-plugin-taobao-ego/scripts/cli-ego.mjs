// cli-ego.mjs —— ego 侧命令入口（供 DSH 插件调用；在 ego 的 nodejs 运行时里跑）
//   __TB_CLI_CFG = { cmd: 'spaces' | 'probe' | 'run' | 'env' | 'templates', space, ...runConfig }
// 输出：最后一行打印 JSON（插件那侧解析）
import { existsSync } from 'node:fs'

const INLINE = (typeof globalThis !== 'undefined' && globalThis.__TB_CLI_CFG) || {}
const CMD = String(INLINE.cmd || 'spaces').trim()
const SPACE = Number(INLINE.space || 0)
const OUT = { cmd: CMD, space: SPACE || null, ok: false }

/** 连 space（优先已登录的发布页/千牛页签）。 */
async function connect(spaceId) {
  const lib = await import('../lib/tb_ego.mjs')
  const { task, page } = await lib.connectSpace(spaceId, { preferUrl: /item\.upload\.taobao\.com|publish\.htm|qn\.taobao\.com/ })
  return { lib, task, page }
}

try {
  if (CMD === 'spaces') {
    const spaces = await listTaskSpaces().catch(() => null)
    OUT.spaces = spaces
    OUT.ok = !!spaces
  } else if (CMD === 'probe') {
    if (!SPACE) throw new Error('space_required')
    const { page } = await connect(SPACE)
    OUT.url = String(await page.url()).slice(0, 160)
    OUT.state = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const slots = [...document.querySelectorAll('div,span,li,p')]
        .filter(vis)
        .filter((e) => clean(e.innerText) === '上传图片').length
      const labels = ['1:1主图', '3:4主图', '商品视频', '白底图', '宝贝详情', '商品描述']
      const found = {}
      for (const t of labels) {
        const el = [...document.querySelectorAll('div,span,p,h2,h3')].filter(vis).find((e) => clean(e.innerText) === t)
        found[t] = !!el
      }
      return {
        url: location.href,
        title: document.title,
        inPublish: /publish\.htm/.test(location.href),
        catId: (location.search.match(/catId=(\d+)/) || [])[1] || null,
        emptyImageSlots: slots,
        sections: found,
        textSample: clean(document.body.innerText).slice(0, 300),
      }
    })
    OUT.ok = true
  } else if (CMD === 'search') {
    // 类目搜索（只读）：关键词 → 候选类目路径；给了 clickIndex 就点进去拿 catId
    if (!SPACE) throw new Error('space_required')
    const { page } = await connect(SPACE)
    const mod = await import('./tb_category_search.mjs')
    OUT.search = await mod.searchCategory(page, INLINE.keyword, { clickIndex: INLINE.clickIndex })
    OUT.ok = !!(OUT.search && OUT.search.ok)
  } else if (CMD === 'profile') {
    // 抓类目资料（只读）：属性 / 必填 / 可选值 / 图片视频要求 / 本地模板
    if (!SPACE) throw new Error('space_required')
    const { page } = await connect(SPACE)
    const mod = await import('./tb_category_profile.mjs')
    OUT.profile = await mod.categoryProfile(page, {
      catid: INLINE.catid,
      cat: INLINE.cat,
      brand: INLINE.brand,
      force: INLINE.force,
      withOptions: INLINE.withOptions,
      templateOut: INLINE.templateOut,
    })
    OUT.ok = !!(OUT.profile && OUT.profile.ok)
    // 可选：把类目资料导出成「给人填的 Excel」（四个 sheet：类目要求/基本信息/属性/SKU）
    if (OUT.ok && INLINE.exportXlsx) {
      const { execFileSync } = await import('node:child_process')
      const fs = await import('node:fs')
      const os = await import('node:os')
      const path = await import('node:path')
      const profPath = path.join(os.tmpdir(), 'tb-profile-' + Date.now() + '.json')
      fs.writeFileSync(profPath, JSON.stringify({ profile: OUT.profile }, null, 1), 'utf8')
      const outXlsx = String(INLINE.exportXlsx)
      const py = String(INLINE.python || '')
      const { fileURLToPath } = await import('node:url')
      const HERE = path.dirname(fileURLToPath(import.meta.url))
      const script = path.join(HERE, 'category_profile_xlsx.py')
      try {
        const pyCmd = py || 'python'
        execFileSync(pyCmd, ['-X', 'utf8', script, '--profile', profPath, '--out', outXlsx], { stdio: 'inherit', timeout: 120000 })
        OUT.xlsx = outXlsx
        OUT.xlsxOk = fs.existsSync(outXlsx)
      } catch (e) {
        OUT.xlsxError = String((e && e.message) || e).slice(0, 200)
      }

      // 顺手把「该类目官方 SKU 模板」也下下来：给用户看，也供后续导入直接复用（同类目缓存）
      try {
        const dlMod = await import('./tb_download_template.mjs')
        const outDir = String(INLINE.templateOut || '')
        if (outDir) {
          // 已有同类目缓存就直接用（不重复下载）
          const cached = fs
            .readdirSync(outDir)
            .filter((f) => f.startsWith('SKU模板_' + (OUT.profile.catId || '') + '_') && /\.(xlsx|xls)$/i.test(f))
            .sort()
            .pop()
          if (cached) {
            const full = path.join(outDir, cached)
            OUT.template = full
            OUT.templateInfo = { 文件名: cached, 字节: fs.statSync(full).size, 方式: 'reuse_cache' }
          } else {
            // ★ 下载「下载模版」按钮在**基础信息**页：profile 结束时页面停在「图文描述」→ 先切回去再下
          try {
            const tabPt = await page.evaluate(() => {
              const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
              const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
              const el = [...document.querySelectorAll('div,span,a,li')].filter(vis).filter((e) => clean(e.innerText) === '基础信息').map((e) => e.getBoundingClientRect()).filter((r) => r.top < 120)[0]
              if (!el) return { ok: false }
              const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight
              return { ok: true, x: Math.round(Math.min(Math.max(el.left + el.width / 2, 5), vw - 5)), y: Math.round(Math.min(Math.max(el.top + el.height / 2, 5), vh - 5)) }
            }).catch(() => ({ ok: false }))
            if (tabPt.ok) {
              await page.mouse.move(tabPt.x, tabPt.y).catch(() => {})
              await sleep(120)
              await page.mouse.click(tabPt.x, tabPt.y, { label: 'switch-basic-tab' }).catch(() => {})
              await sleep(1200)
            }
          } catch {}
          const dl = await dlMod.downloadTemplate(page, { catId: OUT.profile.catId, out: outDir, mode: 'ui', timeoutMs: 60000 })
            if (dl && dl.ok) {
              OUT.template = dl.path
              OUT.templateInfo = { 文件名: dl.文件名, 字节: dl.大小, 方式: dl.方式 }
            } else {
              OUT.templateError = String((dl && dl.why) || 'download_failed')
            }
          }
        }
      } catch (e) {
        OUT.templateError = String((e && e.message) || e).slice(0, 200)
      }
    }
  } else if (CMD === 'pack') {
    // 生成完整素材包：listing.json（或填好的 xlsx）→ <pack>/商品信息.xlsx + 淘宝/<id>/图片目录
    const { execFileSync } = await import('node:child_process')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const HERE = path.dirname(fileURLToPath(import.meta.url))
    let listingPath = String(INLINE.listingPath || '')
    if (!listingPath && INLINE.listingXlsx) {
      const outJson = path.join(os.tmpdir(), 'tb-listing-' + Date.now() + '.json')
      execFileSync(String(INLINE.python || 'python'), ['-X', 'utf8', path.join(HERE, 'listing_xlsx_to_json.py'), '--xlsx', String(INLINE.listingXlsx), '--out', outJson], { stdio: 'inherit', timeout: 120000 })
      listingPath = outJson
    }
    if (!listingPath) throw new Error('need_listingPath_or_listingXlsx')
    let profPath = ''
    if (INLINE.profilePath && fs.existsSync(String(INLINE.profilePath))) {
      profPath = String(INLINE.profilePath)
    } else if (INLINE.profile) {
      profPath = path.join(os.tmpdir(), 'tb-profile-' + Date.now() + '.json')
      fs.writeFileSync(profPath, JSON.stringify({ profile: INLINE.profile }, null, 1), 'utf8')
    }
    const args = ['-X', 'utf8', path.join(HERE, 'build_pack.py'), '--listing', listingPath, '--pack-dir', String(INLINE.packDir)]
    if (profPath) args.push('--profile', profPath)
    if (INLINE.dim2) args.push('--dim2', String(INLINE.dim2))
    if (INLINE.audience) args.push('--audience', String(INLINE.audience))
    if (INLINE.profileJson) args.push('--profile-json', String(INLINE.profileJson))
    // 官方 SKU 模板：显式给了就用，否则从该类目 _downloads 缓存里挑（build_pack 自己也会兜底找）
    if (INLINE.templatePath && fs.existsSync(String(INLINE.templatePath))) {
      args.push('--template', String(INLINE.templatePath))
    }
    const stdout = execFileSync(String(INLINE.python || 'python'), args, { encoding: 'utf8', timeout: 180000 })
    OUT.pack = JSON.parse(String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}')
    OUT.ok = !!(OUT.pack && OUT.pack.ok)
  } else if (CMD === 'build') {
    // 手工造数据：listingXlsx（给人填的 Excel）→ listing.json → product.json + img/
    const mod = await import('./tb_build_product_manual.mjs')
    let listingPath = String(INLINE.listingPath || '')
    if (!listingPath && INLINE.listingXlsx) {
      const { execFileSync } = await import('node:child_process')
      const fs = await import('node:fs')
      const os = await import('node:os')
      const path = await import('node:path')
      const outJson = path.join(os.tmpdir(), 'tb-listing-' + Date.now() + '.json')
      const { fileURLToPath } = await import('node:url')
      const HERE = path.dirname(fileURLToPath(import.meta.url))
      const script = path.join(HERE, 'listing_xlsx_to_json.py')
      execFileSync(String(INLINE.python || 'python'), ['-X', 'utf8', script, '--xlsx', String(INLINE.listingXlsx), '--out', outJson], { stdio: 'inherit', timeout: 120000 })
      listingPath = outJson
    }
    OUT.build = listingPath
      ? mod.buildProductFromFile(listingPath, { out: INLINE.out })
      : INLINE.listing
        ? mod.buildProductFromListing(INLINE.listing, { out: INLINE.out })
        : { ok: false, why: 'need_listing' }
    OUT.ok = !!(OUT.build && OUT.build.ok)
  } else if (CMD === 'run') {
    // ★ 必须先把「别自动跑」的开关打开：run_listing_tb.mjs 末尾有个 CLI 直跑入口，
    //   import 时不设 __TB_NO_MAIN 会**自己跑一遍**，我们再调 runListing() 就是第二遍 → 第二遍里
    //   图片槽位已经被占满，4/4c/5g 全报 not_enough_slots（2026-11-16 真机踩到）。
    globalThis.__TB_NO_MAIN = true
    const mod = await import('./run_listing_tb.mjs')
    const cfg = { ...INLINE }
    delete cfg.cmd
    const res = await mod.runListing(null, cfg)
    OUT.result = res
    OUT.ok = res && res.ok !== false
  } else {
    throw new Error('unknown_cmd:' + CMD)
  }
} catch (e) {
  OUT.error = String((e && e.message) || e).slice(0, 300)
}

console.log(JSON.stringify(OUT))
