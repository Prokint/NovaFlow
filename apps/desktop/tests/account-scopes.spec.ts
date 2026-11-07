import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOptionalPatches, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { expect, it, onTestFinished } from 'vitest'
import { DesktopAccountScopes, desktopAccountKey } from '../src/account-scopes.ts'

const a = { origin: 'https://site.example', userId: '1' }
const b = { origin: 'https://site.example', userId: '2' }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'novaflow-scopes-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const options = { home: join(root, 'home'), userData: join(root, 'native'), documents: join(root, 'Documents') }
  const legacy = join(options.home, 'profiles', 'desktop')
  await mkdir(join(legacy, 'node_modules', 'third-party'), { recursive: true })
  await writeFile(join(legacy, 'package.json'), JSON.stringify({ dependencies: { 'third-party': 'file:./plugin.tgz' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'third-party'] } } }))
  await writeFile(join(legacy, 'cordis.patch.yml'), 'private-old-settings')
  await writeFile(join(legacy, '.env'), 'PRIVATE=old')
  await writeFile(join(legacy, 'node_modules', 'third-party', 'index.js'), 'throw new Error("must not execute")')
  await mkdir(join(options.home, 'storages'), { recursive: true })
  await writeFile(join(options.home, 'storages', 'workspace.json'), 'old workspace')
  return { root, options, legacy, scopes: new DesktopAccountScopes(options) }
}

it('keys storage by exact server origin and immutable user ID', () => {
  expect(desktopAccountKey(a)).toMatch(/^[a-f0-9]{64}$/u)
  expect(desktopAccountKey(a)).not.toBe(desktopAccountKey(b))
  expect(desktopAccountKey(a)).not.toBe(desktopAccountKey({ ...a, origin: 'https://other.example' }))
  expect(desktopAccountKey(null)).toBe('signed-out')
})

it('binds legacy data once using the saved identity and persists that owner', async () => {
  const { scopes, options } = await fixture()
  expect(scopes.resolve(a).legacy).toBe(false)
  await scopes.claimLegacy(a)
  await scopes.claimLegacy(b)
  const restored = new DesktopAccountScopes(options)
  expect(restored.resolve(a)).toMatchObject({ legacy: true, home: options.home, partition: undefined })
  expect(restored.resolve(b).legacy).toBe(false)
  expect(restored.resolve(null).home).not.toBe(options.home)
})

it('never assigns unowned legacy data to a subsequent login or its saved record on restart', async () => {
  const { scopes, options } = await fixture()
  await scopes.sealLegacy()
  const restarted = new DesktopAccountScopes(options)
  await restarted.claimLegacy(b)
  expect(restarted.resolve(b).legacy).toBe(false)
  expect(restarted.legacyOwner).toBeNull()
})

it('composes the account-owned first workspace directory after the shipped product overlay', async () => {
  const { scopes, options } = await fixture()
  const scope = scopes.resolve(b)
  await scopes.prepare(scope)
  const anchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
  const profile = loadProfileDirectory('NovaFlow', scope.profile, anchor)
  const shippedPath = fileURLToPath(new URL('../../desktop-host/src/novaflow.patch.yml', import.meta.url))
  const shipped = loadOptionalPatches('NovaFlow', shippedPath) ?? []
  const owned = loadOptionalPatches('NovaFlow', scope.patchFile!) ?? []
  const warnings: string[] = []
  const rows = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches, shipped, owned],
    value => warnings.push(value))
  expect(rows.find(row => row.id === 'workspace-controller')?.config).toMatchObject({
    documentsDirectory: join(options.documents, 'NovaFlow', 'accounts'), productDirectory: scope.key,
  })
  expect(warnings).toEqual([])
})

it('copies installed plugin payloads without activation, old settings, credentials or workspace registry', async () => {
  const { scopes, legacy, options } = await fixture()
  await scopes.claimLegacy(a)
  const scope = scopes.resolve(b)
  await scopes.prepare(scope, legacy)
  const manifest: unknown = JSON.parse(await readFile(join(scope.profile, 'package.json'), 'utf8'))
  expect(manifest).toHaveProperty('dependencies.third-party', `file:${join(legacy, 'plugin.tgz')}`)
  expect(manifest).toHaveProperty('dsh.profile.bundles', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  expect(await readFile(join(scope.profile, 'node_modules', 'third-party', 'index.js'), 'utf8')).toContain('must not execute')
  expect(await readFile(join(scope.profile, 'cordis.patch.yml'), 'utf8')).not.toContain('private-old-settings')
  await expect(readFile(join(scope.profile, '.env'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(scope.home, 'storages', 'workspace.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(JSON.parse(await readFile(scope.patchFile!, 'utf8'))).toEqual([{ id: 'workspace-controller', config: {
    documentsDirectory: join(options.documents, 'NovaFlow', 'accounts'), productDirectory: scope.key,
  } }])
  expect(await readFile(join(options.home, 'storages', 'workspace.json'), 'utf8')).toBe('old workspace')
  expect(await readdir(join(options.home, 'accounts'))).toEqual([scope.key])
})

it('enables shipped bundles for a new authenticated account while inherited user plugins and signed-out profiles stay disabled', async () => {
  const { options, legacy } = await fixture()
  const bundledPlugins = ['dsh-douyin-comments', 'dsh-skill-explorer']
  const scopes = new DesktopAccountScopes({ ...options, bundledPlugins })
  const account = scopes.resolve(b)
  await scopes.prepare(account, legacy)
  const filename = join(account.profile, 'package.json')
  const manifest = JSON.parse(await readFile(filename, 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
  expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...bundledPlugins])
  expect(manifest.dependencies).toHaveProperty('third-party')
  expect(manifest.dsh.profile.bundles).not.toContain('third-party')
  manifest.dsh.profile.bundles.pop()
  await writeFile(filename, JSON.stringify(manifest))
  await scopes.prepare(account, legacy)
  expect(JSON.parse(await readFile(filename, 'utf8'))).toHaveProperty('dsh.profile.bundles',
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-douyin-comments'])
  const signedOut = scopes.resolve(null)
  await scopes.prepare(signedOut, legacy)
  expect(JSON.parse(await readFile(join(signedOut.profile, 'package.json'), 'utf8')))
    .toHaveProperty('dsh.profile.bundles', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
})

it('preserves returning account activation and gives signed-out users no inherited packages', async () => {
  const { scopes, legacy } = await fixture()
  const scope = scopes.resolve(b)
  await scopes.prepare(scope, legacy)
  await writeFile(join(scope.profile, 'package.json'), 'account-specific activation')
  await scopes.prepare(scope, legacy)
  expect(await readFile(join(scope.profile, 'package.json'), 'utf8')).toBe('account-specific activation')
  const guest = scopes.resolve(null)
  await scopes.prepare(guest, legacy)
  expect(JSON.parse(await readFile(join(guest.profile, 'package.json'), 'utf8'))).toHaveProperty('dependencies', {})
  expect(guest.partition).not.toBe(scope.partition)
})

it('rejects unowned or symlinked account directories and invalid legacy ownership', async () => {
  const { scopes, root, options } = await fixture()
  const scope = scopes.resolve(b)
  await mkdir(join(options.home, 'accounts'), { recursive: true })
  await symlink(root, scope.home, 'junction')
  await expect(scopes.prepare(scope)).rejects.toThrow('directory is a link')
  await mkdir(options.userData, { recursive: true })
  await writeFile(join(options.userData, 'novaflow-account-scopes.json'), '{"version":1,"legacyOwner":"../escape"}')
  expect(() => new DesktopAccountScopes(options)).toThrow('invalid legacy ownership')
})
