/** DeepSeek-hosted services in the shipped NovaFlow Desktop composition. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { composeEntries, loadOptionalPatches, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { createPluginProfile } from '../src/project-manager.ts'

interface Row { id?: string; name?: string; disabled?: boolean | null; group?: boolean; config?: unknown }

/** Packages that talk to DeepSeek or only serve its disabled routes; none may mount in NovaFlow. */
const DEEPSEEK_SERVICES = [
  '@deepseek-ai/dsh-deepseek-account-platform', '@deepseek-ai/dsh-llm-deepseek-api-key', '@deepseek-ai/dsh-llm-deepseek-account',
  '@deepseek-ai/dsh-session-telemetry-otel', '@deepseek-ai/dsh-host-product-telemetry-otel', '@deepseek-ai/dsh-client-product-analytics',
  '@deepseek-ai/dsh-message-feedback', '@deepseek-ai/dsh-client-ui-message-feedback', '@deepseek-ai/dsh-command-feedback',
  '@deepseek-ai/dsh-session-log-deepseek', '@deepseek-ai/dsh-client-ui-settings-session-log',
  '@deepseek-ai/dsh-deepseek-llm-api-extensions', '@deepseek-ai/dsh-plugin-package-inventory-deepseek',
  '@deepseek-ai/dsh-web-search-deepseek', '@deepseek-ai/dsh-web-deepseek-api', '@deepseek-ai/dsh-client-ui-settings-web-search',
  '@deepseek-ai/dsh-client-ui-settings-account',
]

function flatten(rows: readonly Row[]): Row[] {
  return rows.flatMap(row => [row, ...row.group === true && Array.isArray(row.config) ? flatten(row.config as Row[]) : []])
}

it('mounts no DeepSeek-hosted service, keeps web search off DeepSeek and drops the DeepSeek prompt sections', () => {
  const home = mkdtempSync(join(tmpdir(), 'novaflow-desktop-profile-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    createPluginProfile(profileDir)
    const installAnchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
    const profile = loadProfileDirectory('dsh desktop', profileDir, installAnchor)
    const overlay = loadOptionalPatches('dsh desktop', fileURLToPath(new URL('../../desktop-host/src/novaflow.patch.yml', import.meta.url))) ?? []
    const warnings: string[] = []
    const rows = flatten(composeEntries([...profile.layers.map(layer => layer.patches), profile.patches, overlay],
      message => warnings.push(message)) as Row[])

    expect(warnings).toEqual([])
    const mounted = rows.filter(row => row.name !== undefined && DEEPSEEK_SERVICES.includes(row.name) && row.disabled !== true)
    expect(mounted.map(row => row.id)).toEqual([])
    for (const name of DEEPSEEK_SERVICES) expect(rows.some(row => row.name === name), name).toBe(true)
    expect(rows.find(row => row.id === 'web')?.config).toEqual({ fetchProvider: 'http' })
    expect(rows.find(row => row.id === 'system-prompt')?.config).toEqual({
      includeHarnessIdentity: false,
      personaPrefix: 'You are a coding agent powered by the {{model}} model.',
      personaSuffix: 'Your working directory is {{cwd}}.',
    })
    // The upstream Web-surface sections name DeepSeek Harness and describe `dsh web` development.
    expect(rows.find(row => row.id === 'web-runtime')?.config).toMatchObject({ surfaceContext: false, printUrl: true })
    expect(rows.find(row => row.id === 'harness-dev-context')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'workspace-controller')?.config).toEqual({ productDirectory: 'NovaFlow' })
    expect(rows.find(row => row.id === 'llm-pi-ai')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'ui-settings-models')?.disabled).toBe(true)
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-llm-pi-ai' && row.disabled !== true)).toEqual([])
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-client-ui-settings-models' && row.disabled !== true)).toEqual([])
    // Native account discovery sets the saved selection; the invocation layer must not shadow profile edits.
    expect(rows.find(row => row.id === 'agent-default-model')?.config).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
