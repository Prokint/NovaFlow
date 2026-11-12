import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { NOVAFLOW_OPTIONAL_BUNDLES } from '@deepseek-ai/dsh-official-bundles'
import { exposeNovaFlowBundledPlugins, stageNovaFlowBundledPlugins } from '../scripts/novaflow-bundled-plugins.ts'
import {
  migrateNovaFlowBundledPlugins,
  NOVAFLOW_BUNDLED_PLUGINS,
  NOVAFLOW_BUNDLED_PLUGINS_FILE,
  NOVAFLOW_COMPAT_PLUGINS,
  NOVAFLOW_OPTIONAL_PLUGINS,
  readNovaFlowBundledPlugins,
} from '../src/novaflow/bundled-plugins.ts'
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

it('registers the optional Douyin bundle and keeps the built-in Skill Center out of the optional list', () => {
  expect(NOVAFLOW_OPTIONAL_BUNDLES).toContain('dsh-douyin-comments')
  expect(NOVAFLOW_OPTIONAL_BUNDLES).not.toContain('dsh-skill-explorer')
})

it('stages every reviewed bundle and compatibility package without running plugin code', () => {
  const root = fixture()
  stageNovaFlowBundledPlugins(sources, root)
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as TestManifest
  expect(manifest.dependencies).toEqual({ 'existing-core': 'file:./core.tgz',
    'dsh-douyin-comments': 'file:./third-party/dsh-douyin-comments',
    'dsh-comment-viewer': 'file:./third-party/dsh-comment-viewer',
    'dsh-skill-explorer': 'file:./third-party/dsh-skill-explorer' })
  for (const plugin of [...NOVAFLOW_BUNDLED_PLUGINS, ...NOVAFLOW_OPTIONAL_PLUGINS, ...NOVAFLOW_COMPAT_PLUGINS]) {
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
  const douyin = JSON.parse(readFileSync(join(root, 'third-party/dsh-douyin-comments/package.json'), 'utf8')) as {
    version: string
    dependencies: Record<string, string>
    exports: Record<string, string>
  }
  expect(douyin).toHaveProperty('version', '0.9.26')
  expect(douyin).toHaveProperty('dependencies.playwright-core', '^1.63.0')
  expect(douyin.exports['./viewer']).toBe('./viewer.mjs')
  expect(readFileSync(join(root, 'third-party/dsh-douyin-comments/NOTICE.txt'), 'utf8')).toContain('novaflow')
  expect(readFileSync(join(root, 'third-party/dsh-douyin-comments/core.enc'), 'utf8')).toContain('DYC-CORE-1')
  expect(readFileSync(join(root, 'third-party/dsh-douyin-comments/extension.enc'), 'utf8')).toContain('DYC-EXT-1')
})

it('exposes shipped bundles through the installation and preserves a user disabling one on a later launch', () => {
  const root = fixture()
  const runtime = join(root, 'runtime')
  const anchor = join(runtime, 'node_modules/@deepseek-ai/dsh/package.json')
  mkdirSync(resolve(anchor, '..'), { recursive: true })
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.3', dependencies: {} }))
  for (const plugin of [...NOVAFLOW_BUNDLED_PLUGINS, ...NOVAFLOW_OPTIONAL_PLUGINS, ...NOVAFLOW_COMPAT_PLUGINS]) {
    cpSync(join(sources, plugin.name), join(runtime, 'node_modules', plugin.name), { recursive: true })
  }
  const expected = Object.fromEntries([
    ...NOVAFLOW_BUNDLED_PLUGINS, ...NOVAFLOW_OPTIONAL_PLUGINS, ...NOVAFLOW_COMPAT_PLUGINS,
  ].map(p => [p.name, p.version]))
  expect(exposeNovaFlowBundledPlugins(runtime)).toEqual(expected)
  const names = readNovaFlowBundledPlugins(runtime)
  expect(names).toEqual(NOVAFLOW_BUNDLED_PLUGINS.map(plugin => plugin.name))
  expect(names).not.toContain('dsh-douyin-comments')
  const profile = join(root, 'profile')
  createPluginProfile(profile, names)
  const loaded = loadProfileDirectory('NovaFlow', profile, anchor)
  expect(loaded.layers.map(layer => layer.packageName)).toEqual(expect.arrayContaining([...names]))
  const filename = join(profile, 'package.json')
  const manifest = JSON.parse(readFileSync(filename, 'utf8')) as TestManifest
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name: string) => name !== 'dsh-skill-explorer')
  writeFileSync(filename, JSON.stringify(manifest))
  const before = readFileSync(filename, 'utf8')
  createPluginProfile(profile, names)
  expect(readFileSync(filename, 'utf8')).toBe(before)
  const active = loadProfileDirectory('NovaFlow', profile, anchor).layers.map(layer => layer.packageName)
  expect(active).not.toContain('dsh-skill-explorer')
  expect(active).not.toContain('dsh-douyin-comments')
  expect(JSON.parse(readFileSync(anchor, 'utf8'))).toHaveProperty('dependencies.dsh-skill-explorer', '0.1.2')
  expect(JSON.parse(readFileSync(anchor, 'utf8'))).toHaveProperty('dependencies.dsh-douyin-comments', '0.9.26')
  expect(JSON.parse(readFileSync(anchor, 'utf8'))).toHaveProperty('dependencies.dsh-comment-viewer', '0.2.16')
})

