/** Read the newest release from the self-hosted update feed; builds that cannot install in place open its download page. */

import { readFileSync, writeFileSync } from 'node:fs'

/** Public HTTPS directory that serves the update feed and installers. */
export const NOVAFLOW_UPDATE_FEED_URL = 'https://updates.lanjiaotrade.com/'

/** Feed document with the newest version, its download page, and release notes. */
export const NOVAFLOW_RELEASE_FILE = 'release.json'

/** Release-body marker before the installation instructions appended for the download page. */
export const RELEASE_INSTALL_NOTES_MARKER = '<!-- novaflow:install-notes -->'

/** Longest changelog excerpt shown in a native dialog; the download page carries the rest. */
const MAX_NOTES_CHARS = 4000

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/u

/** Outcome of comparing the running version with the newest feed release. */
export type NovaFlowReleaseCheck =
  | { readonly status: 'newer'; readonly version: string; readonly url: string; readonly notes: string }
  | { readonly status: 'current'; readonly version: string }

interface ParsedVersion {
  readonly core: readonly [number, number, number]
  readonly prerelease: readonly string[]
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = SEMVER.exec(version)
  if (match === null) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left)
  const rightNumeric = /^\d+$/u.test(right)
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right))
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Order two semantic versions by SemVer 2.0 precedence; build metadata is ignored.
 * @param left - First version.
 * @param right - Second version.
 * @returns Negative, zero or positive like a sort comparator.
 * @throws when either value is not a semantic version.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) throw new Error(`novaflow release: invalid version ${JSON.stringify(a === undefined ? left : right)}`)
  const core = Math.sign(a.core[0] - b.core[0] || a.core[1] - b.core[1] || a.core[2] - b.core[2])
  if (core !== 0) return core
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return Math.sign(b.prerelease.length - a.prerelease.length)
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index]
    const right = b.prerelease[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const order = compareIdentifier(left, right)
    if (order !== 0) return order
  }
  return 0
}

/**
 * Turn release notes (Markdown) into plain text for a native dialog; nothing is rendered as markup.
 * Installation instructions after {@link RELEASE_INSTALL_NOTES_MARKER} belong to the download page and are dropped.
 * @param body - Release notes as the feed stores them.
 * @returns Readable notes, possibly empty, capped at a dialog-sized excerpt.
 */
export function releaseNotesText(body: string): string {
  const markerAt = body.indexOf(RELEASE_INSTALL_NOTES_MARKER)
  const text = (markerAt === -1 ? body : body.slice(0, markerAt))
    .replace(/\r\n?/gu, '\n')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/^(\s*)[-*+]\s+/gmu, '$1• ')
    .replace(/(\*\*|__)(.+?)\1/gu, '$2')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  return text.length > MAX_NOTES_CHARS ? `${text.slice(0, MAX_NOTES_CHARS).trimEnd()}…` : text
}

/**
 * Validate one `release.json` feed document.
 * @param value - Parsed JSON body.
 * @returns The release version, its HTTPS download page, and its notes as plain text.
 * @throws for any other shape, an invalid version, or a non-HTTPS page.
 */
export function parseRelease(value: unknown): { version: string; url: string; notes: string } {
  if (typeof value !== 'object' || value === null) throw new Error('novaflow release: invalid response')
  const version: unknown = Reflect.get(value, 'version')
  const pageUrl: unknown = Reflect.get(value, 'pageUrl')
  const notes: unknown = Reflect.get(value, 'notes')
  if (typeof version !== 'string' || parseVersion(version) === undefined) throw new Error('novaflow release: unexpected version')
  if (typeof pageUrl !== 'string') throw new Error('novaflow release: unexpected release page')
  let page: URL
  try {
    page = new URL(pageUrl)
  } catch (_pageError) {
    throw new Error('novaflow release: unexpected release page')
  }
  if (page.protocol !== 'https:' || page.username !== '' || page.password !== '') {
    throw new Error('novaflow release: unexpected release page')
  }
  if (notes !== undefined && typeof notes !== 'string') throw new Error('novaflow release: unexpected release notes')
  return { version, url: page.href, notes: notes === undefined ? '' : releaseNotesText(notes) }
}

const FEED_HEADERS = { accept: 'application/json', 'user-agent': 'NovaFlow-Desktop' }

function releaseUrl(): string {
  return new URL(NOVAFLOW_RELEASE_FILE, NOVAFLOW_UPDATE_FEED_URL).href
}

async function fetchRelease(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<Response> {
  return fetcher(releaseUrl(), { headers: FEED_HEADERS, redirect: 'error', signal })
}

/**
 * Ask the update feed for the newest release and compare it with the running version.
 * @param currentVersion - The running application's semantic version.
 * @param fetcher - Network fetch; the main process passes Electron's `net.fetch` so system proxies apply.
 * @param signal - Cancellation and timeout.
 * @returns Whether a newer release exists, with its notes and download page.
 */
export async function checkNovaFlowRelease(
  currentVersion: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<NovaFlowReleaseCheck> {
  const response = await fetchRelease(fetcher, signal)
  // Nothing published to a feed that exists but has no release yet: the running build is the newest one available.
  if (response.status === 404) return { status: 'current', version: currentVersion }
  if (!response.ok) throw new Error(`novaflow release: feed answered ${String(response.status)}`)
  const latest = parseRelease(await response.json())
  return compareVersions(latest.version, currentVersion) > 0
    ? { status: 'newer', ...latest }
    : { status: 'current', version: currentVersion }
}

/**
 * Read the notes of the newest published release, for the in-app update confirmation.
 * @param version - Version shown in the download confirmation.
 * @param fetcher - Network fetch.
 * @param signal - Cancellation and timeout.
 * @returns Plain-text notes; empty when the release has none.
 * @throws when the feed cannot be read or the notes belong to another release.
 */
export async function fetchNovaFlowReleaseNotes(
  version: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<string> {
  if (parseVersion(version) === undefined) throw new Error(`novaflow release: invalid version ${JSON.stringify(version)}`)
  const response = await fetchRelease(fetcher, signal)
  if (!response.ok) throw new Error(`novaflow release: feed answered ${String(response.status)}`)
  const release = parseRelease(await response.json())
  if (release.version !== version) throw new Error('novaflow release: notes belong to another release')
  return release.notes
}

/** Remembers the release a user postponed from an automatic prompt; manual checks always report. */
export class ReleaseNoticeState {
  private dismissedVersion: string | undefined

  private constructor(private readonly file: string, dismissed: string | undefined) {
    this.dismissedVersion = dismissed
  }

  /**
   * Load the postponed version; a missing or unreadable file means nothing was postponed.
   * @param file - Private JSON file under the application's user-data directory.
   * @returns The state bound to that file.
   */
  static load(file: string): ReleaseNoticeState {
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
      const dismissed: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'dismissedVersion') : undefined
      return new ReleaseNoticeState(file, typeof dismissed === 'string' ? dismissed : undefined)
    } catch (_readError) {
      return new ReleaseNoticeState(file, undefined)
    }
  }

  /** The release the user last postponed, if any. */
  get dismissed(): string | undefined { return this.dismissedVersion }

  /**
   * Stop prompting automatically for one release; a later release prompts again.
   * @param version - The postponed release version.
   */
  dismiss(version: string): void {
    this.dismissedVersion = version
    try { writeFileSync(this.file, `${JSON.stringify({ dismissedVersion: version })}\n`, { mode: 0o600 }) }
    catch (_writeError) { /* Losing the preference only means one more prompt next launch. */ }
  }
}
