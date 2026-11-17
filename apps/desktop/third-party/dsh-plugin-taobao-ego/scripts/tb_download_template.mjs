/**
 * 下载**当前类目**的官方 SKU 模板（ego 版）—— 等价原 scripts/tb_download_template.js。
 *
 * 原脚本：taobao-product-listing\scripts\tb_download_template.js
 *         （Playwright + CDP 版，只读参照，本文件不改它）
 *
 * 为什么要它：`tb_build.py --from-template` 依赖官方模板（它是**按类目**给的，表头就一列规格），
 * 换类目就得重下。这是上架流程里的正式一步（不是一次性的）。
 *
 * 原脚本的关键点（都是实测踩出来的，全部保留）：
 *   · 下载要先用 CDP 指定目录：`Browser.setDownloadBehavior { behavior:'allow', downloadPath }`，
 *     否则 Chrome 会卡在"询问保存位置"；
 *   · 「下载模版」必须用**真实鼠标点击**（合成事件不算用户手势，Chrome 会静默拦下载）；
 *   · 文件下来是 `.xls`，**其实是 xlsx**（文件头 `50 4B`）。
 *   · ⚠️ 别用 `.find()` 取第一页：会拿到**最旧的**发布页，下成别的类目的模板（实测踩到）
 *     → 用 `--catid` 指定；不传则取**最后打开**的那页。
 *
 * ── 导出（只导出函数，没有 main/CLI）──────────────────────────────
 *   downloadTemplate(page, { catId, out, … })   ← 主入口；契约 `{ ok, path }`
 *   discoverTemplateUrl(page)                   ← DOM 线索（href / data-url / 按钮类名），失败诊断用
 *
 * ── 移植差异（ego 版）─────────────────────────────────────────────
 * 1. 连接/选页：原版自己 `connectOverCDP` 并在多张 publish.htm 里按 catId 挑页 → ego 一店一 space、一页，
 *    page 由编排层传入。本文件只**读回**页面 URL 的 catId：
 *    - 不在 publish.htm → `{ok:false, why:'no_publish_page'}`（原版同款提示：先把类目选到 publish.htm）；
 *    - 传了 catId 但页面 catId 不同 → 默认 `{ok:false, why:'catid_mismatch'}`（**拒绝下成别的类目的模板**；
 *      原版在这种情况下会退回「最后打开的那页」照样下 —— ego 只有一页，所以改成硬拦；
 *      确要照旧行为可传 allowCatIdMismatch:true）。
 * 2. 下载目录：ego 没有 CDP，发不了 `Browser.setDownloadBehavior` → 改为
 *    **轮询候选目录**（`out` + `__TB_CFG.downloadDir`（可多个，`;`/`,` 分隔）+ `~/Downloads`、`~/下载`），
 *    按「新文件 / 同名文件被覆盖（mtime+size 变化）」判落盘，且**等大小稳定**才算下完（避免半截文件）。
 * 3. 落盘失败时的兜底（原版没有这条路径）：
 *    ① `__TB_CFG.templateUrl`（支持 `{catId}` 占位）→ 浏览器侧 `fetch(credentials:'include')` 拿到字节
 *       （带浏览器登录态，最稳），失败再走 Node `https/http` 下载（`__TB_CFG.cookie` 可选）；
 *    ② 没有配置就扫 DOM 线索（`<a href>` / `data-url|data-href|data-download-url` / 按钮类名），
 *       找到 http(s) 绝对地址再按同样的顺序拉。
 *    ★ 模板二进制一律先验文件头（`50 4B`=xlsx / `D0 CF 11 E0`=xls），不是表格就删掉并换下一条路。
 * 4. 原版等 20×1.5s=30s 后如果目录里已有旧模板只打一行「⚠ 没等到新文件，但目录里有」并**仍判失败**
 *    → ego 版保留这个默认语义；另加 `reuseExisting:true` 才复用目录里最新的模板文件。
 * 5. 原版最后打印 `{ok:!!p, file:p}` 并 exit；ego 版返回契约字段 `{ ok, path }`，`path` 为绝对路径，
 *    另带 方式 / 类目 / 目录 / 原名 / 大小 / 是xlsx / 后缀是xls但内容是xlsx 等读回（便于 Lead 现场核对）。
 * 6. 配置：ego 子进程**不继承自定义环境变量** → 只从 `globalThis.__TB_CFG` 读；`TB_*` env 只作本地开发兜底。
 *    `__TB_CFG` 键：`catid` / `templateOut`（落地目录）/ `downloadDir` / `templateUrl` / `cookie` / `workdir`。
 * 7. ② 复用 `tb_import_sku.mjs` 的 `openBatchImportDialog`（原版两个脚本各写一份同样的开弹窗逻辑；
 *    ego 版共用一份，避免两套选择器各自漂移）。
 *
 * ── 仍依赖的硬规则（一条都不许改）─────────────────────────────────
 * A. 模板是**按类目**给的 —— 换类目必须重下；绝不拿别的类目的模板去导入。
 * B. 「下载模版」（注意平台文案是「模**版**」不是「模板」）必须**真实鼠标点击**；合成事件会被静默拦。
 * C. 下载下来的 `.xls` **内容是 xlsx**（文件头 `50 4B`）→ 读文件的工具要按 xlsx 处理。
 * D. 只做下载 + 落盘 + 读回；**不碰**「确认识别」「在当前规格后添加」等会改页面的动作。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import { say, sleep, waitUntil } from '../lib/tb_ego.mjs'
import { openBatchImportDialog } from './tb_import_sku.mjs'

/** ego 不继承自定义环境变量 → 配置只从 globalThis.__TB_CFG 读（env 仅为本地开发兜底）。 */
function tbCfg() {
  return (typeof globalThis !== 'undefined' && globalThis.__TB_CFG) || {}
}
function pickCfg(key, envName, dflt) {
  const c = tbCfg()
  if (c[key] !== undefined && c[key] !== null && c[key] !== '') return c[key]
  if (envName && typeof process !== 'undefined' && process.env && process.env[envName]) return process.env[envName]
  return dflt
}
function workdirBase() {
  const w = String(pickCfg('workdir', 'TB_WORKDIR', '') || '')
  return w ? path.resolve(w) : process.cwd()
}

