/** Materialize reviewed third-party plugins through the desktop production dependency install. */
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NOVAFLOW_BUNDLED_PLUGINS, NOVAFLOW_BUNDLED_PLUGINS_FILE, NOVAFLOW_COMPAT_PLUGINS } from '../src/novaflow/bundled-plugins.ts'

function addDependencies(filename: string, dependencies: Readonly<Record<string, string>>): void {
  const manifest = JSON.parse(readFileSync(filename, 'utf8')) as { dependencies?: Record<string, string> }
  manifest.dependencies = { ...manifest.dependencies, ...dependencies }
  writeFileSync(filename, `${JSON.stringify(manifest, undefined, 2)}\n`)
}

/**
 * Stage pinned source packages before pnpm resolves their normal dependency graph.
 * @param sourceDirectory - Reviewed third-party source root.
 * @param projectDirectory - Disposable build project with its core package manifest already prepared.
 */
export function stageNovaFlowBundledPlugins(sourceDirectory: string, projectDirectory: string): void {
  const dependencies: Record<string, string> = {}
  for (const plugin of [...NOVAFLOW_BUNDLED_PLUGINS, ...NOVAFLOW_COMPAT_PLUGINS]) {
    const source = join(sourceDirectory, plugin.name)
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
    if (manifest.name !== plugin.name || manifest.version !== plugin.version) {
      throw new Error(`NovaFlow: bundled plugin source does not match ${plugin.name}@${plugin.version}`)
    }
    cpSync(source, join(projectDirectory, 'third-party', plugin.name), { recursive: true })
    dependencies[plugin.name] = `file:./third-party/${plugin.name}`
  }
  addDependencies(join(projectDirectory, 'package.json'), dependencies)
}

/**
 * Advertise the installed bundles to Plugin Manager and seal their first-use catalog.
 * @param runtimeDirectory - Materialized production runtime, before its integrity inventory is written.
 * @returns Versioned dependencies for the runtime's root manifest and shared-package inventory.
 */
export function exposeNovaFlowBundledPlugins(runtimeDirectory: string): Record<string, string> {
  const dependencies: Record<string, string> = {}
  for (const plugin of [...NOVAFLOW_BUNDLED_PLUGINS, ...NOVAFLOW_COMPAT_PLUGINS]) {
    const manifest = JSON.parse(readFileSync(join(runtimeDirectory, 'node_modules', plugin.name, 'package.json'), 'utf8')) as {
      name?: unknown
      version?: unknown
    }
    if (manifest.name !== plugin.name || manifest.version !== plugin.version) {
      throw new Error(`NovaFlow: installed bundle does not match ${plugin.name}@${plugin.version}`)
    }
    dependencies[plugin.name] = plugin.version
  }
  addDependencies(join(runtimeDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), dependencies)
  writeFileSync(join(runtimeDirectory, NOVAFLOW_BUNDLED_PLUGINS_FILE),
    `${JSON.stringify({ schemaVersion: 1, plugins: NOVAFLOW_BUNDLED_PLUGINS }, undefined, 2)}\n`)
  return dependencies
}
