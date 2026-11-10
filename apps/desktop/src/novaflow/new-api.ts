/** Standard New API dashboard sessions: login refresh, account discovery and the authenticated chat gateway. */
import { NovaFlowAuthError, concreteGroup, type AccessGrant, type AuthorizationRequest, type CodeExchange, type NovaFlowAuthTransport, type RefreshGrant } from './auth-protocol.ts'
import { NovaFlowUnauthorizedError, readAccountJson } from './account-errors.ts'
import type { NovaFlowWalletQuota } from './account-info.ts'
import type { DesktopCatalogView } from './catalog-controller.ts'
import type { DesktopEndpoint, DesktopModel } from './catalog.ts'
import type { RelayAccess } from './relay-broker.ts'
import { allowedGroup, type DesktopGroup, type GroupSelection } from './group-policy.ts'

/** HttpOnly cookie issued only after the site's complete login verification succeeds. */
export const NEW_API_REFRESH_COOKIE = 'new_api_refresh'
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new NovaFlowAuthError('invalid_response')
  return value as Record<string, unknown>
}

function text(value: unknown, limit: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!allowEmpty && value.length === 0) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new NovaFlowAuthError('invalid_response')
  }
  return value
}

function modelId(value: unknown): string {
  const id = text(value, 512)
  if (id !== id.trim()) throw new NovaFlowAuthError('invalid_response')
  return id
}

function seconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER / 1000) {
    throw new NovaFlowAuthError('invalid_response')
  }
  return value * 1000
}

/**
 * Validate an opaque site refresh cookie and return its session binding.
 * @param value - Cookie value, without its name or attributes.
 * @returns The server-issued session ID.
 */
export function newApiSessionId(value: string): string {
  const parts = value.split('.')
  const sid = parts[0] ?? ''
  if (parts.length !== 2 || !SESSION_ID.test(sid) || !/^[A-Za-z0-9_-]{32,256}$/u.test(parts[1] ?? '')) {
    throw new NovaFlowAuthError('invalid_response')
  }
  return sid
}

/**
 * Decode the dedicated encrypted site-session record; access tokens and passwords are never restored from disk.
 * @param value - Decrypted refresh-only JSON.
 * @param origin - Exact selected server origin.
 * @returns Minimized, origin-bound refresh credential.
 */
export function parseNewApiRefreshRecord(value: unknown, origin: string): RefreshGrant {
  const data = record(value)
  const profile = record(data.profile)
  const refreshToken = text(data.refreshToken, 512)
  const deviceSessionId = newApiSessionId(refreshToken)
  if (data.version !== 1 || data.origin !== origin || data.deviceSessionId !== deviceSessionId
    || typeof data.refreshExpiresAt !== 'number' || !Number.isSafeInteger(data.refreshExpiresAt) || data.refreshExpiresAt <= 0) {
    throw new NovaFlowAuthError('invalid_response')
  }
  const id = text(profile.id, 32)
  if (!/^[1-9]\d*$/u.test(id)) throw new NovaFlowAuthError('invalid_response')
  return { refreshToken, deviceSessionId, refreshExpiresAt: data.refreshExpiresAt, group: concreteGroup(data.group),
    profile: { id, displayName: text(profile.displayName, 256, true) } }
}

/**
 * Validate the rotated dashboard session and project only native account fields.
 * @param value - Standard New API refresh response.
 * @param refreshToken - Successor HttpOnly cookie from the same response.
 * @param now - Current milliseconds.
 * @returns Memory-only access token plus the refresh-only persistence fields.
 */
export function parseNewApiGrant(value: unknown, refreshToken: string, now: number): AccessGrant {
  const envelope = record(value)
  if (envelope.success !== true) throw new NovaFlowAuthError('invalid_grant')
  const data = record(envelope.data)
  const user = record(data.user)
  const session = record(data.session)
  const deviceSessionId = newApiSessionId(refreshToken)
  const accessToken = text(data.access_token, 16384)
  const accessExpiresAt = seconds(data.access_expires_at)
  const refreshExpiresAt = seconds(session.expires_at)
  if (data.token_type !== 'Bearer' || /\s/u.test(accessToken) || session.sid !== deviceSessionId
    || typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id < 1 || user.status !== 1
    || accessExpiresAt <= now || refreshExpiresAt <= accessExpiresAt) throw new NovaFlowAuthError('invalid_response')
  const group = concreteGroup(user.group)
  const displayName = text(user.display_name, 256, true) || text(user.username, 256)
  return { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt, deviceSessionId,
    group, allowedGroups: [group], autoGroups: null, crossGroupRetry: false, canSelectGroup: false,
    profile: { id: String(user.id), displayName } }
}

