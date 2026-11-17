/**
 * 淘宝/千牛上架编排 · ego 版（等价原 scripts/run_listing.ps1 的 15–18 步）。
 *
 * 与原版（Playwright + CDP、每步一个 node 进程）的差异：
 *   - 连接：`connectSpace(spaceId)` 一次，全流程**同一个 ego 进程 + 同一个 page**（各模块都是函数式接口）。
 *   - 顺序/判据/中止规则与原版逐条一致：入口步失败**立即中止**（否则后面全填到旧类目页面）；
 *     其余步失败只记录、继续（和原版一样把 bad 步单独列出来）。
 *   - 「完全没有输出 = 疑似空跑」的判据：函数式接口不会没输出，这里等价判成「返回 null/undefined」。
 *
 * 红线：只填空 + 读回核对；**绝不点「提交宝贝信息」**；收尾只点「保存草稿」。
 *
 * 运行（ego 子进程不继承自定义环境变量 → 配置一律走 __TB_CFG）：
 *   ego nodejs -e "globalThis.__TB_CFG={space:5,catid:'50003280',cat:'宠物/宠物食品及用品 > 猫/狗玩具 > 猫抓板',product:'D:/.../product.json'}; await import('file:///<插件目录>/scripts/run_listing_tb.mjs')"
 *
 * __TB_CFG 键（★ = 必填 / 缺了就停）：
 *   ★ space       ego space id（一店一个；别选到拼多多店）
 *   ★ catid       类目 id（和页面 URL 的 catId 对不上会被各步硬拦）
 *   ★ cat         完整类目路径（`>` 或 `>>` 分隔，逐级点选，不用 AI/搜索推荐）
 *   brand         品牌，默认「无品牌」
 *   方式一：product   product.json 绝对路径（推荐；数据已准备好时用这个）
 *   方式二：pack      素材包根目录 → 自动跑 tb_build.py + tb_prep_assets.js（产到 <repo>/output/<商品号>/）
 *   python        pack 模式用的解释器（需 openpyxl；默认自动探测 python/py/python3）
 *   node          pack 模式跑 tb_prep_assets.js 用的 node（默认 PATH 里的 node）
 *   workdir       产物目录（默认 = product.json 所在目录；pack 模式 = <repo>/output/<商品号>）
 *   imgDir        图片目录（默认 <workdir>/img）
 *   listPrice     一口价覆盖（>0 才传；默认用 product.json 的 list_price）
 *   sizeSort      'source'（默认，照源表顺序）/ 'natural'
 *   mainLimit     主图上限（默认 0 = 取 min(5, 素材张数)；平台硬上限 5）
 *   detailBatch   详情图每批张数（默认 20，实测 >20 会被截断）
 *   skuTemplate   官方 SKU 模板路径（默认 product 同目录 `sku_import_官方模板.xlsx`；缺了自动下载）
 *   templateOut   模板下载落地目录（默认 <repo>/output/_downloads）
 *   saveDraft     默认 true；false = 不点第 10 步
 *   forceEntry    true = 忽略已有表单页，重走入口
 *   dryRun        true = 只做数据准备 + 打印计划，**不连页面**
 *   specColors / strictReadback / detailCheckExists… 等：透传给对应模块（各模块自己读 __TB_CFG）
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import { connectSpace, dismissDialogs, out, say, sleep } from '../lib/tb_ego.mjs'
import { checkList } from './tb_checklist.mjs'
import { fillBasic, fillInputByPid } from './tb_fill_basic.mjs'
import { fillSpecImages } from './tb_fill_spec_images.mjs'
import { importSku } from './tb_import_sku.mjs'
import { downloadTemplate } from './tb_download_template.mjs'
import { closeMaterialPanel } from './tb_panel.mjs'
import { saveDraft } from './tb_save_draft.mjs'
import { specAddImage } from './tb_spec_add_image.mjs'
import { uploadDetail } from './tb_upload_detail.mjs'
import { uploadMain } from './tb_upload_main.mjs'
import { uploadVideo, pickVideoFile, closeVideoPanel } from './tb_upload_video.mjs'


const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
/** 读 __TB_CFG 的一个键（未设置/空串时用默认值）。 */
const cfgVal = (key, dflt) => {
  const c = (typeof globalThis !== 'undefined' && globalThis.__TB_CFG) || {}
  const v = c[key]
  return v === undefined || v === null || v === '' ? dflt : v
}

/** 输出根目录：__TB_CFG.outputRoot（插件默认 ~/.dsh/taobao-ego/output）→ 否则包内 output。 */
const outputRoot = () => {
  const v = cfgVal('outputRoot', '')
  return v ? resolve(String(v)) : join(ROOT, 'output')
}
/** 发现 DSH 自带的 Python（与 /office-xlsx 用的是同一份；装了 DSH 就不需要用户另装 Python）。 */
function dshPythons() {
  const out = []
  const base = join(homedir(), '.dsh', 'dsh-runtimes')
  try {
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      for (const exe of ['python.exe', 'python', 'python3']) {
        const p = join(base, d.name, 'dependencies', 'python', exe)
        if (existsSync(p)) {
          out.push(p)
          break
        }
      }
    }
  } catch {
    /* 没有 .dsh 运行时就跳过 */
  }
  return out
}
const IMG_RE = /\.(jpe?g|png|webp)$/i
/** 平台硬规则：淘宝 1:1 主图至多 5 张（发布页原文「至多可上传5张」）。 */
const PLATFORM_MAIN_MAX = 5

/** 配置只从 globalThis.__TB_CFG 读（ego 子进程不继承自定义环境变量）。 */
const CFG = () => (typeof globalThis !== 'undefined' && globalThis.__TB_CFG) || {}
const str = (v, dflt = '') => (v === undefined || v === null ? dflt : String(v))
const posNum = (v, dflt = 0) => {
  const x = Number(v)
  return Number.isFinite(x) && x > 0 ? x : dflt
}
const countImgs = (dir) => {
  try {
    return readdirSync(dir).filter((f) => IMG_RE.test(f)).length
  } catch {
    return 0
  }
}

/** 数视频文件（img/video 里的 mp4/mov/mkv/webm）。 */
const countVideos = (dir) => {
  try {
    return readdirSync(dir).filter((f) => /\.(mp4|mov|mkv|webm)$/i.test(f)).length
  } catch {
    return 0
  }
}

/**
 * 素材包资产自检：按「给了什么就上什么，没有就跳过，不支持的明确告知」的原则出报告。
 * @returns `{ 会上传, 跳过, 暂不支持 }`
 */