function listDir(dir) {
  try {
    return readdirSync(dir).filter((f) => {
      try {
        return statSync(path.join(dir, f)).isFile()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

function statOf(file) {
  try {
    const st = statSync(file)
    return st.isFile() ? st : null
  } catch {
    return null
  }
}

/** 候选下载目录：out 一定在里面；再加 __TB_CFG.downloadDir（可多个）与常见 Downloads。 */
function candidateDirs(out, explicit) {
  const raw = []
  const push = (v) => {
    if (!v) return
    if (Array.isArray(v)) v.forEach((x) => raw.push(String(x)))
    else String(v).split(/[;,]/).forEach((x) => raw.push(x))
  }
  push(explicit)
  push(pickCfg('downloadDir', 'TB_DOWNLOAD_DIR', ''))
  const home = os.homedir()
  push(path.join(home, 'Downloads'))
  push(path.join(home, '下载'))
  const seen = new Set()
  const dirs = []
  for (const item of raw) {
    const s = String(item).trim()
    if (!s) continue
    const abs = path.resolve(s)
    if (seen.has(abs) || !existsSync(abs)) continue
    seen.add(abs)
    dirs.push(abs)
  }
  if (!dirs.includes(path.resolve(out))) dirs.unshift(path.resolve(out))
  return dirs
}

/** 目录快照：name → `mtimeMs:size`，用来识别「新文件」与「同名文件被覆盖」。 */
function snapshot(dirs) {
  const map = new Map()
  for (const d of dirs) {
    const rec = new Map()
    for (const f of listDir(d)) {
      const st = statOf(path.join(d, f))
      if (st) rec.set(f, st.mtimeMs + ':' + st.size)
    }
    map.set(d, rec)
  }
  return map
}

/** 文件头判类型（原版注释：`.xls` 其实是 xlsx，文件头 50 4B）。 */
function sniffExcel(file) {
  const st = statOf(file)
  let head = Buffer.alloc(0)
  try {
    head = readFileSync(file).subarray(0, 8)
  } catch {
    /* 读不到就只报大小 */
  }
  const hex = head
    .subarray(0, 4)
    .toString('hex')
    .toUpperCase()
    .split('')
    .join('')
    .replace(/(.{2})/g, '$1 ')
    .trim()
  const 是xlsx = head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b
  const 是xls = head.length >= 4 && head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0
  const 后缀 = path.extname(file).toLowerCase()
  return {
    头四字节: hex,
    是xlsx,
    是xls,
    后缀,
    大小: st ? st.size : 0,
    后缀是xls但内容是xlsx: 后缀 === '.xls' && 是xlsx,
  }
}

/** 把候选目录里下到的文件复制进 out（同名已存在就加时间戳，绝不覆盖旧模板）。 */
function copyInto(dir, src) {
  const base = path.basename(src)
  const dest = path.join(dir, base)
  if (path.resolve(src) === path.resolve(dest)) return dest
  try {
    let target = dest
    if (existsSync(dest)) target = path.join(dir, base.replace(/(\.[^.]+)$/, '_' + Date.now() + '$1'))
    copyFileSync(src, target)
    return target
  } catch {
    return src
  }
}

/**
 * 等浏览器把文件落地：轮询候选目录，只认 `.xls/.xlsx`，且等大小稳定（避免半截文件）。
 * 原版语义：20×1.5s 超时；超时后目录里有旧模板也只提示、默认仍判失败（reuseExisting 才复用）。
 */
async function waitForNewExcelFile({ dirs, beforeMap, timeoutMs = 30000 }) {
  const started = Date.now()
  const trace = []
  while (Date.now() - started < timeoutMs) {
    await sleep(1500)
    for (const d of dirs) {
      const rec = beforeMap.get(d) || new Map()
      for (const f of listDir(d)) {
        if (/\.crdownload$|\.part$|\.tmp$/i.test(f)) continue
        const p = path.join(d, f)
        const st = statOf(p)
        if (!st) continue
        const key = st.mtimeMs + ':' + st.size
        const prev = rec.get(f)
        const isNew = !prev
        const changed = !!prev && prev !== key && st.mtimeMs >= started - 2000
        if (!isNew && !changed) continue
        if (!/\.xls[x]?$/i.test(f)) {
          trace.push({ 目录: d, 文件: f, 状态: '非表格，忽略' })
          rec.set(f, key)
          continue
        }
        const size1 = st.size
        await sleep(900)
        const st2 = statOf(p)
        if (st2 && st2.size > 0 && st2.size === size1) {
          trace.push({ 目录: d, 文件: f, 大小: size1 })
          return { file: p, 目录: d, 原名: f, 大小: size1, trace }
        }
        trace.push({ 目录: d, 文件: f, 大小: st2 ? st2.size : 0, 状态: '仍在写入' })
        rec.set(f, key)
      }
    }
  }
  return { file: null, trace }
}

/**
 * DOM 线索：找「下载模版」按钮的类名，以及可能藏着模板地址的 href / data-* 属性。
 * （原版没做这步；ego 版用于「浏览器下载拦不住 / 不知道 ego 的下载目录」时的兜底。）
 */
export async function discoverTemplateUrl(page) {
  return page
    .evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const hrefs = []
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        const href = String(a.getAttribute('href') || '')
        if (/xls|excel|template|download|模板/i.test(href)) hrefs.push({ href: href.slice(0, 200), 文本: clean(a.innerText).slice(0, 20) })
      }
      const attrs = []
      for (const el of Array.from(document.querySelectorAll('[data-url],[data-href],[data-download-url]'))) {
        for (const k of ['data-url', 'data-href', 'data-download-url']) {
          const v = el.getAttribute(k)
          if (v && /xls|excel|template|download/i.test(v)) attrs.push({ 属性: k, 值: String(v).slice(0, 200), 文本: clean(el.innerText).slice(0, 20) })
        }
      }
      const btn =
        Array.from(document.querySelectorAll('.download-template-btn')).filter((e) => {
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        })[0] ||
        Array.from(document.querySelectorAll('button,a,span,div')).find((e) => /下载模[版板]/.test(clean(e.innerText)))
      return {
        按钮类名: btn ? clean(btn.className).slice(0, 80) : null,
        按钮标签: btn ? btn.tagName : null,
        href候选: hrefs.slice(0, 8),
        data候选: attrs.slice(0, 8),
      }
    })
    .catch((e) => ({ 错误: String((e && e.message) || e) }))
}

/** 浏览器侧 fetch（带浏览器登录态），返回 base64（避免二进制在 evaluate 里丢精度）。 */
async function browserFetchBase64(page, url, timeoutMs = 30000) {
  return page
    .evaluate(
      async ({ url, timeoutMs }) => {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), timeoutMs)
        try {
          const res = await fetch(url, { credentials: 'include', signal: ctl.signal })
          const buf = await res.arrayBuffer()
          const bytes = new Uint8Array(buf)
          let bin = ''
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
          let b64 = ''
          try {
            b64 = btoa(bin)
          } catch (e) {
            return { ok: false, why: 'btoa_failed: ' + String((e && e.message) || e) }
          }
          return { ok: res.ok, status: res.status, type: String(res.headers.get('content-type') || ''), size: bytes.length, b64, finalUrl: String(res.url || url) }
        } catch (e) {
          return { ok: false, why: String((e && e.message) || e) }
        } finally {
          clearTimeout(timer)
        }
      },
      { url: String(url), timeoutMs }
    )
    .catch((e) => ({ ok: false, why: 'evaluate_failed: ' + String((e && e.message) || e) }))
}

/** Node 侧下载（原版下载受限时的兜底；cookie 可选）。 */
function nodeDownload(url, dest, { cookie, referer, redirects = 5, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const go = (target, left) => {
      let u
      try {
        u = new URL(target)
      } catch (e) {
        resolve({ ok: false, why: 'bad_url: ' + String((e && e.message) || e) })
        return
      }
      const lib = u.protocol === 'https:' ? https : http
      const req = lib.request(
        {
          method: 'GET',
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            accept: 'application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*',
            referer: String(referer || 'https://item.upload.taobao.com/'),
            ...(cookie ? { cookie: String(cookie) } : {}),
          },
        },
        (res) => {
          const status = res.statusCode || 0
          if (status >= 300 && status < 400 && res.headers.location && left > 0) {
            res.resume()
            go(new URL(String(res.headers.location), target).toString(), left - 1)
            return
          }
          if (status < 200 || status >= 300) {
            res.resume()
            resolve({ ok: false, why: 'http_' + status, status })
            return
          }
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            const buf = Buffer.concat(chunks)
            try {
              writeFileSync(dest, buf)
              resolve({ ok: true, status, bytes: buf.length, type: String(res.headers['content-type'] || ''), finalUrl: target })
            } catch (e) {
              resolve({ ok: false, why: 'write_failed: ' + String((e && e.message) || e) })
            }
          })
        }
      )
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
      req.on('error', (e) => resolve({ ok: false, why: String((e && e.message) || e) }))
      req.end()
    }
    go(String(url), redirects)
  })
}

