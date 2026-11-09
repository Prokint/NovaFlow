import { expect, it, vi } from 'vitest'
import { DesktopAccountSwitch } from '../src/account-switch.ts'
import type { DesktopAccountScope } from '../src/account-scopes.ts'

const scope = (key: string): DesktopAccountScope => ({ key, home: key, profile: key, legacy: false,
  authenticated: true, partition: key, patchFile: undefined, agentsHome: `${key}-agents` })
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } }

it('revokes synchronously, waits for old Host exit, then prepares and reveals the next account', async () => {
  const stopped = deferred()
  const events: string[] = []
  const controller = new DesktopAccountSwitch(scope('a'), {
    block: () => { events.push('block') }, stop: async () => { events.push('stop'); await stopped.promise },
    prepare: async (s) => { events.push(`prepare:${s.key}`) }, start: async (s) => { events.push(`start:${s.key}`) },
    reveal: async (s) => { events.push(`reveal:${s.key}`) }, failed: vi.fn(),
  })
  const operation = controller.select(scope('b'))
  expect(events).toEqual(['block'])
  await Promise.resolve()
  expect(events).toEqual(['block', 'stop'])
  stopped.resolve(); await operation
  expect(events).toEqual(['block', 'stop', 'prepare:b', 'start:b', 'reveal:b'])
  await controller.select(scope('b'))
  expect(events).toHaveLength(5)
})

it('never reveals a superseded Host and stops it before starting the latest account', async () => {
  const started = deferred(); const release = deferred(); const events: string[] = []
  const controller = new DesktopAccountSwitch(scope('a'), {
    block: vi.fn(), stop: async () => { events.push('stop') }, prepare: async () => {},
    start: async (s) => { events.push(`start:${s.key}`); if (s.key === 'b') { started.resolve(); await release.promise } },
    reveal: async (s) => { events.push(`reveal:${s.key}`) }, failed: vi.fn(),
  })
  const b = controller.select(scope('b')); await started.promise
  const c = controller.select(scope('c')); release.resolve()
  await Promise.all([b, c])
  expect(events).toEqual(['stop', 'start:b', 'stop', 'stop', 'start:c', 'reveal:c'])
})

it('keeps failures blocked and permits an explicit retry', async () => {
  const prepare = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
  const failed = vi.fn(); const reveal = vi.fn(async () => {})
  const controller = new DesktopAccountSwitch(scope('a'), { block: vi.fn(), stop: async () => {}, prepare,
    start: async () => {}, reveal, failed })
  await expect(controller.select(scope('b'))).rejects.toThrow('disk full')
  expect(reveal).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce()
  await controller.select(scope('b'))
  expect(reveal).toHaveBeenCalledOnce()
})

it('closing waits for preparation and prevents a later start', async () => {
  const entered = deferred(); const release = deferred(); const start = vi.fn(async () => {})
  const controller = new DesktopAccountSwitch(scope('a'), { block: vi.fn(), stop: async () => {},
    prepare: async () => { entered.resolve(); await release.promise }, start, reveal: async () => {}, failed: vi.fn() })
  const change = controller.select(scope('b')); await entered.promise
  const close = controller.close(); release.resolve(); await Promise.all([change, close])
  await controller.select(scope('c')); expect(start).not.toHaveBeenCalled()
})