function assetReport(o) {
  const 会上传 = []
  const 跳过 = []
  const 暂不支持 = []
  const add = (list, label, n) => {
    if (n > 0) list.push(`${label} ${n}`)
    else list.push(label)
  }

  const main = countImgs(join(o.imgDir, '1x1'))
  const d34 = countImgs(join(o.imgDir, '3x4'))
  const detail = countImgs(join(o.imgDir, 'detail'))
  const spec = countImgs(join(o.imgDir, 'spec'))
  const white = countImgs(join(o.imgDir, 'white'))
  const videos = countVideos(join(o.imgDir, 'video'))

  for (const [label, n] of [
    ['1:1 主图', Math.min(main, 5)],
    ['3:4 主图', Math.min(d34, 5)],
    ['详情图', detail],
    ['规格图', spec],
    ['白底图', Math.min(white, 1)],
    ['商品视频', Math.min(videos, 1)],
  ]) {
    if (n > 0) 会上传.push(`${label} ${n}`)
    else 跳过.push(label)
  }
  if (videos > 1) 暂不支持.push(`商品视频 ${videos} 个（本技能暂只传 1 个）`)
  if (white > 1) 暂不支持.push(`白底图 ${white} 张（本技能暂只传 1 张）`)

  // 目录级：已知会上传的目录 vs 不支持的目录
  const SUPPORTED_DIRS = new Set(['1x1', '3x4', 'detail', 'spec', 'white', 'video', 'skusearch', '3x4'])
  const UNSUPPORTED_DIRS = {
    skusearch: 'SKU 搜索主图（暂不支持自动上传）',
  }
  try {
    for (const d of readdirSync(o.imgDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const name = d.name
      if (!SUPPORTED_DIRS.has(name) && name !== 'video') 暂不支持.push(`目录「${name}」里的素材（暂不支持）`)
    }
  } catch {
    /* imgDir 不存在时上面已按 0 处理 */
  }
  for (const [dir, why] of Object.entries(UNSUPPORTED_DIRS)) {
    if (countImgs(join(o.imgDir, dir)) > 0) 暂不支持.push(why)
  }
  return { 会上传, 跳过, 暂不支持 }
}

/**
 * 归一化配置。
 * @param input - 覆盖项（默认取 __TB_CFG）。
 * @returns 编排用的配置对象（productObj 仍未加载时为空）。
 */
export function resolveOptions(input = {}) {
  const raw = { ...CFG(), ...(input || {}) }
  const o = {
    space: Number(raw.space || 0),
    cat: str(raw.cat),
    catid: str(raw.catid),
    brand: str(raw.brand, '无品牌'),
    product: str(raw.product),
    pack: str(raw.pack),
    workdir: str(raw.workdir),
    productId: str(raw.productId),
    python: str(raw.python),
    node: str(raw.node) || 'node',
    listPrice: Number(raw.listPrice || 0),
    sizeSort: str(raw.sizeSort, 'source'),
    mainLimit: Number(raw.mainLimit || 0),
    detailBatch: posNum(raw.detailBatch, 20),
    skuTemplate: str(raw.skuTemplate),
    templateOut: str(raw.templateOut),
    imgDir: str(raw.imgDir),
    // ★ 红线：默认**不存草稿**（用户口径）；要存才在 run-config 里显式给 saveDraft:true
    saveDraft: raw.saveDraft === undefined ? false : !!raw.saveDraft,
    crop34: raw.crop34 === undefined ? false : !!raw.crop34, // 默认不自动裁 3:4
    upload34: raw.upload34 === undefined ? true : !!raw.upload34,
    recheckAttrs: !!raw.recheckAttrs,
    uploadVideo: raw.uploadVideo === undefined ? true : !!raw.uploadVideo,
    uploadWhite: raw.uploadWhite === undefined ? true : !!raw.uploadWhite,
    videoFile: str(raw.videoFile),
    dryRun: !!raw.dryRun,
    forceEntry: !!raw.forceEntry,
    reloadFirst: !!raw.reloadFirst,
    debug: raw.debug === true || String(raw.debug || '') === '1',
    productObj: null,
  }
  if (!o.workdir && o.product) o.workdir = dirname(resolve(o.product))
  if (!o.imgDir && o.workdir) o.imgDir = join(o.workdir, 'img')
  return o
}

/** 官方模板文件名前缀（按类目）；与原版 build_from_pack.ps1 的口径一致。 */
function findTemplate(catid) {
  if (!catid) return ''
  const dir = cfgVal('templateOut', '') || join(outputRoot(), '_downloads')
  if (!existsSync(dir)) return ''
  const hits = readdirSync(dir)
    .filter((f) => f.startsWith(`SKU模板_${catid}_`) && /\.(xlsx|xls)$/i.test(f))
    .sort()
  // ★ 平台常给「.xls 名字、其实是 xlsx 内容」的文件；openpyxl 见到 .xls 会直接拒读
  //   → 优先挑 .xlsx；只有 .xls 时按文件头纠正后缀（否则后面填模板/自检会静默失败）
  const hit = hits.find((f) => /\.xlsx$/i.test(f)) || hits.pop()
  if (!hit) return ''
  const full = join(dir, hit)
  if (/\.xlsx$/i.test(hit)) return full
  try {
    const head = readFileSync(full).subarray(0, 2)
    if (head[0] === 0x50 && head[1] === 0x4b) {
      const target = full.replace(/\.xls$/i, '.xlsx')
      copyFileSync(full, target)
      try {
        unlinkSync(full)
      } catch {}
      say('↻ 模板后缀按内容纠正：', hit, '→', target.split(/[\\/]/).pop())
      return target
    }
  } catch {}
  return full
}

/** 探测能 import openpyxl 的 python（pack 模式用；ego 不继承 TB_PYTHON，故从 __TB_CFG 取首选）。 */
function probePython(preferred) {
  const cands = [...new Set([preferred, ...dshPythons(), 'python', 'py', 'python3'].filter(Boolean))]
  for (const c of cands) {
    try {
      execFileSync(c, ['-c', 'import openpyxl'], { stdio: 'ignore', timeout: 20000 })
      return c
    } catch {
      // 换下一个候选；全都失败时在调用方抛明确错误
    }
  }
  return ''
}

/**
 * pack 模式的数据管道（等价 build_from_pack.ps1）：
 *   `商品信息.xlsx` → `tb_build.py` → `output/<商品号>/product.json`（+ SKU 导入表）
 *   `淘宝/<商品号>/` 的图 → `tb_prep_assets.js` → `output/<商品号>/img/{1x1,3x4,detail,spec}`
 * @returns `{ product, workdir, productId }`。
 */
/**
 * 判断素材包的 `商品信息.xlsx` 是不是「给用户填的」那版（4-sheet：基本信息/属性/SKU）。
 * tb_build 格式反而有 sheet「淘宝」且 R4 是 JSON 元数据。
 */
function isUserFacingPack(o, xlsx) {
  try {
    const py = probePython(o.python)
  if (!py) return false
  const out = execFileSync(py, ['-c', [
      'import openpyxl,sys,json',
      'wb=openpyxl.load_workbook(sys.argv[1],data_only=True)',
      'print(json.dumps({"sheets":wb.sheetnames}))',
    ].join(';\n'), xlsx], { encoding: 'utf8', timeout: 60000 })
    const j = JSON.parse(String(out || '').trim().split(/\r?\n/).pop() || '{}')
    const sheets = j.sheets || []
    // ★ 用户版：有「基本信息」+「属性」，且没有 tb_build 需要的「淘宝」sheet
    //   （SKU 现在填在 SKU模板/ 里，所以这里不能要求存在「SKU」sheet）
    return sheets.includes('基本信息') && sheets.includes('属性') && !sheets.includes('淘宝')
  } catch {
    return false
  }
}

/** 把「给用户填的素材包」转成内部 tb_build 格式（产出到 outputRoot/packs/<id>）。 */
function convertUserPack(o, userPack, xlsx) {
  const py = probePython(o.python)
  if (!py) return { ok: false, why: 'python_not_found' }
  const id = (String(userPack).split(/[\\/]/).filter(Boolean).pop() || 'PACK').replace(/[^\w.-]+/g, '-')
  const tmp = join(outputRoot(), 'packs', id)
  try {
    mkdirSync(tmp, { recursive: true })
  } catch {}
  const listingJson = join(tmp, 'listing.json')
  const base = join(userPack, '淘宝')
  const subs = existsSync(base) ? readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []
  const subId = o.productId && subs.includes(o.productId) ? o.productId : subs[0] || id
  // ① 4-sheet Excel → listing.json（图片留空时用包里的图片目录）
  const tplForSku = (() => {
    const dir = join(userPack, 'SKU模板')
    if (!existsSync(dir)) return ''
    const hit = readdirSync(dir).filter((f) => /\.(xlsx|xls)$/i.test(f)).sort().pop()
    return hit ? join(dir, hit) : ''
  })()
  const args1 = ['-X', 'utf8', join(HERE, 'listing_xlsx_to_json.py'), '--xlsx', xlsx, '--out', listingJson, '--images-base', join(base, subId)]
  if (tplForSku) args1.push('--sku-template', tplForSku)
  execFileSync(py, args1, {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 180000,
  })
  // ★ listing.json 没 id 时 build_pack 会用默认名 TB-PACK-01 → 不同商品互相覆盖工作目录
  //   → 用素材包目录名当商品号（output/<包名>/），一单一目录
  try {
    const raw = readFileSync(listingJson, 'utf8')
    const j = JSON.parse(raw)
    if (!j.id) {
      j.id = String(userPack).split(/[\\/]/).filter(Boolean).pop() || 'PACK'
      writeFileSync(listingJson, JSON.stringify(j, null, 1), 'utf8')
    }
  } catch {}
  // ② listing.json → 技术版素材包（tb_build 格式；SKU 模板用包里的那份）
  const tplDir = join(userPack, 'SKU模板')
  const tpl = existsSync(tplDir)
    ? join(tplDir, readdirSync(tplDir).filter((f) => /\.(xlsx|xls)$/i.test(f)).sort().pop() || '')
    : ''
  const args2 = ['-X', 'utf8', join(HERE, 'build_pack.py'), '--listing', listingJson, '--pack-dir', tmp, '--audience', 'tb']
  if (tpl) args2.push('--template', tpl)
  execFileSync(py, args2, { cwd: ROOT, stdio: 'inherit', timeout: 180000 })
  return { ok: true, pack: tmp, xlsx: join(tmp, '商品信息.xlsx'), id: subId }
}

/**
 * 上传前的 SKU 导入表自检（check_sku_template.py）：
 * 规格列必须有值（否则平台报「未检测到有效销售规格」）、价格列必须有值、不能有重复规格组合。
 * 没有 python 时**不阻塞**（只在日志里提示），避免把整单卡死。
 * @returns `{ ok, rows?, specCols?, problems?, skipped? }`
 */
function checkSkuTemplate(o, file) {
  if (!file || !existsSync(file)) return { ok: false, problems: ['SKU 导入表不存在：' + String(file)] }
  // ★ o.product 可能还没赋值 → 退化到「模板同目录的 product.json」，都没有就跳过自检（不阻塞）
  if (!o.product) {
    const guess = join(dirname(resolve(file)), 'product.json')
    if (existsSync(guess)) o = { ...o, product: guess }
    else return { ok: true, skipped: 'no_product' }
  }
  const py = o && o.python ? probePython(o.python) : probePython('')
  if (!py) return { ok: true, skipped: 'no_python' }
  const script = join(HERE, 'check_sku_template.py')
  if (!existsSync(script)) return { ok: true, skipped: 'no_script' }
  const parse = (s) => {
    const line = String(s || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}'
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }
  try {
    const stdout = execFileSync(py, ['-X', 'utf8', script, '--product', o.product, '--xlsx', file], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
    })
    return { ...(parse(stdout) || {}), file }
  } catch (e) {
    // 退出码 2 = 自检不过，但 stdout 里仍有完整 JSON（execFileSync 抛错时带 stdout）
    const j = parse((e && e.stdout) || '')
    if (j && Array.isArray(j.problems)) return { ...j, file }
    return { ok: true, skipped: 'check_failed:' + String((e && e.message) || e).slice(0, 100) }
  }
}

