/**
 * Gather one NovaFlow version's installers and update files into a release directory.
 *
 * Inputs are electron-builder output directories, or earlier collections, from separate runners.
 * Same-named macOS metadata from the arm64 and x64 runners is merged into one `latest-mac.yml`.
 * Every metadata file is verified against the collected installers before `SHA256SUMS` is written.
 * When release notes are supplied, `release.json` is written for the static update feed's download page.
 * Usage: `node collect-release-assets.mjs --version <version> --output <directory> [--release-notes <file>] [--page-url <url>] <input>...`.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DESKTOP_RELEASE_FILE, DESKTOP_UPDATE_PAGE_URL, mergeDesktopUpdateMetadata, verifyDesktopUpdateMetadata } from './desktop-update-feed.mjs'

/** Checksum listing written beside the collected assets. */
export const DESKTOP_RELEASE_CHECKSUMS = 'SHA256SUMS'

const METADATA = /^latest(?:-mac|-linux(?:-[a-z0-9]+)?)?\.yml$/u
const METADATA_PLATFORM = { 'latest.yml': 'win32', 'latest-mac.yml': 'darwin' }

function escape(text) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function httpsUrl(value, label) {
  let url
  try { url = new URL(value) }
  catch { throw new Error(`desktop release: ${label} must be an HTTPS URL`) }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error(`desktop release: ${label} must be an HTTPS URL`)
  }
  return url.href
}

/**
 * Collect, merge, verify, and checksum one version's release assets.
 * @param {{ version: string, inputs: readonly string[], output: string, releaseNotes?: string, pageUrl?: string }} request - Version, input directories, the empty output directory, and optional download-page notes.
 * @returns {Promise<string[]>} Collected asset names, sorted, ending with `SHA256SUMS`.
 */
export async function collectDesktopReleaseAssets({ version, inputs, output, releaseNotes, pageUrl }) {
  const installer = new RegExp(`^novaflow-${escape(version)}-(?:win|mac|linux)-[^/\\\\]+\\.(?:exe|dmg|zip|AppImage|deb)(?:\\.blockmap)?$`, 'u')
  const sourceArchive = new RegExp(`^novaflow-${escape(version)}-source\\.(?:zip|tar\\.gz)$`, 'u')
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length > 0) throw new Error(`desktop release: output directory ${output} is not empty`)
  const metadata = new Map()
  const copied = new Map()
  for (const input of inputs) {
    for (const entry of await readdir(input, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const source = join(input, entry.name)
      if (METADATA.test(entry.name)) {
        metadata.set(entry.name, [...metadata.get(entry.name) ?? [], await readFile(source, 'utf8')])
        continue
      }
      if (!installer.test(entry.name) && !sourceArchive.test(entry.name)) continue
      const digest = await sha256(source)
      const previous = copied.get(entry.name)
      if (previous !== undefined && previous !== digest) throw new Error(`desktop release: ${entry.name} differs between inputs`)
      if (previous === undefined) await copyFile(source, join(output, entry.name))
      copied.set(entry.name, digest)
    }
  }
  if (metadata.size === 0) throw new Error(`desktop release: no update metadata found for ${version}`)
  for (const [filename, documents] of metadata) {
    const unique = [...new Set(documents)]
    await writeFile(join(output, filename), unique.length === 1 ? unique[0] : mergeDesktopUpdateMetadata(unique))
    await verifyDesktopUpdateMetadata({ directory: output, filename, version, platform: METADATA_PLATFORM[filename] ?? 'linux' })
  }
  if (releaseNotes !== undefined) {
    const page = httpsUrl(pageUrl ?? DESKTOP_UPDATE_PAGE_URL, 'download page URL')
    const feed = { version, pageUrl: page, notes: releaseNotes }
    await writeFile(join(output, DESKTOP_RELEASE_FILE), `${JSON.stringify(feed, null, 2)}\n`)
  }
  const assets = (await readdir(output)).sort()
  for (const name of assets) {
    if (!(await stat(join(output, name))).isFile()) throw new Error(`desktop release: ${name} is not a file`)
  }
  const sums = await Promise.all(assets.map(async name => `${await sha256(join(output, name))}  ${name}\n`))
  await writeFile(join(output, DESKTOP_RELEASE_CHECKSUMS), sums.join(''))
  return [...assets, DESKTOP_RELEASE_CHECKSUMS]
}

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    version: { type: 'string' }, output: { type: 'string' },
    'release-notes': { type: 'string' }, 'page-url': { type: 'string' },
  } })
  if (!values.version || !values.output || positionals.length === 0) {
    throw new Error('desktop release: expected --version <version> --output <directory> <input>...')
  }
  const releaseNotes = values['release-notes'] === undefined ? undefined : await readFile(resolve(values['release-notes']), 'utf8')
  const assets = await collectDesktopReleaseAssets({
    version: values.version, output: resolve(values.output), inputs: positionals.map(input => resolve(input)),
    ...(releaseNotes === undefined ? {} : { releaseNotes }),
    ...(values['page-url'] === undefined ? {} : { pageUrl: values['page-url'] }),
  })
  process.stdout.write(`${assets.join('\n')}\n`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main(process.argv.slice(2))
