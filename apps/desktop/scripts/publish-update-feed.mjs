/**
 * Upload one collected NovaFlow release to the static update feed.
 *
 * Binaries and blockmaps are uploaded before metadata so a client can never read a manifest that
 * references a file the server does not have yet. Existing releases stay on the server because
 * electron-updater needs an older version's blockmap for differential downloads.
 *
 * Usage: `node publish-update-feed.mjs --source <dir> [--remote <user@host:/dir>] [--ssh-key <file>] [--known-hosts <file>]`.
 * The remote defaults to `$DSH_DESKTOP_UPDATE_PUBLISH_REMOTE` and the SSH key to `$DSH_DESKTOP_UPDATE_SSH_KEY`.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DESKTOP_RELEASE_FILE, DESKTOP_UPDATE_FEED_URL } from './desktop-update-feed.mjs'

/** Environment variable naming the rsync destination for the update feed. */
export const DESKTOP_UPDATE_PUBLISH_REMOTE_ENV = 'DSH_DESKTOP_UPDATE_PUBLISH_REMOTE'

/** Environment variable naming the private SSH key used to upload the update feed. */
export const DESKTOP_UPDATE_SSH_KEY_ENV = 'DSH_DESKTOP_UPDATE_SSH_KEY'

/** Default rsync destination: the restricted publish account on the feed host. */
export const DESKTOP_UPDATE_DEFAULT_REMOTE = 'novaflow-publish@103.236.67.115:/'

/** Feed files that must land only after every installer they reference. */
const METADATA = /^(?:latest(?:-mac|-linux(?:-[a-z0-9]+)?)?\.yml|release\.json|SHA256SUMS|index\.html)$/u