/**
 * ★ 兜底：数据管道产出的 SKU 导入表自检不过时，改用素材包里「已填好的官方模板」
 *   （用户自己往 SKU模板/ 里填过 SKU 时，那份才是权威）。
 */
function ensureSkuImportTable(o, workdir, tplInPack, productPath) {
  const target = join(workdir, 'sku_import_官方模板.xlsx')
  if (!existsSync(target)) return { ok: false, problems: ['数据管道没有产出 sku_import_官方模板.xlsx'] }
  // ★ prepareFromPack 里调用时 o.product 还没赋值（runListing 之后才设）→ 显式传，避免 --product ''
  const prod = productPath || (o.product || join(workdir, 'product.json'))
  const r = checkSkuTemplate({ ...o, product: prod }, target)
  if (r.ok !== false) return r
  if (!tplInPack || !existsSync(tplInPack) || resolve(tplInPack) === resolve(target)) return r
  try {
    copyFileSync(tplInPack, target)
  } catch {
    return r
  }
  const r2 = checkSkuTemplate({ ...o, product: prod }, target)
  if (r2.ok !== false) {
    say('↻ 数据管道产出的导入表自检不过 → 改用素材包里已填好的官方模板:', tplInPack)
    return { ...r2, recovered: tplInPack }
  }
  return r
}

