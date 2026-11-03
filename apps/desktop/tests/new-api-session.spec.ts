import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { NewApiSessionTransport, newApiSessionEndpoint, parseNewApiGrant, parseNewApiRefreshRecord, readNewApiCatalog, readNewApiWallet } from '../src/novaflow/new-api.ts'
import { NovaFlowDesktopRuntime } from '../src/novaflow/runtime.ts'
import { ServerOriginSetting } from '../src/novaflow/server-origin.ts'
import type { AccessGrant, RefreshGrant } from '../src/novaflow/auth-protocol.ts'

const sid = 'a3851245-c3e5-4e2b-8b78-6ac18c57c835'
const refresh = `${sid}.${'a'.repeat(43)}`
const now = Date.now()
const response = () => ({ success: true, data: {
  token_type: 'Bearer', access_token: 'dashboard-memory-only-token', access_expires_at: Math.floor(now / 1000) + 900,
  session: { sid, expires_at: Math.floor(now / 1000) + 86400 },
  user: { id: 42, username: 'alice', display_name: 'Alice', group: 'default', status: 1, role: 100, email: 'private@example.test' },
} })

describe('New API session boundary', () => {
  it('minimizes identity and keeps passwords, claims and access tokens out of the persisted projection', () => {
    const grant = parseNewApiGrant(response(), refresh, now)
    const stored = parseNewApiRefreshRecord({ version: 1, origin: 'https://relay.example', ...grant, password: 'never-store' }, 'https://relay.example')
    expect(stored).toEqual({ refreshToken: refresh, refreshExpiresAt: grant.refreshExpiresAt, deviceSessionId: sid,
      profile: { id: '42', displayName: 'Alice' }, group: 'default' })
    expect(JSON.stringify(stored)).not.toContain('dashboard-memory-only-token')
    expect(JSON.stringify(stored)).not.toContain('private@example.test')
    expect(() => parseNewApiRefreshRecord({ version: 1, origin: 'https://other.example', ...grant }, 'https://relay.example')).toThrow()
    expect(() => parseNewApiRefreshRecord({ version: 1, origin: 'https://relay.example', ...grant, refreshToken: grant.accessToken }, 'https://relay.example')).toThrow()
  })

  it('rejects mismatched sessions, invalid expiries and non-chat session routes', () => {
    const value = response()
    value.data.session.sid = randomUUID()
    expect(() => parseNewApiGrant(value, refresh, now)).toThrow()
    expect(() => parseNewApiGrant(response(), refresh, now + 900001)).toThrow()
    expect(newApiSessionEndpoint('/v1/chat/completions')).toBe('/pg/chat/completions')
    expect(() => newApiSessionEndpoint('/v1/responses')).toThrow()
  })

  it('pins revocation to the issuer when the selected site changes during a login', async () => {
    let origin = 'https://issuer.example'
    const calls: string[] = []
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      if (url.endsWith('/groups')) return Response.json({ success: true, data: { default: { desc: 'Default', ratio: 1 } } })
      return new Response(JSON.stringify(url.endsWith('/refresh') ? response() : { success: true }), {
        headers: { 'content-type': 'application/json', 'set-cookie': `new_api_refresh=${refresh}; HttpOnly; Path=/api/user/auth` },
      })
    }
    const transport = new NewApiSessionTransport(() => origin, fetcher, () => now)
    await transport.exchangeBrowserSession(refresh, new AbortController().signal)
    origin = 'https://unrelated.example'
    await transport.revoke(refresh)
    expect(calls).toEqual(['https://issuer.example/api/user/auth/refresh', 'https://issuer.example/api/user/self/groups', 'https://issuer.example/api/user/auth/logout'])
  })
})

