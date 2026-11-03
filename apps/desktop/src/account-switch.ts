/** Serializes account changes so an earlier Host and renderer cannot survive into another account. */
import type { DesktopAccountScope } from './account-scopes.ts'

/** Native lifecycle effects; stop and start settle only after their owned processes have stopped or become ready. */
export interface DesktopAccountSwitchOptions {
  block(): void
  stop(): Promise<void>
  prepare(scope: DesktopAccountScope): Promise<void>
  start(scope: DesktopAccountScope): Promise<void>
  reveal(scope: DesktopAccountScope): Promise<void>
  failed(error: unknown): void
}

/** Latest account wins; all state-changing work remains serialized and failures keep access blocked. */
export class DesktopAccountSwitch {
  private wanted: { scope: DesktopAccountScope } | undefined
  private settledKey: string
  private pending: Promise<void> | undefined
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(initial: DesktopAccountScope, private readonly options: DesktopAccountSwitchOptions) { this.settledKey = initial.key }

  /**
   * Hide and revoke access synchronously, then replace the account's process and document after quiescent teardown.
   * @param scope - Native-resolved next account.
   * @returns Completion of this request; a superseded request never reveals its account.
   */
  select(scope: DesktopAccountScope): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.wanted?.scope.key === scope.key && this.pending !== undefined) return this.pending
    if (this.wanted === undefined && this.settledKey === scope.key) return Promise.resolve()
    const request = { scope }
    this.wanted = request
    this.options.block()
    const operation = this.tail.then(async () => {
      await this.options.stop()
      if (!this.isCurrent(request)) return
      await this.options.prepare(scope)
      if (!this.isCurrent(request)) return
      await this.options.start(scope)
      if (!this.isCurrent(request)) { await this.options.stop(); return }
      await this.options.reveal(scope)
      if (this.isCurrent(request)) { this.settledKey = scope.key; this.wanted = undefined }
    }).catch((error: unknown) => {
      if (this.isCurrent(request)) { this.options.block(); this.options.failed(error) }
      throw error
    }).finally(() => { if (this.pending === operation) this.pending = undefined })
    this.pending = operation
    // The requesting caller owns reporting; later selections still run after a failed request.
    this.tail = operation.catch((_reportedFailure: unknown) => {})
    return operation
  }

  /** Cancel later activation and wait for already-started lifecycle work; the caller also closes its backend. */
  async close(): Promise<void> { this.closed = true; this.wanted = undefined; await this.tail }

  private isCurrent(request: { scope: DesktopAccountScope }): boolean { return this.wanted === request && !this.closed }
}