function prepareFromPack(o) {
  let pack = resolve(o.pack)
  if (!existsSync(pack)) throw new Error('pack_not_found:' + pack)

  // ① 数据表（两种素材包都认：tb_build 格式 / 给用户填的 4-sheet 格式）
  let xlsx = join(pack, '商品信息.xlsx')
  // ★ 给用户填的素材包：商品信息.xlsx 是「基本信息/属性/SKU」三张 sheet（没有 tb_build 需要的 R4 元数据）
  //   → 先转成内部 tb_build 格式（listing.json + 技术版素材包），后面的流程完全不变。
  if (existsSync(xlsx) && isUserFacingPack(o, xlsx)) {
    const converted = convertUserPack(o, pack, xlsx)
    if (!converted.ok) throw new Error('user_pack_convert_failed:' + (converted.why || 'unknown'))
    say('↻ 检测到「给用户填的素材包」→ 已转成内部格式:', converted.pack)
    pack = converted.pack
    xlsx = converted.xlsx
  }
  if (!existsSync(xlsx)) {
    const fe = join(pack, '发品excel')
    const cands = existsSync(fe) ? readdirSync(fe).filter((f) => /\.(xlsx|xls)$/i.test(f)) : []
    if (o.productId) {
      const hit = cands.find((f) => f.replace(/\.(xlsx|xls)$/i, '') === o.productId)
      if (hit) xlsx = join(fe, hit)
    }
    if (!existsSync(xlsx) && cands.length === 1) xlsx = join(fe, cands[0])
  }
  if (!existsSync(xlsx)) throw new Error('xlsx_not_found:' + pack)

  // ② 商品号：以 淘宝/<目录名> 为权威（和 Excel 不一致时用目录名）
  const tbDir = join(pack, '淘宝')
  const subs = existsSync(tbDir)
    ? readdirSync(tbDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : []
  let id = o.productId
  if (!id || !existsSync(join(tbDir, id))) {
    if (subs.length !== 1) throw new Error(`product_id_ambiguous:${subs.join('/') || '（淘宝/ 下没有目录）'}`)
    id = subs[0]
  }
  const workdir = join(outputRoot(), id)
  const product = join(workdir, 'product.json')

  // ③ 官方 SKU 模板（有就透传；没有只警告不阻塞，SKU 导入那步会自己下载）
  // ★ 用户口径（2026-11-17）：**SKU 模板一律以该类目官方模板为准**，它是最正确的。
  //   所以包里那份模板必须**catId 对得上**才用；对不上就忽略并改下该类目官方模板（否则平台必报
  //   「未检测到有效销售规格」，而且很难看出来是模板借错了类目）。
  const catIdOf = (file) => (basename(file).match(/SKU模板_(\d+)_/) || [])[1] || ''
  const tplInPack = (() => {
    const dir = join(pack, 'SKU模板')
    if (!existsSync(dir)) return ''
    const cands = readdirSync(dir)
      .filter((f) => /\.(xlsx|xls)$/i.test(f))
      .sort()
    if (!cands.length) return ''
    const want = String(o.catid || '')
    // 优先挑 catId 与本次类目一致的那份；都没标注 catId 时退回最后一个（老素材包兼容）
    const match = cands.find((f) => catIdOf(f) && catIdOf(f) === want) || ''
    if (match) return join(dir, match)
    const annotated = cands.filter((f) => catIdOf(f))
    if (annotated.length && want) {
      say('★ 素材包里的 SKU 模板不属于本类目 → 忽略，改下载官方模板:', annotated.pop(), '（本项目 catId =', want + '）')
      return ''
    }
    return join(dir, cands.pop())
  })()
  if (tplInPack && !catIdOf(tplInPack)) {
    say('ℹ 素材包模板文件名里没有 catId，无法自动核对类目；如与本次类目不符，导入会失败（建议按类目下载官方模板）')
  }
  const tpl = tplInPack || findTemplate(o.catid)
  const py = probePython(o.python)
  if (!py) throw new Error('python_not_found: pack 模式需要能 import openpyxl 的 python（用 __TB_CFG.python 指定）')

  // ④ tb_build.py
  say('④ 数据管道 tb_build.py …', '| python =', py, '| 模板 =', tpl || '（暂无）')
  const env = { ...process.env, TB_XLSX: xlsx }
  if (tpl) env.TB_TEMPLATE = tpl
  const args = [join(HERE, 'tb_build.py'), '--product-id', id, '--out', workdir, '--size-sort', o.sizeSort]
  if (o.listPrice > 0) args.push('--list-price', String(o.listPrice))
  execFileSync(py, args, { env, cwd: ROOT, stdio: 'inherit', timeout: 300000 })
  if (!existsSync(product)) throw new Error('product_json_missing:' + product)

  // ⑤ tb_prep_assets.js（拷图）
  say('⑤ 拷图 tb_prep_assets.js …')
  execFileSync(o.node, [join(HERE, 'tb_prep_assets.cjs'), '--pack', pack, '--product', product], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 300000,
  })
  // ⑥ SKU 导入表自检：规格列必须有值，否则平台会报「未检测到有效销售规格」→ 不上传垃圾
  ensureSkuImportTable(o, workdir, tplInPack)
  return { product, workdir, productId: id }
}

/**
 * 第 3 步：SKU 模板导入 + 一口价。
 * 模板口径与原版一致：product 同目录 `sku_import_官方模板.xlsx`；缺了就现下该类目官方模板。
 */
/**
 * 素材包只有 1:1 主图时，按 1:1 中心裁出 3:4 主图（可关：__TB_CFG.crop34=false）。
 * 用 python + Pillow（同样逐个解释器试；ego 子进程不能捕获 stdout → stdio 用 inherit/ignore）。
 */
function crop34(o) {
  try {
    const script = join(HERE, 'crop_3x4.py')
    if (!existsSync(script)) return { skipped: 'no_script' }
    const src = join(o.imgDir, '1x1')
    const dst = join(o.imgDir, '3x4')
    if (!existsSync(src)) return { skipped: 'no_1x1' }
    const cands = [
      o.python,
      ...dshPythons(),
      'py',
      'python3',
    ].filter(Boolean)
    const seen = new Set()
    let lastErr = ''
    for (const py of cands) {
      if (seen.has(py)) continue
      seen.add(py)
      try {
        execFileSync(py, [script, '--src', src, '--dst', dst, '--limit', String(o.mainLimit || 5)], { stdio: 'inherit', timeout: 120000 })
        return { ok: true, python: py }
      } catch (e) {
        lastErr = String((e && e.message) || e).slice(0, 140)
        continue
      }
    }
    return { ok: false, 错误: lastErr || 'no_python' }
  } catch (e) {
    return { ok: false, 错误: String((e && e.message) || e).slice(0, 140) }
  }
}

