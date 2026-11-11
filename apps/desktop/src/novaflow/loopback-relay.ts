/** Private HTTP transport from the trusted Host subprocess to the native account relay. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { finished } from 'node:stream/promises'
import type { DesktopEndpoint } from './catalog.ts'
import type { NovaFlowDesktopRuntime } from './runtime.ts'

/** Explicit native limits; the runtime is never exposed through renderer IPC. */
export interface NovaFlowCollectRelayOptions {
  /** Collect service base URL, without a trailing slash or path suffix. */
  readonly origin: () => string
  /** Current authenticated account bearer, read from the native broker for each forwarded request. */
  readonly access: () => Promise<string>
  /** Local path prefix the Host calls; defaults to `/novaflow/collect`. */
  readonly pathPrefix?: string
}

/** Explicit native limits; the runtime is never exposed through renderer IPC. */
export interface NovaFlowLoopbackRelayOptions {
  readonly runtime: Pick<NovaFlowDesktopRuntime, 'invoke' | 'getRelayRevision'>
  readonly maxRequestBytes: number
  readonly maxConcurrentRequests: number
  /** Bounds receipt of local headers/body, without timing out upstream inference streams. */
  readonly requestTimeoutMs: number
  /** When present, deny account-transition requests before and after body receipt; absence admits normally. */
  readonly admit?: () => boolean
  /** Notified once per rejected quota failure so the shell can offer a top-up without reading the stream. */
  readonly onAccountQuotaExhausted?: () => void
  /** When present, also forwards collect-service requests carrying the account token. */
  readonly collect?: NovaFlowCollectRelayOptions
}

/** Transfer only through trusted subprocess IPC; neither field belongs in renderer state or logs. */
export interface NovaFlowLoopbackRelay {
  readonly baseURL: string
  readonly localCapability: string
  /** Stop admission, abort streams, and wait for all owned work and sockets to stop. */
  close(): Promise<void>
}

class LocalRequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

/** An error response is small JSON; anything larger is forwarded unread rather than buffered. */
const MAX_ERROR_BODY_BYTES = 64 * 1024

/** Quota wording a gateway returns both for a depleted balance and for an exhausted subscription. */
const QUOTA_FAILURE = new RegExp([
  String.raw`\binsufficient[\s_-]+(?:\w+[\s_-]+){0,2}(?:quota|balance|credits?)\b`,
  String.raw`\b(?:quota|balance)[\s_-]+(?:exceeded|exhausted|reached)\b`,
  String.raw`\b402\b`,
].join('|'), 'i')

async function readErrorText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (body === null) return ''
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > MAX_ERROR_BODY_BYTES) {
        await reader.cancel().catch((_cancelError: unknown) => {
          // A body already ended by the upstream cannot be cancelled; the partial text is still useful.
        })
        break
      }
      chunks.push(Buffer.from(chunk.value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

function quotaFailure(text: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return QUOTA_FAILURE.test(text)
  }
  if (typeof parsed !== 'object' || parsed === null || !('error' in parsed)) return QUOTA_FAILURE.test(text)
  const error: unknown = parsed.error
  if (typeof error !== 'object' || error === null) return QUOTA_FAILURE.test(text)
  const detail = error as { code?: unknown; message?: unknown }
  return (typeof detail.code === 'string' && QUOTA_FAILURE.test(detail.code))
    || (typeof detail.message === 'string' && QUOTA_FAILURE.test(detail.message))
}

/** Forward a rejected upstream response, turning an exhausted balance into 402 so callers classify it as quota. */
async function relayFailure(
  upstream: Response, response: ServerResponse, onQuotaExhausted: (() => void) | undefined, signal: AbortSignal,
): Promise<void> {
  const text = await readErrorText(upstream.body)
  signal.throwIfAborted()
  const quota = quotaFailure(text)
  if (quota) onQuotaExhausted?.()
  const headers: Record<string, string> = {
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close',
  }
  const contentType = upstream.headers.get('content-type')
  if (contentType !== null) headers['content-type'] = contentType
  const retryAfter = upstream.headers.get('retry-after')
  if (retryAfter !== null && /^\d+$/u.test(retryAfter)) headers['retry-after'] = retryAfter
  response.writeHead(quota ? 402 : upstream.status, headers)
  response.end(text)
  await finished(response, { cleanup: true })
}

/** Local path the Host uses for collect-service forwarding; the entitlement module appends `/v1/*`. */
const COLLECT_PATH_PREFIX = '/novaflow/collect'

/** @returns whether the request target addresses the collect-service relay. */
function isCollectPath(url: string | undefined, prefix: string): boolean {
  return url !== undefined && (url === prefix || url.startsWith(`${prefix}/`))

}

function headerCount(request: IncomingMessage, name: string): number {
  let count = 0
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count++
  }
  return count
}

