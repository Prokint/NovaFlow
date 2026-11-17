/**
 * 运行时路径解析：配置 > 环境变量 > 自动探测（一支能装到任何机器上的解析层）。
 *
 * 本模块只做文件系统探测，不依赖 Cordis，可独立冒烟测试。
 * 所有探测函数都返回 undefined/空数组表示「没找到」，由调用方决定报错文案。
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : ''

/** 返回第一个真实存在的候选路径。 */
export function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return undefined
}

/** 在 PATH 的各目录里查找可执行文件。 */
export function findOnPath(names) {
  const directories = String(process.env.PATH || '').split(delimiter).filter(Boolean)
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * 探测 ego-browser 可执行文件。
 * 顺序：显式配置 → 环境变量（TB_EGO_BROWSER）→ ego 安装目录（含版本子目录）→ PATH。
 */
export function detectEgoBrowser(options = {}) {
  const { configured, envVar = 'TB_EGO_BROWSER' } = options
  const direct = firstExisting([configured, envVar ? process.env[envVar] : undefined])
  if (direct) return direct

  const home = homedir()
  const activeDirectory = join(home, '.local', 'share', 'ego', 'active_version_dir')
  const candidates = [join(activeDirectory, `ego-browser${EXE_SUFFIX}`)]
  if (existsSync(activeDirectory)) {
    try {
      for (const entry of readdirSync(activeDirectory, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(join(activeDirectory, entry.name, `ego-browser${EXE_SUFFIX}`))
      }
    } catch {}
  }
  candidates.push(
    join(home, '.local', 'bin', `ego-browser${EXE_SUFFIX}`),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'ego', `ego-browser${EXE_SUFFIX}`) : undefined,
  )
  return firstExisting(candidates) || findOnPath([`ego-browser${EXE_SUFFIX}`, 'ego-browser'])
}

/**
 * 列出 DSH 自带的 Python：用户都用 DSH 跑插件，不该为了读 Excel 再装一份 Python。
 * DSH 运行时（`~/.dsh/dsh-runtimes/<runtime>/dependencies/python`）自带 python + openpyxl。
 */
export function listDshPythons(home = homedir()) {
  const base = join(home, '.dsh', 'dsh-runtimes')
  const found = []
  let entries = []
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    for (const exe of [`python${EXE_SUFFIX}`, 'python', 'python3']) {
      const candidate = join(base, entry.name, 'dependencies', 'python', exe)
      if (existsSync(candidate)) {
        found.push(candidate)
        break
      }
    }
  }
  return found
}

/**
 * 列出 Python 解释器候选（调用方逐个验证 openpyxl）。
 * 顺序：插件配置 → DSH 自带 → 环境变量 TB_PYTHON → PATH → 常见安装目录。
 */
export function listPythonCandidates(options = {}) {
  const { configured, envVar = 'TB_PYTHON' } = options
  const home = homedir()
  const localPrograms = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Python') : undefined
  const configuredFirst = [configured].filter(Boolean)
  const dsh = listDshPythons(home)
  const fromEnv = [envVar ? process.env[envVar] : undefined].filter(Boolean)
  const installed = []
  for (const version of ['313', '312', '311', '310']) {
    if (localPrograms) installed.push(join(localPrograms, `Python${version}`, `python${EXE_SUFFIX}`))
    installed.push(join(home, 'AppData', 'Local', 'Programs', 'Python', `Python${version}`, `python${EXE_SUFFIX}`))
  }
  if (process.env.LOCALAPPDATA) installed.push(join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Launcher', `py${EXE_SUFFIX}`))
  const onPath = findOnPath([`python${EXE_SUFFIX}`, 'python'])
  return [...configuredFirst, ...dsh, ...fromEnv, onPath, ...installed].filter(
    (value) => typeof value === 'string' && value.length > 0,
  )
}

/** 可写日志位置（包可能装在只读位置，默认落系统临时目录）。 */
export function resolveLogFile(options = {}) {
  const { configured, envVar = 'TB_EGO_LOG' } = options
  const fromEnv = envVar ? process.env[envVar] : undefined
  if (configured) return String(configured)
  if (fromEnv) return String(fromEnv)
  return join(tmpdir(), 'taobao-ego-plugin.log')
}

/**
 * 工作目录：默认插件包自带的 `scripts/`（执行层随包分发）。
 * 返回值统一正斜杠（会拼进 `file:///` URL）。
 */
export function resolveWorkDir(options = {}) {
  const { configured, envVar = 'TB_WORK_DIR', fallback } = options
  const fromEnv = envVar ? process.env[envVar] : undefined
  const chosen = configured || fromEnv || fallback
  return String(chosen).replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 输出根目录（product.json / 下载的 SKU 模板 / 图片都落这里）：默认 `~/.dsh/taobao-ego/output`。 */
export function resolveOutputRoot(options = {}) {
  const { configured, envVar = 'TB_OUTPUT_ROOT' } = options
  const fromEnv = envVar ? process.env[envVar] : undefined
  const chosen = configured || fromEnv || join(homedir(), '.dsh', 'taobao-ego', 'output')
  return String(chosen).replace(/\\/g, '/').replace(/\/+$/, '')
}
