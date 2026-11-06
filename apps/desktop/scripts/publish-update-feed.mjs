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
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

/**
 * Render the download page from one release manifest.
 * @param {{ version: string, pageUrl: string, notes?: string }} release - Parsed `release.json`.
 * @param {readonly string[]} installers - Installer filenames served beside the page.
 * @returns {string} Complete HTML document.
 */
export function renderDownloadPage(release, installers) {
  const links = installers
    .map(name => `      <li><a href="./${htmlEscape(encodeURIComponent(name))}">${htmlEscape(name)}</a></li>`)
    .join('\n')
  const notes = typeof release.notes === 'string' ? release.notes.trim() : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NovaFlow ${htmlEscape(release.version)} 下载</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem auto; max-width: 46rem; padding: 0 1rem; line-height: 1.6; }
    h1 { font-size: 1.5rem; }
    code, a { overflow-wrap: anywhere; }
    pre { white-space: pre-wrap; background: #f4f4f5; padding: 1rem; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>NovaFlow ${htmlEscape(release.version)}</h1>
  <p>下载对应平台的安装包。macOS 构建未签名，首次启动请右键“打开”。</p>
  <ul>
${links}
  </ul>
  ${notes === '' ? '' : `<h2>更新内容</h2>\n  <pre>${htmlEscape(notes)}</pre>`}
  <p>更新源：<a href="./${DESKTOP_RELEASE_FILE}">${DESKTOP_RELEASE_FILE}</a></p>
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
  const installers = names.filter(name => INSTALLER.test(name))
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
