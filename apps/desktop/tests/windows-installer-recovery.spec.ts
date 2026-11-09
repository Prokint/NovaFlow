/** Recovery behavior for payload extraction a security product interrupts. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { readInstallerLocales } from '../scripts/installer-locales.mjs'

const installerPath = new URL('../installer/path.nsh', import.meta.url)
const directories = new URL('../scripts/installer-directories.nsh', import.meta.url)

it('probes an executable file name before installation starts', () => {
  const source = readFileSync(installerPath, 'utf8')
  const preflight = source.slice(source.indexOf('Function InstallerPreflight'))
  // Policy can allow a plain temporary file while rejecting the payload the installer writes next.
  expect(preflight).toContain('FileOpen')
  expect(preflight).toContain('.dll')
  expect(preflight.indexOf('.dll')).toBeLessThan(preflight.indexOf('GetDiskFreeSpaceExW'))
})

it('retries a failed extraction once before reporting it', () => {
  const source = readFileSync(directories, 'utf8')
  const macro = source.slice(source.indexOf('!macro dshExtractPayload'), source.indexOf('!macro dshStageApplication'))
  expect(macro).toContain('Sleep')
  // The retry re-runs the same attempt and lets the failure report keep the final result.
  expect(macro.match(/dshExtractAttempt/g)).toHaveLength(2)
  expect(macro.indexOf('Sleep')).toBeLessThan(macro.lastIndexOf('dshExtractAttempt'))
  expect(macro.indexOf('Sleep')).toBeLessThan(macro.indexOf('customInstallerExtractFailed'))
})

it.each(['en_US', 'zh_CN'])('names security software and exclusions in %s', (locale) => {
  const resource = readInstallerLocales().find(candidate => candidate.id === locale)
  expect(resource, `${locale} installer locale is missing`).toBeDefined()
  const hint = resource!.strings.INSTALLER_EXTRACT_HINT!
  expect(hint.toLowerCase()).toMatch(/antivirus|antivírus|杀毒|ウイルス/)
  expect(hint.toLowerCase()).toMatch(/exclusion|排除|除外/)
})
