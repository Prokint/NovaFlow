/** Isolated response-only bridge for the shell-owned balance dialog. */
import { contextBridge, ipcRenderer } from 'electron'
import { QUOTA_DIALOG_IPC, type QuotaDialogApi, type QuotaDialogView } from './quota-dialog.ts'

const api: QuotaDialogApi = {
  status: () => ipcRenderer.invoke(QUOTA_DIALOG_IPC.status) as Promise<QuotaDialogView | null>,
  respond: (revision, index) => ipcRenderer.invoke(QUOTA_DIALOG_IPC.respond, revision, index) as Promise<void>,
  subscribe: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, view: QuotaDialogView | null): void => { listener(view) }
    ipcRenderer.on(QUOTA_DIALOG_IPC.changed, receive)
    return () => { ipcRenderer.removeListener(QUOTA_DIALOG_IPC.changed, receive) }
  },
}
if (location.href === 'dsh-app://shell/quota-dialog.html') contextBridge.exposeInMainWorld('dshQuotaDialog', api)