const INSTALLER = /^novaflow-.*\.(?:exe|dmg|zip|AppImage|deb)$/u

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with ${String(code)}`))
    })
  })
}

function htmlEscape(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/** Human-readable installer size; the feed stores bytes only for display. */
function formatSize(bytes) {
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0
    ? `${Math.round(bytes / 1_000_000)} MB`
    : ''
}

/** Which download column an installer belongs to; source archives stay in the full file list. */
function platformOf(name) {
  if (/source/i.test(name)) return null
  if (/win/i.test(name)) return 'windows'
  if (/mac/i.test(name)) return 'macos'
  if (/linux|appimage|\.deb$/i.test(name)) return 'linux'
  return null
}

/** File-type copy for one installer. */
function fileKind(name) {
  if (/\.exe$/i.test(name)) return '安装包'
  if (/\.dmg$/i.test(name)) return '磁盘映像'
  if (/\.zip$/i.test(name)) return 'ZIP 压缩包'
  if (/\.appimage$/i.test(name)) return 'AppImage'
  if (/\.deb$/i.test(name)) return 'Debian 安装包'
  return '文件'
}

/** Escape then render the small inline Markdown subset used by release notes. */
function renderInline(value) {
  return htmlEscape(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>')
}

/** Render the release notes without trusting their Markdown as HTML. */
function renderNotes(markdown) {
  const source = markdown.replace(/<!--[\s\S]*?-->/g, '').trim()
  if (source === '') return '<p class="notes-empty">本次更新没有额外说明。</p>'
  const output = []
  let list = null
  const closeList = () => {
    if (list !== null) {
      output.push(`</${list}>`)
      list = null
    }
  }
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === '') {
      closeList()
      continue
    }
    const heading = /^(#{2,4})\s+(.*)$/.exec(line)
    if (heading !== null) {
      closeList()
      const level = Math.min(6, heading[1].length + 1)
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      continue
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet !== null) {
      if (list !== 'ul') {
        closeList()
        list = 'ul'
        output.push('<ul>')
      }
      output.push(`<li>${renderInline(bullet[1])}</li>`)
      continue
    }
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (ordered !== null) {
      if (list !== 'ol') {
        closeList()
        list = 'ol'
        output.push('<ol>')
      }
      output.push(`<li>${renderInline(ordered[1])}</li>`)
      continue
    }
    closeList()
    output.push(`<p>${renderInline(line)}</p>`)
  }
  closeList()
  return output.join('\n')
}

/** One platform's download block, with the preferred installer first. */
function renderPlatformCards(installers) {
  const groups = { windows: [], macos: [], linux: [] }
  for (const file of installers) {
    const platform = platformOf(file.name)
    if (platform !== null) groups[platform].push(file)
  }
  const rank = (name) => {
    if (/\.exe$/i.test(name)) return 0
    if (/\.dmg$/i.test(name)) return 0
    if (/\.appimage$/i.test(name)) return 0
    if (/\.zip$/i.test(name)) return 1
    return 2
  }
  for (const files of Object.values(groups)) files.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
  const platforms = [
    ['windows', 'Windows x64'],
    ['macos', 'macOS Apple Silicon'],
    ['linux', 'Linux x64'],
  ].filter(([key]) => groups[key].length > 0)
  if (platforms.length === 0) return ''
  return platforms.map(([key, title]) => {
    const files = groups[key]
    const primary = files[0]
    const secondary = files.slice(1)
    const primarySize = formatSize(primary.size)
    const secondaryLinks = secondary.map(file => `<a href="./${htmlEscape(encodeURIComponent(file.name))}" download>${htmlEscape(fileKind(file.name))}${formatSize(file.size) === '' ? '' : ` · ${formatSize(file.size)}`}</a>`).join('')
    return `        <article data-reveal class="platform platform--${key}">
          <h3>${htmlEscape(title)}</h3>
          <p class="platform-file">${htmlEscape(primary.name)}</p>
          <p class="platform-meta">${htmlEscape(fileKind(primary.name))}${primarySize === '' ? '' : ` · ${primarySize}`}</p>
          <a class="button platform-button" href="./${htmlEscape(encodeURIComponent(primary.name))}" download>下载 ${htmlEscape(title)}</a>
          ${secondaryLinks === '' ? '' : `<p class="platform-links">${secondaryLinks}</p>`}
        </article>`
  }).join('\n')
}

/**
 * Render the download page from one release manifest.
 * @param {{ version: string, pageUrl: string, notes?: string }} release - Parsed `release.json`.
 * @param {readonly ({ name: string, size?: number } | string)[]} installers - Installer files served beside the page.
 * @returns {string} Complete HTML document.
 */
export function renderDownloadPage(release, installers) {
  const files = installers.map(file => typeof file === 'string' ? { name: file } : file)
  const notes = typeof release.notes === 'string' ? release.notes.trim() : ''
  const version = htmlEscape(release.version)
  const platforms = renderPlatformCards(files)
  const platformList = platforms === ''
    ? `<p class="fallback">安装文件暂未生成，请稍后再试。</p>`
    : platforms
  const copyCommand = '# macOS\nshasum -a 256 -c SHA256SUMS --ignore-missing\n\n# Linux\nsha256sum -c SHA256SUMS --ignore-missing'
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#f4f5f6">
  <meta name="description" content="下载 NovaFlow ${version} 桌面端。Windows、macOS 与 Linux 安装包，含 SHA-256 校验。">
  <title>下载 NovaFlow ${version}</title>
  <style>
    :root {
      color-scheme: light;
      --paper: #f4f5f6;
      --ink: #15171b;
      --muted: #62656c;
      --accent: #2457ff;
      --accent-strong: #183fce;
      --band: #12151a;
      --band-ink: #f5f6f7;
      --band-muted: #aeb3ba;
      --panel: #1c2027;
      --tone: #e6e9ec;
      --max: 1160px;
      --gutter: clamp(20px, 4vw, 40px);
      --mono: "SFMono-Regular", "SF Mono", "Cascadia Code", "Liberation Mono", monospace;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body { overflow-x: clip; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font-family: "Avenir Next", "Helvetica Neue", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    a { color: inherit; text-underline-thickness: 1px; text-underline-offset: 3px; }
    a:hover { text-decoration-thickness: 2px; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
    .skip { position: absolute; left: 16px; top: -60px; padding: 10px 14px; background: var(--ink); color: var(--paper); z-index: 10; }
    .skip:focus { top: 16px; }
    .site-head {
      max-width: var(--max);
      margin: 0 auto;
      padding: 28px var(--gutter);
      display: flex;
      align-items: center;
      gap: 28px;
    }
    .wordmark { display: inline-flex; align-items: center; gap: 10px; font-size: 20px; font-weight: 700; letter-spacing: -0.035em; text-decoration: none; }
    .wordmark-mark { width: 28px; height: 28px; display: grid; place-items: center; background: var(--ink); color: var(--paper); border-radius: 2px; font-size: 15px; }
    .site-nav { margin-left: auto; display: flex; gap: clamp(14px, 2.4vw, 30px); font-size: 15px; color: var(--muted); }
    .site-nav a { text-decoration: none; }
    .site-nav a:hover { color: var(--ink); }
    .site-version { font-size: 14px; color: var(--muted); white-space: nowrap; }
    main { display: block; }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(240px, 0.85fr);
      gap: clamp(32px, 7vw, 96px);
      align-items: end;
      max-width: var(--max);
      margin: 0 auto;
      padding: clamp(44px, 8vw, 108px) var(--gutter) clamp(56px, 9vw, 116px);
    }
    h1 { margin: 0; font-size: clamp(56px, 8.6vw, 120px); line-height: 0.9; letter-spacing: -0.06em; max-width: 9ch; }
    .lede { margin: 28px 0 0; max-width: 34ch; color: var(--muted); font-size: clamp(18px, 2vw, 22px); line-height: 1.45; }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 48px;
      padding: 13px 22px;
      border: 0;
      border-radius: 2px;
      background: var(--accent);
      color: #fff;
      font: inherit;
      font-size: 16px;
      font-weight: 650;
      text-decoration: none;
      cursor: pointer;
      transition: background-color 140ms ease;
    }
    .button:hover { background: var(--accent-strong); }
    .hero-figure { grid-column: 2; grid-row: 1 / span 2; background: var(--tone); padding: clamp(20px, 3vw, 30px); }
    .hero-cta { grid-column: 1; grid-row: 2; justify-self: start; margin-top: 2px; }
    .hero-version { display: block; font-size: clamp(56px, 7vw, 96px); line-height: 0.85; letter-spacing: -0.06em; font-weight: 700; }
    .hero-meta { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 24px; color: var(--muted); font-size: 14px; }
    .download-band { padding: clamp(48px, 7vw, 92px) 0; background: var(--band); color: var(--band-ink); }
    .band-inner { max-width: var(--max); margin: 0 auto; padding: 0 var(--gutter); }
    .band-head { margin-bottom: 32px; }
    h2 { margin: 0; font-size: clamp(30px, 3.8vw, 46px); line-height: 1.02; letter-spacing: -0.045em; }
    .band-head p { margin: 0; color: var(--band-muted); font-size: 15px; line-height: 1.6; }
    .platforms { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 0.9fr); gap: 16px; }
    .platform { display: flex; flex-direction: column; min-height: 230px; padding: clamp(22px, 3vw, 32px); background: var(--panel); }
    .platform:first-child { grid-row: span 2; min-height: 100%; }
    .platform h3 { margin: 0 0 12px; font-size: clamp(24px, 2.8vw, 36px); line-height: 1; letter-spacing: -0.045em; }
    .platform-file { margin: 0; color: var(--band-ink); font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
    .platform-meta { margin: 8px 0 0; color: var(--band-muted); font-size: 14px; }
    .platform .button { margin-top: auto; background: var(--band-ink); color: var(--band); }
    .platform .button:hover { background: #fff; }
    .platform-links { display: flex; flex-wrap: wrap; gap: 8px 18px; margin: 12px 0 0; color: var(--band-muted); font-size: 13px; }
    .platform-links a { color: var(--band-ink); }
    .band-foot { display: flex; flex-wrap: wrap; gap: 8px 18px; margin: 22px 0 0; color: var(--band-muted); font-size: 14px; }
    .band-foot a { color: var(--band-ink); }
    .fallback { padding: 28px; background: var(--panel); color: var(--band-ink); }
    .notes { display: grid; grid-template-columns: minmax(180px, 0.62fr) minmax(0, 1.38fr); gap: clamp(32px, 7vw, 96px); max-width: var(--max); margin: 0 auto; padding: clamp(64px, 9vw, 120px) var(--gutter); }
    .section-head p { max-width: 30ch; margin: 14px 0 0; color: var(--muted); font-size: 15px; line-height: 1.6; }
    .notes-body h3 { margin: 36px 0 12px; font-size: clamp(22px, 2.4vw, 30px); line-height: 1.15; letter-spacing: -0.03em; }
    .notes-body h3:first-child { margin-top: 0; }
    .notes-body h4 { margin: 28px 0 8px; font-size: 18px; line-height: 1.3; }
    .notes-body p { max-width: 68ch; margin: 0 0 14px; font-size: 16px; line-height: 1.65; }
    .notes-body ul, .notes-body ol { max-width: 68ch; margin: 0 0 18px; padding-left: 20px; }
    .notes-body li { margin: 0 0 8px; font-size: 16px; line-height: 1.65; }
    .notes-body li::marker { color: var(--accent); }
    .notes-body code { padding: 2px 5px; background: var(--tone); font-family: var(--mono); font-size: 0.88em; }
    .notes-empty { color: var(--muted); }
    .verify { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr); gap: clamp(32px, 6vw, 76px); max-width: var(--max); margin: 0 auto clamp(64px, 9vw, 116px); padding: clamp(28px, 4vw, 48px); background: var(--tone); }
    .verify h2 { font-size: clamp(28px, 3.4vw, 42px); }
    .verify h3 { margin: 0 0 10px; font-size: 20px; letter-spacing: -0.02em; }
    .verify p { margin: 0 0 14px; color: #494c53; font-size: 15px; line-height: 1.65; }
    .code-block { display: flex; flex-direction: column; align-items: flex-start; gap: 14px; margin: 18px 0; padding: 18px; background: var(--band); color: var(--band-ink); }
    .code-block pre { max-width: 100%; margin: 0; overflow: auto; }
    .code-block code { font-family: var(--mono); font-size: 13px; line-height: 1.6; white-space: pre; }
    .copy-button { min-height: 36px; padding: 7px 12px; border: 0; border-radius: 2px; background: var(--accent); color: #fff; font: inherit; font-size: 13px; cursor: pointer; }
    .copy-button:hover { background: var(--accent-strong); }
    [data-reveal] { opacity: 1; }
    [data-reveal].reveal { opacity: 0.001; transform: translateY(18px); transition: opacity 480ms ease, transform 480ms cubic-bezier(.2, .7, .2, 1); }
    [data-reveal].reveal.is-in { opacity: 1; transform: none; }
    @media (prefers-reduced-motion: reduce) { [data-reveal].reveal { opacity: 1; transform: none; transition: none; } }
    .text-link { color: #173fc8; font-weight: 600; }
    .verify > *, .notes > *, .notes-body, .code-block, .code-block pre, .platform, .platform-file { min-width: 0; }
    .code-block pre { max-width: 100%; }
    .all-files { padding-bottom: 24px; }
    .all-files details { padding: 0; }
    .all-files summary { color: var(--muted); font-size: 15px; font-weight: 600; cursor: pointer; }
    .all-files ul { columns: 2; column-gap: 32px; margin: 14px 0 0; padding: 0; list-style: none; }
    .all-files li { padding: 7px 0; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
    .site-foot { max-width: var(--max); margin: 0 auto; padding: clamp(36px, 6vw, 76px) var(--gutter) 44px; display: flex; align-items: end; justify-content: space-between; gap: 28px; }
    .foot-mark { margin: 0; font-size: 20px; line-height: 1; letter-spacing: -0.035em; font-weight: 700; }
    .foot-links { display: flex; flex-wrap: wrap; gap: 10px 20px; color: var(--muted); font-size: 14px; }
    .foot-links a { text-decoration: none; }
    .foot-links a:hover { color: var(--ink); }
    @media (max-width: 900px) {
      .hero { grid-template-columns: 1fr; }
      .hero-figure { grid-column: auto; grid-row: auto; max-width: 440px; }
      .hero-cta { grid-column: auto; grid-row: auto; margin-top: 0; }
      .band-head, .notes, .verify { grid-template-columns: 1fr; }
      .platforms { grid-template-columns: 1fr; }
      .platform:first-child { grid-row: auto; min-height: 230px; }
      .all-files ul { columns: 1; }
    }
    @media (max-width: 600px) {
      .site-head { padding-top: 20px; padding-bottom: 20px; }
      .site-nav { gap: 14px; font-size: 13px; }
      .site-version { display: none; }
      .hero { padding-top: 36px; padding-bottom: 56px; }
      .code-block { padding: 14px; }
      .code-block code { white-space: pre-wrap; overflow-wrap: anywhere; }
      h1 { max-width: none; }
      .hero-figure { max-width: none; }
      .site-foot { align-items: flex-start; flex-direction: column; }
    }
    @media (prefers-reduced-motion: no-preference) {
        @keyframes rise { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }
    }
  </style>
</head>
<body>
  <a class="skip" href="#download">跳到下载</a>
  <header class="site-head">
    <a class="wordmark" href="./"><span class="wordmark-mark" aria-hidden="true">N</span><span>NovaFlow</span></a>
    <nav class="site-nav" aria-label="页面导航">
      <a href="#download">下载</a>
      <a href="#notes">更新说明</a>
      <a href="#verify">校验</a>
      <a href="https://github.com/Prokint/NovaFlow" rel="noreferrer">GitHub</a>
    </nav>
    <span class="site-version">v${version}</span>
  </header>
  <main>
    <section class="hero">
      <div class="hero-copy">
        <h1>下载 NovaFlow</h1>
        <p class="lede">NovaFlow 是把想法变成桌面工作台的 AI 桌面端。选择你的平台，获取最新版 ${version}。</p>
      </div>
      <div class="hero-figure" aria-hidden="true">
        <span class="hero-version">${version}</span>
        <div class="hero-meta"><span>Windows</span><span>macOS</span><span>未签名构建</span></div>
      </div>
      <a class="button hero-cta" href="#download">选择平台下载</a>
    </section>
    <section class="download-band" id="download">
      <div class="band-inner">
        <div class="band-head" data-reveal>
          <h2>选择你的平台</h2>
        </div>
        <div class="platforms">
${platformList}
        </div>
        <p class="band-foot" data-reveal>未签名构建：Windows 可能触发 SmartScreen；macOS 首次启动需右键打开。<a href="#verify">查看安装与校验</a></p>
      </div>
    </section>
    <section class="notes" id="notes">
      <div class="section-head">
        <h2 data-reveal>更新说明</h2>
        <p>${version} 的主要变化与升级说明。</p>
      </div>
      <div class="notes-body" data-reveal>
${renderNotes(notes)}
      </div>
    </section>
    <section class="verify" id="verify">
      <div data-reveal>
        <h2>校验下载</h2>
        <p>下载完成后核对 SHA-256，确认文件没有在传输中损坏。SHA256SUMS 由发布流程生成。</p>
        <div class="code-block">
          <pre><code>${htmlEscape(copyCommand)}</code></pre>
          <button class="copy-button" type="button" data-copy="${htmlEscape(copyCommand)}">复制命令</button>
        </div>
        <p><a class="text-link" href="./SHA256SUMS">下载 SHA256SUMS</a></p>
      </div>
      <div data-reveal>
        <h3>未签名构建</h3>
        <p>Windows：SmartScreen 提示时选择“更多信息 → 仍要运行”。</p>
        <p>macOS：按住 Control 点按 NovaFlow，选择“打开”；如仍被拦截，到“系统设置 → 隐私与安全性”允许。</p>
        <p>Linux：AppImage 需先执行 <code>chmod +x</code>。</p>
      </div>
    </section>
  </main>
  <footer class="site-foot">
    <p class="foot-mark" data-reveal>NovaFlow</p>
    <div class="foot-links" data-reveal>
      <a href="https://github.com/Prokint/NovaFlow" rel="noreferrer">源码与历史版本</a>
      <a href="./${DESKTOP_RELEASE_FILE}">更新清单</a>
      <a href="./">更新源首页</a>
    </div>
  </footer>
  <script>
    const revealTargets = [...document.querySelectorAll('[data-reveal]')]
    if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.classList.add('is-in')
          observer.unobserve(entry.target)
        }
      }, { threshold: 0.12 })
      for (const target of revealTargets) {
        target.classList.add('reveal')
        observer.observe(target)
      }
    }
    for (const button of document.querySelectorAll('[data-copy]')) {
      button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(button.getAttribute('data-copy') ?? '')
          button.textContent = '已复制'
        } catch {
          button.textContent = '请手动复制'
        }
        setTimeout(() => { button.textContent = '复制命令' }, 1600)
      })
    }
  </script>
</body>
</html>
`
}