/**
 * 按 URL 拉模板并落盘（浏览器侧 fetch → Node 下载，或反之）。
 * @returns `{ ok, file, 方式:'browser_fetch'|'node_fetch', 状态码, 字节, 内容类型, trace }` /
 *          `{ ok:false, why, 地址, trace }`
 */
async function fetchTemplateToFile(page, { url, OUT, 类目, cookie, referer, preferred = 'auto', timeoutMs = 30000 }) {
  const destBase = path.join(OUT, `SKU模板_${类目 || 'unknown'}_${Date.now()}`)
  // 先按内容嗅探再定后缀（下面写文件时会用 realDest）
  let dest = destBase + '.xlsx'
  const pageUrl = String(await Promise.resolve(page.url()).catch(() => ''))
  let 同源 = false
  try {
    同源 = new URL(String(url)).origin === new URL(pageUrl).origin
  } catch {
    /* 地址不合法就走 Node */
  }
  const order = preferred === 'browser' ? ['browser', 'node'] : preferred === 'node' ? ['node', 'browser'] : 同源 ? ['browser', 'node'] : ['node', 'browser']
  const trace = []
  for (const how of order) {
    let res = null
    let bytes = 0
    if (how === 'browser') {
      const b = await browserFetchBase64(page, url, timeoutMs)
      if (b && b.ok && b.b64) {
        try {
          const buf = Buffer.from(b.b64, 'base64')
          writeFileSync(dest, buf)
          bytes = buf.length
          res = { 方式: 'browser_fetch', 状态码: b.status, 字节: bytes, 内容类型: b.type }
        } catch (e) {
          trace.push({ 方式: 'browser_fetch', 失败: 'write: ' + String((e && e.message) || e) })
          continue
        }
      } else {
        trace.push({ 方式: 'browser_fetch', 失败: b ? b.why || 'status_' + b.status : 'no_result' })
        continue
      }
    } else {
      const n = await nodeDownload(url, dest, { cookie, referer, timeoutMs })
      if (n.ok) {
        bytes = n.bytes
        res = { 方式: 'node_fetch', 状态码: n.status, 字节: bytes, 内容类型: n.type }
      } else {
        trace.push({ 方式: 'node_fetch', 失败: n.why })
        continue
      }
    }
    const sniff = sniffExcel(dest)
    if (!sniff.是xlsx && !sniff.是xls) {
      // 拿到了但不是表格（典型：登录页 HTML / 错误提示）→ 删掉换下一条路
      try {
        unlinkSync(dest)
      } catch {
        /* ignore */
      }
      trace.push({ 方式: how, 非表格: sniff.头四字节, 字节: bytes })
      continue
    }
    // ★ 后缀按**内容**定：官方模板内容几乎都是 xlsx（50 4B），平台有时给 .xls 名字
    const wantXlsx = sniff.是xlsx
    const curXlsx = /\.xlsx$/i.test(dest)
    if (wantXlsx !== curXlsx) {
      const target = dest.replace(/\.(xlsx|xls)$/i, wantXlsx ? '.xlsx' : '.xls')
      try {
        copyFileSync(dest, target)
        try {
          unlinkSync(dest)
        } catch {}
        dest = target
      } catch {}
    }
    trace.push({ 方式: how, 状态码: res.状态码, 字节: bytes })
    return { ok: true, file: dest, ...res, trace }
  }
  return { ok: false, why: 'fetch_failed', 地址: String(url).slice(0, 200), trace }
}

/** 把 `{catId}` 占位替换成真实类目。 */
function withCat(url, catId) {
  return String(url).replace(/\{catId\}/g, String(catId || ''))
}