/**
 * 模板自检 + 清理（best-effort）：模板里混入 图案/材质/面层工艺 这类属性列时，
 * 淘宝「批量导入」的 AI 会把它们识别成额外销售属性 → SKU 表行数/规格全乱（PE-001 实测）。
 * 用 python 脚本把非规格列清空；没有 python 就原样上传（并在日志里提示）。
 */
function cleanSkuTemplate(o, file) {
  const script = join(HERE, 'sanitize_sku_template.py')
  if (!existsSync(script)) return { skipped: 'no_sanitizer' }
  if (!o.product || !existsSync(o.product)) return { skipped: 'no_product' }
  // ★ ego 的子进程**不能捕获 stdout**（会报 Unknown encoding: buffer）→ 一律 stdio:'ignore'/'inherit'；
  //   又因为 PATH 里可能有多个 python（有的没 openpyxl），逐个试，谁真能跑就用谁。
  const cands = [
    o.python,
    ...dshPythons(),
    'py',
    'python3',
    'python',
  ].filter(Boolean)
  const seen = new Set()
  let lastErr = ''
  for (const py of cands) {
    if (seen.has(py)) continue
    seen.add(py)
    try {
      execFileSync(py, [script, '--product', o.product, '--xlsx', file, '--check'], { stdio: 'ignore', timeout: 120000 })
      return { ok: true, python: py, 清理: false }
    } catch (e) {
      if (e && e.status === 1) {
        try {
          execFileSync(py, [script, '--product', o.product, '--xlsx', file], { stdio: 'inherit', timeout: 180000 })
          return { ok: true, python: py, 清理: true }
        } catch (e2) {
          if (e2 && e2.status === 3) {
            return { ok: false, why: 'no_spec_after_clean', 错误: '清理后没有任何规格列有值（平台会报「未检测到有效销售规格」）' }
          }
          lastErr = String((e2 && e2.message) || e2).slice(0, 140)
          continue
        }
      }
      lastErr = String((e && e.message) || e).slice(0, 140)
      continue
    }
  }
  return { ok: false, 错误: lastErr || 'no_python' }
}
/**
 * 官方模板下载失败时的兜底：按 product.json 生成本地 SKU 导入表。
 * 列名取 product.json.dimensions（如 颜色分类×款式），其余用官方通用列（价格/数量/商家编码）。
 * @returns `{ ok, file?, header?, 错误? }`
 */
function generateSkuTemplate(o, outFile) {
  const py = probePython(o.python)
  if (!py) return { ok: false, why: 'python_not_found' }
  const script = join(HERE, 'gen_sku_template.py')
  if (!existsSync(script)) return { ok: false, why: 'no_script' }
  try {
    execFileSync(py, ['-X', 'utf8', script, '--product', o.product, '--out', outFile], {
      cwd: ROOT,
      stdio: 'ignore',
      timeout: 120000,
    })
  } catch (e) {
    return { ok: false, why: 'gen_failed', 错误: String((e && e.message) || e).slice(0, 200) }
  }
  if (!existsSync(outFile)) return { ok: false, why: 'gen_missing_file' }
  let header = null
  try {
    header = JSON.parse(
      execFileSync(py, ['-X', 'utf8', script, '--product', o.product, '--out', outFile], { cwd: ROOT, encoding: 'utf8', timeout: 120000 }),
    ).header
  } catch {
    header = null
  }
  return { ok: true, file: outFile, header }
}

/**
 * 把 product.json 的 SKU 行写进**官方模板**（保留类目专属表头，如 地毯 的 厚度/宽度/地毯尺寸/长度/底背材质）。
 * @returns `{ ok, file?, rows?, specCols?, unfilledCols?, skipped?, 错误? }`
 */
function fillSkuTemplate(o, templateFile) {
  const py = probePython(o.python)
  if (!py) return { ok: false, why: 'python_not_found' }
  const script = join(HERE, 'fill_sku_template.py')
  if (!existsSync(script)) return { ok: false, why: 'no_script' }
  const out = join(dirname(resolve(o.product)), 'sku_import_官方模板_已填充.xlsx')
  try {
    const stdout = execFileSync(py, ['-X', 'utf8', script, '--template', templateFile, '--product', o.product, '--out', out], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 180000,
    })
    const j = JSON.parse(String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}')
    if (!j.ok) return { ok: false, why: j.why || 'fill_failed', 错误: j.错误 }
    return { ok: true, file: j.out || out, rows: j.rows, specCols: j.specCols, unfilledCols: j.unfilledCols }
  } catch (e) {
    return { ok: false, why: 'fill_failed', 错误: String((e && e.message) || e).slice(0, 300) }
  }
}