/** One private server exercises the production session broker, discovery, relay and restart without a model API key. */
async function fixture() {
  const requests: { path: string; cookie: string; authorization: string; origin: string; body: string }[] = []
  let rotation = 0
  const expires = Math.floor(Date.now() / 1000) + 86400
  let origin = ''
  const self = { id: 42, username: 'alice', display_name: 'Alice', group: 'default', status: 1, quota: 100000, used_quota: 75 }
  async function respond(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    const record = { path: req.url ?? '', cookie: req.headers.cookie ?? '', authorization: req.headers.authorization ?? '', origin: req.headers.origin ?? '', body }
    requests.push(record)
    res.setHeader('content-type', 'application/json')
    if (record.path === '/api/user/auth/refresh') {
      rotation++
      res.setHeader('set-cookie', `new_api_refresh=${sid}.${String.fromCharCode(98 + rotation).repeat(43)}; HttpOnly; Path=/api/user/auth`)
      res.end(JSON.stringify({ success: true, data: { token_type: 'Bearer', access_token: `dashboard-memory-${rotation}`,
        access_expires_at: Math.floor(Date.now() / 1000) + 900, session: { sid, expires_at: expires }, user: self } }))
    } else if (record.path === '/api/user/self') res.end(JSON.stringify({ success: true, data: self }))
    else if (record.path === '/api/user/self/groups') res.end(JSON.stringify({ success: true, data: { default: { desc: 'Default', ratio: 1 }, vip: { desc: 'VIP', ratio: 2 } } }))
    else if (record.path === '/api/user/models?group=default' || record.path === '/api/user/models?group=vip') res.end(JSON.stringify({ success: true, data: ['chat-model', 'embedding-model'] }))
    else if (record.path === '/api/pricing') res.end(JSON.stringify({ success: true, data: [
      { model_name: 'chat-model', supported_endpoint_types: ['openai'] },
      { model_name: 'embedding-model', supported_endpoint_types: ['openai-embedding'] },
      { model_name: 'not-allowed', supported_endpoint_types: ['openai'] },
    ] }))
    else if (record.path === '/api/status') res.end(JSON.stringify({ success: true, data: {} }))
    else if (record.path === '/pg/chat/completions') {
      res.setHeader('content-type', 'text/event-stream')
      res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n')
    } else if (record.path === '/api/user/auth/logout') res.end(JSON.stringify({ success: true }))
    else { res.statusCode = 404; res.end('{}') }
  }
  const server = createServer((req, res) => {
    void respond(req, res).catch((error: unknown) => { res.destroy(error instanceof Error ? error : new Error('Fixture request failed', { cause: error })) })
  })
  server.listen(0, '127.0.0.1')
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  })
  await once(server, 'listening')
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let saved: RefreshGrant | null = null
  const store = {
    assertAvailable() {}, load: async () => saved,
    save: async (grant: RefreshGrant) => { saved = structuredClone(grant) }, clear: async () => { saved = null },
  }
  const transport = new NewApiSessionTransport(() => origin)
  const createRuntime = (interactiveSignIn: (origin: string, signal: AbortSignal) => Promise<AccessGrant>
    = (_origin, signal) => transport.exchangeBrowserSession(refresh, signal)) => {
    const runtime = new NovaFlowDesktopRuntime({ server: new ServerOriginSetting(undefined, origin), fetch, transport, store,
      deviceName: 'fixture', maxRequestBytes: 65536, openExternal: async () => {}, accountMode: 'site-session',
      interactiveSignIn,
      readCatalog: (site, access, signal) => readNewApiCatalog(fetch, site, access, signal,
        { contextWindow: 65536, maxOutputTokens: 8192 }),
      readWalletQuota: readNewApiWallet, endpointPath: newApiSessionEndpoint })
    onTestFinished(() => runtime.dispose())
    return runtime
  }
  return { createRuntime, requests, origin, saved: () => saved }
}

it('revokes a late interactive grant after cancellation without saving or reopening the account', async () => {
  const f = await fixture()
  const pending = Promise.withResolvers<AccessGrant>()
  const grant = parseNewApiGrant(response(), refresh, now)
  const runtime = f.createRuntime(() => pending.promise)
  try {
    await runtime.startSignIn()
    await runtime.cancelSignIn()
    pending.resolve(grant)
    await vi.waitFor(() => { expect(f.requests.some(row => row.path === '/api/user/auth/logout')).toBe(true) })
    expect(runtime.getSnapshot().account.status).toBe('signed-out')
    expect(f.saved()).toBeNull()
  } finally { pending.resolve(grant); await runtime.dispose() }
})

