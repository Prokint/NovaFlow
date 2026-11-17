#!/usr/bin/env node
/**
 * 淘宝/千牛上架 · ego 版命令行入口。
 *
 *   node scripts/run_tb.mjs --config run-config.json        正式跑（默认不存草稿、不提交）
 *   node scripts/run_tb.mjs --config run-config.json --dry  只做数据准备 + 打印计划，不碰页面
 *
 * 做了什么：读 run-config.json → 找 ego-browser → 起一个 ego「nodejs」进程 →
 * 把参数塞进 globalThis.__TB_CFG → 调用 scripts/run_listing_tb.mjs 的 runListing()。
 *
 * 为什么这样起：ego 子进程**不继承自定义环境变量**，所以所有配置只能走 __TB_CFG；
 * 又因为编排层会自己 connectSpace，控制权在用户手里时要用 takeOverTaskSpace（见 HANDOVER.md）。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

/** 允许从 run-config.json 透传给 __TB_CFG 的键（其余是工具链配置，不传）。 */
const CFG_KEYS = [
  'space', 'catid', 'cat', 'brand', 'product', 'pack', 'workdir', 'imgDir',
  'python', 'node', 'productId', 'listPrice', 'sizeSort', 'mainLimit', 'detailBatch',
  'skuTemplate', 'templateOut', 'saveDraft', 'reloadFirst', 'dryRun', 'forceEntry',
  'specColors', 'strictReadback', 'debug', 'downloadDir', 'templateUrl',
  'upload34', 'uploadVideo', 'uploadWhite', 'crop34', 'recheckAttrs', 'uploadSettleMs', 'videoFile',
  'detailBatch', 'detailCheckExists', 'detailSearchFallback', 'detailNoSelect',
]

function parseArgs(argv) {
  const out = { config: join(ROOT, 'run-config.json'), dry: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--config' || a === '-c') out.config = argv[i += 1]
    else if (a === '--dry' || a === '--dryRun') out.dry = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

/** 找 ego-browser：配置 → 环境变量 → ego 安装目录 → PATH。 */
function detectEgo(config) {
  if (config.egoBrowser && existsSync(config.egoBrowser)) return config.egoBrowser
  if (process.env.TB_EGO_BROWSER && existsSync(process.env.TB_EGO_BROWSER)) return process.env.TB_EGO_BROWSER
  const active = join(homedir(), '.local', 'share', 'ego', 'active_version_dir')
  const exe = process.platform === 'win32' ? 'ego-browser.exe' : 'ego-browser'
  const local = join(active, exe)
  if (existsSync(local)) return local
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    const p = join(dir, exe)
    if (existsSync(p)) return p
  }
  return ''
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`用法: node scripts/run_tb.mjs [--config <run-config.json>] [--dry]
  --config  上架参数文件，默认 ${join(ROOT, 'run-config.json')}
  --dry     只做数据准备 + 打印计划，不连浏览器（等价 __TB_CFG.dryRun=true）`)
    process.exit(0)
  }

  const cfgPath = resolve(args.config)
  if (!existsSync(cfgPath)) {
    console.error(`★ 找不到配置：${cfgPath}\n  先复制模板：copy run-config.example.json run-config.json 再改里面的 space/product`)
    process.exit(2)
  }

  let raw
  try {
    // Windows 记事本/PowerShell 保存的 JSON 可能带 BOM → 先去掉再解析
    raw = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    console.error('★ 配置不是合法 JSON：' + String((e && e.message) || e))
    process.exit(2)
  }

  const cfg = {}
  for (const k of CFG_KEYS) if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') cfg[k] = raw[k]
  if (args.dry) cfg.dryRun = true
  if (cfg.saveDraft === undefined) cfg.saveDraft = false
  if (!cfg.space) {
    console.error('★ run-config.json 里缺 space（ego space id；用 `ego-browser nodejs -e "console.log(JSON.stringify(await listTaskSpaces()))"` 或 pdd_ego_spaces 看）')
    process.exit(2)
  }
  if (!cfg.catid || !cfg.cat) {
    console.error('★ run-config.json 里缺 catid / cat（类目 id 与完整路径，逐级点选用）')
    process.exit(2)
  }

  const ego = detectEgo(raw)
  if (!ego) {
    console.error('★ 找不到 ego-browser：装 ego lite，或在 run-config.json 里写 egoBrowser，或设 TB_EGO_BROWSER')
    process.exit(2)
  }

  const entry = pathToFileURL(join(HERE, 'run_listing_tb.mjs')).href
  const script =
    'globalThis.__TB_NO_MAIN = true\n' +
    'globalThis.__TB_ORCHESTRATOR = true\n' +
    'globalThis.__TB_CFG = ' + JSON.stringify(cfg) + '\n' +
    'const mod = await import(' + JSON.stringify(entry) + ')\n' +
    'const report = await mod.runListing()\n' +
    'console.log("REPORT " + JSON.stringify(report))\n' +
    'process.exitCode = report && report.ok ? 0 : 1\n'

  console.log(`[run_tb] ego = ${ego}`)
  console.log(`[run_tb] config = ${cfgPath}`)
  console.log(`[run_tb] space = ${cfg.space} | catId = ${cfg.catid} | saveDraft = ${!!cfg.saveDraft} | dryRun = ${!!cfg.dryRun}`)

  const t0 = Date.now()
  // ego 的 nodejs 子进程即使跑成功也可能以 1 退出 → 以我们自己打印的 REPORT 为准
  let sawReport = null
  let buffer = ''
  const child = execFile(ego, ['nodejs', '-e', script], { timeout: 45 * 60 * 1000, maxBuffer: 128 * 1024 * 1024, windowsHide: true }, (err) => {
    const sec = Math.round((Date.now() - t0) / 1000)
    console.log(`\n[run_tb] done in ${sec}s`)
    if (sawReport) {
      process.exitCode = sawReport.ok ? 0 : 1
      return
    }
    if (err) {
      console.error('[run_tb] 失败：' + String((err && err.message) || err).slice(0, 400))
      process.exitCode = 1
    }
  })
  child.stdout.on('data', (d) => {
    process.stdout.write(d)
    buffer += String(d)
    const m = buffer.match(/REPORT (\{.*\})\r?\n?/)
    if (m) {
      try {
        sawReport = JSON.parse(m[1])
      } catch (e) {
        /* REPORT 行被截断时忽略，最后仍以退出码为准 */
      }
    }
  })
  child.stderr.on('data', (d) => process.stderr.write(d))
}

main()