function sshArguments(sshKey, knownHosts) {
  const options = ['-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes']
  if (sshKey !== undefined) options.push('-o', `IdentityFile=${sshKey}`)
  if (knownHosts !== undefined) options.push('-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`)
  else options.push('-o', 'StrictHostKeyChecking=accept-new')
  return options
}

async function rsyncFiles(remote, files, sshKey, knownHosts) {
  if (files.length === 0) return
  await run('rsync', ['-az', '-e', ['ssh', ...sshArguments(sshKey, knownHosts)].join(' '), ...files, remote])
}

async function verifyPublished(feedUrl, release) {
  const base = new URL(feedUrl)
  const manifestUrl = new URL(DESKTOP_RELEASE_FILE, base).href
  const manifest = await fetch(manifestUrl, { headers: { accept: 'application/json', 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30_000) })
  if (!manifest.ok) throw new Error(`update feed: ${manifestUrl} answered ${String(manifest.status)}`)
  const published = await manifest.json()
  if (published.version !== release.version) {
    throw new Error(`update feed: ${manifestUrl} serves ${String(published.version)}, expected ${release.version}`)
  }
  for (const name of ['latest.yml', 'latest-mac.yml', 'index.html']) {
    const url = new URL(name, base).href
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`update feed: ${url} answered ${String(response.status)}`)
  }
  process.stdout.write(`update feed: verified ${release.version} at ${base.href}\n`)
}