async function runSku(page, o) {
  let file = o.skuTemplate
  // ★ 数据管道（tb_build --from-template）已经按【官方模板表头 + 本单 SKU 行】产出过一份导入表 →
  //   直接用它，别再下载/再填充（重复填充会把颜色/尺寸列清空，平台识别不出 → 对账 0 行）
  const pipelineTpl = join(dirname(resolve(o.product)), 'sku_import_官方模板.xlsx')
  if (!file && existsSync(pipelineTpl)) {
    file = pipelineTpl
    say('✓ 用数据管道产出的官方模板导入表:', pipelineTpl)
  }
  if (file && !existsSync(file)) {
    say('★ __TB_CFG.skuTemplate 指向的文件不存在：', file, '→ 改用默认位置/现下')
    file = ''
  }
  if (!file) {
    const cand = join(dirname(resolve(o.product)), 'sku_import_官方模板.xlsx')
    if (existsSync(cand)) file = cand
  }
  if (!file) {
    // ★ 复用「已下载过的官方模板」（按 catId 缓存）：每个类目成功下载一次后就一直用它
    const cached = findTemplate(o.catid)
    if (cached) {
      file = cached
      say('✓ 复用已下载的官方模板:', cached)
    }
  }
  if (!file) {
    const si = o.productObj && typeof o.productObj.sku_import === 'string' ? o.productObj.sku_import : ''
    if (si) {
      const p = resolve(dirname(resolve(o.product)), si)
      if (existsSync(p)) file = p
    }
  }
  if (!file) {
    say('缺该类目的官方 SKU 模板 → 现下（需要该类目的发布页；当前页就是）')
    const outDir = o.templateOut || join(outputRoot(), '_downloads')
    const dl = await downloadTemplate(page, { catId: o.catid, out: outDir })
    if (!dl || !dl.ok) {
      // ★ 官方模板下载失败 → 兜底：按 product.json 本地生成一份（列名可能与该类目官方模板不完全一致，必须提示）
      say('⚠ 官方模板下载失败（' + String((dl && dl.why) || 'unknown') + '）→ 改按 product.json 生成本地导入表')
      const gen = generateSkuTemplate(o, join(dirname(resolve(o.product)), 'sku_import_本地兜底.xlsx'))
      if (gen.ok) {
        file = gen.file
        say('⚠ 已用兜底导入表:', file, '| 列名 =', JSON.stringify(gen.header))
        say('   注意：官方模板的规格列可能不止这两个（' + JSON.stringify(gen.header) + '），如导入被平台拒绝请手动下模板重跑')
      } else {
        say('✗ 兜底导入表也没生成成功：' + String(gen.错误 || gen.why || 'unknown'))
        return { ok: false, why: 'template_download_failed', 下载: dl, 兜底: gen }
      }
    } else {
      file = dl.path
      say('✓ 模板已下载:', file)
    }
  }
  // ★ 官方模板是**表头 + 空表**：必须把 product.json 的行按官方列名写进去，否则导入的是空表
  const fromPipeline = file === pipelineTpl
  const filled = fromPipeline ? { skipped: '数据管道已按官方模板填好' } : fillSkuTemplate(o, file)
  if (filled.ok) {
    say('✓ 已把 SKU 行写进官方模板:', filled.file, '| 行数 =', filled.rows, '| 规格列 =', JSON.stringify(filled.specCols || []))
    if (filled.unfilledCols && filled.unfilledCols.length) {
      say('   ℹ 官方模板里这些列本次没有数据（留空）:', filled.unfilledCols.join('、'))
    }
    file = filled.file
  } else if (filled.skipped) {
    say('   ℹ 跳过「写入官方模板」（' + filled.skipped + '），按原文件导入')
  } else {
    say('   ⚠ 写入官方模板失败（照原样上传）：' + String(filled.错误 || filled.why || 'unknown'))
  }

  // ★ 模板自检：混入属性列的模板会被 AI 识别成额外尺寸 → 先清成「只有规格列」
  const tplClean = cleanSkuTemplate(o, file)
  if (tplClean.清理) say('   ✓ 模板已清理：已清空非规格列（图案/材质/工艺/标题 等）')
  else if (tplClean.skipped) say('   ℹ 模板自检跳过（' + tplClean.skipped + '）')
  else if (tplClean.ok === false) say('   ⚠ 模板自检失败：' + tplClean.错误)

  // ★ 上传前最后一道闸：规格列必须有值。否则平台直接报「未检测到有效销售规格」，
  //   一整轮上传白跑（实测 2026-11-16 窗帘类目就是这样，颜色/尺寸列全空）。
  const pre = checkSkuTemplate(o, file)
  if (pre.ok === false) {
    for (const p of pre.problems || []) say('   · ' + p)
    return {
      ok: false,
      why: 'sku_template_invalid',
      file,
      自检: pre,
      提示:
        'SKU 导入表里没有可识别的规格值 → 没有上传（否则平台报「未检测到有效销售规格」）。' +
        '请检查素材包 SKU模板/ 那份官方模板的颜色/尺寸列是否填了值，或 product.json 里有没有 skus。',
    }
  }
  if (pre.skipped) say('   ℹ 上传前自检跳过（' + pre.skipped + '）')
  else {
    const scs = (pre.specCols || []).map((s) => `${s.name}×${s.values.length}`).join(' × ')
    say('   ✓ 上传前自检通过：行数 =', pre.rows, '| 规格 =', scs || '（无）')
    for (const w of pre.warnings || []) say('   ℹ ' + w)
  }

  return importSku(page, o.product, {
    catId: o.catid,
    file,
    listPrice: o.listPrice > 0 ? o.listPrice : undefined,
    sizeSort: o.sizeSort,
  })
}

/**
 * 组装步骤表（顺序与原版 run_listing.ps1 一致）。
 * @param o - resolveOptions() 的结果（需已填 product / imgDir / productObj）。
 * @returns `{ steps: [{ key, run }], meta }`。
 */