function endpointFor(path: string | undefined): DesktopEndpoint {
  switch (path) {
    case '/v1/chat/completions':
    case '/v1/responses':
    case '/v1/messages': return path
    case '/v1/messages?beta=true': return '/v1/messages'
    default: throw new LocalRequestError(404, 'unknown_endpoint')
  }
}

function authorize(request: IncomingMessage, host: string, authorization: Buffer): DesktopEndpoint {
  if (headerCount(request, 'origin') !== 0 || request.method === 'OPTIONS') {
    throw new LocalRequestError(403, 'browser_requests_forbidden')
  }
  if (headerCount(request, 'host') !== 1 || request.headers.host !== host) {
    throw new LocalRequestError(403, 'invalid_host')
  }
  const endpoint = endpointFor(request.url)
  const apiKeyAuth = endpoint === '/v1/messages' && headerCount(request, 'authorization') === 0
    && headerCount(request, 'x-api-key') === 1 && typeof request.headers['x-api-key'] === 'string'
  const supplied = Buffer.from(apiKeyAuth ? `Bearer ${String(request.headers['x-api-key'])}` : request.headers.authorization ?? '', 'utf8')
  if ((!apiKeyAuth && headerCount(request, 'authorization') !== 1) || supplied.length !== authorization.length
    || !timingSafeEqual(supplied, authorization)) {
    throw new LocalRequestError(401, 'unauthorized')
  }
  if (request.method !== 'POST') throw new LocalRequestError(405, 'method_not_allowed')
  if (headerCount(request, 'content-type') !== 1
    || !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(request.headers['content-type'] ?? '')
    || headerCount(request, 'content-encoding') !== 0) {
    throw new LocalRequestError(415, 'json_required')
  }
  return endpoint
}

function revisionFor(request: IncomingMessage): number {
  const value = request.headers['x-novaflow-revision']
  if (headerCount(request, 'x-novaflow-revision') !== 1 || typeof value !== 'string'
    || !/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new LocalRequestError(400, 'invalid_relay_revision')
  }
  return Number(value)
}

async function readJSON(request: IncomingMessage, maxBytes: number, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
  const length = request.headers['content-length']
  if (length !== undefined && Number(length) > maxBytes) throw new LocalRequestError(413, 'request_too_large')
  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    const cleanup = () => {
      clearTimeout(timer)
      request.off('data', onData)
      request.off('end', onEnd)
      signal.removeEventListener('abort', onAbort)
    }
    const fail = (error: Error) => { cleanup(); request.pause(); reject(error) }
    const onAbort = () => { fail(new LocalRequestError(400, 'request_cancelled')) }
    const onData = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBytes) { fail(new LocalRequestError(413, 'request_too_large')); return }
      chunks.push(chunk)
    }
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, bytes)) }
    const timer = setTimeout(() => { fail(new LocalRequestError(408, 'request_timeout')) }, timeoutMs)
    timer.unref()
    request.on('data', onData)
    request.once('end', onEnd)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) }
  catch (_parseError) { throw new LocalRequestError(400, 'invalid_json') }
}

function failure(response: ServerResponse, error: unknown): void {
  if (response.destroyed) return
  if (response.headersSent) { response.destroy(); return }
  const status = error instanceof LocalRequestError ? error.status : 502
  const code = error instanceof LocalRequestError ? error.code : 'relay_unavailable'
  response.writeHead(status, {
    'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', connection: 'close',
  })
  response.end(JSON.stringify({ error: { code, message: code } }))
}

async function streamResponse(upstream: Response, response: ServerResponse, signal: AbortSignal): Promise<void> {
  const reader = upstream.body?.getReader()
  let cancellation: Promise<void> | undefined
  const cancel = () => {
    if (reader === undefined || cancellation !== undefined) return
    cancellation = reader.cancel().catch((_cancelError: unknown) => {
      // A failed upstream stream may reject cancellation; its reader still needs releasing.
    })
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted) cancel()
    signal.throwIfAborted()
    const headers: Record<string, string> = {
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close',
    }
    const contentType = upstream.headers.get('content-type')
    if (contentType !== null) headers['content-type'] = contentType
    const retryAfter = upstream.headers.get('retry-after')
    if (retryAfter !== null && /^\d+$/u.test(retryAfter)) headers['retry-after'] = retryAfter
    response.writeHead(upstream.status, headers)
    response.flushHeaders()
    if (reader !== undefined) {
      while (true) {
        const chunk = await reader.read()
        signal.throwIfAborted()
        if (chunk.done) break
        if (!response.write(chunk.value)) await once(response, 'drain', { signal })
      }
    }
    response.end()
    await finished(response, { cleanup: true })
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    await cancellation
    reader?.releaseLock()
  }
}