/** Native-only transport for the site's existing login session; it creates no model or management API key. */
export class NewApiSessionTransport implements NovaFlowAuthTransport {
  private readonly sessionOrigins = new Map<string, string>()
  private readonly sessionGroups = new Map<string, readonly string[]>()
  /**
   * @param origin - Selected, normalized site origin.
   * @param fetcher - Main-process HTTP transport.
   * @param now - Clock for validating response expiries.
   */
  constructor(private readonly origin: () => string, private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now) {}

  /**
   * Complete a site login by exchanging its HttpOnly refresh cookie, without reading page storage or credentials.
   * @param refreshToken - Cookie from the isolated login window.
   * @param signal - Login cancellation.
   * @param loginOrigin - Origin captured when the isolated login window opened.
   * @returns A validated account grant held only by the native broker.
   */
  async exchangeBrowserSession(refreshToken: string, signal: AbortSignal, loginOrigin?: string): Promise<AccessGrant> {
    return this.exchangeSession(refreshToken, signal, loginOrigin)
  }

  private async exchangeSession(
    refreshToken: string, signal: AbortSignal, loginOrigin?: string, selectedGroup?: string,
  ): Promise<AccessGrant> {
    const sid = newApiSessionId(refreshToken)
    const issuer = this.sessionOrigins.get(refreshToken)
    if (issuer !== undefined && loginOrigin !== undefined && issuer !== loginOrigin) throw new NovaFlowAuthError('invalid_response')
    const origin = issuer ?? loginOrigin ?? this.origin()
    this.sessionOrigins.set(refreshToken, origin)
    let successor = ''
    const fetcher: typeof fetch = async (input, init) => {
      const response = await this.fetcher(input, init)
      const cookie = response.headers.getSetCookie().find(item => item.startsWith(`${NEW_API_REFRESH_COOKIE}=`))
      successor = cookie?.split(';', 1)[0]?.slice(NEW_API_REFRESH_COOKIE.length + 1) ?? ''
      return response
    }
    try {
      const value = await readAccountJson(fetcher, `${origin}/api/user/auth/refresh`, {
        method: 'POST', headers: { origin, cookie: `${NEW_API_REFRESH_COOKIE}=${refreshToken}`, 'X-Auth-Session': sid, accept: 'application/json' },
        redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      }, 262144)
      const grant = parseNewApiGrant(value, successor, this.now())
      this.sessionOrigins.set(grant.refreshToken, origin)
      try {
        const groups = await readNewApiGroups(this.fetcher, origin, grant, signal)
        const group = allowedGroup(selectedGroup ?? grant.group, groups.map(item => item.name))
        this.sessionGroups.set(grant.refreshToken, groups.map(item => item.name))
        return { ...grant, group, allowedGroups: groups.map(item => item.name), canSelectGroup: true }
      } catch (_discoveryError) {
        // Rotation consumed the predecessor: revoke the uninstalled successor and require a fresh login.
        try { await this.revoke(grant.refreshToken) }
        catch (_revokeError) { /* Local admission still fails closed when remote cleanup is unavailable. */ }
        throw new NovaFlowAuthError('invalid_grant')
      }
    } catch (error) {
      if (error instanceof NovaFlowUnauthorizedError) throw new NovaFlowAuthError('invalid_grant')
      if (error instanceof NovaFlowAuthError) throw error
      throw new NovaFlowAuthError(signal.aborted ? 'cancelled' : 'network_error')
    }
  }

  refresh(grant: RefreshGrant, signal: AbortSignal): Promise<AccessGrant> {
    return this.exchangeSession(grant.refreshToken, signal, undefined, grant.group)
  }
  authorize(_request: AuthorizationRequest, _signal: AbortSignal): Promise<{ authorizationUrl: string; requestId: string }> {
    return Promise.reject(new NovaFlowAuthError('invalid_response'))
  }
  exchange(_request: CodeExchange, _signal: AbortSignal): Promise<AccessGrant> { return Promise.reject(new NovaFlowAuthError('invalid_response')) }
  selectGroup(grant: RefreshGrant, selection: GroupSelection, signal: AbortSignal): Promise<AccessGrant> {
    if (selection.group === 'auto' || selection.autoGroups !== null || selection.crossGroupRetry) {
      return Promise.reject(new NovaFlowAuthError('group_unavailable'))
    }
    if (!this.sessionGroups.get(grant.refreshToken)?.includes(selection.group)) {
      return Promise.reject(new NovaFlowAuthError('group_unavailable'))
    }
    return this.exchangeSession(grant.refreshToken, signal, undefined, concreteGroup(selection.group))
  }
  cancel(_requestId: string, _codeVerifier: string): Promise<void> { return Promise.resolve() }

