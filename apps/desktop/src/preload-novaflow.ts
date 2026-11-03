/** Native account page bridge, installed only into the owned application main frame. */
import { contextBridge, ipcRenderer } from 'electron'
import { createNovaFlowAccountUi, novaFlowAccountCopy, type NovaFlowAccountPage, type NovaFlowAccountUiOperations } from './novaflow/account-ui.ts'
import type { NovaFlowDesktopSnapshot } from './novaflow/runtime.ts'
import { NOVAFLOW_ACCESS_MODE } from './novaflow/server-default.ts'

/** Account summary the page's sidebar entry may read; it carries no credentials, group or wallet data. */
export interface NovaFlowSidebarAccount {
  readonly status: 'signed-out' | 'signing-in' | 'signed-in'
  /** Display name, or the account ID when the name is empty; present only while signed in. */
  readonly name?: string
}

/**
 * Project one desktop snapshot to the sidebar entry's summary.
 * @param snapshot - Snapshot from the main process, or null before the runtime exists.
 * @returns The renderer-safe summary.
 */
export function sidebarAccount(snapshot: NovaFlowDesktopSnapshot | null): NovaFlowSidebarAccount {
  const account = snapshot?.account
  if (account === undefined) return { status: 'signed-out' }
  if (account.status !== 'signed-in') return { status: account.status }
  return { status: 'signed-in', name: account.profile.displayName || account.profile.id }
}

/** Shell requests to show the account page, held for the client page until it listens. */
export interface AccountOpenRequests {
  /** Ask every listener to show the page; with none yet, keep one request for the first listener. */
  request(): void
  /**
   * Receive later requests, and a kept one on the next microtask.
   * @param listener - Shows the account page.
   * @returns Stop receiving requests.
   */
  listen(listener: () => void): () => void
}

/**
 * Create the request queue between the main process and the client page.
 * @returns A queue that keeps at most one request made before any listener.
 */
export function createAccountOpenRequests(): AccountOpenRequests {
  const listeners = new Set<() => void>()
  let kept = false
  return {
    request() {
      if (listeners.size === 0) { kept = true; return }
      for (const listener of listeners) listener()
    },
    listen(listener) {
      listeners.add(listener)
      if (kept) {
        kept = false
        queueMicrotask(() => { if (listeners.has(listener)) listener() })
      }
      return () => { listeners.delete(listener) }
    },
  }
}

/** Install the account page bridge without exposing raw IPC or secret-bearing operations. */
export function installNovaFlowAccountUi(): void {
  const operations: NovaFlowAccountUiOperations = {
    state: () => ipcRenderer.invoke('novaflow:state') as Promise<NovaFlowDesktopSnapshot | null>,
    start: () => ipcRenderer.invoke('novaflow:start') as Promise<NovaFlowDesktopSnapshot>,
    cancel: () => ipcRenderer.invoke('novaflow:cancel') as Promise<NovaFlowDesktopSnapshot>,
    signOut: () => ipcRenderer.invoke('novaflow:sign-out') as Promise<{ remoteRevoked: boolean; cancelled?: boolean }>,
    openPage: page => ipcRenderer.invoke('novaflow:open-page', page) as Promise<void>,
    refresh: () => ipcRenderer.invoke('novaflow:refresh') as ReturnType<NovaFlowAccountUiOperations['refresh']>,
    refreshCatalog: () => ipcRenderer.invoke('novaflow:refresh-catalog') as ReturnType<NovaFlowAccountUiOperations['refreshCatalog']>,
    restore: () => ipcRenderer.invoke('novaflow:restore') as ReturnType<NovaFlowAccountUiOperations['restore']>,
    refreshWallet: () => ipcRenderer.invoke('novaflow:refresh-wallet') as Promise<void>,
    selectGroup: selection => ipcRenderer.invoke('novaflow:select-group', selection) as ReturnType<NovaFlowAccountUiOperations['selectGroup']>,
    setServer: origin => ipcRenderer.invoke('novaflow:set-server', origin) as Promise<NovaFlowDesktopSnapshot>,
    subscribe(listener) {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: NovaFlowDesktopSnapshot): void => { listener(snapshot) }
      ipcRenderer.on('novaflow:changed', handler)
      return () => { ipcRenderer.off('novaflow:changed', handler) }
    },
  }
  let restored: Promise<void> | undefined
  const pageOperations: NovaFlowAccountUiOperations = {
    ...operations,
    async state() {
      // Opening the account page restores its native session once.
      restored ??= operations.restore().then(() => {}, (error: unknown) => { restored = undefined; throw error })
      await restored
      return operations.state()
    },
  }
  let ui: NovaFlowAccountPage | undefined
  let chinese: boolean | undefined
  let hosts: { head: HTMLElement; content: HTMLElement } | undefined
  // The page follows the client's <html lang>; a change between Chinese and English re-creates it in place.
  const render = (): void => {
    const current = document.documentElement.lang || navigator.language
    const wantsChinese = current.toLowerCase().startsWith('zh')
    if (ui === undefined || wantsChinese !== chinese) {
      ui?.dispose()
      chinese = wantsChinese
      ui = createNovaFlowAccountUi(document, pageOperations, novaFlowAccountCopy(current))
    }
    if (hosts === undefined) return
    void ui.mount(hosts.head, hosts.content).catch((_mountError: unknown) => { /* A disposed page renders nothing. */ })
  }
  const language = new MutationObserver(() => { render() })
  const opens = createAccountOpenRequests()
  const open = (): void => { opens.request() }
  ipcRenderer.on('novaflow:open', open)
  contextBridge.exposeInMainWorld('dshNovaFlow', {
    accessMode: NOVAFLOW_ACCESS_MODE,
    subscribe(listener: (state: NovaFlowSidebarAccount) => void): () => void {
      let active = true
      let changed = false
      const unsubscribe = operations.subscribe((snapshot) => { changed = true; listener(sidebarAccount(snapshot)) })
      void operations.state().then(
        (snapshot) => { if (active && !changed) listener(sidebarAccount(snapshot)) },
        (_stateError: unknown) => { /* The entry stays signed out until the next change. */ },
      )
      return () => { active = false; unsubscribe() }
    },
    onOpen: (listener: () => void): (() => void) => opens.listen(listener),
    mount(head: unknown, content: unknown): () => void {
      if (!(head instanceof HTMLElement) || !(content instanceof HTMLElement) || !head.isConnected || !content.isConnected) {
        throw new TypeError('novaflow: the account page needs connected head and content hosts')
      }
      const mounted = { head, content }
      hosts = mounted
      language.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
      render()
      return () => {
        if (hosts !== mounted) return
        hosts = undefined
        language.disconnect()
        ui?.unmount()
      }
    },
  })
  window.addEventListener('unload', () => {
    ipcRenderer.off('novaflow:open', open)
    language.disconnect(); ui?.dispose()
  }, { once: true })
}
