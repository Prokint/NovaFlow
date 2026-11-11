/** Main-owned top-up dialog: amount choices, order creation, and the shell payment window. */
import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import type { NewApiPayMethod, NewApiTopUpInfo, NewApiTopUpOrder, NewApiTopUpState } from './novaflow/new-api.ts'
import type { NovaFlowAccountCopy } from './novaflow/locale.ts'
import type { DesktopOverlay, DesktopUpdateOverlays } from './update-overlay.ts'

/** Channels available only to the isolated top-up dialog document. */
export const TOPUP_DIALOG_IPC = {
  status: 'dsh-topup-dialog:status', changed: 'dsh-topup-dialog:changed', quote: 'dsh-topup-dialog:quote',
  pay: 'dsh-topup-dialog:pay', poll: 'dsh-topup-dialog:poll', close: 'dsh-topup-dialog:close',
} as const

/** One shortcut amount and its formatted price. */
export interface TopUpDialogOption {
  readonly amount: number
  readonly label: string
}

/** Everything the dialog document renders; the main process owns every value. */
export interface TopUpDialogView {
  readonly revision: number
  readonly locale: string
  readonly title: string
  readonly balanceLabel: string
  readonly balanceValue: string
  readonly amountLabel: string
  readonly payLabel: string
  readonly payingText: string
  readonly waitingText: string
  readonly successText: string
  readonly failedText: string
  readonly closeLabel: string
  readonly finishLabel: string
  readonly exchangeHint: string
  /** Message shown when the site offers no online payment method. */
  readonly noMethod: string
  /** Currency prefix for a formatted amount. */
  readonly moneyPrefix: string
  readonly options: readonly TopUpDialogOption[]
  readonly methods: readonly NewApiPayMethod[]
}

/** The document can only quote, create, and poll orders the shell owns. */
export interface TopUpDialogApi {
  status(): Promise<TopUpDialogView | null>
  quote(amount: number): Promise<string>
  pay(amount: number, method: string): Promise<{ tradeNo: string }>
  poll(tradeNo: string): Promise<{ tradeNo: string; state: NewApiTopUpState; balanceValue?: string }>
  close(): void
  /** Receive replacement views (a refreshed balance or a new configuration). */
  subscribe(listener: (view: TopUpDialogView | null) => void): () => void
}

/** Account operations and presentation the shell injects. */
export interface TopUpDialogDeps {
  readonly info: () => Promise<NewApiTopUpInfo>
  readonly quote: (amount: number) => Promise<string>
  readonly start: (amount: number, method: string) => Promise<NewApiTopUpOrder>
  readonly state: (tradeNo: string) => Promise<NewApiTopUpState>
  /** Current formatted wallet balance. */
  readonly balance: () => string
  /** Refresh the wallet after a paid order. */
  readonly refreshWallet: () => Promise<void>
  readonly copy: () => NovaFlowAccountCopy
  /** Currency prefix for raw gateway money strings (for example `¥`), read when the dialog renders. */
  readonly moneyPrefix: () => string
  /** Localized note naming the site's exchange rate; empty when the site hides it. */
  readonly exchangeHint: () => string
}

// main.ts's protocol.handle shell route serves this document and its renderer assets; the modal requires that route.
const page = 'dsh-app://shell/topup-dialog.html'