/**
 * Upload one collected release directory and verify the published manifest.
 * @param {{ source: string, remote?: string, sshKey?: string, knownHosts?: string, feedUrl?: string, verify?: boolean }} request - Release directory, rsync destination, SSH key, known-hosts file, and verification target.
 * @returns {Promise<void>} Resolves after every file is uploaded and the feed reflects the release.
 */
export async function publishUpdateFeed({ source, remote = DESKTOP_UPDATE_DEFAULT_REMOTE, sshKey, knownHosts, feedUrl = DESKTOP_UPDATE_FEED_URL, verify = true }) {
  const directory = resolve(source)
  const release = JSON.parse(await readFile(join(directory, DESKTOP_RELEASE_FILE), 'utf8'))
  if (typeof release !== 'object' || release === null || typeof release.version !== 'string') {
    throw new Error(`update feed: ${join(directory, DESKTOP_RELEASE_FILE)} has no version`)
  }
  const names = (await readdir(directory)).sort()
  const installers = await Promise.all(names.filter(name => INSTALLER.test(name)).map(async name => ({
    name, size: (await stat(join(directory, name))).size,
  })))
  const payload = names.filter(name => !METADATA.test(name))
  const metadata = names.filter(name => METADATA.test(name))
  if (!metadata.includes(DESKTOP_RELEASE_FILE)) throw new Error(`update feed: ${DESKTOP_RELEASE_FILE} is missing from ${directory}`)

  const staging = await mkdtemp(join(tmpdir(), 'novaflow-update-feed-'))
  try {
    const page = join(staging, 'index.html')
    await writeFile(page, renderDownloadPage(release, installers))
    // Binaries first: the metadata must never point at a file the server does not serve yet.
    await rsyncFiles(remote, payload.map(name => join(directory, name)), sshKey, knownHosts)
    await rsyncFiles(remote, [...metadata.map(name => join(directory, name)), page], sshKey, knownHosts)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  if (verify) await verifyPublished(feedUrl, release)
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    source: { type: 'string' }, remote: { type: 'string' }, 'ssh-key': { type: 'string' },
    'known-hosts': { type: 'string' }, 'feed-url': { type: 'string' }, 'no-verify': { type: 'boolean' },
  } })
  if (values.source === undefined) throw new Error('update feed: expected --source <release directory>')
  const sshKey = values['ssh-key'] ?? process.env[DESKTOP_UPDATE_SSH_KEY_ENV]
  await publishUpdateFeed({
    source: values.source,
    remote: values.remote ?? process.env[DESKTOP_UPDATE_PUBLISH_REMOTE_ENV] ?? DESKTOP_UPDATE_DEFAULT_REMOTE,
    ...(sshKey === undefined ? {} : { sshKey: resolve(sshKey) }),
    ...(values['known-hosts'] === undefined ? {} : { knownHosts: resolve(values['known-hosts']) }),
    ...(values['feed-url'] === undefined ? {} : { feedUrl: values['feed-url'] }),
    verify: values['no-verify'] !== true,
  })
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main(process.argv.slice(2))