  async revoke(refreshToken: string): Promise<void> {
    const sid = newApiSessionId(refreshToken)
    const origin = this.sessionOrigins.get(refreshToken) ?? this.origin()
    const value = await readAccountJson(this.fetcher, `${origin}/api/user/auth/logout`, {
      method: 'POST', headers: { origin, cookie: `${NEW_API_REFRESH_COOKIE}=${refreshToken}`, 'X-Auth-Session': newApiSessionId(refreshToken) },
      redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    }, 8192)
    if (record(value).success !== true) throw new NovaFlowAuthError('invalid_response')
    for (const [token, issuer] of this.sessionOrigins) {
      if (issuer === origin && newApiSessionId(token) === sid) {
        this.sessionOrigins.delete(token)
        this.sessionGroups.delete(token)
      }
    }
  }
}

/** Conservative sizing for models whose authenticated directory does not publish capacities; users can override it. */
export interface NewApiModelDefaults {
  readonly contextWindow: number
  readonly maxOutputTokens: number
}

function data(value: unknown): unknown {
  const envelope = record(value)
  if (envelope.success !== true) throw new NovaFlowAuthError('invalid_response')
  return envelope.data
}

function request(access: RelayAccess, signal: AbortSignal): RequestInit {
  return { headers: { authorization: `Bearer ${access.accessToken}`, accept: 'application/json' },
    redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }
}

/** Decode the concrete routing groups the authenticated site permits for this account. */
function parseNewApiGroups(value: unknown): readonly DesktopGroup[] {
  return Object.entries(record(data(value))).filter(([name]) => name !== 'auto').map(([name, value]) => {
    const group = record(value)
    if (typeof group.ratio !== 'number' || !Number.isFinite(group.ratio) || group.ratio < 0) throw new NovaFlowAuthError('invalid_response')
    return { name: concreteGroup(name), description: text(group.desc, 1024, true), ratio: group.ratio }
  })
}

async function readNewApiGroups(
  fetcher: typeof fetch, origin: string, access: RelayAccess, signal: AbortSignal,
): Promise<readonly DesktopGroup[]> {
  return parseNewApiGroups(await readAccountJson(fetcher, `${origin}/api/user/self/groups`, request(access, signal), 262144))
}

/**
 * Discover only account-allowed models that the site advertises for Chat Completions, the session gateway's protocol.
 * @param fetcher - Main-process transport.
 * @param origin - Selected site.
 * @param access - Broker-owned session access.
 * @param signal - Catalog cancellation.
 * @param defaults - Deployment sizing for missing model capacities.
 * @returns Account-bound metadata with no API keys or dashboard claims.
 */
export async function readNewApiCatalog(fetcher: typeof fetch, origin: string, access: RelayAccess,
  signal: AbortSignal, defaults: NewApiModelDefaults): Promise<DesktopCatalogView> {
  const controller = new AbortController()
  const init = request(access, AbortSignal.any([signal, controller.signal]))
  const reads = [
    readAccountJson(fetcher, `${origin}/api/user/self`, init, 262144),
    readAccountJson(fetcher, `${origin}/api/user/self/groups`, init, 262144),
    readAccountJson(fetcher, `${origin}/api/user/models?group=${encodeURIComponent(access.group)}`, init, 2 * 1024 * 1024),
    readAccountJson(fetcher, `${origin}/api/pricing`, { ...init, headers: { accept: 'application/json' } }, 4 * 1024 * 1024),
  ]
  const [selfJson, groupsJson, modelsJson, pricingJson] = await Promise.all(reads).catch(async (error: unknown) => {
    controller.abort(); await Promise.allSettled(reads); throw error
  })
  concreteGroup(record(data(selfJson)).group)
  const groups = parseNewApiGroups(groupsJson)
  allowedGroup(access.group, groups.map(item => item.name))
  const names = data(modelsJson)
  const pricing = record(pricingJson)
  if (!Array.isArray(names) || names.length > 10000 || pricing.success !== true || !Array.isArray(pricing.data)) {
    throw new NovaFlowAuthError('invalid_response')
  }
  const chatModels = new Set<string>()
  for (const value of pricing.data) {
    const row = record(value)
    if (Array.isArray(row.supported_endpoint_types) && row.supported_endpoint_types.includes('openai')) chatModels.add(modelId(row.model_name))
  }
  const models: DesktopModel[] = [...new Set(names.map(modelId))].filter(name => chatModels.has(name)).map(id => ({
    id, endpoints: ['/v1/chat/completions'], contextWindow: defaults.contextWindow, maxOutputTokens: defaults.maxOutputTokens,
    capacityDefaults: ['contextWindow', 'maxOutputTokens'],
  }))
  return { group: access.group, groups,
    auto: null, routeGroups: [access.group], models }
}