/** Escape one HTML attribute value for the payment form. */
function attribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/** Build the auto-submitting gateway form the payment window shows while it redirects. */
export function paymentDocument(order: NewApiTopUpOrder, title: string): string {
  const fields = Object.entries(order.fields).map(([key, value]) =>
    `<input type="hidden" name="${attribute(key)}" value="${attribute(value)}">`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${attribute(title)}</title>
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f6f6f7;color:#3b3f46;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}p{margin:0}</style>
</head><body><p>正在打开支付页面…</p>
<form id="pay" method="post" action="${attribute(order.payUrl)}">${fields}</form>
<script>document.getElementById('pay').submit()</script></body></html>`
}

/** One fade-out backdrop reused for every top-up prompt, plus its gateway window. */
export class DesktopTopUpDialog {
  private disposed = false
  private revision = 0
  private window: DesktopOverlay | undefined
  private parent: BrowserWindow | undefined
  private closing: ReturnType<typeof setTimeout> | undefined
  private payment: BrowserWindow | undefined
  private active: { window: DesktopOverlay; view: TopUpDialogView } | undefined

  /** Whether the top-up prompt is open. */
  get isOpen(): boolean { return this.active !== undefined }

  /**
   * @param preload - Bundled isolated preload for the dialog document.
   * @param overlays - Application-owned overlay creation and input tracking.
   * @param deps - Account operations and localized presentation.
   */
  constructor(private readonly preload: string, private readonly overlays: Pick<DesktopUpdateOverlays, 'create'>,
    private readonly deps: TopUpDialogDeps) {
    ipcMain.handle(TOPUP_DIALOG_IPC.status, (event) => { this.owned(event); return this.active?.view ?? null })
    ipcMain.handle(TOPUP_DIALOG_IPC.quote, (event, amount: unknown) => {
      this.owned(event)
      return this.deps.quote(this.amount(amount))
    })
    ipcMain.handle(TOPUP_DIALOG_IPC.pay, async (event, amount: unknown, method: unknown) => {
      this.owned(event)
      const order = await this.deps.start(this.amount(amount), this.method(method))
      this.openPayment(order)
      return { tradeNo: order.tradeNo }
    })
    ipcMain.handle(TOPUP_DIALOG_IPC.poll, async (event, tradeNo: unknown) => {
      this.owned(event)
      if (typeof tradeNo !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(tradeNo)) throw new Error('desktop top-up: invalid trade number')
      const state = await this.deps.state(tradeNo)
      if (state !== 'paid') return { tradeNo, state }
      await this.deps.refreshWallet()
      if (this.active !== undefined) this.active.view = { ...this.active.view, balanceValue: this.deps.balance() }
      this.closePayment()
      return { tradeNo, state, balanceValue: this.deps.balance() }
    })
    ipcMain.handle(TOPUP_DIALOG_IPC.close, (event) => { this.owned(event); this.close() })
  }

  /**
   * Load the site's configuration and show the dialog over the product window.
   * @param parent - Window the prompt covers.
   */
  async show(parent: BrowserWindow): Promise<void> {
    if (this.disposed || parent.isDestroyed()) return
    if (this.parent !== parent) this.close()
    clearTimeout(this.closing)
    this.closing = undefined
    const view = await this.buildView()
    if (parent.isDestroyed()) return
    const existing = this.window
    const window = existing ?? this.overlays.create(parent, this.preload, view.title, false)
    this.window = window
    this.parent = parent
    this.active = { window, view }
    if (existing !== undefined) { window.webContents.send(TOPUP_DIALOG_IPC.changed, view); return }
    const failed = (): void => { if (this.window === window) this.close() }
    window.once('closed', failed)
    window.webContents.on('will-navigate', (event, url) => { if (url !== page) event.preventDefault() })
    window.webContents.once('render-process-gone', failed)
    void window.loadURL(page).then(() => {
      if (this.window === window) window.webContents.send(TOPUP_DIALOG_IPC.changed, view)
    }).catch(failed)
  }

  /** Close the dialog and any gateway window it opened. */
  close(): void {
    this.active = undefined
    this.closePayment()
    const window = this.window
    this.window = undefined
    this.parent = undefined
    if (window !== undefined && !window.isDestroyed()) window.destroy()
  }

  /** Close the document and detach its private IPC handlers. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.close()
    for (const channel of Object.values(TOPUP_DIALOG_IPC)) if (channel !== TOPUP_DIALOG_IPC.changed) ipcMain.removeHandler(channel)
  }

  private async buildView(): Promise<TopUpDialogView> {
    const copy = this.deps.copy()
    const money = (value: string): string => `${this.deps.moneyPrefix()}${value}`
    let info: NewApiTopUpInfo | undefined
    try { info = await this.deps.info() } catch (_error) { info = undefined }
    const options: TopUpDialogOption[] = []
    for (const amount of info?.amountOptions.slice(0, 8) ?? []) {
      try {
        options.push({ amount, label: money(await this.deps.quote(amount)) })
      } catch (_error) { /* Skip a shortcut the site cannot price. */ }
    }
    return {
      revision: ++this.revision, locale: copy.numberLocale, title: copy.topupTitle, balanceLabel: copy.quotaBalance,
      balanceValue: this.deps.balance(), amountLabel: copy.topupAmountLabel,
      payLabel: copy.topupPay, payingText: copy.topupPaying, waitingText: copy.topupWaiting,
      successText: copy.topupSuccess, failedText: copy.topupFailed, closeLabel: copy.topupClose, finishLabel: copy.topupFinish,
      exchangeHint: this.deps.exchangeHint(), noMethod: copy.topupNoMethod, moneyPrefix: this.deps.moneyPrefix(),
      options, methods: info?.payMethods ?? [],
    }
  }

  private openPayment(order: NewApiTopUpOrder): void {
    this.closePayment()
    const copy = this.deps.copy()
    const window = new BrowserWindow({
      width: 430, height: 660, title: copy.topupTitle, autoHideMenuBar: true,
      ...this.parent === undefined ? {} : { parent: this.parent },
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    })
    window.setMenu(null)
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:/u.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    window.on('closed', () => { if (this.payment === window) this.payment = undefined })
    this.payment = window
    const document = paymentDocument(order, copy.topupTitle)
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`).catch(() => { this.closePayment() })
  }

  private closePayment(): void {
    const window = this.payment
    this.payment = undefined
    if (window !== undefined && !window.isDestroyed()) window.destroy()
  }

  private amount(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
      throw new Error('desktop top-up: invalid amount')
    }
    return value
  }

  private method(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(value)) throw new Error('desktop top-up: invalid payment method')
    return value
  }

  private owned(event: IpcMainInvokeEvent): void {
    const window = this.window
    if (window === undefined || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) {
      throw new Error('desktop top-up: rejected unowned dialog renderer')
    }
  }
}