/** Constant-time capability check for collect forwarding; the Host never reuses the model Authorization header. */
function authorizeCollect(request: IncomingMessage, host: string, localCapability: string): void {
  if (headerCount(request, 'origin') !== 0 || request.method === 'OPTIONS') {
    throw new LocalRequestError(403, 'browser_requests_forbidden')
  }
  if (headerCount(request, 'host') !== 1 || request.headers.host !== host) {
    throw new LocalRequestError(403, 'invalid_host')
  }
  const capability = request.headers['x-novaflow-capability']
  const supplied = Buffer.from(typeof capability === 'string' ? capability : '', 'utf8')
  const expected = Buffer.from(localCapability, 'utf8')
  if (headerCount(request, 'x-novaflow-capability') !== 1 || typeof capability !== 'string'
    || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new LocalRequestError(401, 'unauthorized')
  }
  if (request.method !== 'GET' && request.method !== 'POST') throw new LocalRequestError(405, 'method_not_allowed')
}

/**
 * Forward one collect-service request to the configured origin with the account's access token.
 * The caller chooses only a `/v1/*` suffix; credentials, headers, and cookies are never forwarded.
 * @param request - admitted Host request bound for the collect service.
 * @param response - local response carrying the collect service's status and body.
 * @param controller - per-request abort source tied to the local connection.
 * @param collect - origin and token provider supplied by the desktop shell.
 * @param host - exact loopback host the listener advertises.
 * @param localCapability - minted capability required from the Host.
 */
