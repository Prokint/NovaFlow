/**
 * dsh-plugin-taobao-ego（可分发版）
 *
 * 淘宝/千牛商品上架（ego 版）：执行层（run_listing_tb / 各 tb_* 模块 / tb_build.py 等）随包放在 `scripts/`，
 * ego-browser / Python / 输出目录 / 日志全部「配置 > 环境变量 > 自动探测」，不写死用户目录或盘符。
 *
 * 能力：
 *   - 运行时技能注入：taobao-ego-listing（ctx.inject(['skills'])）
 *   - 工具注册：tb_ego_*（宿主提供 @deepseek-ai/dsh-tools 时）
 *
 * 配置项（均可省略）：
 *   egoBrowser / workDir / outputRoot / pythonPath / logFile / timeoutMs / verbose
 *   allowSubmit（**恒为 false**：本插件从不点「提交宝贝信息」）
 * 环境变量：TB_EGO_BROWSER / TB_WORK_DIR / TB_OUTPUT_ROOT / TB_PYTHON / TB_EGO_LOG / TB_EGO_DEBUG
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { detectEgoBrowser, listPythonCandidates, resolveLogFile, resolveOutputRoot, resolveWorkDir } from './paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const SCRIPTS_DIR = join(PKG_ROOT, 'scripts')
const SKILL_DIR = join(PKG_ROOT, 'skill')

export const name = 'taobao-ego-listing'

export function apply(ctx, config) {
  const raw = config && typeof config === 'object' ? config : {}

  const cfg = {
    egoBrowser: detectEgoBrowser({ configured: raw.egoBrowser }),
    workDir: resolveWorkDir({ configured: raw.workDir, fallback: SCRIPTS_DIR }),
    outputRoot: resolveOutputRoot({ configured: raw.outputRoot }),
    pythonPath: typeof raw.pythonPath === 'string' && raw.pythonPath.length > 0 ? raw.pythonPath : null,
    logFile: resolveLogFile({ configured: raw.logFile }),
    timeoutMs: Number(raw.timeoutMs || 1800000),
    verbose: raw.verbose === true,
    // 红线：本插件没有「提交」能力，这个开关只用于在工具返回里标注「不允许提交」
    allowSubmit: false,
  }

  const DEBUG = () => {
    try {
      return process.env.TB_EGO_DEBUG === '1'
    } catch {
      return false
    }
  }
  const log = (message) => {
    if (!DEBUG()) return
    try {
      appendFileSync(cfg.logFile, new Date().toISOString() + ' ' + message + '\n')
    } catch {}
  }
  const vlog = (message) => {
    if (cfg.verbose) log('[debug] ' + message)
  }
  vlog('config = ' + JSON.stringify(cfg))

  // ── 子进程 ────────────────────────────────────────────────────────────────
  let execFileFn = null
  const safeRequire = () => {
    try {
      return createRequire(import.meta.url)
    } catch {
      return null
    }
  }
  const getExecFile = () => {
    if (execFileFn) return execFileFn
    const rp = safeRequire()
    if (!rp) return null
    try {
      execFileFn = rp('node:child_process').execFile
      return execFileFn
    } catch {
      try {
        execFileFn = rp('child_process').execFile
        return execFileFn
      } catch (e2) {
        log('child_process unavailable: ' + e2.message)
        return null
      }
    }
  }

  const runCmd = (command, args, options) =>
    new Promise((done) => {
      const execFile = getExecFile()
      if (!execFile) return done({ ok: false, stdout: '', stderr: '', error: 'execFile unavailable' })
      execFile(
        command,
        args,
        {
          timeout: (options && options.timeoutMs) || cfg.timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, ...((options && options.env) || {}) },
          windowsHide: true,
        },
        (err, stdout, stderr) =>
          done({
            ok: !err,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            error: err ? String(err.message || err).slice(0, 400) : null,
          }),
      )
    })

  const cleanLog = (text) =>
    String(text || '')
      .split(/\r?\n/)
      .filter((line) => !/^\[ego-browser:notice\]/.test(line))
      .join('\n')
      .trim()

  /** 从输出里捞最后一个能解析的 JSON（REPORT 行或 cli-ego 的 JSON）。 */
  const parseJson = (text) => {
    const lines = String(text || '').split(/\r?\n/).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim()
      const start = line.indexOf('{')
      if (start < 0) continue
      const tail = line.slice(start)
      try {
        return JSON.parse(tail)
      } catch {}
      if (line.startsWith('REPORT ')) {
        try {
          return JSON.parse(line.slice(7))
        } catch {}
      }
    }
    return null
  }

  // ── ego 调用：把配置内联进 -e 脚本（ego 不继承自定义环境变量） ────────────
  const egoBootstrap = (inline) => {
    const cfgJson = JSON.stringify(inline)
    const cliUrl = 'file:///' + String(join(cfg.workDir, 'cli-ego.mjs')).replace(/\\/g, '/')
    return `globalThis.__TB_CLI_CFG = ${cfgJson}; globalThis.__TB_CFG = ${cfgJson}; await import('${cliUrl}')`
  }

  const runEgo = async (inline) => {
    if (!cfg.egoBrowser) return { ok: false, json: null, text: 'egp_not_found', error: 'ego-browser 未找到' }
    const script = egoBootstrap(inline)
    const result = await runCmd(cfg.egoBrowser, ['nodejs', '-e', script], {})
    const text = cleanLog(result.stdout) || cleanLog(result.stderr) || String(result.error || '')
    return { ok: result.ok, json: parseJson(text), text: text.slice(-8000) }
  }

  const egoJson = async (inline) => {
    const result = await runEgo(inline)
    return result.json ?? { ok: false, error: result.text || 'ego 调用失败且没有输出' }
  }

  // ── Python ────────────────────────────────────────────────────────────────
  let pythonResolved = false
  let pythonPath = cfg.pythonPath
  const pythonCan = async (candidate, expression) => (await runCmd(candidate, ['-c', expression], { timeoutMs: 20000 })).ok

  const resolvePython = async () => {
    if (pythonResolved) return pythonPath
    pythonResolved = true
    if (pythonPath) {
      if (existsSync(pythonPath)) return pythonPath
      log('配置的 pythonPath 不存在，已回退自动探测：' + pythonPath)
      pythonPath = null
    }
    const candidates = listPythonCandidates({})
    for (const candidate of candidates) {
      if (await pythonCan(candidate, 'import openpyxl')) {
        pythonPath = candidate
        vlog('python (openpyxl) = ' + candidate)
        return pythonPath
      }
    }
    for (const candidate of candidates) {
      if (await pythonCan(candidate, 'pass')) {
        pythonPath = candidate
        log('python 可用但没有 openpyxl，读 Excel 会失败：' + candidate)
        return pythonPath
      }
    }
    pythonPath = null
    return null
  }

  // ── 工具定义 ──────────────────────────────────────────────────────────────
  const TOOLS = [
    {
      key: 'tb_ego_env',
      description:
        '自检运行前提：ego 浏览器、Python（含 openpyxl）、当前可连的淘宝 space。上架前先跑它，把结果告诉用户。',
      props: {},
      run: async () => {
        const interpreter = await resolvePython().catch(() => null)
        const pythonHasOpenpyxl = interpreter ? await pythonCan(interpreter, 'import openpyxl') : false
        const spaceResult = cfg.egoBrowser ? await runEgo({ cmd: 'spaces' }) : null
        const missing = []
        if (!cfg.egoBrowser) missing.push('ego-browser')
        if (!interpreter) missing.push('python')
        else if (!pythonHasOpenpyxl) missing.push('openpyxl')
        return {
          ok: missing.length === 0,
          egoBrowser: cfg.egoBrowser || null,
          pythonPath: interpreter,
          pythonHasOpenpyxl,
          workDir: cfg.workDir,
          outputRoot: cfg.outputRoot,
          spaces:
            spaceResult && spaceResult.json && Array.isArray(spaceResult.json.spaces)
              ? spaceResult.json.spaces.map((s) => ({ id: s.id, name: s.name, profileName: s.profileName }))
              : null,
          missing,
          requirement: [
            'ego-browser：需在本机安装（默认探测 ~/.local/share/ego/active_version_dir 与 PATH），也可在插件配置填 egoBrowser 或设 TB_EGO_BROWSER。',
            'Python 3 + openpyxl：**默认直接用 DSH 自带那份**（~/.dsh/dsh-runtimes/*/dependencies/python），用户不需要另装；也可填 pythonPath / 设 TB_PYTHON 覆盖。',
            '淘宝/千牛：需用户自行在 ego 浏览器里登录（本插件不代登录、不碰账号密码）。',
          ],
          hint:
            missing.length === 0
              ? '前提齐全，可以按技能流程跑上架（默认不存草稿、绝不提交）。'
              : '先告诉用户缺哪一项、要装什么，重启应用后再试；不要猜路径，也不要硬跑。',
        }
      },
    },
    {
      key: 'tb_ego_spaces',
      description: '列出 ego 浏览器的店铺工作区（space），确认哪个 spaceId 对应哪个店（ego 重启后 id 会变）。',
      props: {},
      run: async () => egoJson({ cmd: 'spaces' }),
    },
    {
      key: 'tb_ego_probe_shop',
      description: '只读探测某 space 当前页面状态（是否在发布页 / catId / 空图片槽数 / 各区块是否在）。',
      props: { space: { type: 'integer', description: 'spaceId（必填）' } },
      required: ['space'],
      run: async (a) => egoJson({ cmd: 'probe', space: a && a.space }),
    },
    {
      key: 'tb_ego_category_profile',
      description:
        '**只读**抓取某个类目发布页的「上架资料清单」：属性名 / 是否必填 / 控件类型 / 当前值 / 下拉可选值，'
        + '外加 1:1、3:4、白底图、商品视频 的页面原文要求，以及该类目官方 SKU 模板是否已下载。'
        + '用途：用户没有素材包、只有商品图片和口头参数时，先用它告诉用户「这个类目必须填什么、每个能选什么」。'
        + '给了 catid+cat 会先走「搜索发品→级联选类目」进页面；不给就复用当前已打开的发布页。**不会提交、不会保存。**',
      props: {
        space: { type: 'integer', description: 'spaceId（必填）' },
        catid: { type: 'string', description: '可选：类目 id（给了 cat 才会进类目页）' },
        cat: { type: 'string', description: '可选：类目完整路径，如「居家布艺 > 地毯」' },
        brand: { type: 'string', description: '可选：进类目页时要选的品牌（默认 无品牌）' },
        force: { type: 'boolean', description: '可选：强制重走入口（默认 false，已在目标页就复用）' },
        withOptions: { type: 'integer', description: '可选：最多展开多少个下拉读候选值（默认 12，0 = 不展开）' },
        exportXlsx: { type: 'string', description: '可选：把类目资料导出成「给人填的 Excel」（.xlsx 绝对路径；不填就只回 JSON）' },
      },
      required: ['space'],
      run: async (a) => {
        const args = a || {}
        const py = await resolvePython().catch(() => null)
        const r = await egoJson({
          cmd: 'profile',
          space: args.space,
          catid: args.catid ? String(args.catid) : '',
          cat: args.cat ? String(args.cat) : '',
          brand: args.brand ? String(args.brand) : '无品牌',
          force: args.force === true,
          withOptions: args.withOptions === undefined ? 12 : Number(args.withOptions),
          templateOut: join(cfg.outputRoot, '_downloads'),
          exportXlsx: args.exportXlsx ? String(args.exportXlsx) : '',
          python: py || '',
        })
        return r
      },
    },
    {
      key: 'tb_ego_build_product',
      description:
        '**手工造数据**（不碰浏览器）：把一份极简 listing.json（title/catid/cat/skus/图片目录…）拼成技能认识的 '
        + 'product.json + img/{1x1,3x4,detail,spec,white,video}，生成后可直接丢给 tb_ego_run_listing。'
        + '缺字段会列在「缺什么」里，不会静默编造。'
        + 'listing 形状见 README 的「没有素材包时」一节：'
        + 'id / title / cat / catid / brand / attributes / colors / styles / listPrice / skus[] / images{main,threeToFour,detail,white,video,spec}。',
      props: {
        listingPath: { type: 'string', description: '可选：listing.json 绝对路径（与 listing/listingXlsx 三选一）' },
        listingXlsx: { type: 'string', description: '可选：用户填好的 listing.xlsx 绝对路径（tb_ego_category_profile 的 exportXlsx 产物）' },
        listing: { type: 'object', description: '可选：直接内联的 listing 对象（与 listingPath 二选一）' },
        out: { type: 'string', description: '可选：输出目录（默认 ~/.dsh/taobao-ego/output/<id>）' },
      },
      run: async (a) => {
        const args = a || {}
        try {
          const py = await resolvePython().catch(() => null)
          if (args.listingXlsx) {
            // 先把「用户填好的 Excel」转成 listing.json（python），再照常生成 product.json
            const ego = await egoJson({
              cmd: 'build',
              space: cfg.egoBrowser ? undefined : undefined,
              listingXlsx: String(args.listingXlsx),
              out: args.out ? String(args.out) : undefined,
              python: py || '',
            })
            return ego.build ? ({ ok: ego.ok, ...ego.build, xlsx: args.listingXlsx }) : ego
          }
          const mod = await import('file:///' + String(join(cfg.workDir, 'tb_build_product_manual.mjs')).replace(/\\/g, '/'))
          if (args.listingPath) return mod.buildProductFromFile(String(args.listingPath), { out: args.out })
          if (args.listing && typeof args.listing === 'object') return mod.buildProductFromListing(args.listing, { out: args.out })
          return { ok: false, why: 'need_listing', 提示: '给 listingXlsx（用户填好的 Excel）/ listingPath（listing.json）/ listing（内联对象）' }
        } catch (e) {
          return { ok: false, why: 'build_failed', 错误: String((e && e.message) || e) }
        }
      },
    },
    {
      key: 'tb_ego_build_pack',
      description:
        '**生成完整淘宝素材包**（一段数据 → 一个可直接上架的素材包目录）：把 listing.json（或用户填好的 listing.xlsx）'
        + '连同图片目录一起，写成 `商品信息.xlsx`（sheet「淘宝」：类目属性列 + SKU 列，R4 带 JSON 元数据）+ `淘宝/<商品号>/` 六个图片目录'
        + '（1比1主图 / 3比4主图 / 宝贝详情 / 规格图片 / 白底图 / 商品视频）。'
        + '生成后直接 `tb_ego_run_listing({ pack: <该目录>, catid, cat })` 即可（插件会先跑 tb_build.py + tb_prep_assets）。'
        + '第二个规格列名（如「地毯尺寸」）会优先用 listing.dimensions[1]，否则从该类目官方模板表头推断。',
      props: {
        listingPath: { type: 'string', description: '可选：listing.json 绝对路径（与 listingXlsx 二选一）' },
        listingXlsx: { type: 'string', description: '可选：用户填好的 listing.xlsx 绝对路径（tb_ego_category_profile 的 exportXlsx 产物）' },
        profilePath: { type: 'string', description: '可选：类目 profile JSON（提供必填标记；不给就只按 listing 生成）' },
        packDir: { type: 'string', description: '必填：素材包输出目录（不存在会自动建）' },
        dim2: { type: 'string', description: '可选：第二个规格列名（如 地毯尺寸/款式）' },
        templatePath: { type: 'string', description: '可选：该类目官方 SKU 模板绝对路径（不给就自动从 _downloads 缓存挑；会一起放进素材包的 SKU模板/）' },
        audience: { type: 'string', description: "'user'（默认，生成给用户填的素材包：4-sheet 商品信息.xlsx + 空图片目录 + SKU模板/） 或 'tb'（内部 tb_build 格式）" },
        profileJson: { type: 'string', description: '可选：类目 profile JSON 路径（audience=user 时用来生成待填表；不给就从 _downloads 里挑个 profile？建议给）' },
      },
      required: ['packDir'],
      run: async (a) => {
        const args = a || {}
        if (!args.listingPath && !args.listingXlsx) return { ok: false, why: 'need_listing', 提示: '给 listingPath（listing.json）或 listingXlsx（用户填好的 Excel）' }
        const py = await resolvePython().catch(() => null)
        const r = await egoJson({
          cmd: 'pack',
          listingPath: args.listingPath ? String(args.listingPath) : '',
          listingXlsx: args.listingXlsx ? String(args.listingXlsx) : '',
          profilePath: args.profilePath ? String(args.profilePath) : '',
          packDir: String(args.packDir),
          dim2: args.dim2 ? String(args.dim2) : '',
          templatePath: args.templatePath ? String(args.templatePath) : '',
          audience: args.audience ? String(args.audience) : '',
          profileJson: args.profileJson ? String(args.profileJson) : (args.profilePath ? String(args.profilePath) : ''),
          python: py || '',
        })
        return r
      },
    },
    {
      key: 'tb_ego_run_listing',
      description:
        '跑上架编排（只填空 + 校验；**绝不提交、默认不存草稿**）。'
        + '开跑前必须先问用户：店铺(space) / 素材包(product 或 pack) / 类目(catid+cat) / 是否存草稿。'
        + '返回 REPORT JSON（含每步耗时、资产自检、失败项）。',
      props: {
        configPath: { type: 'string', description: '可选：run-config.json 绝对路径（默认插件包 scripts/run-config.json）' },
        space: { type: 'integer', description: '可选：覆盖 spaceId' },
        product: { type: 'string', description: '可选：product.json 绝对路径' },
        pack: { type: 'string', description: '可选：素材包根目录（自动生成 product.json + 拷图）' },
        catid: { type: 'string', description: '可选：类目 id' },
        cat: { type: 'string', description: '可选：类目完整路径（如「居家布艺 > 地毯」）' },
        brand: { type: 'string', description: '可选：品牌（默认 无品牌）' },
        skuTemplate: { type: 'string', description: '可选：官方 SKU 模板绝对路径（默认取 product 同目录的 sku_import_官方模板.xlsx）' },
        imgDir: { type: 'string', description: '可选：素材图根目录（默认 product 同目录的 img/）' },
        reloadFirst: { type: 'boolean', description: '可选：开跑先重载发布页清掉残留（默认 true；页面已有内容又不重载时会报 not_enough_slots）' },
        saveDraft: { type: 'boolean', description: '可选：是否保存草稿（默认 false）' },
        dryRun: { type: 'boolean', description: '可选：只打印计划，不动页面' },
        upload34: { type: 'boolean', description: '可选：是否上传 3:4 主图（默认 true；素材包没有 img/3x4 就自动跳过）' },
        uploadWhite: { type: 'boolean', description: '可选：是否上传白底图（默认 true；没有 img/white 就跳过）' },
        uploadVideo: { type: 'boolean', description: '可选：是否上传商品视频（默认 true；没有 img/video 就跳过）' },
        uploadSettleMs: { type: 'integer', description: '可选：图片传完后等多久再点「完成」（默认 5000）' },
        mainLimit: { type: 'integer', description: '可选：1:1 主图张数上限（默认 5）' },
        detailBatch: { type: 'integer', description: '可选：详情图每批张数（默认 20）' },
        listPrice: { type: 'number', description: '可选：一口价覆盖（必须等于某个有库存 SKU 的价格）' },
      },
      run: async (a) => {
        const args = a || {}
        const base = {}
        if (args.configPath && existsSync(String(args.configPath))) {
          try {
            Object.assign(base, JSON.parse(String(readFileSync(String(args.configPath), 'utf8')).replace(/^\uFEFF/, '')))
          } catch (e) {
            return { ok: false, error: 'bad config: ' + String((e && e.message) || e) }
          }
        }
        const inline = { cmd: 'run', ...base }
        delete inline._说明
        for (const k of Object.keys(inline)) if (k.startsWith('_')) delete inline[k]
        if (args.space !== undefined && args.space !== null) inline.space = args.space
        if (args.product) inline.product = String(args.product)
        if (args.pack) inline.pack = String(args.pack)
        if (args.catid) inline.catid = String(args.catid)
        if (args.cat) inline.cat = String(args.cat)
        if (args.brand) inline.brand = String(args.brand)
        if (args.skuTemplate) inline.skuTemplate = String(args.skuTemplate)
        if (args.imgDir) inline.imgDir = String(args.imgDir)
        if (args.saveDraft !== undefined) inline.saveDraft = args.saveDraft === true
        if (args.dryRun !== undefined) inline.dryRun = args.dryRun === true
        // ★ 默认重载发布页：页面里残留上一轮的图片/SKU 时，图片步会直接报 not_enough_slots（起始空槽=0）
        inline.reloadFirst = args.reloadFirst === undefined ? true : args.reloadFirst === true
        for (const k of ['upload34', 'uploadWhite', 'uploadVideo']) {
          if (args[k] !== undefined) inline[k] = args[k] === true
        }
        for (const k of ['uploadSettleMs', 'mainLimit', 'detailBatch']) {
          if (args[k] !== undefined && args[k] !== null) inline[k] = Number(args[k])
        }
        if (args.listPrice !== undefined && args.listPrice !== null) inline.listPrice = Number(args.listPrice)
        // ★ 收尾目录与模板目录固定在插件输出根目录，避免写进 profile 的 node_modules
        inline.outputRoot = cfg.outputRoot
        inline.templateOut = join(cfg.outputRoot, '_downloads')
        const result = await runEgo(inline)
        // cli-ego 的返回是 {cmd,space,ok,result}；把 REPORT 直接摊出来，模型少挖两层
        const report = (result.json && result.json.result) || result.json || null
        // ★ 返回给模型的值必须是「lossless JSON」：不能带 undefined（DSH 会直接判工具返回非法）
        const out = {
          ok: (report && report.ok) === true,
          submitAllowed: false,
          config: {
            space: inline.space,
            catid: inline.catid,
            cat: inline.cat,
            product: inline.product || null,
            pack: inline.pack || null,
            dryRun: inline.dryRun === true,
            saveDraft: inline.saveDraft === true,
          },
          report,
        }
        if (!report) out.raw = result.text || '(ego 没有输出)'
        return out
      },
    },
  ]

  // ── 技能注册 ──────────────────────────────────────────────────────────────
  const prerequisiteBlock = () => {
    const lines = ['## 运行前提（插件加载时自检）', '']
    lines.push(
      cfg.egoBrowser
        ? `- ego 浏览器：✅ \`${cfg.egoBrowser}\``
        : '- ego 浏览器：❌ **未找到** —— 请在本机安装 ego-browser（默认探测 `~/.local/share/ego/active_version_dir` 与 PATH），或配置 `egoBrowser` / 设 `TB_EGO_BROWSER`。',
    )
    lines.push(
      cfg.pythonPath
        ? `- Python（需 openpyxl）：✅ \`${cfg.pythonPath}\``
        : '- Python（需 openpyxl）：⚠️ 未配置 —— 插件会**优先用 DSH 自带那份**（`~/.dsh/dsh-runtimes/*/dependencies/python`），找不到才回退系统 python；都没有时可配置 `pythonPath` / 设 `TB_PYTHON`。',
    )
    lines.push(`- 输出目录（product.json / 模板 / 图片）：\`${cfg.outputRoot}\``)
    lines.push('- 淘宝/千牛：需用户自行在 ego 浏览器里登录；本插件不代登录、不碰账号密码。')
    lines.push('')
    lines.push('**以上任一项缺失时：先明确告诉用户缺什么、要装什么，然后停下；不要猜路径，也不要硬跑。** 一次性核对全部前提就调用 `tb_ego_env`。')
    lines.push('')
    return lines.join('\n')
  }

  const skillEntry = () => {
    const file = join(SKILL_DIR, 'SKILL.md')
    const body = existsSync(file) ? readFileSync(file, 'utf8') : '# taobao-ego-listing\n'
    let merged = prerequisiteBlock() + body
    if (body.startsWith('---')) {
      const closing = body.indexOf('\n---', 3)
      if (closing >= 0) {
        const afterFrontmatter = body.indexOf('\n', closing + 1)
        const head = body.slice(0, afterFrontmatter + 1)
        const rest = body.slice(afterFrontmatter + 1)
        merged = head + '\n' + prerequisiteBlock() + rest
      }
    }
    return {
      name: 'taobao-ego-listing',
      description:
        '淘宝/千牛商品上架（ego 版）。读素材包 product.json，经 ego-browser 打开发布页，填标题/类目/品牌/属性/规格/SKU/1:1 主图/3:4 主图/详情图/白底图/商品视频/规格图，最后跑提交前核对清单；只填空与校验，绝不点「提交宝贝信息」，默认不存草稿。运行前提：ego 浏览器、DSH 自带 Python（含 openpyxl）、已登录的淘宝/千牛账号。',
      content: merged,
      source: 'bundled',
      resourceBase: { kind: 'directory', path: SKILL_DIR },
    }
  }

  const buildParameters = (props, required) => {
    const out = {}
    for (const [key, value] of Object.entries(props || {})) {
      const item = { type: (value && value.type) || 'string' }
      if (value && value.description) item.description = value.description
      if (Array.isArray(required) && required.includes(key)) item.required = true
      out[key] = item
    }
    return out
  }

  const disposers = []
  const doSkill = (scope) => {
    try {
      const skills = scope && typeof scope.get === 'function' ? scope.get('skills') : scope && scope.skills
      if (!skills || typeof skills.register !== 'function') return log('skills service unavailable')
      disposers.push(skills.register(skillEntry()))
      log('skill registered: taobao-ego-listing')
    } catch (e) {
      log('skill register failed: ' + (e && e.message))
    }
  }

  const doTools = (scope) => {
    try {
      const tools = scope && typeof scope.get === 'function' ? scope.get('tools') : scope && scope.tools
      if (!tools || typeof tools.register !== 'function') return log('tools service unavailable')
      const rp = safeRequire()
      let defineTool = null
      if (rp) {
        try {
          const module = rp('@deepseek-ai/dsh-tools')
          defineTool = module && (module.defineTool || (module.default && module.default.defineTool))
        } catch (e) {
          vlog('dsh-tools not resolvable: ' + e.message)
        }
      }
      if (typeof defineTool !== 'function') return log('defineTool unavailable -> tools skipped')
      for (const definition of TOOLS) {
        try {
          disposers.push(
            tools.register(
              defineTool({
                name: definition.key,
                description: definition.description,
                parameters: buildParameters(definition.props, definition.required),
                output: {
                  schema: { type: 'object', additionalProperties: true, properties: {} },
                  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1).slice(0, 8000) }],
                },
                timeoutMs: cfg.timeoutMs,
                execute: async (args) => definition.run(args || {}),
              }),
            ),
          )
          log('tool registered: ' + definition.key)
        } catch (e) {
          log('tool register failed: ' + definition.key + ' — ' + (e && e.message))
        }
      }
    } catch (e) {
      log('tools setup failed: ' + (e && e.message))
    }
  }

  if (ctx && typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (scope) => {
      doSkill(scope)
      return () => {
        while (disposers.length) {
          const d = disposers.pop()
          try {
            if (typeof d === 'function') d()
          } catch {}
        }
      }
    })
    ctx.inject(['tools'], (scope) => {
      doTools(scope)
    })
  } else {
    log('ctx.inject unavailable -> nothing registered')
  }
}

export default { name, apply }