/**
 * Read authoritative account balance; site sessions have no independent device budget.
 * @param fetcher - Native HTTP transport.
 * @param origin - Selected site.
 * @param access - Broker-owned session access.
 * @param signal - Account-generation cancellation.
 * @returns The account meters; device counters are hidden for this session protocol.
 */
export async function readNewApiWallet(fetcher: typeof fetch, origin: string, access: RelayAccess,
  signal: AbortSignal): Promise<NovaFlowWalletQuota> {
  const self = record(data(await readAccountJson(fetcher, `${origin}/api/user/self`, request(access, signal), 262144)))
  if (typeof self.quota !== 'number' || !Number.isSafeInteger(self.quota) || typeof self.used_quota !== 'number'
    || !Number.isSafeInteger(self.used_quota) || self.used_quota < 0) throw new NovaFlowAuthError('invalid_response')
  return { remaining: String(self.quota), accountUsage: String(self.used_quota), deviceUsage: '0', unit: 'quota' }
}

/**
 * Map the private desktop chat route to New API's account-authenticated gateway; never accept arbitrary URLs.
 * @param endpoint - Catalog-validated protocol path.
 * @returns The fixed same-origin session inference endpoint.
 */
export function newApiSessionEndpoint(endpoint: DesktopEndpoint): string {
  if (endpoint !== '/v1/chat/completions') throw new NovaFlowAuthError('invalid_response')
  return '/pg/chat/completions'
}

/** One payment method the authenticated site offers for top-up. */
export interface NewApiPayMethod {
  /** Provider identifier sent back to `/api/user/pay` (for example `alipay`). */
  readonly type: string
  /** Operator-supplied label shown in the dialog. */
  readonly name: string
}

/** The site's authenticated top-up configuration. */
export interface NewApiTopUpInfo {
  /** Whole-dollar amounts the operator offers as shortcuts. */
  readonly amountOptions: readonly number[]
  /** Smallest whole-dollar amount the site accepts. */
  readonly minTopUp: number
  /** Empty when online top-up is disabled or unconfigured. */
  readonly payMethods: readonly NewApiPayMethod[]
}

/** One created payment order: the gateway form the shell posts in its payment window. */
export interface NewApiTopUpOrder {
  readonly tradeNo: string
  readonly payUrl: string
  readonly fields: Readonly<Record<string, string>>
}

/** How one order is progressing server-side. */
export type NewApiTopUpState = 'pending' | 'paid' | 'failed'

/** Upper bound on a top-up amount; keeps decimal math inside New API's integer units. */
const MAX_TOP_UP_AMOUNT = 1_000_000

function wholeAmount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_TOP_UP_AMOUNT) {
    throw new NovaFlowAuthError('invalid_response')
  }
  return value
}

function payMethodType(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(value)) throw new NovaFlowAuthError('invalid_response')
  return value
}

/**
 * Read the authenticated site's top-up form configuration.
 * @param fetcher - Main-process transport.
 * @param origin - Selected site.
 * @param access - Broker-owned session access.
 * @param signal - Dialog cancellation.
 * @returns Shortcut amounts, the minimum, and the payment methods that can be used now.
 */
export async function readNewApiTopUpInfo(fetcher: typeof fetch, origin: string, access: RelayAccess,
  signal: AbortSignal): Promise<NewApiTopUpInfo> {
  const payload = record(data(await readAccountJson(fetcher, `${origin}/api/user/topup/info`, request(access, signal), 65536)))
  const options = Array.isArray(payload.amount_options)
    ? payload.amount_options.filter(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0).slice(0, 12) as number[]
    : []
  const minTopUp = typeof payload.min_topup === 'number' && Number.isSafeInteger(payload.min_topup) && payload.min_topup > 0
    ? payload.min_topup : 1
  if (payload.enable_online_topup !== true) return { amountOptions: options, minTopUp, payMethods: [] }
  const methods = Array.isArray(payload.pay_methods) ? payload.pay_methods.map((value) => {
    const method = record(value)
    return { type: payMethodType(method.type), name: text(method.name, 64) }
  }) : []
  return { amountOptions: options, minTopUp, payMethods: methods }
}