/** 从 DOM 线索里挑一个可用的绝对地址（href / data-* 优先 http(s)，其次 `//` 补 https）。 */
function urlFromLeads(leads) {
  const cands = []
  for (const h of (leads && leads.href候选) || []) cands.push(String(h.href || ''))
  for (const d of (leads && leads.data候选) || []) cands.push(String(d.值 || ''))
  const abs = cands.find((u) => /^https?:\/\//i.test(u))
  if (abs) return abs
  const proto = cands.find((u) => u.startsWith('//'))
  return proto ? 'https:' + proto : ''
}

/**
 * 主入口（契约）：下载当前类目的官方 SKU 模板并落盘到 `out`。
 *
 * @param page - ego page（应在 publish.htm；本函数只读 URL，不改页面内容）。
 * @param opts - 见下：
 *   catId               - 类目 id（默认取 __TB_CFG.catid 或页面 URL 读回）；与页面不一致会硬拦。
 *   out                 - 落地目录（默认 __TB_CFG.templateOut，再退到 `<workdir>/output/_downloads`）。
 *   templateUrl         - 可选：模板地址（支持 `{catId}` 占位）；配置了就能在 UI 下载失败时兜底拉取。
 *   downloadDir         - 可选：ego 的真实下载目录（可传数组或 `;`/`,` 分隔字符串）。
 *   mode                - 'ui'（默认，先真实点「下载模版」等落盘）/ 'url'（直接按地址拉）/ 'browser' / 'node'。
 *   timeoutMs           - 等落盘上限（默认 30000，原版 20×1.5s）。
 *   allowCatIdMismatch  - true 时允许页面 catId≠入参 catId（默认 false，硬拦）。
 *   reuseExisting       - true 时目录里已有模板可直接复用（默认 false = 原版语义：判失败）。
 *   cookie / referer    - Node 侧拉取用的 Cookie 头 / Referer。
 * @returns 成功 `{ ok:true, path:<绝对路径>, file, 方式, 类目, 目录, 原名, 大小, 是xlsx, … }`
 *          失败 `{ ok:false, why, …读回 }`
 */
export async function downloadTemplate(page, opts = {}) {
  const t0 = Date.now()
  try {
    const res = await downloadInner(page, opts)
    if (res && res.ok === false) res.耗时ms = Date.now() - t0
    return res
  } catch (e) {
    return { ok: false, why: 'exception', 错误: String((e && e.message) || e), 耗时ms: Date.now() - t0 }
  }
}

/**
 * 点「下载模版」后直接把字节取回来（绕开 ego 的「另存为」对话框）。
 *
 * 实测：ego 里点这个按钮会抛 "This action opened a file chooser..." —— 其实是 Chrome 弹了
 * 「另存为」（save-as），ego 把它当 file chooser 并取消。但此时 Chrome 已经生成 blob/直链，
 * 所以这里在点击前挂钩子，点击后自己把字节读成 base64 交给调用方落盘，不依赖下载目录。
 *
 * @param page - ego page。
 * @param clickPos - 按钮中心坐标（真实鼠标点击带用户手势；合成事件会被 Chrome 静默拦下载）。
 * @param options.label - 日志标签。
 * @returns `{ ok, b64, 来源, url, contentType, 字节数, 抓到 }` 或 `{ ok:false, why, 抓到 }`。
 */
/**
 * 强制 Chrome 的下载落到指定目录（CDP）。
 *
 * ego 里点「下载模版」会触发「另存为」（被 ego 当 file chooser 取消），文件既不落在我们的候选目录、
 * blob 钩子也抓不到 —— 结果是 `download_not_landed`。先用 CDP 设下载目录，再点按钮，文件就会直接落地。
 * @returns `{ ok, method? }`
 */
async function forceDownloadDir(page, dir) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {}
  const trials = [
    ['Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true }],
    ['Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir }],
  ]
  for (const [method, params] of trials) {
    try {
      await page.cdp(method, params)
      say('   CDP ' + method + ' → 下载目录 =', dir)
      return { ok: true, method }
    } catch (e) {
      /* 换下一个 */
    }
  }
  say('   ⚠ CDP 设置下载目录失败（两条命令都不支持）')
  return { ok: false }
}

async function captureDownloadBytes(page, clickPos, { label = '下载模版' } = {}) {
  await page
    .evaluate(() => {
      window.__TB_NET = []
      window.__TB_BLOBS = []
      if (window.__TB_HOOKED2) return true
      window.__TB_HOOKED2 = true
      try {
        const create = URL.createObjectURL.bind(URL)
        URL.createObjectURL = function (blob) {
          const u = create(blob)
          try { window.__TB_BLOBS.push({ u, size: (blob && blob.size) || 0 }) } catch (e) {}
          return u
        }
      } catch (e) {}
      try {
        const aclick = HTMLAnchorElement.prototype.click
        HTMLAnchorElement.prototype.click = function () {
          try { window.__TB_NET.push('anchor:' + String(this.href || '')) } catch (e) {}
          return aclick.call(this)
        }
      } catch (e) {}
      try {
        const of = window.fetch
        window.fetch = function (...a) {
          try {
            const u = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url)
            if (u) window.__TB_NET.push('fetch:' + String(u))
          } catch (e) {}
          return of.apply(this, a)
        }
      } catch (e) {}
      try {
        const xo = XMLHttpRequest.prototype.open
        XMLHttpRequest.prototype.open = function (m, u, ...rest) {
          try { if (u) window.__TB_NET.push('xhr:' + String(u)) } catch (e) {}
          return xo.call(this, m, u, ...rest)
        }
      } catch (e) {}
      try {
        const ow = window.open
        window.open = function (u, ...rest) {
          try { if (u) window.__TB_NET.push('open:' + String(u)) } catch (e) {}
          return ow.call(window, u, ...rest)
        }
      } catch (e) {}
      return true
    })
    .catch(() => false)

  if (page.mouse && typeof page.mouse.move === 'function') await page.mouse.move(clickPos.x, clickPos.y).catch(() => {})
  await sleep(300)
  // ⚠️ 这次点击**预期会抛错**（另存为被 ego 取消）—— 不是失败，吞掉继续
  await page.mouse.click(clickPos.x, clickPos.y, { label }).catch((e) => say('   （点击触发另存为对话框，已取消；改从 blob/直链取字节）'))
  await sleep(2500)

  const 抓 = await page
    .evaluate(async () => {
      const net = (window.__TB_NET || []).slice(-20)
      const blobs = (window.__TB_BLOBS || []).slice(-5)
      const b64of = (bytes) => {
        let s = ''
        for (let i = 0; i < bytes.length; i += 8192) {
          s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
        }
        return btoa(s)
      }
      let pick = null
      for (let i = blobs.length - 1; i >= 0 && !pick; i -= 1) {
        try {
          const r = await fetch(blobs[i].u)
          const bytes = new Uint8Array(await r.arrayBuffer())
          if (bytes.length > 2048) {
            pick = { 来源: 'blob', url: blobs[i].u, 字节数: bytes.length, contentType: r.headers.get('content-type') || '', b64: b64of(bytes) }
          }
        } catch (e) {}
      }
      if (!pick) {
        const cand = net.find((n) => /\.(xlsx|xls)(\?|$)/i.test(n)) || net.find((n) => /template|模[版板]|download/i.test(n))
        if (cand) {
          const u = String(cand).replace(/^(fetch|xhr|open|anchor):/, '')
          try {
            const r = await fetch(u, { credentials: 'include' })
            const bytes = new Uint8Array(await r.arrayBuffer())
            if (bytes.length > 2048) {
              pick = { 来源: 'url', url: u, 字节数: bytes.length, contentType: r.headers.get('content-type') || '', b64: b64of(bytes) }
            }
          } catch (e) {}
        }
      }
      return { pick, 抓到: net }
    })
    .catch((e) => ({ pick: null, 抓到: [], why: String((e && e.message) || e) }))

  if (抓.pick) return { ok: true, ...抓.pick, 抓到: 抓.抓到 }
  return { ok: false, why: 'no_bytes_captured', 抓到: 抓.抓到 }
}

/**
 * 确保页面停在「基础信息」tab —— SKU 导入区 / 「批量导入」按钮只在这页。
 *
 * 为什么要单独做：`categoryProfile` 抓完媒体要求会**停在「图文描述」**，而刚进类目时 tab 栏可能还没渲染完
 * → 外面那次「点一下基础信息」经常点空 → 后面「批量导入」按钮根本不在 DOM 里 →
 * 报一个含糊的 `dialog_not_open`（实测 2026-11-16 连踩两次）。
 * 这里改成：先探测是否已就绪；没就绪就真实鼠标点 tab 并**等按钮出现**，最多 3 轮。
 * @returns `{ ok, 已在?, 尝试?, 读回? }`
 */
async function ensureBasicInfoTab(page) {
  const probe = () =>
    page
      .evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const vis = (e) => {
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const hasBtn = [...document.querySelectorAll('button,a,span,div')].filter(vis).some((e) => clean(e.innerText) === '批量导入')
        // ★ 必须**可见**才算就绪：页面停在「图文描述」时基础信息的 DOM 仍然挂着，
        //   只判断「存在」会误判成就绪 → 不去切 tab → 点不到可见的「批量导入」→ dialog_not_open。
        //   这就是「第一次下载必失败、第二次（页面已停在基础信息）才成功」的确定性原因（2026-11-17 定位）。
        const el = document.querySelector('.sell-component-sku-excel-upload')
        const sku = !!(el && vis(el))
        return { hasBtn, sku }
      })
      .catch(() => ({ hasBtn: false, sku: false }))
  const ready = (st) => !!(st && (st.hasBtn || st.sku))
  let st = await probe()
  if (ready(st)) return { ok: true, 已在: true }
  const 尝试 = []
  for (let i = 0; i < 3; i += 1) {
    const pt = await page
      .evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const vis = (e) => {
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        // ★ 放宽：tab 可能在 sticky 头下面（top 更靠下）、也可能是个 <a>/<li>
        const cand = [...document.querySelectorAll('div,span,a,li')]
          .filter(vis)
          .filter((e) => clean(e.innerText) === '基础信息')
          .map((e) => ({ e, r: e.getBoundingClientRect() }))
          .filter((o) => o.r.top < 220)
          .sort((a, b) => a.r.top - b.r.top)
        if (!cand.length) return { ok: false }
        const el = cand[0].e
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        const vw = document.documentElement.clientWidth
        const vh = document.documentElement.clientHeight
        return { ok: true, x: Math.round(Math.min(Math.max(r.left + r.width / 2, 5), vw - 5)), y: Math.round(Math.min(Math.max(r.top + r.height / 2, 5), vh - 5)) }
      })
      .catch(() => ({ ok: false }))
    if (pt.ok) {
      await page.mouse.move(pt.x, pt.y).catch(() => {})
      await sleep(120)
      await page.mouse.click(pt.x, pt.y, { label: 'basic-info-tab' }).catch(() => {})
    }
    await sleep(1300)
    st = await probe()
    尝试.push({ 轮次: i + 1, 找到tab: !!pt.ok, 就绪: ready(st), 读回: st })
    if (ready(st)) return { ok: true, 已在: false, 尝试 }
  }
  return { ok: false, why: 'basic_tab_not_ready', 读回: st, 尝试 }
}

/**
 * 直接调「导出 SKU 模板」接口，拿 OSS 签名直链（**不依赖点击、不依赖下载手势**）。
 * @param page - 当前发布页（带登录态）。
 * @param catId - 类目 id。
 * @returns `{ url, status, 尝试 }`
 */
