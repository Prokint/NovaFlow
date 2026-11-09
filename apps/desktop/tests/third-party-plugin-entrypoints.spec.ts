/** Every shipped third-party plugin must carry the entry points its manifest declares. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import {
  NOVAFLOW_BUNDLED_PLUGINS,
  NOVAFLOW_COMPAT_PLUGINS,
  NOVAFLOW_OPTIONAL_PLUGINS,
} from '../src/novaflow/bundled-plugins.ts'

const thirdParty = fileURLToPath(new URL('../third-party/', import.meta.url))

/**
 * Read one manifest's declared runtime entry point.
 * @param directory - Reviewed plugin source directory.
 * @returns Manifest and the relative main entry, or undefined without one.
 */
function readManifest(directory: string): { main: string | undefined; clientEntry: string | undefined } {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
    main?: unknown
    exports?: Record<string, unknown>
  }
  const client = manifest.exports?.['./client']
  return {
    main: typeof manifest.main === 'string' ? manifest.main : undefined,
    clientEntry: typeof client === 'object' && client !== null && 'default' in client
      && typeof client.default === 'string' ? client.default : undefined,
  }
}

it.each([...NOVAFLOW_BUNDLED_PLUGINS, ...NOVAFLOW_OPTIONAL_PLUGINS, ...NOVAFLOW_COMPAT_PLUGINS])(
  'ships the entry points declared by $name', (plugin) => {
    const directory = join(thirdParty, plugin.name)
    const manifest = readManifest(directory)
    // The 0.2.5 release shipped this plugin without lib/ because .gitignore hid the build output, so the
    // profile failed to load it and the sidebar never appeared. Missing entries must fail here instead.
    expect(manifest.main, `${plugin.name} declares no main entry`).toBeDefined()
    expect(existsSync(join(directory, manifest.main!)), `${plugin.name} main ${manifest.main} is missing`).toBe(true)
    if (manifest.clientEntry !== undefined) {
      expect(existsSync(join(directory, manifest.clientEntry)),
        `${plugin.name} client entry ${manifest.clientEntry} is missing`).toBe(true)
    }
  })