export function buildSteps(o) {
  const img1 = join(o.imgDir, '1x1')
  const imgDetail = join(o.imgDir, 'detail')
  const imgSpec = join(o.imgDir, 'spec')
  const mainTotal = countImgs(img1)
  const detailTotal = countImgs(imgDetail)
  // ★ 主图张数按素材实际数，但平台上限 5 —— 原版写死 --limit 5 时，10 张素材的商品会静默只传 5 张。
  const mainCount = o.mainLimit > 0 ? Math.min(o.mainLimit, mainTotal) : Math.min(PLATFORM_MAIN_MAX, mainTotal)
  const steps = []
  const add = (key, run) => steps.push({ key, run })

  // 1 入口：搜索发品 → 逐级选类目 → 选品牌 → 进 publish.htm
  add('1 entry/cat/brand', async (page) => {
    globalThis.__TB_ORCHESTRATOR = true // 让 tb_enter_form 不执行它自己的 CLI 入口
    const mod = await import('./tb_enter_form.mjs')
    return mod.enterForm(page, {
      cat: o.cat,
      catid: o.catid,
      brand: o.brand,
      product: o.product,
      force: o.forceEntry,
      debug: o.debug,
    })
  })
  // 1b 清残留弹窗：浮层停在页面正中会盖住属性区，真实鼠标点全部点不中（原版 close_dialogs.js --all）
  add('1b clear dialogs', async (page) => ({ ok: true, ...(await dismissDialogs(page)) }))
  add('2 title/attrs/code', (page) => fillBasic(page, o.product, { catId: o.catid }))
  add('3 sku/listprice', (page) => runSku(page, o))
  // 3c 复核属性：**默认关**。SKU/规格导入后再跑 fillBasic 会把属性区再点一遍（多选标签会重复），
  // 用户 2026-11-14 两次指出「填完规格值后又回去重复填属性」→ 默认不做；需要时 __TB_CFG.recheckAttrs=true。
  if (o.recheckAttrs) add('3c recheck attrs', (page) => fillBasic(page, o.product, { catId: o.catid }))
  // 3d 清场：SKU 导入弹窗/校验弹窗若留在页面上，会挡住后面所有图片点击（实测主图/详情因此整步失败）
  add('3d close import modal', async (page) => {
    const r = await dismissDialogs(page)
    const canceled = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const vis = (e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const btn = [...document.querySelectorAll('button')].filter(vis).find((x) => /^(取消|关闭)$/.test(clean(x.innerText)))
      if (btn) {
        btn.click()
        return clean(btn.innerText)
      }
      return null
    }).catch(() => null)
    await page.keyboard.press('Escape').catch(() => {})
    await sleep(700)
    const left = await page.evaluate(() => /模板上传（请先创建sku）/.test(document.body.innerText)).catch(() => true)
    return { ok: !left, closed: r.closed, 取消: canceled, 导入弹窗仍在: !!left }
  })
  add('4a close panel', (page) => closeMaterialPanel(page))
  if (mainCount > 0) add(`4 main images (${mainCount})`, (page) => uploadMain(page, img1, { limit: mainCount }))
  add('4b close panel', (page) => closeMaterialPanel(page))
  // 4c 3:4 主图（1:1 填完后，第一个「上传图片」空槽就落在 3:4 区；同一个图片空间面板）
  // 4c 3:4 主图：点空槽是**直接弹文件选择器**（不走图片空间 iframe）→ 用 tb_upload_34
  const img34 = join(o.imgDir, '3x4')
  const count34 = countImgs(img34)
  if (count34 > 0 && o.upload34) {
    const want34 = o.mainLimit > 0 ? Math.min(o.mainLimit, count34) : Math.min(PLATFORM_MAIN_MAX, count34)
    // ★ 3:4 空槽点下去开的是**同一个图片空间面板**；但「第一个空槽」常常被 3:4 区的覆盖层挡住
    //   → 从**最后一个空槽**开始填（实测有效），走和 1:1 同一套 uploadMain 流程
    add(`4c 3:4 images (${want34})`, (page) => uploadMain(page, img34, { limit: want34, slot: 'first', area: '3:4主图' }))
    add('4d close panel', (page) => closeMaterialPanel(page))
  }
  // 5 详情图分批：每批各自走完「上传 → 自动全选 → 确定」，不跨批挂待确定状态（每批 ≤20）
  let done = 0
  let idx = 0
  while (done < detailTotal) {
    idx += 1
    const lim = Math.min(o.detailBatch, detailTotal - done)
    const skip = done
    add(`5.${idx} detail images (${skip + 1}-${skip + lim})`, (page) =>
      uploadDetail(page, imgDetail, { skip, limit: lim, batch: lim }))
    done += lim
  }
  add('5c close panel', (page) => closeMaterialPanel(page))
  add('5d clear dialogs', async (page) => ({ ok: true, ...(await dismissDialogs(page)) }))
  // 5e 商品视频（img/video 里第一个视频；没有就跳过）
  // 5g 白底图（800x800，白底；img/white 里挑第一张）——默认关
  const imgWhite = join(o.imgDir, 'white')
  const countWhite = countImgs(imgWhite)
  if (o.uploadWhite && countWhite > 0) {
    add('5g white bg', (page) =>
      uploadMain(page, imgWhite, { limit: 1, slot: 'first', area: { start: '白底图', end: '家装家居卖点头图' } }))
  }
  if (o.videoPath && o.uploadVideo) {
    add('5e video', (page) => uploadVideo(page, { file: o.videoPath }))
    // 5f 无论成功失败都关掉视频面板（它会遮挡后面的规格/品牌操作）
    add('5f close video panel', async (page) => {
      const closed = await closeVideoPanel(page)
      return { ok: closed, 面板关闭: closed }
    })
  }
  // 6/7/8 规格图：只有素材包里真的有规格图才做；没有就整段跳过（避免空跑失败）
  const specCount = countImgs(join(o.imgDir, 'spec'))
  if (specCount > 0) {
  add('6 spec add-image', (page) => specAddImage(page))
  // 7 规格图逐格填 + src 核对（原版的 7b verify_spec_images 已并入本模块的 dupSrc 判据）
  add('7 spec images', (page) => fillSpecImages(page, imgSpec, o.product))
  add('8 spec confirm', (page) => specAddImage(page, { confirm: true }))
  }
  // 8b 品牌收尾：SKU 导入/AI 识别会触发属性区重渲染，品牌可能被刷回旧值（实测 Arte）。
  //     放在核对之前再提交一次，保证表单里真的是「无品牌」。
  add('8b brand commit', (page) => fillInputByPid(page, '20000', o.brand || '无品牌'))
  add('9 checklist', async (page) => {
    const r = await checkList(page, o.productObj)
    if (r && r.无此字段 && r.无此字段.length) {
      say('   ℹ 素材包里有、但本类目页面上没有这些字段（跳过，不算失败）:', r.无此字段.join('、'))
    }
    return r
  })
  if (o.saveDraft) add('10 save draft', (page) => saveDraft(page))

  return {
    steps,
    meta: {
      imgDir: o.imgDir,
      img1x1: img1,
      imgDetail,
      imgSpec,
      mainTotal,
      mainCount,
      detailTotal,
      detailBatch: o.detailBatch,
      platformMainMax: PLATFORM_MAIN_MAX,
      saveDraft: o.saveDraft,
      img3x4: img34,
      count3x4: count34,
      video: o.videoPath || '',
    },
  }
}

/** 失败时把关键读回留下、成功时只留摘要，避免一行 JSON 过长。 */
const DIGEST_KEYS = [
  'why', '步骤', 'reused', 'counted', 'uploaded', 'want', 'failedImgs', 'filled', 'dupSrc',
  '唯一src数', '串位', 'skuCount', '一口价', '总库存', '未通过', '保存提示', '确认', '已存在',
  'closed', 'before', 'after',
]
function digest(res) {
  if (!res || typeof res !== 'object') return res === undefined ? '（无返回=疑似空跑）' : res
  if (res.ok === false) return res
  const d = {}
  for (const k of DIGEST_KEYS) if (res[k] !== undefined) d[k] = res[k]
  return d
}

/**
 * 逐步执行步骤表。
 * @param page - ego page。
 * @param plan - buildSteps() 的返回值。
 * @returns `{ ok, aborted, steps, failed }`。
 */
export async function runPlan(page, plan) {
  const results = []
  let aborted = false
  for (const step of plan.steps) {
    say('')
    say(`===== ${step.key} =====`)
    const t0 = Date.now()
    let res
    try {
      res = await step.run(page)
    } catch (e) {
      res = { ok: false, why: 'exception:' + String((e && e.message) || e) }
    }
    const empty = res === null || res === undefined
    const ok = !empty && res.ok !== false
    results.push({ key: step.key, ok, ms: Date.now() - t0, 摘要: digest(res) })
    if (!ok) {
      say(`  [X] failed${empty ? '（无返回=疑似空跑）' : ''}`)
      if (empty) results[results.length - 1].摘要 = { why: 'no_result' }
      // ★ 入口步失败 → 页面还停在旧类目，后面每一步都会填到错误的页面上 → 立刻中止（原版同款硬规则）
      if (step.key.startsWith('1 entry')) {
        say('  ★ 入口没进到目标类目 → 中止，后面步骤不再执行（避免把数据填进别的类目页面）')
        aborted = true
        break
      }
    }
  }
  const failed = results.filter((r) => !r.ok).map((r) => r.key)
  return { ok: failed.length === 0 && !aborted, aborted, steps: results, failed }
}

