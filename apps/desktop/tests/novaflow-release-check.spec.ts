import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  checkNovaFlowRelease, compareVersions, fetchNovaFlowReleaseNotes, NOVAFLOW_LATEST_RELEASE_API, NOVAFLOW_RELEASES_URL,
  parseRelease, ReleaseNoticeState, releaseNotesText,
} from '../src/novaflow/release-check.ts'

const release = (tag: string, body = '') => ({ tag_name: tag, html_url: `${NOVAFLOW_RELEASES_URL}/tag/${tag}`, body })

describe('NovaFlow release check', () => {
  it('uses the renamed repository for release checks and release-page validation', () => {
    expect(NOVAFLOW_RELEASES_URL).toBe('https://github.com/Prokint/NovaFlow/releases')
    expect(NOVAFLOW_LATEST_RELEASE_API).toBe('https://api.github.com/repos/Prokint/NovaFlow/releases/latest')
    expect(parseRelease({ tag_name: 'v0.0.2', html_url: 'https://github.com/Prokint/NovaFlow/releases/tag/v0.0.2', body: '' }))
      .toMatchObject({ version: '0.0.2' })
  })
  it('orders versions by SemVer precedence', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.1.0', '0.1.0-beta.2')).toBe(1)
    expect(compareVersions('0.1.0-beta.10', '0.1.0-beta.2')).toBe(1)
    expect(compareVersions('0.1.0-beta', '0.1.0-beta.1')).toBe(-1)
    expect(compareVersions('1.0.0+build.7', '1.0.0')).toBe(0)
    expect(() => compareVersions('1.0', '1.0.0')).toThrow('invalid version')
  })

  it('accepts this repository with v tags and legacy novaflow-v tags', () => {
    expect(parseRelease(release('v0.0.1', '- one'))).toEqual({ version: '0.0.1', url: `${NOVAFLOW_RELEASES_URL}/tag/v0.0.1`, notes: '• one' })
    expect(parseRelease(release('novaflow-v0.2.0', '- one'))).toEqual({ version: '0.2.0', url: `${NOVAFLOW_RELEASES_URL}/tag/novaflow-v0.2.0`, notes: '• one' })
    expect(() => parseRelease(release('dsh-v0.2.1-alpha.1'))).toThrow('unexpected release tag')
    expect(() => parseRelease({ ...release('novaflow-v0.2.0'), html_url: 'https://evil.example/releases/x' })).toThrow('unexpected release page')
    expect(() => parseRelease(null)).toThrow('invalid response')
  })

  it('reports a newer stable release, the current build, and a repository without releases', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(release('novaflow-v0.2.0')))
      .mockResolvedValueOnce(Response.json(release('novaflow-v0.1.0')))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('rate limited', { status: 403 }))
    const signal = new AbortController().signal
    await expect(checkNovaFlowRelease('0.1.0', fetcher, signal))
      .resolves.toEqual({ status: 'newer', version: '0.2.0', url: `${NOVAFLOW_RELEASES_URL}/tag/novaflow-v0.2.0`, notes: '' })
    await expect(checkNovaFlowRelease('0.1.0', fetcher, signal)).resolves.toEqual({ status: 'current', version: '0.1.0' })
    await expect(checkNovaFlowRelease('0.1.0', fetcher, signal)).resolves.toEqual({ status: 'current', version: '0.1.0' })
    await expect(checkNovaFlowRelease('0.1.0', fetcher, signal)).rejects.toThrow('GitHub answered 403')
    expect(fetcher.mock.calls[0]?.[0]).toBe(NOVAFLOW_LATEST_RELEASE_API)
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
      .mockResolvedValueOnce(Response.json(release('novaflow-v0.2.0', '- 修复')))
      .mockResolvedValueOnce(Response.json(release('novaflow-v0.3.0', '- 其他')))
    const signal = new AbortController().signal
    await expect(fetchNovaFlowReleaseNotes('0.2.0', fetcher, signal)).resolves.toBe('• 修复')
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/Prokint/NovaFlow/releases/tags/v0.2.0')
    await expect(fetchNovaFlowReleaseNotes('0.2.0', fetcher, signal)).rejects.toThrow('another release')
    await expect(fetchNovaFlowReleaseNotes('../x', fetcher, signal)).rejects.toThrow('invalid version')
  })

  it('falls back to a legacy tag only when the v tag is absent', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json(release('novaflow-v0.2.0', '- legacy')))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
    const signal = new AbortController().signal
    await expect(fetchNovaFlowReleaseNotes('0.2.0', fetcher, signal)).resolves.toBe('• legacy')
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://api.github.com/repos/Prokint/NovaFlow/releases/tags/novaflow-v0.2.0')
    await expect(fetchNovaFlowReleaseNotes('0.2.0', fetcher, signal)).rejects.toThrow('GitHub answered 403')
    expect(fetcher).toHaveBeenCalledTimes(3)
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
