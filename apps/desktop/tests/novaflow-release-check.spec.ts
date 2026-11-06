import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  checkNovaFlowRelease, compareVersions, fetchNovaFlowReleaseNotes, NOVAFLOW_RELEASE_FILE, NOVAFLOW_UPDATE_FEED_URL,
  parseRelease, ReleaseNoticeState, releaseNotesText,
} from '../src/novaflow/release-check.ts'

const feedRelease = (version: string, notes = '') => ({ version, pageUrl: 'https://updates.lanjiaotrade.com/', notes })
const releaseUrl = new URL(NOVAFLOW_RELEASE_FILE, NOVAFLOW_UPDATE_FEED_URL).href

describe('NovaFlow release check', () => {
  it('reads the feed served from the update host', () => {
    expect(NOVAFLOW_UPDATE_FEED_URL).toBe('https://updates.lanjiaotrade.com/')
    expect(NOVAFLOW_RELEASE_FILE).toBe('release.json')
    expect(releaseUrl).toBe('https://updates.lanjiaotrade.com/release.json')
    expect(parseRelease(feedRelease('0.0.2'))).toMatchObject({ version: '0.0.2', url: 'https://updates.lanjiaotrade.com/' })
  })

  it('orders versions by SemVer precedence', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.1.0', '0.1.0-beta.2')).toBe(1)
    expect(compareVersions('0.1.0-beta.10', '0.1.0-beta.2')).toBe(1)
    expect(compareVersions('0.1.0-beta', '0.1.0-beta.1')).toBe(-1)
    expect(compareVersions('1.0.0+build.7', '1.0.0')).toBe(0)
    expect(() => compareVersions('1.0', '1.0.0')).toThrow('invalid version')
  })

  it('accepts one feed release document and rejects other payloads', () => {
    expect(parseRelease({ version: '0.0.1', pageUrl: 'https://updates.lanjiaotrade.com/', notes: '- one' }))
      .toEqual({ version: '0.0.1', url: 'https://updates.lanjiaotrade.com/', notes: '• one' })
    expect(parseRelease({ version: '0.2.0', pageUrl: 'https://updates.lanjiaotrade.com/' }))
      .toEqual({ version: '0.2.0', url: 'https://updates.lanjiaotrade.com/', notes: '' })
    expect(() => parseRelease({ version: '0.2.0', pageUrl: 'http://updates.lanjiaotrade.com/' })).toThrow('unexpected release page')
    expect(() => parseRelease({ version: '0.2.0', pageUrl: 'https://user:secret@updates.lanjiaotrade.com/' })).toThrow('unexpected release page')
    expect(() => parseRelease({ version: '0.2.0', pageUrl: 'https://updates.lanjiaotrade.com/', notes: 1 })).toThrow('unexpected release notes')
    expect(() => parseRelease({ version: 'v0.2.0', pageUrl: 'https://updates.lanjiaotrade.com/' })).toThrow('unexpected version')
    expect(() => parseRelease(null)).toThrow('invalid response')
  })

  it('reports a newer release, the current build, and a feed without a release document', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(feedRelease('0.2.0')))
      .mockResolvedValueOnce(Response.json(feedRelease('0.1.0')))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    const signal = new AbortController().signal
    await expect(checkNovaFlowRelease('0.1.0', fetcher, signal))
      .resolves.toEqual({ status: 'newer', version: '0.2.0', url: 'https://updates.lanjiaotrade.com/', notes: '' })
    await expect(checkNovaFlowRelease('0.1.0', fetcher, signal)).resolves.toEqual({ status: 'current', version: '0.1.0' })
    await expect(checkNovaFlowRelease('0.1.0', fetcher, signal)).resolves.toEqual({ status: 'current', version: '0.1.0' })
    await expect(checkNovaFlowRelease('0.1.0', fetcher, signal)).rejects.toThrow('feed answered 503')
    expect(fetcher.mock.calls[0]?.[0]).toBe(releaseUrl)
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', signal })
  })

  it('shows release notes as plain text and drops the download-page install instructions', () => {
    const body = '## 0.2.0\r\n\r\n### 新增\r\n- **侧栏**账号入口，见 [说明](https://example.com)\r\n* `检查更新` 显示日志\r\n\r\n\r\n\r\n'
      + '<!-- comment -->\n<!-- novaflow:install-notes -->\n## 安装\nxattr -dr'
    expect(releaseNotesText(body)).toBe('0.2.0\n\n新增\n• 侧栏账号入口，见 说明\n• 检查更新 显示日志')
    expect(releaseNotesText('x'.repeat(5000))).toHaveLength(4001)
    expect(releaseNotesText('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>')
  })

  it('reads the notes of the offered release only', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(feedRelease('0.2.0', '- 修复')))
      .mockResolvedValueOnce(Response.json(feedRelease('0.3.0', '- 其他')))
    const signal = new AbortController().signal
    await expect(fetchNovaFlowReleaseNotes('0.2.0', fetcher, signal)).resolves.toBe('• 修复')
    expect(fetcher.mock.calls[0]?.[0]).toBe(releaseUrl)
    await expect(fetchNovaFlowReleaseNotes('0.2.0', fetcher, signal)).rejects.toThrow('another release')
    await expect(fetchNovaFlowReleaseNotes('../x', fetcher, signal)).rejects.toThrow('invalid version')
  })

  it('reports feed failures instead of notes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('offline', { status: 502 }))
    await expect(fetchNovaFlowReleaseNotes('0.2.0', fetcher, new AbortController().signal)).rejects.toThrow('feed answered 502')
  })

  it('remembers only the release postponed from an automatic prompt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'novaflow-release-'))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const file = join(directory, 'novaflow-release.json')
    expect(ReleaseNoticeState.load(file).dismissed).toBeUndefined()
    ReleaseNoticeState.load(file).dismiss('0.2.0')
    expect(ReleaseNoticeState.load(file).dismissed).toBe('0.2.0')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ dismissedVersion: '0.2.0' })
  })
})
