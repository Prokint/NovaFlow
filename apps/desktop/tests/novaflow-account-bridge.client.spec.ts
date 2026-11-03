// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NovaFlowDesktopSnapshot } from '../src/novaflow/runtime.ts'

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  handlers: new Map<string, (...args: unknown[]) => void>(),
  invoke: vi.fn(async (_channel: string, ..._args: unknown[]): Promise<unknown> => null),
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => { electron.exposed.set(key, api) } },
  ipcRenderer: {
    invoke: electron.invoke,
    on: (channel: string, handler: (...args: unknown[]) => void) => { electron.handlers.set(channel, handler) },
    off: (channel: string) => { electron.handlers.delete(channel) },
  },
}))

const { createAccountOpenRequests, installNovaFlowAccountUi } = await import('../src/preload-novaflow.ts')

interface ExposedBridge {
  accessMode: string
  subscribe(listener: (state: unknown) => void): () => void
  onOpen(listener: () => void): () => void
  mount(head: unknown, content: unknown): () => void
}

const signedOut: NovaFlowDesktopSnapshot = { account: { status: 'signed-out' }, serverOrigin: 'https://api.novaflow.com', catalogStatus: 'unavailable' }

afterEach(() => {
  window.dispatchEvent(new Event('unload'))
  document.head.replaceChildren(); document.body.replaceChildren()
  document.documentElement.lang = ''
  electron.exposed.clear(); electron.handlers.clear(); electron.invoke.mockReset()
})

function install(): ExposedBridge {
  electron.invoke.mockImplementation(async (channel: string) => channel === 'novaflow:state' ? signedOut : null)
  installNovaFlowAccountUi()
  return electron.exposed.get('dshNovaFlow') as ExposedBridge
}

describe('NovaFlow account page bridge', () => {
  it('keeps one open request for the first listener and forwards later ones', async () => {
    const requests = createAccountOpenRequests()
    requests.request()
    requests.request()
    const first = vi.fn()
    const stop = requests.listen(first)
    expect(first).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(first).toHaveBeenCalledOnce()
    const second = vi.fn()
    requests.listen(second)
    await Promise.resolve()
    expect(second).not.toHaveBeenCalled()
    requests.request()
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledOnce()
    stop()
    requests.request()
    expect(first).toHaveBeenCalledTimes(2)
  })

  it('routes the shell open request to the page and renders the page into connected hosts only', async () => {
    const bridge = install()
    expect(bridge.accessMode).toBe('desktop-account')
    electron.handlers.get('novaflow:open')?.({})
    const open = vi.fn()
    bridge.onOpen(open)
    await Promise.resolve()
    expect(open).toHaveBeenCalledOnce()
    expect(electron.invoke).not.toHaveBeenCalledWith('novaflow:restore')
    const head = document.createElement('div')
    const content = document.createElement('div')
    expect(() => bridge.mount(head, content)).toThrow(TypeError)
    expect(() => bridge.mount({}, {})).toThrow(TypeError)
    document.body.append(head, content)
    const unmount = bridge.mount(head, content)
    await vi.waitFor(() => { expect(head.querySelector('.hcx-chip')?.textContent).toBe('Not signed in') })
    expect(electron.invoke).toHaveBeenCalledWith('novaflow:restore')
    expect(content.querySelector('.hcx-signin')).not.toBeNull()
    unmount()
    expect(head.childElementCount).toBe(0)
    expect(content.childElementCount).toBe(0)
  })

  it('exposes account navigation without a manual model settings bridge', async () => {
    const bridge = install()
    const account = vi.fn()
    bridge.onOpen(account)
    electron.handlers.get('novaflow:open-models')?.({})
    await Promise.resolve()
    expect(bridge).not.toHaveProperty('onOpenModels')
    expect(electron.handlers.has('novaflow:open-models')).toBe(false)
    expect(account).not.toHaveBeenCalled()
    electron.handlers.get('novaflow:open')?.({})
    expect(account).toHaveBeenCalledOnce()
  })

  it('re-creates the mounted page when the client language changes', async () => {
    const bridge = install()
    const head = document.createElement('div')
    const content = document.createElement('div')
    document.body.append(head, content)
    document.documentElement.lang = 'en'
    const unmount = bridge.mount(head, content)
    await vi.waitFor(() => { expect(head.querySelector('h1')?.textContent).toBe('NovaFlow account') })
    document.documentElement.lang = 'zh-CN'
    await vi.waitFor(() => { expect(head.querySelector('h1')?.textContent).toBe('NovaFlow 账号') })
    expect(document.head.querySelectorAll('style')).toHaveLength(1)
    unmount()
    document.documentElement.lang = 'en'
    await Promise.resolve()
    expect(head.childElementCount).toBe(0)
  })
})