it('applies built-in defaults and drops the legacy standalone viewer when the merged collector is enabled', () => {
  const root = fixture()
  const profile = join(root, 'profile')
  mkdirSync(profile)
  const filename = join(profile, 'package.json')
  writeFileSync(filename, JSON.stringify({
    name: 'profile', dsh: { profile: { bundles: [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
      'dsh-douyin-comments', 'dsh-comment-viewer',
    ] } },
  }))
  migrateNovaFlowBundledPlugins(profile)
  expect(JSON.parse(readFileSync(filename, 'utf8'))).toHaveProperty('dsh.profile.bundles', [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-douyin-comments', 'dsh-skill-explorer',
  ])
  // A profile that only enabled the old viewer keeps it, and still receives the built-in bundle.
  writeFileSync(filename, JSON.stringify({
    name: 'profile', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-comment-viewer'] } },
  }))
  migrateNovaFlowBundledPlugins(profile)
  expect(JSON.parse(readFileSync(filename, 'utf8'))).toHaveProperty('dsh.profile.bundles', [
    '@deepseek-ai/dsh-base', 'dsh-comment-viewer', 'dsh-skill-explorer',
  ])
  // The optional Douyin bundle is not added by the migration.
  expect(JSON.parse(readFileSync(filename, 'utf8'))).toHaveProperty('dsh.profile.bundles', [
    '@deepseek-ai/dsh-base', 'dsh-comment-viewer', 'dsh-skill-explorer',
  ])
})

it('removes pre-entitlement profile copies so the shipped bundle cannot be shadowed', () => {
  const root = fixture()
  const profile = join(root, 'profile')
  const writeBundle = (name: string, version: string): void => {
    mkdirSync(join(profile, 'node_modules', name), { recursive: true })
    writeFileSync(join(profile, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }))
  }
  writeBundle('dsh-douyin-comments', '0.7.0')
  writeBundle('dsh-comment-viewer', '0.2.16')
  writeBundle('dsh-skill-explorer', '0.0.9')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'profile', dsh: { profile: { bundles: [] } } }))
  migrateNovaFlowBundledPlugins(profile)
  // Every shipped plugin is enforced, including the built-in bundles.
  expect(existsSync(join(profile, 'node_modules', 'dsh-douyin-comments'))).toBe(false)
  expect(existsSync(join(profile, 'node_modules', 'dsh-skill-explorer'))).toBe(false)
  expect(existsSync(join(profile, 'node_modules', 'dsh-comment-viewer'))).toBe(true)
  writeBundle('dsh-douyin-comments', '0.9.26')
  writeBundle('dsh-skill-explorer', '0.1.2')
  migrateNovaFlowBundledPlugins(profile)
  expect(existsSync(join(profile, 'node_modules', 'dsh-douyin-comments'))).toBe(true)
  expect(existsSync(join(profile, 'node_modules', 'dsh-skill-explorer'))).toBe(true)
})

it('keeps every shipped plugin list covered by the version enforcement', () => {
  // Guard the policy: adding a plugin to any shipped list without enforcement must fail here.
  const root = fixture()
  const profile = join(root, 'profile')
  const shipped = [...NOVAFLOW_BUNDLED_PLUGINS, ...NOVAFLOW_OPTIONAL_PLUGINS, ...NOVAFLOW_COMPAT_PLUGINS]
  for (const plugin of shipped) {
    mkdirSync(join(profile, 'node_modules', plugin.name), { recursive: true })
    writeFileSync(join(profile, 'node_modules', plugin.name, 'package.json'),
      JSON.stringify({ name: plugin.name, version: '0.0.1' }))
  }
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'profile', dsh: { profile: { bundles: [] } } }))
  migrateNovaFlowBundledPlugins(profile)
  for (const plugin of shipped) expect(existsSync(join(profile, 'node_modules', plugin.name))).toBe(false)
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
