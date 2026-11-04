import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LEGACY_DESKTOP_BRAND } from '@deepseek-ai/dsh-desktop-host/novaflow'
import { novaFlowDataFile, pinNovaFlowKeychainIdentity, resolveNovaFlowDataDirectories } from '../src/brand-compat.ts'

it('uses NovaFlow directories on fresh installs and preserves existing private account data in place', () => {
  const root = mkdtempSync(join(tmpdir(), 'novaflow-brand-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const home = join(root, 'home')
  const appData = join(root, 'apps')
  const modern = { home: join(home, '.novaflow'), userData: join(appData, 'novaflow') }
  expect(resolveNovaFlowDataDirectories(home, appData)).toEqual(modern)
  const previous = { home: join(home, `.${LEGACY_DESKTOP_BRAND}`), userData: join(appData, LEGACY_DESKTOP_BRAND) }
  mkdirSync(previous.home, { recursive: true })
  mkdirSync(join(previous.userData, 'new-api-account'), { recursive: true, mode: 0o700 })
  const encrypted = join(previous.userData, 'new-api-account', 'refresh.enc')
  writeFileSync(encrypted, Buffer.from([1, 4, 9]), { mode: 0o600 })
  expect(resolveNovaFlowDataDirectories(home, appData)).toEqual(previous)
  const oldSetting = join(previous.userData, `${LEGACY_DESKTOP_BRAND}-server.json`)
  writeFileSync(oldSetting, '{}')
  expect(novaFlowDataFile(previous.userData, 'server.json')).toBe(oldSetting)
  expect(novaFlowDataFile(previous.userData, 'release.json')).toBe(join(previous.userData, 'novaflow-release.json'))
  expect(readFileSync(encrypted)).toEqual(Buffer.from([1, 4, 9]))
  mkdirSync(modern.home)
  mkdirSync(modern.userData)
  expect(resolveNovaFlowDataDirectories(home, appData)).toEqual(modern)
  const modernSetting = join(previous.userData, 'novaflow-server.json')
  writeFileSync(modernSetting, '{}')
  expect(novaFlowDataFile(previous.userData, 'server.json')).toBe(modernSetting)
  expect(readFileSync(encrypted)).toEqual(Buffer.from([1, 4, 9]))
})

it('pins an explicitly selected legacy Keychain identity until readiness without changing encrypted files', () => {
  const root = mkdtempSync(join(tmpdir(), 'novaflow-keychain-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const app = { name: 'novaflow', setName: vi.fn((name: string) => { app.name = name }) }
  const unchanged = pinNovaFlowKeychainIdentity(app, root)
  unchanged()
  expect(app.setName).not.toHaveBeenCalled()
  mkdirSync(join(root, 'new-api-account'))
  const encrypted = join(root, 'new-api-account', 'refresh.enc')
  writeFileSync(encrypted, Buffer.from([10, 20, 30]))
  writeFileSync(join(root, 'novaflow-keychain.json'), JSON.stringify({ version: 1, identity: LEGACY_DESKTOP_BRAND }))
  const restore = pinNovaFlowKeychainIdentity(app, root)
  expect(app.name).toBe(LEGACY_DESKTOP_BRAND)
  restore()
  expect(app.name).toBe('novaflow')
  expect(readFileSync(encrypted)).toEqual(Buffer.from([10, 20, 30]))
})

it.each([
  { version: 1, identity: 'another-application' },
  { version: 2, identity: 'novaflow' },
  null,
])('rejects an invalid Keychain identity setting before changing the application name (%j)', (setting) => {
  const root = mkdtempSync(join(tmpdir(), 'novaflow-keychain-invalid-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  writeFileSync(join(root, 'novaflow-keychain.json'), JSON.stringify(setting))
  const app = { name: 'novaflow', setName: vi.fn() }
  expect(() => pinNovaFlowKeychainIdentity(app, root)).toThrow('invalid private Keychain identity setting')
  expect(app.setName).not.toHaveBeenCalled()
})
