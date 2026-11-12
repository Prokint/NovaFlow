/** Third-party bundles shipped in NovaFlow, independently switchable in each profile. */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Built-in bundles enabled for every account, without a plugin-page switch. */
export const NOVAFLOW_BUNDLED_PLUGINS = [
  { name: 'dsh-skill-explorer', version: '0.1.2' },
] as const

/** Shipped bundles installed with NovaFlow but switched off until the user enables them. */
export const NOVAFLOW_OPTIONAL_PLUGINS = [
  { name: 'dsh-douyin-comments', version: '0.9.26' },
] as const

/** Installed only so profiles created before the merged Douyin bundle still load their old bundles. */
export const NOVAFLOW_COMPAT_PLUGINS = [
  { name: 'dsh-comment-viewer', version: '0.2.16' },
] as const

/** Immutable runtime catalog; absence identifies older builds without shipped third-party bundles. */
export const NOVAFLOW_BUNDLED_PLUGINS_FILE = 'novaflow-plugins.json'

/** Old standalone viewer bundle replaced by the merged viewer inside dsh-douyin-comments. */
const LEGACY_VIEWER_BUNDLE = 'dsh-comment-viewer'


/** Every plugin shipped inside NovaFlow, enforced at the same version as the runtime copy. */
const SHIPPED_PLUGINS = [
  ...NOVAFLOW_BUNDLED_PLUGINS,
  ...NOVAFLOW_OPTIONAL_PLUGINS,
  ...NOVAFLOW_COMPAT_PLUGINS,
] as const

/** Compare dotted numeric versions; prerelease suffixes sort before the matching release. */
function compareVersions(left: string, right: string): number | undefined {
  const parse = (text: string): { parts: number[]; prerelease: boolean } | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(text)
    return match === null ? undefined : { parts: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: text.includes('-') }
  }
  const a = parse(left)
  const b = parse(right)
  if (a === undefined || b === undefined) return undefined
  for (let index = 0; index < 3; index++) {
    const difference = (a.parts[index] ?? 0) - (b.parts[index] ?? 0)
    if (difference !== 0) return difference
  }
  if (a.prerelease === b.prerelease) return 0
  return a.prerelease ? -1 : 1
}

/**
 * Remove user-installed copies of shipped bundles older than the bundled release. A profile-level
 * install shadows the runtime copy, so a pre-entitlement Douyin plugin would bypass the
 * subscription gate that the shipped build enforces. Every shipped plugin is enforced, not just
 * the ones that carry licensing.
 * @param profileDirectory - Profile whose `node_modules` may shadow a shipped bundle.
 */
export function enforceShippedPluginBundleVersions(profileDirectory: string): void {
  for (const plugin of SHIPPED_PLUGINS) {
    const directory = join(profileDirectory, 'node_modules', plugin.name)
    const manifest = join(directory, 'package.json')
    if (!existsSync(manifest)) continue
    let installed = ''
    try {
      const value: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
      if (typeof value === 'object' && value !== null && 'version' in value && typeof value.version === 'string') installed = value.version
    } catch {
      continue
    }
    if ((compareVersions(installed, plugin.version) ?? 0) < 0) rmSync(directory, { recursive: true, force: true })
  }
}

/** Bundle that contains the merged collector and viewer. */
const MERGED_DOUYIN_BUNDLE = 'dsh-douyin-comments'

/**
 * Bring an existing profile onto the current shipped defaults: built-in bundles are always
 * enabled, a merged Douyin bundle removes the redundant standalone viewer, and a profile-level
 * copy of a shipped bundle older than the bundled release is removed so it cannot shadow the
 * shipped build. The optional Douyin bundle is deliberately not selected here; the plugin page
 * owns that choice.
 * @param profileDirectory - Profile whose package.json carries the bundle list.
 */
export function migrateNovaFlowBundledPlugins(profileDirectory: string): void {
  enforceShippedPluginBundleVersions(profileDirectory)
  const filename = join(profileDirectory, 'package.json')
  if (!existsSync(filename)) return
  let value: unknown
  try { value = JSON.parse(readFileSync(filename, 'utf8')) } catch { return }
  if (typeof value !== 'object' || value === null || !('dsh' in value)
    || typeof value.dsh !== 'object' || value.dsh === null || !('profile' in value.dsh)
    || typeof value.dsh.profile !== 'object' || value.dsh.profile === null || !('bundles' in value.dsh.profile)
    || !Array.isArray(value.dsh.profile.bundles)) return
  const bundles = value.dsh.profile.bundles
  let changed = false
  for (const plugin of NOVAFLOW_BUNDLED_PLUGINS) {
    if (!bundles.includes(plugin.name)) {
      bundles.push(plugin.name)
      changed = true
    }
  }
  if (bundles.includes(MERGED_DOUYIN_BUNDLE) && bundles.includes(LEGACY_VIEWER_BUNDLE)) {
    value.dsh.profile.bundles = bundles.filter(name => name !== LEGACY_VIEWER_BUNDLE)
    changed = true
  }
  if (changed) writeFileSync(filename, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 })
}

/**
 * Read the shipped catalog without importing third-party code.
 * @param runtimeDirectory - Verified desktop runtime directory.
 * @returns Built-in bundle names, or an empty list for builds without the catalog.
 * @throws When an existing catalog does not identify the reviewed packages.
 */
export function readNovaFlowBundledPlugins(runtimeDirectory: string): readonly string[] {
  const filename = join(runtimeDirectory, NOVAFLOW_BUNDLED_PLUGINS_FILE)
  if (!existsSync(filename)) return []
  const value: unknown = JSON.parse(readFileSync(filename, 'utf8'))
  if (typeof value !== 'object' || value === null || !('schemaVersion' in value) || value.schemaVersion !== 1
    || !('plugins' in value) || !Array.isArray(value.plugins)) {
    throw new Error('NovaFlow: invalid bundled plugin catalog')
  }
  const plugins = value.plugins
  if (plugins.length !== NOVAFLOW_BUNDLED_PLUGINS.length
    || !NOVAFLOW_BUNDLED_PLUGINS.every(expected => plugins.some((entry: unknown) =>
      typeof entry === 'object' && entry !== null && 'name' in entry && entry.name === expected.name
      && 'version' in entry && entry.version === expected.version))) {
    throw new Error('NovaFlow: invalid bundled plugin catalog')
  }
  return NOVAFLOW_BUNDLED_PLUGINS.map(plugin => plugin.name)
}