/**
 * 主流程：数据准备（可选）→ 连 space → 逐步执行。
 * @param page - 可选，已连好的 ego page（不给就自己 connectSpace）。
 * @param input - __TB_CFG 覆盖。
 * @returns 最终结果对象（同时会被调用方打印）。
 */
export async function runListing(page, input = {}) {
  const o = resolveOptions(input)
  say('== 淘宝 ego 版上架编排 ==')
  if (!o.space) return { ok: false, why: 'no_space', 提示: '在 __TB_CFG 里给 space（pdd_ego_spaces 里选淘宝那个 space id）' }
  if (!o.catid || !o.cat) return { ok: false, why: 'no_category', 提示: 'catid 与 cat 都要给（逐级点类目用）' }

  if (!o.product && o.pack) {
    say('== 数据准备（pack → product.json / SKU 导入表 / 图片）==')
    const prepared = prepareFromPack(o)
    o.product = prepared.product
    o.workdir = prepared.workdir
    o.productId = prepared.productId
    o.imgDir = o.imgDir || join(o.workdir, 'img')
    say('   → 本次商品号：', o.productId)
  }
  if (!o.product) {
    return {
      ok: false,
      why: 'no_product',
      提示: '给 product（product.json 绝对路径），或给 pack 让数据管道自动生成',
    }
  }
  if (!existsSync(o.product)) return { ok: false, why: 'product_not_found', product: o.product }
  try {
    o.productObj = JSON.parse(readFileSync(o.product, 'utf8'))
  } catch (e) {
    return { ok: false, why: 'bad_product_json', product: o.product, 错误: String((e && e.message) || e) }
  }
  o.imgDir = o.imgDir || join(dirname(resolve(o.product)), 'img')

  // 3:4 主图：没有就按 1:1 中心裁（只裁不拉伸）
  if (o.upload34 && o.crop34 && !countImgs(join(o.imgDir, '3x4')) && countImgs(join(o.imgDir, '1x1'))) {
    const c34 = crop34(o)
    if (c34.ok) say('✓ 已从 1:1 中心裁出 3:4 主图（python =', c34.python + '）')
    else if (c34.skipped) say('ℹ 3:4 裁剪跳过（' + c34.skipped + '）')
    else say('⚠ 3:4 裁剪失败（跳过 3:4 步骤）：' + c34.错误)
  }
  // 商品视频：img/video 里第一个视频（或 __TB_CFG.videoFile）
  o.videoPath = pickVideoFile({ dir: join(o.imgDir, 'video'), file: o.videoFile })

  const 资产 = assetReport(o)
  say('素材包资产：')
  say('  ✓ 会上传:', 资产.会上传.length ? 资产.会上传.join('、') : '（无）')
  say('  - 跳过（素材包没给）:', 资产.跳过.length ? 资产.跳过.join('、') : '（无）')
  if (资产.暂不支持.length) {
    say('  ⚠ 暂不支持（本技能暂无对应功能）:', 资产.暂不支持.join('、'))
    say('    如需上传这些内容，请人工处理，或告诉我加对应功能。')
  }

  const plan = buildSteps(o)
  const m = plan.meta
  say('类目 =', o.catid, '| 商品 =', o.product)
  say('图片素材：1:1 主图', m.mainTotal, '张（本次传', m.mainCount, '）；详情', m.detailTotal, '张（每批', m.detailBatch, '）')
  if (m.mainTotal > m.mainCount) {
    say(`  ℹ️ 1:1 素材 ${m.mainTotal} 张，本次传前 ${m.mainCount} 张（平台上限 ${m.platformMainMax} 张）`)
  }
  if (m.mainTotal === 0 || m.detailTotal === 0) {
    say('  ⚠️ 有图片目录是空的 —— 先跑 tb_prep_assets.js（或给 pack 自动拷图）再跑编排')
  }

  if (o.dryRun) {
    say('')
    say('==================== DryRun：只打印计划，不动页面 ====================')
    say('将按顺序执行', plan.steps.length, '步：')
    plan.steps.forEach((s, i) => say(`  ${String(i + 1).padStart(2)}. ${s.key}`))
    say('')
    say('★ DryRun 结束：什么都没有提交、没有打开页面。去掉 dryRun 即可正式跑。')
    return { ok: true, dryRun: true, meta: m, steps: plan.steps.map((s) => s.key) }
  }

  let owned = false
  if (!page) {
    const connected = await connectSpace(o.space, { preferUrl: /item\.upload\.taobao\.com|login\.taobao\.com/ })
    page = connected.page
    owned = true
  }
  if (o.reloadFirst) {
    say('↻ reloadFirst：重载发布页，清掉上一轮残留的表单值/弹窗')
    await page.reload().catch(() => {})
    await sleep(8000)
  }
  // ★ 窗口太窄时淘宝图片空间面板（900px 宽）右半截会被窗口切掉 → 卡片/按钮落到窗口外点不到。
  //   上传按钮已改成 focus+Enter 触发，但卡片点击仍需可见坐标，所以提前大声提醒。
  const viewWidth = await page
    .evaluate(() => document.documentElement.clientWidth)
    .catch(() => 0)
  if (viewWidth && viewWidth < 1200) {
    say(`⚠ ego 窗口只有 ${viewWidth}px 宽（淘宝图片空间面板 900px 宽会被切掉）→ 请先把 ego 窗口拉宽到 ≥1300px，否则点图可能点空。`)
  } else if (viewWidth) {
    say('窗口宽度', viewWidth + 'px ✓')
  }
  const before = await page.url().catch(() => '')
  say('工作页 =', String(before).slice(0, 120))

  const res = await runPlan(page, plan)
  const report = {
    ok: res.ok,
    aborted: res.aborted,
    space: o.space,
    catId: o.catid,
    product: o.product,
    cat: o.cat,
    meta: m,
    steps: res.steps,
    failed: res.failed,
    资产,
    note: '只填空+校验，未提交；请在页面上核对后自己点「提交宝贝信息」',
  }
  say('')
  if (res.failed.length === 0) say('DONE: all green')
  else {
    say('DONE: failed steps')
    for (const k of res.failed) say('  - ' + k)
  }
  say('NOTE: review the page and submit it yourself.')
  return report
}

// ── CLI 直跑（ego nodejs -e "globalThis.__TB_CFG={...}; await import('file:///.../run_listing_tb.mjs')"）──
// 测试时设 globalThis.__TB_NO_MAIN=true 可只 import 模块、不执行。
if (!globalThis.__TB_NO_MAIN && !globalThis.__TB_ORCHESTRATOR) {
  try {
    const report = await runListing()
    out(report)
    process.exitCode = report && report.ok ? 0 : 1
  } catch (e) {
    out({ ok: false, why: 'exception', 错误: String((e && e.message) || e) })
    process.exitCode = 1
  }
}

export default { runListing, runPlan, buildSteps, resolveOptions }
