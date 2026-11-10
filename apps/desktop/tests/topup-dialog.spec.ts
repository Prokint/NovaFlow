import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { DesktopTopUpDialog, paymentDocument, TOPUP_DIALOG_IPC } from '../src/topup-dialog.ts'
import type { TopUpDialogDeps } from '../src/topup-dialog.ts'
import { DesktopUpdateOverlays } from '../src/update-overlay.ts'
import { novaFlowAccountCopy } from '../src/novaflow/locale.ts'

const fixture = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const windows: FakeWindow[] = []
  class FakeWindow extends EventEmitter {
    destroyed = false
    readonly webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      mainFrame: { url: 'dsh-app://shell/topup-dialog.html' },
      setWindowOpenHandler: vi.fn(),
      insertCSS: vi.fn(async () => 'blur'),
      removeInsertedCSS: vi.fn(async () => {}),
    })
    readonly focus = vi.fn()
    readonly show = vi.fn()
    readonly hide = vi.fn()
    readonly setBounds = vi.fn()
    readonly setMenu = vi.fn()
    readonly loadURL = vi.fn(async () => {})
    constructor(readonly options: unknown) { super(); windows.push(this) }
    getContentBounds() { return { x: 0, y: 0, width: 1200, height: 800 } }
    isDestroyed() { return this.destroyed }
    isVisible() { return true }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  return { handlers, windows, FakeWindow }
})
vi.mock('electron', () => ({
  BrowserWindow: fixture.FakeWindow,
  shell: { openExternal: vi.fn() },
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => fixture.handlers.set(name, fn),
    removeHandler: (name: string) => fixture.handlers.delete(name),
  },
}))

let dialogs: DesktopTopUpDialog | undefined
afterEach(() => {
  dialogs?.dispose()
  dialogs = undefined
  for (const window of fixture.windows) if (!window.isDestroyed()) window.destroy()
  fixture.windows.length = 0
  fixture.handlers.clear()
})

function setup(overrides: Partial<TopUpDialogDeps> = {}) {
  if (process.platform === 'linux') vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const parent = new fixture.FakeWindow({})
  const deps: TopUpDialogDeps = {
    info: async () => ({ amountOptions: [4, 15], minTopUp: 1, payMethods: [{ type: 'alipay', name: '支付宝' }] }),
    quote: async (amount: number) => (amount === 1 ? '7.00' : String(amount * 7) + '.00'),
    start: async () => ({ tradeNo: 'USR1NOabc', payUrl: 'https://zpayz.cn/submit.php', fields: { pid: '1', sign: 'sig' } }),
    state: async () => 'pending',
    balance: () => '¥7',
    refreshWallet: vi.fn(async () => {}),
    copy: () => novaFlowAccountCopy('zh-CN'),
    moneyPrefix: () => '¥',
    exchangeHint: () => '1 美元 = ¥7',
    ...overrides,
  }
  dialogs = new DesktopTopUpDialog('preload-topup-dialog.cjs', new DesktopUpdateOverlays(), deps)
  return { parent, deps }
}

function ownedEvent(window: { webContents: { mainFrame: unknown } }) {
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame }
}

it('builds the view from the site configuration and prices every shortcut', async () => {
  const { parent } = setup()
  const showing = dialogs!.show(parent as unknown as BrowserWindow)
  await showing
  const window = fixture.windows.at(-1)!
  expect(window.webContents.send).toHaveBeenCalledWith(TOPUP_DIALOG_IPC.changed, expect.objectContaining({
    title: '充值', balanceValue: '¥7', moneyPrefix: '¥', minAmount: 1,
    options: [{ amount: 4, label: '¥28.00' }, { amount: 15, label: '¥105.00' }],
    methods: [{ type: 'alipay', name: '支付宝' }], minHint: '最低 ¥7.00',
  }))
  const view = fixture.handlers.get(TOPUP_DIALOG_IPC.status)!(ownedEvent(window)) as { revision: number }
  expect(view.revision).toBe(1)
})

it('validates amounts and opens a payment window when an order is created', async () => {
  const { parent } = setup()
  await dialogs!.show(parent as unknown as BrowserWindow)
  const overlay = fixture.windows[1]!
  const quote = fixture.handlers.get(TOPUP_DIALOG_IPC.quote)!
  expect(() => quote(ownedEvent(overlay), 0)).toThrow(/invalid amount/)
  await expect(quote(ownedEvent(overlay), 4)).resolves.toBe('28.00')
  const pay = fixture.handlers.get(TOPUP_DIALOG_IPC.pay)!
  await expect(pay(ownedEvent(overlay), 4, 'alipay')).resolves.toEqual({ tradeNo: 'USR1NOabc' })
  const payment = fixture.windows.at(-1)!
  expect(payment).not.toBe(overlay)
  expect(payment.loadURL).toHaveBeenCalledWith(expect.stringContaining('data:text/html'))
})

it('reports pending orders and refreshes the wallet once the site credits a paid order', async () => {
  const refreshWallet = vi.fn(async () => {})
  const { parent } = setup({ refreshWallet, state: async (tradeNo: string) => tradeNo === 'USR1NOabc' ? 'paid' : 'pending' })
  await dialogs!.show(parent as unknown as BrowserWindow)
  const overlay = fixture.windows[1]!
  const poll = fixture.handlers.get(TOPUP_DIALOG_IPC.poll)!
  await expect(poll(ownedEvent(overlay), 'bad trade no')).rejects.toThrow(/invalid trade number/)
  await expect(poll(ownedEvent(overlay), 'USR1NOabc')).resolves.toEqual({ tradeNo: 'USR1NOabc', state: 'paid', balanceValue: '¥7' })
  expect(refreshWallet).toHaveBeenCalledOnce()
})

it('formats the gateway form and disposes every handler and window', async () => {
  const document = paymentDocument({ tradeNo: 'T', payUrl: 'https://pay.test/submit.php?a=1&b=2',
    fields: { sign: 'a"b<c', money: '7.00' } }, '充值')
  expect(document).toContain('action="https://pay.test/submit.php?a=1&amp;b=2"')
  expect(document).toContain('value="a&quot;b&lt;c"')
  expect(document).toContain('method="post"')
  const { parent } = setup()
  await dialogs!.show(parent as unknown as BrowserWindow)
  dialogs!.dispose()
  parent.destroy()
  expect(fixture.handlers.size).toBe(0)
  expect(fixture.windows.filter(window => !window.isDestroyed())).toHaveLength(0)
})
