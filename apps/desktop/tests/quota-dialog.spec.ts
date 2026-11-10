import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { DesktopQuotaDialog, QUOTA_DIALOG_IPC, type QuotaDialogContent } from '../src/quota-dialog.ts'
import { DesktopUpdateOverlays } from '../src/update-overlay.ts'
import { resolveDesktopLocale } from '../src/locale.ts'

const fixture = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const windows: FakeWindow[] = []
  class FakeWindow extends EventEmitter {
    destroyed = false
    readonly webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      mainFrame: { url: 'dsh-app://shell/quota-dialog.html' },
      setWindowOpenHandler: vi.fn(),
      insertCSS: vi.fn(async () => 'blur'),
      removeInsertedCSS: vi.fn(async () => {}),
    })
    readonly focus = vi.fn()
    readonly show = vi.fn()
    readonly hide = vi.fn()
    readonly setBounds = vi.fn()
    readonly loadURL = vi.fn(async () => {})
    constructor(readonly options: unknown) { super(); windows.push(this) }
    getContentBounds() { return { x: 10, y: 20, width: 900, height: 650 } }
    isDestroyed() { return this.destroyed }
    isVisible() { return true }
    destroy() { this.destroyed = true; this.emit('closed') }
    setMenu() {}
  }
  return { handlers, windows, FakeWindow }
})
vi.mock('electron', () => ({
  BrowserWindow: fixture.FakeWindow,
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => fixture.handlers.set(name, fn),
    removeHandler: (name: string) => fixture.handlers.delete(name),
  },
}))

let dialogs: DesktopQuotaDialog | undefined
afterEach(() => {
  vi.restoreAllMocks()
  dialogs?.dispose()
  dialogs = undefined
  for (const window of fixture.windows) if (!window.isDestroyed()) window.destroy()
  fixture.windows.length = 0
  fixture.handlers.clear()
})

const content: QuotaDialogContent = {
  title: '余额不足', message: '当前账号余额不足以继续调用模型。', detail: '充值后即可继续对话。',
  balanceLabel: '当前余额', balanceValue: '¥0.00', buttons: ['去充值', '稍后再说'], cancelId: 1,
}

function setup() {
  // The dialog drives a child window on Windows and macOS; update-overlay.spec covers the view Linux embeds instead.
  if (process.platform === 'linux') vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const parent = new fixture.FakeWindow({})
  dialogs = new DesktopQuotaDialog('preload-quota-dialog.cjs', resolveDesktopLocale('zh-CN'), new DesktopUpdateOverlays())
  const show = () => dialogs!.show(parent as unknown as BrowserWindow, content)
  const view = () => {
    const window = fixture.windows.at(-1)!
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    return fixture.handlers.get(QUOTA_DIALOG_IPC.status)!(event) as { revision: number }
  }
  const respond = (...args: unknown[]) => {
    const window = fixture.windows.at(-1)!
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    return fixture.handlers.get(QUOTA_DIALOG_IPC.respond)!(event, view().revision, ...args) as Promise<unknown>
  }
  return { parent, show, view, respond }
}

it('accepts only a displayed choice from its own main frame', async () => {
  const f = setup()
  expect(dialogs!.isOpen).toBe(false)
  const pending = f.show()
  expect(dialogs!.isOpen).toBe(true)
  expect(f.view()).toMatchObject({ title: '余额不足', buttons: ['去充值', '稍后再说'], cancelId: 1, balanceValue: '¥0.00' })
  const window = fixture.windows.at(-1)!
  const handler = fixture.handlers.get(QUOTA_DIALOG_IPC.respond)!
  expect(() => handler({ sender: {}, senderFrame: window.webContents.mainFrame }, f.view().revision, 0)).toThrow(/unowned/)
  for (const index of [-1, 2, '0', 0.5, NaN]) expect(() => f.respond(index)).toThrow(/invalid/)
  await f.respond(0)
  expect(await pending).toBe(0)
  expect(dialogs!.isOpen).toBe(false)
})

it('reuses one backdrop and rejects a response from the previous prompt', async () => {
  const f = setup()
  const first = f.show()
  const window = fixture.windows.at(-1)!
  const second = f.show()
  expect(await first).toBe(1)
  // One parent plus the reused overlay backdrop.
  expect(fixture.windows).toHaveLength(2)
  const staleHandler = fixture.handlers.get(QUOTA_DIALOG_IPC.respond)!
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  expect(() => staleHandler(event, f.view().revision - 1, 0)).toThrow(/stale/)
  await f.respond(1)
  expect(await second).toBe(1)
})

it('cancels on disposal or an already-closed parent without opening a window', async () => {
  const f = setup()
  const pending = f.show()
  dialogs!.dispose()
  expect(await pending).toBe(1)
  expect(fixture.handlers.size).toBe(0)
  f.parent.destroy()
  expect(await f.show()).toBe(1)
})