async function exportTemplateViaApi(page, catId) {
  const id = String(catId || '').trim()
  if (!id) return { url: '', 尝试: [{ err: 'no_catid' }] }
  const 尝试 = []
  const paths = [
    `/excel/sku/exportSkuTemplate?templateType=aiExcel&catId=${id}`,
    `/excel/sku/exportSkuTemplate?catId=${id}&templateType=aiExcel`,
    `/excel/sku/exportSkuTemplate?catId=${id}`,
  ]
  for (const p of paths) {
    for (const method of ['GET', 'POST']) {
      const r = await page
        .evaluate(
          async ({ p, method }) => {
            try {
              const res = await fetch(p, {
                method,
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: method === 'POST' ? JSON.stringify({ catId: p.match(/catId=(\d+)/)?.[1] || '', templateType: 'aiExcel' }) : undefined,
              })
              const txt = await res.text()
              return { status: res.status, txt: txt.slice(0, 800) }
            } catch (e) {
              return { err: String((e && e.message) || e).slice(0, 120) }
            }
          },
          { p, method },
        )
        .catch(() => ({ err: 'eval_failed' }))
      const cand = []
      try {
        const j = JSON.parse(r.txt || '{}')
        const d = j.data || {}
        if (typeof d === 'string') cand.push(d)
        if (d && typeof d === 'object') cand.push(d.url, d.downloadUrl, d.fileUrl, d.templateUrl)
        cand.push(j.url)
        if (typeof j.data === 'string') cand.push(j.data)
      } catch {}
      const m = String(r.txt || '').match(/https?:\/\/[^"'\s\\]+/g) || []
      cand.push(...m)
      const hit = cand.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)).find((u) => /\.(xlsx|xls)(\?|$)/i.test(u)) || cand.find((u) => typeof u === 'string' && /^https?:\/\//.test(u)) || ''
      尝试.push({ p: p.slice(0, 64), method, status: r.status, err: r.err || null, hit: String(hit).slice(0, 80) })
      if (hit) return { url: String(hit), status: r.status, 尝试 }
      if (r.err) continue
    }
  }
  return { url: '', 尝试 }
}

async function downloadInner(page, opts) {
  const MODE = String(opts.mode || 'ui')
  const TIMEOUT = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30000
  const ALLOW_MISMATCH = !!opts.allowCatIdMismatch
  const REUSE = !!opts.reuseExisting
  if (!page) return { ok: false, why: 'no_page' }

  const 类目 = String(opts.catId || pickCfg('catid', 'TB_CATID', '') || '').trim()
  const OUT = path.resolve(String(opts.out || pickCfg('templateOut', 'TB_TEMPLATE_OUT', '') || path.join(workdirBase(), 'output', '_downloads')))

  // ⓪ 页面读回（原版靠「挑对 publish 页」；ego 只有一页 → 直接读 URL 校验类目）
  const st = await page
    .evaluate(() => {
      const url = location.href
      return {
        url: String(url).slice(0, 200),
        在发布页: /publish\.htm/.test(url),
        catId: (url.match(/catId=(\d+)/) || [])[1] || null,
        来自以图发品: /fromAIImage=true/.test(url),
        有SKU导入区: !!document.querySelector('.sell-component-sku-excel-upload'),
      }
    })
    .catch(() => ({ url: '', 在发布页: false, catId: null, 来自以图发品: false, 有SKU导入区: false }))
  if (!st.在发布页) {
    say('★ 找不到发布页（先把类目选到 publish.htm）:', st.url)
    return { ok: false, why: 'no_publish_page', 提示: '先把类目选到 publish.htm（类目页 → 确认，下一步）', 工作页: st.url }
  }
  const 页面catId = st.catId
  if (类目 && 页面catId && 类目 !== 页面catId && !ALLOW_MISMATCH) {
    say('★ 页面 catId 与入参不一致 → 拒绝下成别的类目模板:', 页面catId, '≠', 类目)
    return {
      ok: false,
      why: 'catid_mismatch',
      类目,
      页面catId,
      工作页: st.url,
      提示: 'ego 一店一页，不能再像原版那样在多张发布页里挑 catId 匹配的那张；确需照旧行为请传 allowCatIdMismatch:true',
    }
  }
  const 有效类目 = 类目 || 页面catId || ''
  say('① 工作页:', st.url.slice(0, 96), '| 类目 =', 有效类目 || '（未读到）')

  // ★ 下载按钮只存在于「基础信息」tab：先确保切过去并等导入区就绪，否则只会得到含糊的 dialog_not_open
  const tab = await ensureBasicInfoTab(page)
  say('①b 基础信息 tab:', JSON.stringify({ ok: tab.ok, 已在: tab.已在, why: tab.why || null, 尝试: tab.尝试 || null }))
  if (!tab.ok) {
    return {
      ok: false,
      why: 'basic_tab_not_ready',
      步骤: '①b 切到基础信息 tab',
      类目: 有效类目,
      工作页: st.url,
      读回: tab,
      提示: '页面不在「基础信息」tab（或 tab 栏还没渲染完），「批量导入 / 下载模版」按钮不在 DOM 里；' +
        '常见于刚进类目就下载。稍后重试一次通常就好，也可在页面上手动点一下「基础信息」。',
    }
  }

  // 页面校验通过后才建目录（原版在开工就 mkdir；ego 版避免「拦下来了还留下空目录」）
  mkdirSync(OUT, { recursive: true })
  const dirs = candidateDirs(OUT, opts.downloadDir)
  const beforeMap = snapshot(dirs)
  const URL_FROM_CFG = String(opts.templateUrl || pickCfg('templateUrl', 'TB_TEMPLATE_URL', '') || '')
  const COOKIE = String(opts.cookie || pickCfg('cookie', 'TB_COOKIE', '') || '')
  const REFERER = String(opts.referer || st.url || '')

  let got = null
  let 方式 = null
  let 点击 = null
  let 线索 = null
  let 目录内最新 = null
  let 等待轨迹 = []

  // ①b 「url / browser / node」模式：跳过 UI，直接按地址拉
  const 显式地址 = URL_FROM_CFG ? withCat(URL_FROM_CFG, 有效类目) : ''
  const 直接拉 = MODE === 'url' || MODE === 'browser' || MODE === 'node'
  const 已试地址 = new Set()
  if (直接拉) {
    let url = 显式地址
    if (!url) {
      say('   mode =', MODE, '但没给 templateUrl → 先扫 DOM 线索')
      线索 = await discoverTemplateUrl(page)
      url = urlFromLeads(线索)
      say('   DOM 线索给出的地址:', url || '（没有 http(s) 绝对地址）')
    }
    if (url) {
      say('①b 直接按 URL 拉模板:', String(url).slice(0, 120))
      已试地址.add(url)
      const r = await fetchTemplateToFile(page, {
        url,
        OUT,
        类目: 有效类目,
        cookie: COOKIE,
        referer: REFERER,
        preferred: MODE === 'url' ? 'auto' : MODE,
        timeoutMs: TIMEOUT,
      })
      say('   拉取结果:', JSON.stringify({ ok: r.ok, 方式: r.方式, why: r.why, 字节: r.字节 }))
      if (r.ok) {
        got = { file: r.file, 目录: OUT, 原名: path.basename(r.file), 大小: r.字节, trace: r.trace }
        方式 = r.方式
      }
    } else {
      say('   ⚠ 拿不到模板地址 → 回落到 UI 点击「下载模版」')
    }
  }

  // ★ ①c 直接调「导出 SKU 模板」接口拿 OSS 直链 —— **不依赖任何点击/用户手势**。
  //   为什么必须加这条：UI 点「下载模版」需要真实手势，合成点击会被 Chrome 静默拦下载，
  //   而前端也可能是 `<a download>`/blob 导致 URL 钩子抓不到 → 首次下载必 `download_not_landed`。
  //   接口返回的就是 alibaba OSS 签名直链（带限时签名），浏览器侧带 cookie fetch 即可。
  if (!got) {
    try {
      const api = await exportTemplateViaApi(page, 有效类目)
      say('①c 直连导出接口:', JSON.stringify({ ok: !!api.url, status: api.status, url: (api.url || '').slice(0, 100), 尝试: api.尝试, err: api.err }))
      if (api.url) {
        const r = await fetchTemplateToFile(page, {
          url: api.url,
          OUT,
          类目: 有效类目,
          cookie: COOKIE,
          referer: REFERER,
          preferred: 'browser',
          timeoutMs: TIMEOUT,
        })
        say('   接口直链拉取结果:', JSON.stringify({ ok: r.ok, 方式: r.方式, why: r.why, 字节: r.字节 }))
        if (r.ok) {
          got = { file: r.file, 目录: OUT, 原名: path.basename(r.file), 大小: r.字节, trace: r.trace }
          方式 = 'api_url'
        }
      }
    } catch (e) {
      say('   ①c 接口直连失败（不影响后续 UI 兜底）:', String((e && e.message) || e).slice(0, 120))
    }
  }

  // ② 打开「批量导入」弹窗（若没开）—— 原版同款；下载按钮在弹窗里
  if (!got) {
    const open = await openBatchImportDialog(page)
    say('② 打开批量导入:', JSON.stringify({ ok: open.ok, 方式: open.方式, 弹窗文本: open.已开 ? open.已开.文本 : null, why: open.why }))
    if (!open.ok) {
      return {
        ok: false,
        why: open.why || 'dialog_not_open',
        步骤: '② 打开批量导入',
        类目: 有效类目,
        挂起地址: 显式地址 || null,
        工作页: st.url,
        读回: open,
      }
    }

    // ③ 真实鼠标点「下载模版」（合成事件不算用户手势，Chrome 会静默拦下载）
    //    ★ 先确认弹窗真的开着：不然按钮不在 DOM 里 → 找不到/点了没反应（实测就是这里丢的）
    const dialogReady = () =>
      page
        .evaluate(() => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
          return [...document.querySelectorAll('div')].some((d) => {
            const t = clean(d.innerText)
            return t.includes('下载模版') && t.includes('模板上传')
          })
        })
        .catch(() => false)
    if (!(await dialogReady())) {
      const openPt = await page
        .evaluate(() => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
          const vis = (e) => {
            const r = e.getBoundingClientRect()
            return r.width > 0 && r.height > 0
          }
          const el = [...document.querySelectorAll('button,a,span,div')].filter(vis).find((e) => clean(e.innerText) === '批量导入')
          if (!el) return { ok: false }
          el.scrollIntoView({ block: 'center' })
          const r = el.getBoundingClientRect()
          const vw = document.documentElement.clientWidth
          const vh = document.documentElement.clientHeight
          return { ok: true, x: Math.round(Math.min(Math.max(r.left + r.width / 2, 5), vw - 5)), y: Math.round(Math.min(Math.max(r.top + r.height / 2, 5), vh - 5)) }
        })
        .catch(() => ({ ok: false }))
      if (openPt.ok) {
        await page.mouse.move(openPt.x, openPt.y).catch(() => {})
        await sleep(150)
        await page.mouse.click(openPt.x, openPt.y).catch(() => {})
        await sleep(1200)
      }
    }
    点击 = await page
      .evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const vis = (e) => {
          if (!e) return false
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const pool = Array.from(document.querySelectorAll('button,a,span,div')).filter(vis)
        // 优先平台自带的 class（现场记录 记录：button.download-template-btn）
        const byClass = pool.filter((e) => /download-template-btn/i.test(String(e.className || '')))
        const hits = byClass.length ? byClass : pool.filter((e) => /下载模[版板]/.test(clean(e.innerText)))
        if (!hits.length) return { ok: false, why: 'no_download_btn' }
        const el = hits.filter((e) => !hits.some((o) => o !== e && e.contains(o)))[0]
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        const vw = document.documentElement.clientWidth
        const vh = document.documentElement.clientHeight
        return {
          ok: true,
          x: Math.round(Math.min(Math.max(r.left + r.width / 2, 5), vw - 5)),
          y: Math.round(Math.min(Math.max(r.top + r.height / 2, 5), vh - 5)),
          文本: clean(el.innerText).slice(0, 12),
          类名: String(el.className || '').slice(0, 60),
          href: (el.getAttribute && (el.getAttribute('href') || el.getAttribute('data-url') || el.getAttribute('data-href'))) || null,
        }
      })
      .catch((e) => ({ ok: false, why: 'evaluate_failed: ' + String((e && e.message) || e) }))
    say('③ 找到「下载模版」:', JSON.stringify(点击))
    if (点击.ok) {
      // ③a 按钮可能还在 loading/disabled（刚打开弹窗）→ 等它真的可点，否则点了不发 XHR
      await waitUntil(
        async () =>
          (await page
            .evaluate(() => {
              const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
              const vis = (e) => {
                const r = e.getBoundingClientRect()
                return r.width > 0 && r.height > 0
              }
              const btn = [...document.querySelectorAll('button,a,span,div')]
                .filter(vis)
                .filter((e) => /download-template-btn/i.test(String(e.className || '')) || clean(e.innerText) === '下载模版')[0]
              if (!btn) return false
              const isBtn = String(btn.tagName) === 'BUTTON' ? btn : btn.closest('button')
              return !(isBtn && isBtn.disabled)
            })
            .catch(() => false))
            ? true
            : null,
        { timeoutMs: 6000, intervalMs: 250, label: 'download-btn-enabled' }
      )
      // ③b 先把下载目录定到 OUT（否则 ego 的「另存为」会把文件吞掉，哪个候选目录都等不到）
      const forced = await forceDownloadDir(page, OUT)
      say('   下载目录已就位:', JSON.stringify(forced))

      // ★ ③c 点击前**重新定位并做命中校验**：刚打开弹窗时按钮还在动画里，
      //   用之前算的坐标会点空 → 没有下载请求 → download_not_landed（这就是「第一次必失败」的真因）。
      const locateVerified = async () =>
        page
          .evaluate(() => {
            const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
            const vis = (e) => {
              if (!e) return false
              const r = e.getBoundingClientRect()
              return r.width > 0 && r.height > 0
            }
            const pool = Array.from(document.querySelectorAll('button,a,span,div')).filter(vis)
            const byClass = pool.filter((e) => /download-template-btn/i.test(String(e.className || '')))
            const hits = byClass.length ? byClass : pool.filter((e) => /下载模[版板]/.test(clean(e.innerText)))
            if (!hits.length) return { ok: false, why: 'no_download_btn' }
            const el = hits.filter((e) => !hits.some((o) => o !== e && e.contains(o)))[0]
            el.scrollIntoView({ block: 'center' })
            const r = el.getBoundingClientRect()
            const x = Math.round(Math.min(Math.max(r.left + r.width / 2, 5), document.documentElement.clientWidth - 5))
            const y = Math.round(Math.min(Math.max(r.top + r.height / 2, 5), document.documentElement.clientHeight - 5))
            const hit = document.elementFromPoint(x, y)
            const inside = !!hit && (hit === el || el.contains(hit) || !!(hit.closest && el.contains(hit.closest('button,a,span,div'))))
            return { ok: true, x, y, 命中: inside, 命中节点: hit ? hit.tagName : null, 文本: clean(el.innerText).slice(0, 12) }
          })
          .catch(() => ({ ok: false, why: 'eval_failed' }))
      let 稳定 = null
      for (let i = 0; i < 6; i += 1) {
        稳定 = await locateVerified()
        if (稳定 && 稳定.ok && 稳定.命中) break
        if (i === 2) {
          const reopen = await openBatchImportDialog(page).catch(() => ({ ok: false }))
          say('   ③c 点不中 → 重开「批量导入」弹窗:', JSON.stringify({ ok: reopen && reopen.ok, 方式: reopen && reopen.方式 }))
        }
        await sleep(350)
      }
      say('③c 下载按钮命中校验:', JSON.stringify(稳定))

      // ③b 先挂钩子再点：ego 点这个按钮会弹「另存为」（被当作 file chooser 取消），
      //    但 Chrome 已生成 blob/直链 —— 自己把字节读回来，绕开对话框。
      // ★ 首次点击常常「命中但不发请求」：弹窗是刚被合成点击打开的，按钮的 handler 还没挂上
      //   （实测：等一轮后第二次点击就能拿到 OSS 直链）→ 这里做最多 3 次重点。
      let cap = { ok: false }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt) {
          say('   ③d 下载没发起 → 第', attempt + 1, '次重试（重新定位后重点）')
          await sleep(1600)
          稳定 = await locateVerified()
          say('      重新定位:', JSON.stringify(稳定))
        }
        cap = await captureDownloadBytes(page, {
          x: 稳定 && 稳定.ok ? 稳定.x : 点击.x,
          y: 稳定 && 稳定.ok ? 稳定.y : 点击.y,
        })
        if (cap && cap.ok) break
      }
      if (cap.ok) {
        const bytes = Buffer.from(String(cap.b64 || ''), 'base64')
        const magic = bytes.subarray(0, 4).toString('hex')
        const ext = magic.startsWith('504b') ? '.xlsx' : '.xls'
        const file = path.join(OUT, 'SKU模板_' + 有效类目 + '_' + Date.now() + ext)
        writeFileSync(file, bytes)
        const sniffNow = sniffExcel(file)
        if (sniffNow.是xlsx || sniffNow.是xls) {
          got = { file, 目录: OUT, 原名: path.basename(file), 大小: sniffNow.大小, trace: [] }
          方式 = 'browser_capture'
          say('④ 已直接取回模板字节（绕开「另存为」对话框）：', path.basename(file), '| 字节 =', bytes.length)
        } else {
          say('   ⚠ 取回字节不是 Excel（头四字节 =', magic, '）→ 回退目录轮询')
        }
      }
      if (!got) {
        // 兜底①：从**点击时挂到的网络钩子**里拿真实下载地址。
        // 实测这个按钮的链路是：XHR `/excel/sku/exportSkuTemplate?templateType=aiExcel&catId=…`
        //   → 后端返回一个**OSS 签名直链**（excel-tmall-item.oss-cn-qingdao.aliyuncs.com/SKU模板_<catId>_<ts>.xlsx?Signature=…）
        //   → 前端 `window.open(直链)` → Chrome 下载被 ego 当 file chooser 取消。
        // 既然直链已经捕获到，直接用 Node 拉它（签名 URL 不需要 cookie）。
        // ★ 直链是异步回来的（XHR 拿到签名地址后再 window.open）→ 轮询等它出现，不要读一次就判死
        let urls = []
        const seen = await waitUntil(
          async () => {
            const hooks = await page
              .evaluate(() => ({ net: window.__TB_NET || [] }))
              .catch(() => ({ net: [] }))
            urls = (hooks.net || [])
              .map((u) => String(u).replace(/^(open|fetch|xhr|anchor):/, ''))
              .filter((u) => /^https?:\/\//.test(u) && /\.(xlsx|xls|zip|csv)(\?|$)/i.test(u))
              .reverse()
              .slice(0, 3)
            return urls.length ? urls : null
          },
          { timeoutMs: 30000, intervalMs: 400, label: 'template-url-hook' }
        )
        say('   网络钩子等待结果:', seen.ok ? urls[0].slice(0, 110) : '（30s 内没拿到直链）')
        if (!urls.length) {
          // 钩子没抓到（按钮 loading / 钩子被重置等）→ 自己重放那个导出接口，拿到 OSS 签名直链
          const replay = await page
            .evaluate(async (catid) => {
              try {
                const r = await fetch('/excel/sku/exportSkuTemplate?templateType=aiExcel&catId=' + encodeURIComponent(catid), { credentials: 'include' })
                const t = await r.text()
                const m = t.match(/https?:[^"'\s]+?\.(?:xlsx|xls)[^"'\s]*/i)
                return { ok: true, status: r.status, url: m ? m[0] : null, sample: t.slice(0, 160) }
              } catch (e) {
                return { ok: false, err: String((e && e.message) || e) }
              }
            }, 有效类目)
            .catch((e) => ({ ok: false, err: String((e && e.message) || e) }))
          say('   重放导出接口:', JSON.stringify({ ok: replay.ok, status: replay.status, url: replay.url ? replay.url.slice(0, 110) : null }))
          if (replay.ok && replay.url) urls = [replay.url]
        }
        if (urls.length) say('   ⓘ 从网络钩子拿到模板直链:', urls[0].slice(0, 110))
        for (const u of urls) {
          if (已试地址.has(u)) continue
          已试地址.add(u)
          const fr = await fetchTemplateToFile(page, {
            url: u,
            OUT,
            类目: 有效类目,
            cookie: COOKIE,
            referer: REFERER,
            preferred: 'node',
            timeoutMs: TIMEOUT,
          }).catch((e) => ({ ok: false, why: String((e && e.message) || e) }))
          say('   直链拉取:', JSON.stringify({ ok: fr.ok, 方式: fr.方式, why: fr.why, 字节: fr.字节 }))
          if (fr.ok) {
            got = { file: fr.file, 目录: OUT, 原名: path.basename(fr.file), 大小: fr.字节, trace: fr.trace }
            方式 = 'captured_url'
            break
          }
        }
      }
      if (!got) {
        // 兜底②：再点一次（重开弹窗）—— 实测某些页面状态下第一次点不会真的发导出请求
        say('   ↻ 下载没成功 → 关弹窗重开再点一次')
        await page.keyboard.press('Escape').catch(() => {})
        await sleep(800)
        const reopen = await openBatchImportDialog(page).catch(() => ({ ok: false }))
        say('   重开弹窗:', JSON.stringify({ ok: reopen.ok, 方式: reopen.方式 }))
        if (reopen.ok) {
          const btn2 = await page
            .evaluate(() => {
              const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
              const vis = (e) => {
                const r = e.getBoundingClientRect()
                return r.width > 0 && r.height > 0
              }
              const el = [...document.querySelectorAll('button,a,span,div')]
                .filter(vis)
                .filter((e) => /download-template-btn/i.test(String(e.className || '')) || clean(e.innerText) === '下载模版')[0]
              if (!el) return { ok: false }
              el.scrollIntoView({ block: 'center' })
              const r = el.getBoundingClientRect()
              return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
            })
            .catch(() => ({ ok: false }))
          if (btn2.ok) {
            await page.mouse.move(btn2.x, btn2.y).catch(() => {})
            await sleep(200)
            await page.mouse.click(btn2.x, btn2.y).catch(() => {})
            const again = await waitUntil(
              async () => {
                const hooks2 = await page.evaluate(() => ({ net: window.__TB_NET || [] })).catch(() => ({ net: [] }))
                const u2 = (hooks2.net || [])
                  .map((u) => String(u).replace(/^(open|fetch|xhr|anchor):/, ''))
                  .filter((u) => /^https?:\/\//.test(u) && /\.(xlsx|xls)(\?|$)/i.test(u))
                  .reverse()
                  .slice(0, 1)
                if (!u2.length) return null
                const fr2 = await fetchTemplateToFile(page, { url: u2[0], OUT, 类目: 有效类目, cookie: COOKIE, referer: REFERER, preferred: 'node', timeoutMs: TIMEOUT })
                if (fr2.ok) {
                  got = { file: fr2.file, 目录: OUT, 原名: path.basename(fr2.file), 大小: fr2.字节, trace: fr2.trace }
                  方式 = 'captured_url_retry'
                }
                return got ? true : null
              },
              { timeoutMs: 20000, intervalMs: 800, label: 'download-retry' }
            )
            say('   重试结果:', JSON.stringify({ ok: !!got, 方式 }))
          }
        }
      }
      if (!got) {
        // 兜底③：万一浏览器还是把文件落到了下载目录
        const wait = await waitForNewExcelFile({ dirs, beforeMap, timeoutMs: TIMEOUT })
        等待轨迹 = wait.trace || []
        say('④ 下载结果:', wait.file || '（没下到）', wait.file ? '' : JSON.stringify(等待轨迹.slice(-3)))
        if (wait.file) {
          got = wait
          方式 = 'browser_click'
        }
      }
    } else {
      say('   ⚠ 没找到「下载模版」按钮 → 走 URL 兜底')
    }
  }

  // ④b 兜底：目录里已有旧模板（默认只提示不复用 —— 原版语义）
  const newest = listDir(OUT)
    .filter((f) => /模板|SKU/i.test(f) && /\.xls[x]?$/i.test(f))
    .map((f) => ({ f, t: (statOf(path.join(OUT, f)) || { mtimeMs: 0 }).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  if (newest.length) 目录内最新 = path.join(OUT, newest[0].f)
  if (!got && 目录内最新) say('⚠ 没等到新文件，但目录里有:', newest[0].f, REUSE ? '（reuseExisting → 复用）' : '（原版语义：不复用、判失败）')
  if (!got && REUSE && 目录内最新) {
    got = { file: 目录内最新, 目录: OUT, 原名: newest[0].f, 大小: (statOf(目录内最新) || { size: 0 }).size, trace: [] }
    方式 = 'reuse_existing'
  }

  // ⑤ 最后兜底：URL 拉取（配置地址 或 DOM 线索里找到的绝对地址）
  if (!got) {
    if (!线索) 线索 = await discoverTemplateUrl(page)
    let url = 显式地址 || urlFromLeads(线索)
    if (url && 已试地址.has(url)) {
      say('   （该地址刚试过且失败，不再重复拉）')
      url = ''
    }
    if (url) {
      say('   → 改走 URL 拉取兜底:', String(url).slice(0, 120))
      const r = await fetchTemplateToFile(page, { url, OUT, 类目: 有效类目, cookie: COOKIE, referer: REFERER, preferred: 'auto', timeoutMs: TIMEOUT })
      say('   拉取结果:', JSON.stringify({ ok: r.ok, 方式: r.方式, why: r.why, 字节: r.字节 }))
      if (r.ok) {
        got = { file: r.file, 目录: OUT, 原名: path.basename(r.file), 大小: r.字节, trace: r.trace }
        方式 = r.方式
      }
    }
  }

  if (!got) {
    return {
      ok: false,
      why: 'download_not_landed',
      类目: 有效类目,
      候选目录: dirs,
      目录内最新: 目录内最新 || null,
      等待轨迹,
      DOM线索: 线索,
      点击,
      工作页: st.url,
      建议: '① 把 __TB_CFG.downloadDir 指向 ego 的真实下载目录；② 或给 __TB_CFG.templateUrl（支持 {catId}）让浏览器/Node 直接拉；③ 手动点「下载模版」把文件放进 __TB_CFG.templateOut（或传 reuseExisting:true）',
    }
  }

  // ⑥ 落到 out（下载目录可能在别处）+ 文件头读回
  let file = copyInto(OUT, got.file)
  const sniff = sniffExcel(file)
  if (!sniff.是xlsx && !sniff.是xls) {
    return { ok: false, why: 'not_excel', path: file, file, 类目: 有效类目, ...sniff, 方式, 工作页: st.url }
  }
  // ★ 后缀按**内容**纠正：平台给的模板内容是 xlsx（头 50 4B），但文件名常是 .xls
  //   → openpyxl/读表工具会拒读 .xls，所以这里直接改名成 .xlsx
  let finalFile = file
  if (sniff.后缀是xls但内容是xlsx) {
    const xlsxPath = String(file).replace(/\.xls$/i, '.xlsx')
    try {
      copyFileSync(file, xlsxPath)
      try {
        unlinkSync(file)
      } catch {}
      finalFile = xlsxPath
      say('   ↻ 后缀已按内容纠正：.xls → .xlsx（' + path.basename(xlsxPath) + '）')
    } catch (e) {
      say('   ⚠ 后缀纠正失败（继续用 .xls）：' + String((e && e.message) || e))
    }
  }
  file = finalFile
  say('⑥ 落盘:', file, '| 大小 =', sniff.大小, '| 头四字节 =', sniff.头四字节, sniff.后缀是xls但内容是xlsx ? '| ⚠ 内容 xlsx' : '')

  // ★ 去重：一次「点下载模版 + 重试」其实会产生**多份同内容文件**——
  //   我们自己抓直链 fetch 写一份，Chrome 又按 `setDownloadBehavior` 把同一份下到同一目录；
  //   点了 3 次就留 3 个（实测每个类目都留 2~3 个，用户会以为「下载了两次」）。
  //   这里只保留最终采用的那份，**点击后新产生的**其它 excel / 临时下载文件全删掉
  //   （每次重试都是平台的一次**新导出**，内容/时间戳不同，所以不能按 md5 去重）
  let 清理重复 = []
  try {
    const keepAbs = path.resolve(file)
    for (const d of dirs) {
      let names = []
      try {
        names = readdirSync(d)
      } catch {
        continue
      }
      for (const n of names) {
        if (!/\.(xls|xlsx|crdownload)$/i.test(n)) continue
        const full = path.resolve(d, n)
        if (full === keepAbs) continue
        // ⚠️ snapshot() 返回的是 Map<dir, Map<file, 'mtime:size'>>，不是普通对象；
        //    之前按 `beforeMap[d][n]` 取 → 永远 undefined → 把**整个下载目录的旧缓存都删了**（2026-11-17 事故）
        const rec = beforeMap instanceof Map ? beforeMap.get(d) : beforeMap && beforeMap[d]
        const existed = rec instanceof Map ? rec.has(n) : !!(rec && rec[n])
        if (existed) continue // 点击之前就存在的缓存，不动
        try {
          unlinkSync(full)
          清理重复.push(path.basename(full))
        } catch {}
      }
    }
  } catch {}
  if (清理重复.length) say('⑥b 清理重复下载（只留最终一份）:', 清理重复.join('、'))

  return {
    ok: true,
    path: file,
    file,
    清理重复,
    类目: 有效类目,
    方式,
    目录: OUT,
    原名: got.原名,
    下载目录: got.目录,
    文件名: path.basename(file),
    等待轨迹: got.trace && got.trace.length ? got.trace : [],
    点击,
    工作页: st.url,
    页面catId,
    ...sniff,
  }
}

export default { downloadTemplate, discoverTemplateUrl }
