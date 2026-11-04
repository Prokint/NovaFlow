/** Native account ownership of desktop data, plugin activation, and first-use directories. */
import { createHash } from 'node:crypto'
import { constants, existsSync, readFileSync } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { initProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import type { NovaFlowDesktopSnapshot } from './novaflow/runtime.ts'

/** Authenticated identity, never a username, group, or credential. */
export interface DesktopAccountIdentity { readonly origin: string; readonly userId: string }

/** Process and browser storage selected only by native code. */
export interface DesktopAccountScope {
  readonly key: string
  readonly home: string
  readonly profile: string
  readonly legacy: boolean
  readonly authenticated: boolean
  readonly partition: string | undefined
  readonly patchFile: string | undefined
}

/** Native roots; all account paths below them are derived from hashed identities. */
export interface DesktopAccountScopeOptions {
  readonly home: string
  readonly userData: string
  readonly documents: string
  /** Shipped bundles enabled for a new signed-in account; absent means only the base Web profile. */
  readonly bundledPlugins?: readonly string[]
}

/**
 * Derive a stable namespace from the exact site and server-issued user ID.
 * @param identity - Validated native account identity; null selects the signed-out namespace.
 * @returns Opaque account key with no path or credential content.
 */
export function desktopAccountKey(identity: DesktopAccountIdentity | null): string {
  return identity === null ? 'signed-out' : createHash('sha256')
    .update(JSON.stringify(['novaflow-account-v1', identity.origin, identity.userId])).digest('hex')
}

/**
 * Project a native account snapshot onto its storage identity.
 * @param snapshot - Safe state supplied by the native authentication broker.
 * @returns Authenticated site/user pair, otherwise null; transient catalog refreshes keep the same identity.
 */
export function desktopAccountIdentity(snapshot: NovaFlowDesktopSnapshot): DesktopAccountIdentity | null {
  return snapshot.account.status === 'signed-in'
    ? { origin: snapshot.serverOrigin, userId: snapshot.account.profile.id } : null
}

function readOwner(filename: string): string | null {
  if (!existsSync(filename)) return null
  const value: unknown = JSON.parse(readFileSync(filename, 'utf8'))
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1
    || !('legacyOwner' in value) || (value.legacyOwner !== null
      && (typeof value.legacyOwner !== 'string' || !/^[a-f0-9]{64}$/u.test(value.legacyOwner)))) {
    throw new Error('NovaFlow account isolation: invalid legacy ownership record')
  }
  return value.legacyOwner
}

/** Preserves the authenticated owner of existing data and prepares independent profiles without executing plugins. */
export class DesktopAccountScopes {
  private readonly ownerFile: string
  private owner: string | null

  constructor(private readonly options: DesktopAccountScopeOptions) {
    this.ownerFile = join(options.userData, 'novaflow-account-scopes.json')
    this.owner = readOwner(this.ownerFile)
  }

  /** The default Electron partition belongs only to the recorded legacy owner. */
  get legacyOwner(): string | null { return this.owner }

  /**
   * Bind old data from an already-encrypted account record before rotating it or accepting another login.
   * An absent record never grants old data to the next person who signs in.
   * @param identity - Identity recovered from the existing refresh-only record for the selected site.
   */
  async claimLegacy(identity: DesktopAccountIdentity): Promise<void> {
    if (!existsSync(join(this.options.home, 'profiles', 'desktop', 'package.json'))) return
    await mkdir(this.options.userData, { recursive: true, mode: 0o700 })
    await withFileLock(this.ownerFile, async () => {
      if (existsSync(this.ownerFile)) { this.owner = readOwner(this.ownerFile); return }
      this.owner = readOwner(this.ownerFile)
      if (this.owner !== null) return
      const key = desktopAccountKey(identity)
      await writeFileAtomic(this.ownerFile, JSON.stringify({ version: 1, legacyOwner: key }) + '\n', { mode: 0o600, dirMode: 0o700 })
      this.owner = key
    })
  }

  /** Finish first-launch adoption; no saved identity permanently leaves old unowned data unassigned. */
  async sealLegacy(): Promise<void> {
    await mkdir(this.options.userData, { recursive: true, mode: 0o700 })
    await withFileLock(this.ownerFile, async () => {
      if (!existsSync(this.ownerFile)) await writeFileAtomic(this.ownerFile,
        JSON.stringify({ version: 1, legacyOwner: null }) + '\n', { mode: 0o600, dirMode: 0o700 })
      this.owner = readOwner(this.ownerFile)
    })
  }