it('signs in, discovers account models, streams chat and restores on restart without issuing any API key', async () => {
  const f = await fixture()
  const runtime = f.createRuntime()
  await runtime.startSignIn()
  await vi.waitFor(() => {
    expect(runtime.getSnapshot().catalogStatus).toBe('ready')
    expect(runtime.getSnapshot().walletStatus).toBe('ready')
  })
  const snapshot = runtime.getSnapshot()
  expect(snapshot.accountMode).toBe('site-session')
  expect(snapshot.account.status).toBe('signed-in')
  expect(snapshot.account).toMatchObject({ canSelectGroup: true, allowedGroups: ['default', 'vip'] })
  expect(snapshot.catalog?.models.map(model => model.id)).toEqual(['chat-model'])
  expect(snapshot.wallet).toMatchObject({ remaining: '100000', accountUsage: '75' })
  expect(JSON.stringify(snapshot)).not.toContain('dashboard-memory')
  expect(JSON.stringify(f.saved())).not.toContain('accessToken')
  const result = await runtime.invoke('/v1/chat/completions', { model: 'chat-model', messages: [], stream: true })
  expect(await result.response.text()).toContain('[DONE]')
  expect(f.requests.find(row => row.path === '/pg/chat/completions')?.authorization).toBe('Bearer dashboard-memory-1')
  expect(f.requests[0]).toMatchObject({ path: '/api/user/auth/refresh', origin: f.origin, cookie: `new_api_refresh=${refresh}` })
  await expect(runtime.invoke('/v1/chat/completions', { model: 'not-allowed' })).rejects.toThrow()
  await expect(runtime.invoke('/v1/chat/completions', { model: 'chat-model', group: 'vip' })).rejects.toThrow()
  await runtime.dispose()
  const restarted = f.createRuntime()
  await restarted.restore()
  await vi.waitFor(() => { expect(restarted.getSnapshot().catalogStatus).toBe('ready') })
  expect(f.requests.filter(row => row.path === '/api/user/auth/refresh')).toHaveLength(2)
  expect(await restarted.signOut()).toEqual({ remoteRevoked: true })
  expect(f.saved()).toBeNull()
  expect(f.requests.at(-1)?.path).toBe('/api/user/auth/logout')
  expect(f.requests.some(row => row.path.startsWith('/api/token') || row.path.startsWith('/api/desktop'))).toBe(false)
})

it('switches the native routing group, binds inference to it and preserves it across refresh and restart', async () => {
  const f = await fixture()
  const runtime = f.createRuntime()
  await runtime.startSignIn()
  await vi.waitFor(() => { expect(runtime.getSnapshot().catalogStatus).toBe('ready') })
  expect(await runtime.selectGroup({ group: 'forbidden', autoGroups: null, crossGroupRetry: false })).toBe('group_unavailable')
  expect(runtime.getSnapshot().account.status).toBe('signed-in')
  expect(await runtime.selectGroup({ group: 'vip', autoGroups: null, crossGroupRetry: false })).toBe('selected')
  await vi.waitFor(() => { expect(runtime.getSnapshot().catalog).toMatchObject({ group: 'vip' }) })
  const result = await runtime.invoke('/v1/chat/completions', { model: 'chat-model', messages: [], stream: true })
  await result.response.text()
  expect(JSON.parse(f.requests.findLast(row => row.path === '/pg/chat/completions')!.body)).toMatchObject({ group: 'vip' })
  await expect(runtime.invoke('/v1/chat/completions', { model: 'chat-model', group: 'default' })).rejects.toThrow('routing overrides')
  expect(f.saved()?.group).toBe('vip')
  await runtime.refreshAccount()
  expect(runtime.getSnapshot().account).toMatchObject({ group: 'vip' })
  await runtime.dispose()
  const restarted = f.createRuntime()
  await restarted.restore()
  await vi.waitFor(() => { expect(restarted.getSnapshot().catalog).toMatchObject({ group: 'vip' }) })
  expect(f.requests.some(row => row.path === '/api/user/models?group=vip')).toBe(true)
})