async function serveCollect(
  request: IncomingMessage, response: ServerResponse, controller: AbortController,
  collect: NovaFlowCollectRelayOptions, host: string, localCapability: string,
): Promise<void> {
  authorizeCollect(request, host, localCapability)
  const prefix = collect.pathPrefix ?? COLLECT_PATH_PREFIX
  const rawURL = request.url ?? ''
  const suffix = rawURL.slice(prefix.length)
  if (!suffix.startsWith('/v1/')) throw new LocalRequestError(404, 'unknown_endpoint')
  let payload: unknown
  if (request.method === 'POST') {
    if (headerCount(request, 'content-type') !== 1
      || !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(request.headers['content-type'] ?? '')
      || headerCount(request, 'content-encoding') !== 0) {
      throw new LocalRequestError(415, 'json_required')
    }
    payload = await readJSON(request, 1 * 1024 * 1024, 60_000, controller.signal)
  }
  let accessToken: string
  try {
    accessToken = await collect.access()
  } catch (_accessError) {
    throw new LocalRequestError(503, 'account_unavailable')
  }
  const target = `${collect.origin().replace(/\/+$/u, '')}${suffix}`
  const timeout = AbortSignal.timeout(Math.min(60_000, 2_147_483_647))
  const post = request.method === 'POST'
  const init: RequestInit = {
    method: post ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${accessToken}`, ...post ? { 'content-type': 'application/json' } : {} },
    signal: AbortSignal.any([controller.signal, timeout]),
  }
  if (post) init.body = JSON.stringify(payload)
  let upstream: Response
  try {
    upstream = await fetch(target, init)
  } catch (_fetchError) {
    throw new LocalRequestError(503, 'collect_unavailable')
  }
  const headers: Record<string, string> = {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close',
  }
  const text = await upstream.text()
  response.writeHead(upstream.status, headers)
  response.end(text)
}

/**
 * Bind a fresh IPv4 loopback listener and mint a 256-bit capability used only by the trusted Host.
 * Each request requires local capability authentication (Bearer, or Anthropic x-api-key) and its prepared positive x-novaflow-revision.
 * No destination, account credential, or caller header is forwarded to the upstream runtime.
 * @param options - private invocation dependency and explicit resource limits.
 * @returns listener coordinates and idempotent asynchronous shutdown; baseURL has no protocol-path suffix.
 */
export async function startNovaFlowLoopbackRelay(options: NovaFlowLoopbackRelayOptions): Promise<NovaFlowLoopbackRelay> {
  for (const limit of [options.maxRequestBytes, options.maxConcurrentRequests, options.requestTimeoutMs]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('novaflow: invalid local relay limit')
  }
  if (options.requestTimeoutMs > 2_147_483_647) throw new Error('novaflow: invalid local relay timeout')
  const localCapability = randomBytes(32).toString('base64url')
  const authorization = Buffer.from(`Bearer ${localCapability}`, 'utf8')
  const active = new Set<AbortController>()
  const pending = new Set<Promise<void>>()
  const sockets = new Set<Socket>()
  let closing = false
  let host = ''
  let closePromise: Promise<void> | undefined
  const server = createServer({
    maxHeaderSize: 8 * 1024,
    headersTimeout: options.requestTimeoutMs,
    requestTimeout: options.requestTimeoutMs,
    connectionsCheckingInterval: options.requestTimeoutMs,
  }, (request, response) => {
    const task = serve(request, response)
    pending.add(task)
    void task.then(() => { pending.delete(task) })
  })

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController()
    const abort = () => { controller.abort() }
    const close = () => { if (!response.writableFinished) abort() }
    request.on('error', abort)
    request.once('aborted', abort)
    response.on('error', abort)
    response.once('close', close)
    let admitted = false
    try {
      if (closing) throw new LocalRequestError(503, 'relay_closed')
      if (options.admit?.() === false) throw new LocalRequestError(503, 'account_unavailable')
      if (options.collect !== undefined && isCollectPath(request.url, options.collect.pathPrefix ?? COLLECT_PATH_PREFIX)) {
        await serveCollect(request, response, controller, options.collect, host, localCapability)
        return
      }
      const endpoint = authorize(request, host, authorization)
      const revision = revisionFor(request)
      if (revision !== options.runtime.getRelayRevision()) throw new LocalRequestError(409, 'stale_relay_revision')
      if (active.size >= options.maxConcurrentRequests) throw new LocalRequestError(429, 'relay_busy')
      active.add(controller)
      admitted = true
      const payload = await readJSON(request, options.maxRequestBytes, options.requestTimeoutMs, controller.signal)
      controller.signal.throwIfAborted()
      if (options.admit?.() === false) throw new LocalRequestError(503, 'account_unavailable')
      if (revision !== options.runtime.getRelayRevision()) throw new LocalRequestError(409, 'stale_relay_revision')
      const result = await options.runtime.invoke(endpoint, payload, controller.signal, revision)
      if (result.response.status >= 400) {
        await relayFailure(result.response, response, options.onAccountQuotaExhausted, controller.signal)
        return
      }
      await streamResponse(result.response, response, controller.signal)
    } catch (error) {
      failure(response, error)
      await finished(response, { cleanup: true }).catch((_responseError: unknown) => {
        // Local disconnection is already reflected in cancellation; never emit transport diagnostics.
      })
    } finally {
      if (!request.complete) {
        request.destroy()
        await finished(request, { cleanup: true }).catch((_requestError: unknown) => {
          // Incomplete uploads must stop before their final error listener is removed.
        })
      }
      if (admitted) active.delete(controller)
      request.off('error', abort)
      request.off('aborted', abort)
      response.off('error', abort)
      response.off('close', close)
    }
  }

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
    if (closing) socket.destroy()
  })
  // Neither protocol upgrade nor Expect negotiation bypasses the ordinary admission checks.
  server.on('upgrade', (_request, socket) => { socket.destroy() })
  server.on('connect', (_request, socket) => { socket.destroy() })
  server.on('checkContinue', (request, response) => { failure(response, new LocalRequestError(417, 'expectation_failed')); request.resume() })
  server.on('checkExpectation', (request, response) => { failure(response, new LocalRequestError(417, 'expectation_failed')); request.resume() })
  await new Promise<void>((resolve, reject) => {
    const onError = () => { reject(new Error('novaflow: local relay unavailable')) }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.off('error', onError); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('novaflow: local relay unavailable')
  }
  host = `127.0.0.1:${address.port}`
  function close(): Promise<void> {
    closePromise ??= (async () => {
      closing = true
      const stopped = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      for (const controller of active) controller.abort()
      for (const socket of sockets) socket.destroy()
      await stopped
      await Promise.all([...pending])
    })()
    return closePromise
  }
  server.on('error', () => { void close() })
  return {
    baseURL: `http://${host}`,
    localCapability,
    close,
  }
}
