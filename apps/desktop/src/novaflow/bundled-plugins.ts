/** Third-party bundles shipped in NovaFlow, independently switchable in each profile. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Reviewed upstream package identities carried by the desktop installer. */
export const NOVAFLOW_BUNDLED_PLUGINS = [
  { name: 'dsh-douyin-comments', version: '0.5.62' },
  { name: 'dsh-comment-viewer', version: '0.2.16' },
  { name: 'dsh-skill-explorer', version: '0.1.0' },
] as const

/** Immutable runtime catalog; absence identifies older builds without shipped third-party bundles. */
export const NOVAFLOW_BUNDLED_PLUGINS_FILE = 'novaflow-plugins.json'

/**
 * Read the shipped catalog without importing third-party code.
 * @param runtimeDirectory - Verified desktop runtime directory.
 * @returns Initial bundle names, or an empty list for builds without the catalog.
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