/**
 * Ask the site what one whole-dollar amount costs after its own price and discounts.
 * @param fetcher - Main-process transport.
 * @param origin - Selected site.
 * @param access - Broker-owned session access.
 * @param amount - Whole-dollar top-up amount the user selected.
 * @param signal - Dialog cancellation.
 * @returns The money string the payment gateway receives (for example `7.00`).
 */
export async function quoteNewApiTopUp(fetcher: typeof fetch, origin: string, access: RelayAccess,
  amount: number, signal: AbortSignal): Promise<string> {
  const body = JSON.stringify({ amount: wholeAmount(amount) })
  const init = { ...request(access, signal), method: 'POST', headers: {
    authorization: `Bearer ${access.accessToken}`, accept: 'application/json', 'content-type': 'application/json',
  }, body }
  // This legacy handler answers `{message, data}` without the `success` flag the newer routes carry.
  const envelope = record(await readAccountJson(fetcher, `${origin}/api/user/amount`, init, 16384))
  if (envelope.message !== 'success') throw new NovaFlowAuthError('invalid_response')
  const money = envelope.data
  if (typeof money !== 'string' || !/^\d{1,9}(?:\.\d{1,4})?$/u.test(money)) throw new NovaFlowAuthError('invalid_response')
  return money
}

/**
 * Create one payment order. The shell posts the returned gateway form in its own payment window.
 * @param fetcher - Main-process transport.
 * @param origin - Selected site.
 * @param access - Broker-owned session access.
 * @param request - Whole-dollar amount and the selected payment provider.
 * @param signal - Dialog cancellation.
 * @returns Trade number, gateway URL, and the form fields the gateway expects.
 */
export async function startNewApiTopUp(fetcher: typeof fetch, origin: string, access: RelayAccess,
  request_: { amount: number; method: string }, signal: AbortSignal): Promise<NewApiTopUpOrder> {
  const body = JSON.stringify({ amount: wholeAmount(request_.amount), payment_method: payMethodType(request_.method) })
  const init = { ...request(access, signal), method: 'POST', headers: {
    authorization: `Bearer ${access.accessToken}`, accept: 'application/json', 'content-type': 'application/json',
  }, body }
  const envelope = record(await readAccountJson(fetcher, `${origin}/api/user/pay`, init, 16384))
  if (envelope.message !== 'success') throw new NovaFlowAuthError('invalid_response')
  const order = record(envelope.data)
  const tradeNo = text(order.out_trade_no, 128)
  const payUrl = text(envelope.url, 2048)
  let parsed: URL
  try { parsed = new URL(payUrl) } catch (_error) { throw new NovaFlowAuthError('invalid_response') }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') throw new NovaFlowAuthError('invalid_response')
  const fields: Record<string, string> = {}
  for (const [key, value] of Object.entries(order)) {
    if (!/^[a-zA-Z0-9_]{1,64}$/u.test(key) || key === 'out_trade_no') continue
    if (typeof value === 'string' && value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value)) fields[key] = value
  }
  return { tradeNo, payUrl, fields }
}

/**
 * Read one order's server-side state from the authenticated top-up history.
 * @param fetcher - Main-process transport.
 * @param origin - Selected site.
 * @param access - Broker-owned session access.
 * @param tradeNo - Trade number returned by {@link startNewApiTopUp}.
 * @param signal - Dialog cancellation.
 * @returns `paid` once the gateway callback credited the order.
 */
export async function readNewApiTopUpState(fetcher: typeof fetch, origin: string, access: RelayAccess,
  tradeNo: string, signal: AbortSignal): Promise<NewApiTopUpState> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(tradeNo)) throw new NovaFlowAuthError('invalid_response')
  const payload = record(data(await readAccountJson(fetcher, `${origin}/api/user/topup/self?p=1&size=20`, request(access, signal), 262144)))
  const items = Array.isArray(payload.items) ? payload.items : []
  for (const value of items) {
    const row = record(value)
    if (row.trade_no !== tradeNo) continue
    if (row.status === 'success') return 'paid'
    if (row.status === 'pending') return 'pending'
    return 'failed'
  }
  throw new NovaFlowAuthError('invalid_response')
}

/** One account mode's complete online top-up surface, injected into the desktop runtime. */
export interface NewApiTopUpFace {
  readonly info: typeof readNewApiTopUpInfo
  readonly quote: typeof quoteNewApiTopUp
  readonly start: typeof startNewApiTopUp
  readonly state: typeof readNewApiTopUpState
}
