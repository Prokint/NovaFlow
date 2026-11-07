import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { exposeNovaFlowBundledPlugins, stageNovaFlowBundledPlugins } from '../scripts/novaflow-bundled-plugins.ts'
import { NOVAFLOW_BUNDLED_PLUGINS, NOVAFLOW_BUNDLED_PLUGINS_FILE, readNovaFlowBundledPlugins } from '../src/novaflow/bundled-plugins.ts'
import { createPluginProfile } from '../src/project-manager.ts'

const sources = resolve(import.meta.dirname, '../third-party')

interface TestManifest {
  dependencies: Record<string, string>
  dsh: { profile: { bundles: string[] } }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'novaflow-bundled-plugins-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'runtime-test', dependencies: { 'existing-core': 'file:./core.tgz' } }))
  return root
}

it('stages every reviewed bundle and its dependency manifest without running plugin code', () => {
  const root = fixture()
  stageNovaFlowBundledPlugins(sources, root)
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as TestManifest
  expect(manifest.dependencies).toEqual({ 'existing-core': 'file:./core.tgz',
    'dsh-douyin-comments': 'file:./third-party/dsh-douyin-comments',
    'dsh-comment-viewer': 'file:./third-party/dsh-comment-viewer',
    'dsh-skill-explorer': 'file:./third-party/dsh-skill-explorer' })
  for (const plugin of NOVAFLOW_BUNDLED_PLUGINS) {
    const staged = join(root, 'third-party', plugin.name)
    expect(JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8'))).toMatchObject(plugin)
    expect(readFileSync(join(staged, 'cordis.patch.yml'), 'utf8')).toContain(plugin.name)
    const notice = readFileSync(join(staged, 'NOTICE.txt'), 'utf8')
    if (plugin.name === 'dsh-skill-explorer') {
      expect(notice).toContain('zhu1090093659/dsh-web')
      expect(notice).toContain('telemetry')
      expect(readFileSync(join(staged, 'lib/client.js'), 'utf8')).not.toMatch(/dsh-market\.com|reportDailyHeartbeat|telemetry-visitor/)
    } else {
      expect(notice).toContain('monagisa/douyin-ai-collector')
    }
  }
  expect(JSON.parse(readFileSync(join(root, 'third-party/dsh-douyin-comments/package.json'), 'utf8')))
    .toHaveProperty('dependencies.playwright-core', '^1.63.0')
})

it('exposes shipped bundles through the installation and preserves a user disabling one on a later launch', () => {
  const root = fixture()
  const runtime = join(root, 'runtime')
  const anchor = join(runtime, 'node_modules/@deepseek-ai/dsh/package.json')
  mkdirSync(resolve(anchor, '..'), { recursive: true })
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.3', dependencies: {} }))
  for (const plugin of NOVAFLOW_BUNDLED_PLUGINS) {
    cpSync(join(sources, plugin.name), join(runtime, 'node_modules', plugin.name), { recursive: true })
  }
  expect(exposeNovaFlowBundledPlugins(runtime)).toEqual(Object.fromEntries(NOVAFLOW_BUNDLED_PLUGINS.map(p => [p.name, p.version])))
  const names = readNovaFlowBundledPlugins(runtime)
  const profile = join(root, 'profile')
  createPluginProfile(profile, names)
  const loaded = loadProfileDirectory('NovaFlow', profile, anchor)
  expect(loaded.layers.map(layer => layer.packageName)).toEqual(expect.arrayContaining([...names]))
  const filename = join(profile, 'package.json')
  const manifest = JSON.parse(readFileSync(filename, 'utf8')) as TestManifest
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name: string) => name !== 'dsh-comment-viewer')
  writeFileSync(filename, JSON.stringify(manifest))
  const before = readFileSync(filename, 'utf8')
  createPluginProfile(profile, names)
  expect(readFileSync(filename, 'utf8')).toBe(before)
  const active = loadProfileDirectory('NovaFlow', profile, anchor).layers.map(layer => layer.packageName)
  expect(active).not.toContain('dsh-comment-viewer')
  expect(active).toContain('dsh-douyin-comments')
  expect(JSON.parse(readFileSync(anchor, 'utf8'))).toHaveProperty('dependencies.dsh-comment-viewer', '0.2.16')
})

it('leaves older runtimes unchanged and rejects an invalid shipped catalog or changed pinned source', () => {
  const root = fixture()
  expect(readNovaFlowBundledPlugins(root)).toEqual([])
  writeFileSync(join(root, NOVAFLOW_BUNDLED_PLUGINS_FILE), JSON.stringify({ schemaVersion: 1, plugins: [] }))
  expect(() => readNovaFlowBundledPlugins(root)).toThrow('invalid bundled plugin catalog')
  const badSource = join(root, 'source')
  const first = NOVAFLOW_BUNDLED_PLUGINS[0]
  mkdirSync(join(badSource, first.name), { recursive: true })
  writeFileSync(join(badSource, first.name, 'package.json'), JSON.stringify({ ...first, version: '99.0.0' }))
  expect(() => { stageNovaFlowBundledPlugins(badSource, root) }).toThrow('bundled plugin source does not match')
})
