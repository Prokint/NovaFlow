/** Isolated bridge for the shell-owned top-up dialog; it only exposes order operations. */
import { contextBridge, ipcRenderer } from 'electron'
import { TOPUP_DIALOG_IPC, type TopUpDialogApi, type TopUpDialogView } from './topup-dialog.ts'

const api: TopUpDialogApi = {
  status: () => ipcRenderer.invoke(TOPUP_DIALOG_IPC.status) as Promise<TopUpDialogView | null>,
  quote: amount => ipcRenderer.invoke(TOPUP_DIALOG_IPC.quote, amount) as Promise<string>,
  pay: (amount, method) => ipcRenderer.invoke(TOPUP_DIALOG_IPC.pay, amount, method) as Promise<{ tradeNo: string }>,
  poll: tradeNo => ipcRenderer.invoke(TOPUP_DIALOG_IPC.poll, tradeNo) as Promise<{ tradeNo: string; state: 'pending' | 'paid' | 'failed'; balanceValue?: string }>,
  close: () => { void ipcRenderer.invoke(TOPUP_DIALOG_IPC.close) },
  subscribe: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, view: TopUpDialogView | null): void => { listener(view) }
    ipcRenderer.on(TOPUP_DIALOG_IPC.changed, receive)
    return () => { ipcRenderer.removeListener(TOPUP_DIALOG_IPC.changed, receive) }
  },
}
if (location.href === 'dsh-app://shell/topup-dialog.html') contextBridge.exposeInMainWorld('dshTopUpDialog', api)
