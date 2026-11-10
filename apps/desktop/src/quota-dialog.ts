/** Main-owned balance dialog shown when a model request fails for lack of funds. */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { DesktopLocale } from './locale.ts'
import type { DesktopOverlay, DesktopUpdateOverlays } from './update-overlay.ts'

/** Channels available only to the isolated quota-dialog document. */
export const QUOTA_DIALOG_IPC = { status: 'dsh-quota-dialog:status', changed: 'dsh-quota-dialog:changed', respond: 'dsh-quota-dialog:respond' } as const

/** Text and choices supplied by the main process, never by product documents. */
export interface QuotaDialogView {
  /** Identifies the displayed choices; a response from an older prompt is rejected. */
  readonly revision: number
  readonly locale: string
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly balanceLabel: string
  /** Formatted wallet balance, or empty to hide the balance row. */
  readonly balanceValue: string
  readonly buttons: readonly string[]
  readonly cancelId: number
  readonly closeLabel: string
}

/** Content the shell supplies for one balance prompt. */
export interface QuotaDialogContent {
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly balanceLabel: string
  readonly balanceValue: string
  readonly buttons: readonly [string, string]
  readonly cancelId: number
}

/** The document can select only a displayed response index. */
export interface QuotaDialogApi {
  status(): Promise<QuotaDialogView | null>
  respond(revision: number, index: number): Promise<void>
  subscribe(listener: (view: QuotaDialogView | null) => void): () => void
}

// main.ts's protocol.handle shell route serves this document and its renderer assets; the modal requires that route.
const page = 'dsh-app://shell/quota-dialog.html'

/** One fade-out backdrop that is reused for every balance prompt. */
export class DesktopQuotaDialog {
  private disposed = false
  private revision = 0
  private window: DesktopOverlay | undefined
  private parent: BrowserWindow | undefined
  private closing: ReturnType<typeof setTimeout> | undefined
  private active: { window: DesktopOverlay; view: QuotaDialogView; finish: (index: number, retain?: boolean) => void } | undefined

  /** Whether a balance prompt is awaiting a response. */
  get isOpen(): boolean { return this.active !== undefined }

  /**
   * @param preload - Bundled isolated preload.
   * @param locale - Shell-owned copy or a reader of the current UI language.
   * @param overlays - Application-owned overlay creation and input tracking.
   */
  constructor(private readonly preload: string, private readonly locale: DesktopLocale | (() => DesktopLocale),
    private readonly overlays: Pick<DesktopUpdateOverlays, 'create'>) {
    ipcMain.handle(QUOTA_DIALOG_IPC.status, (event) => { this.owned(event); return this.active?.view ?? null })
    ipcMain.handle(QUOTA_DIALOG_IPC.respond, (event, revision: unknown, index: unknown) => {
      this.owned(event)
      const active = this.active
      if (active === undefined || revision !== active.view.revision) throw new Error('desktop quota: stale dialog response')
      if (typeof index !== 'number' || !Number.isInteger(index)
        || (index !== active.view.cancelId && (index < 0 || index >= active.view.buttons.length))) {
        throw new Error('desktop quota: invalid dialog response')
      }
      active.finish(index)
    })
  }

  /**
   * @param parent - Window the prompt covers.
   * @param content - Main-owned localized text and the two response choices.
   * @returns The chosen response index, or the cancel index when the prompt cannot be shown.
   */
  show(parent: BrowserWindow, content: QuotaDialogContent): Promise<number> {
    const locale = typeof this.locale === 'function' ? this.locale() : this.locale
    if (this.disposed || parent.isDestroyed()) return Promise.resolve(content.cancelId)
    if (this.parent !== parent) { this.cancel(); this.close() }
    this.active?.finish(this.active.view.cancelId, true)
    clearTimeout(this.closing)
    this.closing = undefined
    const existing = this.window
    const window = existing ?? this.overlays.create(parent, this.preload, content.title, false)
    this.window = window
    this.parent = parent
    const view: QuotaDialogView = { revision: ++this.revision, locale: locale.id, title: content.title,
      message: content.message, detail: content.detail, balanceLabel: content.balanceLabel,
      balanceValue: content.balanceValue, buttons: content.buttons, cancelId: content.cancelId,
      closeLabel: locale.messages.updateClose }
    return new Promise((resolve) => {
      const finish = (response: number, retain = false): void => {
        if (this.active?.view !== view) return
        this.active = undefined
        if (!retain && !window.isDestroyed()) {
          window.webContents.send(QUOTA_DIALOG_IPC.changed, null)
          this.closing = setTimeout(() => { this.close() }, 150)
        }
        resolve(response)
      }
      this.active = { window, view, finish }
      if (existing !== undefined) { window.webContents.send(QUOTA_DIALOG_IPC.changed, view); return }
      const failed = (): void => { if (this.window === window) { this.cancel(); this.close() } }
      window.once('closed', failed)
      window.webContents.on('will-navigate', (event, url) => { if (url !== page) event.preventDefault() })
      window.webContents.once('render-process-gone', failed)
      void window.loadURL(page).catch(failed)
    })
  }

  /** Cancel the displayed prompt without opening the wallet. */
  cancel(): void { this.active?.finish(this.active.view.cancelId) }

  /** Close the document and detach its private IPC handlers. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel()
    this.close()
    ipcMain.removeHandler(QUOTA_DIALOG_IPC.status)
    ipcMain.removeHandler(QUOTA_DIALOG_IPC.respond)
  }

  private close(): void {
    clearTimeout(this.closing)
    this.closing = undefined
    const window = this.window
    this.window = undefined
    this.parent = undefined
    if (window !== undefined && !window.isDestroyed()) {
      // Release Windows modality before destruction so another application cannot become active.
      if (process.platform === 'win32' && window.isVisible()) window.hide()
      window.destroy()
    }
  }

  private owned(event: IpcMainInvokeEvent): boolean {
    const window = this.window
    if (window === undefined || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) {
      throw new Error('desktop quota: rejected unowned dialog renderer')
    }
    return true
  }
}