  /**
   * Resolve an account's native-owned paths without creating or reading its application data.
   * @param identity - Current authenticated identity, or null while signed out.
   * @returns A stable descriptor; the recorded old owner retains its existing directories.
   */
  resolve(identity: DesktopAccountIdentity | null): DesktopAccountScope {
    const key = desktopAccountKey(identity)
    const legacy = key === this.owner
    const home = legacy ? this.options.home : join(this.options.home, 'accounts', key)
    return { key, home, legacy, authenticated: identity !== null, profile: join(home, 'profiles', 'desktop'),
      partition: legacy ? undefined : `persist:novaflow-account-${key}`,
      patchFile: legacy ? undefined : join(home, 'desktop-account.patch.json') }
  }

  /**
   * Prepare a fresh account once. Installed plugin payloads are copied privately, with no old settings or enabled bundles.
   * Existing accounts are never reseeded; package copying runs no install/build scripts.
   * @param scope - Native-resolved target.
   * @param seedProfile - Last authenticated account's stopped profile; omission or signed-out targets inherit no plugins.
   */
  async prepare(scope: DesktopAccountScope, seedProfile?: string): Promise<void> {
    if (scope.legacy) return
    if (existsSync(scope.home)) {
      if ((await lstat(scope.home)).isSymbolicLink()) throw new Error('NovaFlow account isolation: account directory is a link')
      const marker: unknown = JSON.parse(await readFile(join(scope.home, 'novaflow-scope.json'), 'utf8'))
      if (typeof marker !== 'object' || marker === null || !('version' in marker) || marker.version !== 1
        || !('key' in marker) || marker.key !== scope.key) throw new Error('NovaFlow account isolation: invalid account directory')
      return
    }
    const parent = join(this.options.home, 'accounts')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const temporary = await mkdtemp(join(parent, `${scope.key}-preparing-`))
    try {
      const profile = join(temporary, 'profiles', 'desktop')
      const template = PROFILE_TEMPLATES.web
      if (template === undefined) throw new Error('NovaFlow account isolation: desktop template is unavailable')
      const bundles = [...template.bundles, ...scope.authenticated ? this.options.bundledPlugins ?? [] : []]
      initProfile(profile, bundles)
      if (scope.authenticated && seedProfile !== undefined && existsSync(join(seedProfile, 'package.json'))) {
        const source: unknown = JSON.parse(await readFile(join(seedProfile, 'package.json'), 'utf8'))
        if (typeof source !== 'object' || source === null) throw new Error('NovaFlow account isolation: invalid plugin manifest')
        const dependencies: Record<string, string> = {}
        if ('dependencies' in source) {
          if (typeof source.dependencies !== 'object' || source.dependencies === null || Array.isArray(source.dependencies)) {
            throw new Error('NovaFlow account isolation: invalid installed dependencies')
          }
          for (const [name, spec] of Object.entries(source.dependencies)) {
            if (typeof spec !== 'string') throw new Error('NovaFlow account isolation: invalid dependency specifier')
            dependencies[name] = /^(file:|link:)\./u.test(spec)
              ? spec.slice(0, 5) + resolve(seedProfile, spec.slice(5)) : spec
          }
        }
        await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'novaflow-account-profile', private: true,
          dependencies, dsh: { profile: { bundles } } }, null, 2) + '\n', { mode: 0o600 })
        const installed = join(seedProfile, 'node_modules')
        if (existsSync(installed)) await cp(installed, join(profile, 'node_modules'), {
          recursive: true, dereference: false, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
        })
      }
      await writeFile(join(temporary, 'desktop-account.patch.json'), JSON.stringify([{ id: 'workspace-controller', config: {
        documentsDirectory: join(this.options.documents, 'NovaFlow', 'accounts'), productDirectory: scope.key,
      } }]) + '\n', { mode: 0o600 })
      await writeFile(join(temporary, 'novaflow-scope.json'), JSON.stringify({ version: 1, key: scope.key }) + '\n', { mode: 0o600 })
      await rename(temporary, scope.home)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
}
