import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildModelCatalog } from '@deepseek-ai/dsh-api-session-controller/src/catalog.ts'
import {
  NOVAFLOW_IDENTITY, novaFlowDefaultSelection, installNovaFlowIdentity, installNovaFlowProvider,
  parseNovaFlowHostConfiguration, LEGACY_DESKTOP_BRAND, type NovaFlowCapacitySaver,
} from '../src/novaflow.ts'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => { while (disposers.length) await disposers.pop()?.() })

const refuseSave: NovaFlowCapacitySaver = () => Promise.reject(new Error('fixture: saving is not expected'))

function configuration(baseURL = 'http://127.0.0.1:43210') {
  return {
    type: 'novaflow-config' as const, baseURL, localCapability: 't'.repeat(43), revision: 2,
    models: [{ id: 'fixture-model', endpoints: ['/v1/chat/completions'], contextWindow: 8192, maxOutputTokens: 2048 }],
  }
}

describe('native Host configuration', () => {
  it('publishes only NovaFlow model groups while retaining legacy call routing', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    const initial = configuration()
    initial.models.push({ ...initial.models[0]!, id: 'fixture-model-2' })
    let update: ((configuration: unknown) => void) | undefined
    await ctx.plugin((scope) => { update = installNovaFlowProvider(scope, initial, refuseSave) })
    const selection = { provider: 'novaflow-chat', model: 'fixture-model' }
    const catalog = await buildModelCatalog(ctx, selection)
    expect(catalog.failures).toEqual([])
    expect(catalog.groups.map(group => ({ id: group.id, models: group.models.map(model => model.id) })))
      .toEqual([{ id: 'novaflow-chat', models: ['fixture-model', 'fixture-model-2'] }])
    expect((await ctx.llm.prepareCall({ provider: `${LEGACY_DESKTOP_BRAND}-chat`, model: 'fixture-model' })).config.model)
      .toBe('fixture-model')
    update?.({ ...initial, revision: 3, models: [] })
    expect(await buildModelCatalog(ctx, selection)).toMatchObject({ groups: [], failures: [] })
    update?.({ ...initial, revision: 4 })
    expect((await buildModelCatalog(ctx, selection)).groups.map(group => group.id)).toEqual(['novaflow-chat'])
  })
  it('lists empty legacy protocol routes across catalog refreshes without losing their adapter profiles', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    let update: ((configuration: unknown) => void) | undefined
    await ctx.plugin((scope) => { update = installNovaFlowProvider(scope, configuration(), refuseSave) })
    for (const protocol of ['responses', 'anthropic']) {
      expect(await ctx.llm.listModels(`${LEGACY_DESKTOP_BRAND}-${protocol}`)).toEqual([])
    }
    update?.({ ...configuration(), revision: 3, models: [] })
    for (const protocol of ['chat', 'responses', 'anthropic']) {
      expect(await ctx.llm.listModels(`${LEGACY_DESKTOP_BRAND}-${protocol}`)).toEqual([])
    }
    update?.({ ...configuration(), revision: 4 })
    expect(await ctx.llm.listModels(`${LEGACY_DESKTOP_BRAND}-chat`)).toEqual([])
    expect(await ctx.llm.listModels(`${LEGACY_DESKTOP_BRAND}-responses`)).toEqual([])
    expect(await ctx.llm.listModels(`${LEGACY_DESKTOP_BRAND}-anthropic`)).toEqual([])
  })
  it('lets a saved model override the shipped deployment defaults', () => {
    const deployment = loadOverlayPatches('test', fileURLToPath(new URL('../src/novaflow.patch.yml', import.meta.url)))
    const next = novaFlowDefaultSelection({ ...configuration(), autoSelectModel: true },
      { provider: 'novaflow-responses', model: 'select-a-model' })
    expect(next).toEqual({ provider: 'novaflow-chat', model: 'fixture-model' })
    const rows = deployment.filter(row => row.id !== undefined).map(row => ({ id: row.id!, name: 'fixture:plugin' }))
    rows.push({ id: 'agent-default-model', name: 'fixture:model' })
    const composed = applyEntryPatches(rows, [{ id: 'agent-default-model', config: next }, ...deployment],
      (message) => { throw new Error(message) })
    expect(composed.find(row => row.id === 'agent-default-model')?.config).toEqual(next)
  })
  it('preserves standard API-key mode and refuses unknown access modes', () => {
    expect(parseNovaFlowHostConfiguration({ ...configuration(), accessMode: 'api-key' }).accessMode).toBe('api-key')
    const hybrid = parseNovaFlowHostConfiguration({ ...configuration(), accessMode: 'hybrid' })
    expect(hybrid.accessMode).toBe('hybrid')
    expect(novaFlowDefaultSelection(hybrid, { provider: 'novaflow', model: 'saved-api-model' })).toBeUndefined()
    expect(novaFlowDefaultSelection({ ...hybrid, autoSelectModel: true }, { provider: 'novaflow', model: 'select-a-model' }))
      .toEqual({ provider: 'novaflow-chat', model: 'fixture-model' })
    expect(novaFlowDefaultSelection({ ...hybrid, autoSelectModel: true }, { provider: 'novaflow', model: 'saved-api-model' })).toBeUndefined()
    expect(novaFlowDefaultSelection({ ...hybrid, autoSelectModel: true }, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }))
      .toEqual({ provider: 'novaflow-chat', model: 'fixture-model' })
    expect(() => parseNovaFlowHostConfiguration({ ...configuration(), accessMode: 'password' })).toThrow('invalid access mode')
  })
  it.each(['https://api.novaflow.com', 'http://localhost:43210', 'http://127.0.0.1:43210/v1', 'http://user@127.0.0.1:43210', 'http://127.0.0.1:43210?x=1'])('rejects a non-exact loopback endpoint %s', (baseURL) => {
    expect(() => parseNovaFlowHostConfiguration(configuration(baseURL))).toThrow()
  })
  it('does not invent model capacities or accept invalid native revisions', () => {
    const unknown = parseNovaFlowHostConfiguration({ ...configuration(), models: [{ id: 'unknown', endpoints: ['/v1/responses'] }] })
    expect(unknown.models).toEqual([{ id: 'unknown', endpoints: ['/v1/responses'] }])
    const model = { id: 'fixture-model', endpoints: ['/v1/chat/completions'] }
    for (const invalid of [
      { contextWindow: 0 }, { maxOutputTokens: 1.5 }, { contextWindow: 1024, maxOutputTokens: 2048 },
      { userContextWindow: 1024, userMaxOutputTokens: 2048 }, { capacityDefaults: ['contextWindow', 'contextWindow'] },
      { capacityDefaults: ['context_window'] }, { capacityDefaults: 'contextWindow' },
    ]) expect(() => parseNovaFlowHostConfiguration({ ...configuration(), models: [{ ...model, ...invalid }] })).toThrow('invalid model capacity')
    expect(() => parseNovaFlowHostConfiguration({ ...configuration(), revision: -1 })).toThrow()
    expect(() => parseNovaFlowHostConfiguration({ ...configuration(), localCapability: 'dsk.upstream-credential' })).toThrow()
  })
  it('registers real Harness protocol adapters and disposes their routes', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    let publications = 0
    ctx.on('llm/adapters-updated', () => { publications++ })
    let update: ((configuration: unknown) => void) | undefined
    const owner = await ctx.plugin((scope) => { update = installNovaFlowProvider(scope, configuration(), refuseSave) })
    expect(await ctx.llm.listModels('novaflow-chat')).toEqual([
      { provider: 'novaflow-chat', id: 'fixture-model', name: 'fixture-model', inputModalities: ['text'] },
    ])
    const call = await ctx.llm.prepareCall({ provider: 'novaflow-chat', model: 'fixture-model' })
    expect(call.retryPolicy).toMatchObject({ mode: 'normal', maxRetries: 0 })
    const previousProvider = `${LEGACY_DESKTOP_BRAND}-chat`
    expect(await ctx.llm.listModels(previousProvider)).toEqual([])
    const previousCall = await ctx.llm.prepareCall({ provider: previousProvider, model: 'fixture-model' })
    expect(previousCall.config).toMatchObject({ provider: previousProvider, model: 'fixture-model' })
    expect(novaFlowDefaultSelection(configuration(), { provider: previousProvider, model: 'fixture-model' }))
      .toEqual({ provider: 'novaflow-chat', model: 'fixture-model' })
    expect(() => update?.({ ...configuration(), baseURL: 'http://127.0.0.1:43211', revision: 3 })).toThrow('identity cannot change')
    const beforeRefresh = publications
    update?.({ ...configuration(), revision: 3, models: [] })
    expect(publications).toBeGreaterThan(beforeRefresh)
    expect(await ctx.llm.listModels('novaflow-chat')).toEqual([])
    expect(() => update?.(configuration())).toThrow('stale')
    await owner.dispose()
    await expect(ctx.llm.prepareCall({ provider: 'novaflow-chat', model: 'fixture-model' })).rejects.toThrow()
  })
  it('uses the actual serializer, private local bearer and prepared revision for one streaming request', async () => {
    const seen: { path?: string; authorization?: string; revision?: string; body?: string }[] = []
    const server = createServer((request, response) => {
      const record = { path: request.url ?? '', authorization: request.headers.authorization ?? '',
        revision: typeof request.headers['x-novaflow-revision'] === 'string' ? request.headers['x-novaflow-revision'] : '', body: '' }
      seen.push(record)
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { record.body += chunk })
      request.on('end', () => {
        response.setHeader('content-type', 'text/event-stream')
        response.end('data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\ndata: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      })
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    disposers.push(() => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) }))
    const port = (server.address() as AddressInfo).port
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    const initial = configuration(`http://127.0.0.1:${String(port)}`)
    let update: ((configuration: unknown) => void) | undefined
    await ctx.plugin((scope) => { update = installNovaFlowProvider(scope, initial, refuseSave) })
    const prepared = await ctx.llm.prepareCall({ provider: 'novaflow-chat', model: 'fixture-model' })
    update?.({ ...initial, revision: 3 })
    const chunks = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider: 'novaflow-chat', model: 'fixture-model' } })] })) chunks.push(chunk)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ path: '/v1/chat/completions', authorization: `Bearer ${'t'.repeat(43)}`, revision: '2' })
    expect(JSON.parse(seen[0]?.body ?? '{}')).toMatchObject({ model: 'fixture-model', stream: true })
    expect(JSON.stringify(chunks)).toContain('hello')
    expect(JSON.stringify(chunks)).not.toContain('t'.repeat(43))
  })
})

describe('vendor reasoning', () => {
  const capacity = { contextWindow: 200_000, maxOutputTokens: 32_000 }

  it('offers the vendor catalog effort levels for a matching id and protocol, and Google\'s on Chat Completions', async () => {
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    await ctx.plugin((scope) => {
      installNovaFlowProvider(scope, { ...configuration(), models: [
        { id: 'claude-opus-4-7', endpoints: ['/v1/messages'], ...capacity },
        { id: 'gpt-5.1', endpoints: ['/v1/responses'], ...capacity },
        { id: 'gpt-5.2', endpoints: ['/v1/chat/completions'], ...capacity },
        { id: 'fixture-model', endpoints: ['/v1/chat/completions'], ...capacity },
        { id: 'qwen3.8-max', endpoints: ['/v1/chat/completions'], ...capacity },
        { id: 'deepseek-v4-pro', endpoints: ['/v1/chat/completions'], ...capacity },
        { id: 'deepseek-v4-flash', endpoints: ['/v1/chat/completions'], ...capacity },
        { id: 'gemini-3.8-flash', endpoints: ['/v1/chat/completions'], ...capacity },
        { id: 'gemini-2.5-pro', endpoints: ['/v1/chat/completions'], ...capacity },
        { id: 'gemini-3.5-flash', endpoints: ['/v1/responses'], ...capacity },
        { id: 'gemma-4-31b-it', endpoints: ['/v1/chat/completions'], ...capacity },
      ] }, refuseSave)
    })
    const efforts = async (provider: string, model: string) =>
      (await ctx.llm.resolveModelInfo(provider, model)).reasoning?.efforts.map(effort => String(effort.id))
    expect(await efforts('novaflow-anthropic', 'claude-opus-4-7')).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(await efforts('novaflow-responses', 'gpt-5.1')).toEqual(['off', 'low', 'medium', 'high'])
    expect(await efforts('novaflow-chat', 'gpt-5.2')).toBeUndefined()
    expect(await efforts('novaflow-chat', 'fixture-model')).toBeUndefined()
    expect(await efforts('novaflow-chat', 'qwen3.8-max')).toEqual(['low', 'medium', 'xhigh'])
    // DeepSeek's own entry wins over Alibaba's hosted copy, and a DeepSeek id only Alibaba hosts stays without levels.
    expect(await efforts('novaflow-chat', 'deepseek-v4-pro')).toEqual(['off', 'high', 'max'])
    expect(await efforts('novaflow-chat', 'deepseek-v4-flash')).toBeUndefined()
    expect(await efforts('novaflow-chat', 'gemini-3.8-flash')).toEqual(['low', 'medium', 'high'])
    // Google lists no levels for Gemini 2.5, whose thinking takes a budget; New API budgets these three.
    expect(await efforts('novaflow-chat', 'gemini-2.5-pro')).toEqual(['low', 'medium', 'high'])
    expect(await efforts('novaflow-responses', 'gemini-3.5-flash')).toBeUndefined()
    // New API's Gemini channels configure thinking for Gemini models only.
    expect(await efforts('novaflow-chat', 'gemma-4-31b-it')).toBeUndefined()
  })

  it('requests thinking with the vendor wire controls through the relay', async () => {
    const bodies = new Map<string, string>()
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        bodies.set(`${(request.url ?? '').split('?')[0] ?? ''} ${String((JSON.parse(body) as { model?: unknown }).model)}`, body)
        response.statusCode = 400
        response.setHeader('content-type', 'application/json')
        response.end('{"error":{"type":"invalid_request_error","message":"fixture"}}')
      })
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    disposers.push(() => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) }))
    const port = (server.address() as AddressInfo).port
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    await ctx.plugin((scope) => {
      installNovaFlowProvider(scope, { ...configuration(`http://127.0.0.1:${String(port)}`), models: [
        { id: 'claude-opus-4-7', endpoints: ['/v1/messages'], ...capacity },
        { id: 'deepseek-v4-pro', endpoints: ['/v1/chat/completions'], ...capacity },
        { id: 'qwen3.8-max', endpoints: ['/v1/chat/completions'], ...capacity },
        { id: 'gemini-3.8-flash', endpoints: ['/v1/chat/completions'], ...capacity },
        { id: 'gemini-2.5-pro', endpoints: ['/v1/chat/completions'], ...capacity },
        { id: 'gemini-2.5-flash', endpoints: ['/v1/chat/completions'], ...capacity },
      ] }, refuseSave)
    })
    const requests: readonly (readonly [string, string, string | undefined])[] = [
      ['novaflow-anthropic', 'claude-opus-4-7', 'high'], ['novaflow-chat', 'deepseek-v4-pro', 'high'], ['novaflow-chat', 'qwen3.8-max', 'medium'],
      ['novaflow-chat', 'gemini-3.8-flash', 'low'], ['novaflow-chat', 'gemini-2.5-pro', 'medium'], ['novaflow-chat', 'gemini-2.5-flash', undefined],
    ]
    for (const [provider, model, effort] of requests) {
      const prepared = await ctx.llm.prepareCall({
        provider, model, ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
      })
      const message = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider, model } })
      try {
        for await (const _chunk of prepared.stream({ ...prepared.config, system: 'Fixture instructions.', messages: [message] })) { /* drain */ }
      } catch (_fixtureRejection) { /* the fixture server refuses every request after recording its body */ }
    }
    expect(JSON.parse(bodies.get('/v1/messages claude-opus-4-7') ?? '{}')).toMatchObject({
      thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
    })
    expect(JSON.parse(bodies.get('/v1/chat/completions deepseek-v4-pro') ?? '{}')).toMatchObject({
      thinking: { type: 'enabled' }, reasoning_effort: 'high', messages: [{ role: 'system' }, { role: 'user' }],
    })
    expect(JSON.parse(bodies.get('/v1/chat/completions qwen3.8-max') ?? '{}')).toMatchObject({
      enable_thinking: true, reasoning_effort: 'medium', messages: [{ role: 'system' }, { role: 'user' }],
    })
    const gemini = JSON.parse(bodies.get('/v1/chat/completions gemini-3.8-flash') ?? '{}') as Record<string, unknown>
    expect(gemini).toMatchObject({ reasoning_effort: 'low' })
    expect(gemini).not.toHaveProperty('thinking')
    expect(gemini).not.toHaveProperty('enable_thinking')
    expect(JSON.parse(bodies.get('/v1/chat/completions gemini-2.5-pro') ?? '{}')).toMatchObject({ reasoning_effort: 'medium' })
    // The default effort leaves Gemini 2.5 thinking to the model's own default.
    const unselected = JSON.parse(bodies.get('/v1/chat/completions gemini-2.5-flash') ?? '{}') as Record<string, unknown>
    expect(unselected).toHaveProperty('model', 'gemini-2.5-flash')
    expect(unselected).not.toHaveProperty('reasoning_effort')
  })
})

describe('one route per model', () => {
  const capacity = { contextWindow: 200_000, maxOutputTokens: 32_000 }
  const all = ['/v1/chat/completions', '/v1/responses', '/v1/messages']
  const models = [
    { id: 'claude-opus-4-7', endpoints: all, ...capacity },
    { id: 'gpt-5.1', endpoints: all, ...capacity },
    { id: 'deepseek-v4-pro', endpoints: all, ...capacity },
    { id: 'fixture-model', endpoints: all, ...capacity },
    { id: 'fixture-responses', endpoints: ['/v1/messages', '/v1/responses'], ...capacity },
    { id: 'fixture-messages', endpoints: ['/v1/messages'], ...capacity },
    // Newer than the installed catalog: placed by name family.
    { id: 'claude-sonnet-9-9', endpoints: all, ...capacity },
    { id: 'gpt-9', endpoints: all, ...capacity },
    { id: 'deepseek-flash', endpoints: ['/v1/responses', '/v1/chat/completions'], ...capacity },
  ]

  it('lists a model under its vendor or name-family protocol, otherwise under the first advertised endpoint', async () => {
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    await ctx.plugin((scope) => { installNovaFlowProvider(scope, { ...configuration(), models }, refuseSave) })
    const listed = async (provider: string) => (await ctx.llm.listModels(provider)).map(model => model.id)
    expect(await listed('novaflow-chat')).toEqual(['deepseek-v4-pro', 'fixture-model', 'deepseek-flash'])
    expect(await listed('novaflow-responses')).toEqual(['gpt-5.1', 'fixture-responses', 'gpt-9'])
    expect(await listed('novaflow-anthropic')).toEqual(['claude-opus-4-7', 'fixture-messages', 'claude-sonnet-9-9'])
    expect((await ctx.llm.resolveModelInfo('novaflow-anthropic', 'claude-sonnet-9-9')).reasoning).toBeUndefined()
  })

  it('moves a saved default selection to the route that lists its model', () => {
    const applied = parseNovaFlowHostConfiguration({ ...configuration(), models })
    expect(novaFlowDefaultSelection(applied, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }))
      .toEqual({ provider: 'novaflow-responses', model: 'select-a-model' })
    expect(novaFlowDefaultSelection(applied, { provider: 'novaflow-responses', model: 'deepseek-v4-pro', reasoningEffort: ReasoningEffortId('high') }))
      .toEqual({ provider: 'novaflow-chat', model: 'deepseek-v4-pro' })
    expect(novaFlowDefaultSelection(applied, { provider: 'novaflow-chat', model: 'deepseek-v4-pro' })).toBeUndefined()
    expect(novaFlowDefaultSelection(applied, { provider: 'novaflow-chat', model: 'withdrawn-model' })).toBeUndefined()
    expect(novaFlowDefaultSelection(applied, { provider: 'novaflow-responses', model: 'select-a-model' })).toBeUndefined()
  })
})

describe('image input', () => {
  const capacity = { contextWindow: 200_000, maxOutputTokens: 32_000 }
  const chat = ['/v1/chat/completions']
  // 1x1 opaque PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

  it('accepts images for a model some pi-ai catalog lists with them, and text alone otherwise', async () => {
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    await ctx.plugin((scope) => {
      installNovaFlowProvider(scope, { ...configuration(), models: [
        // Google's own catalog lists Gemini under Gemini's protocol; any catalog's image input counts.
        { id: 'gemini-3.8-flash', endpoints: chat, ...capacity },
        { id: 'gpt-5.1', endpoints: ['/v1/responses'], ...capacity },
        { id: 'deepseek-v4-pro', endpoints: chat, ...capacity },
        { id: 'fixture-model', endpoints: chat, ...capacity },
      ] }, refuseSave)
    })
    const input = async (provider: string, model: string) => (await ctx.llm.resolveModelInfo(provider, model)).inputModalities
    expect(await input('novaflow-chat', 'gemini-3.8-flash')).toEqual(['text', 'image'])
    expect(await input('novaflow-responses', 'gpt-5.1')).toEqual(['text', 'image'])
    expect(await input('novaflow-chat', 'deepseek-v4-pro')).toEqual(['text'])
    expect(await input('novaflow-chat', 'fixture-model')).toEqual(['text'])
  })

  it('sends a stored image through the relay', async () => {
    const bodies: string[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        bodies.push(body)
        response.statusCode = 400
        response.setHeader('content-type', 'application/json')
        response.end('{"error":{"type":"invalid_request_error","message":"fixture"}}')
      })
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    disposers.push(() => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) }))
    const home = await mkdtemp(join(tmpdir(), 'novaflow-host-images-'))
    disposers.push(() => rm(home, { recursive: true, force: true }))
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    await ctx.plugin(LocalAttachments, { dshHome: home })
    await ctx.plugin((scope) => {
      installNovaFlowProvider(scope, { ...configuration(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`), models: [
        { id: 'gemini-3.8-flash', endpoints: chat, ...capacity },
      ] }, refuseSave)
    })
    const attachment = await ctx.attachments.saveImage({ data: png, mediaType: 'image/png' })
    const prepared = await ctx.llm.prepareCall({ provider: 'novaflow-chat', model: 'gemini-3.8-flash' })
    const message = createUserMessage({
      content: [{ type: 'text', text: 'What is this?' }, { type: 'image', attachment }],
      source: { kind: 'model', provider: 'novaflow-chat', model: 'gemini-3.8-flash' },
    })
    try {
      for await (const _chunk of prepared.stream({ ...prepared.config, messages: [message] })) { /* drain */ }
    } catch (_fixtureRejection) { /* the fixture server refuses every request after recording its body */ }
    expect(bodies).toHaveLength(1)
    const { messages } = JSON.parse(bodies[0] ?? '{}') as { messages: { role: string; content: { type: string; image_url?: { url: string } }[] }[] }
    expect(messages.map(entry => entry.role)).toEqual(['user'])
    expect(messages[0]?.content.find(part => part.type === 'image_url')?.image_url?.url).toMatch(/^data:image\/png;base64,/u)
  })
})

describe('model capacities', () => {
  const defaults = ['contextWindow', 'maxOutputTokens'] as const
  const server = { contextWindow: 128_000, maxOutputTokens: 8192 }
  const chat = ['/v1/chat/completions']
  const models = [
    // Server defaults give way to the vendor catalog entry, which only sizes the model.
    { id: 'deepseek-v4-pro', endpoints: chat, ...server, capacityDefaults: defaults },
    // Server metadata is the deployment's choice and caps every request.
    { id: 'claude-opus-4-7', endpoints: ['/v1/messages'], contextWindow: 200_000, maxOutputTokens: 32_000 },
    // Without a vendor entry the server defaults stay.
    { id: 'fixture-model', endpoints: chat, ...server, capacityDefaults: defaults },
    // The user's value wins; the side the user left alone follows the catalog.
    { id: 'gpt-5.1', endpoints: ['/v1/responses'], ...server, capacityDefaults: defaults, userContextWindow: 300_000 },
    // A configured output above the catalog window moves the defaulted window up, as the server does.
    { id: 'glm-5.3', endpoints: chat, contextWindow: 1_200_000, maxOutputTokens: 1_200_000, capacityDefaults: ['contextWindow' as const] },
    // A catalog output above the user's window is fitted to it.
    { id: 'kimi-k2.7-code', endpoints: chat, ...server, capacityDefaults: defaults, userContextWindow: 100_000 },
    // No server figure and no vendor entry: runnable only with the user's own values.
    { id: 'bare-model', endpoints: chat },
    { id: 'user-model', endpoints: chat, userContextWindow: 64_000, userMaxOutputTokens: 4096 },
  ]

  const routed = [
    ['novaflow-chat', 'deepseek-v4-pro'], ['novaflow-anthropic', 'claude-opus-4-7'], ['novaflow-chat', 'fixture-model'],
    ['novaflow-responses', 'gpt-5.1'], ['novaflow-chat', 'glm-5.3'], ['novaflow-chat', 'kimi-k2.7-code'],
    ['novaflow-chat', 'bare-model'], ['novaflow-chat', 'user-model'],
  ] as const

  it('takes each capacity from the user, server metadata, the vendor catalog, then the server default', async () => {
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    const owner = await ctx.plugin((scope) => { installNovaFlowProvider(scope, { ...configuration(), models }, refuseSave) })
    const capacities = ctx.get('modelCapacity')
    expect(routed.map(([provider, model]) => capacities?.describe(provider, model))).toEqual([
      { contextWindow: 1_000_000, contextSource: 'catalog', maxOutputTokens: 384_000, outputSource: 'catalog',
        automaticContextWindow: 1_000_000, automaticMaxOutputTokens: 384_000 },
      { contextWindow: 200_000, contextSource: 'provider', maxOutputTokens: 32_000, outputSource: 'provider',
        automaticContextWindow: 200_000, automaticMaxOutputTokens: 32_000 },
      { contextWindow: 128_000, contextSource: 'default', maxOutputTokens: 8192, outputSource: 'default',
        automaticContextWindow: 128_000, automaticMaxOutputTokens: 8192 },
      { contextWindow: 300_000, contextSource: 'user', maxOutputTokens: 128_000, outputSource: 'catalog',
        automaticContextWindow: 400_000, automaticMaxOutputTokens: 128_000 },
      { contextWindow: 1_200_000, contextSource: 'catalog', maxOutputTokens: 1_200_000, outputSource: 'provider',
        automaticContextWindow: 1_200_000, automaticMaxOutputTokens: 1_200_000 },
      { contextWindow: 100_000, contextSource: 'user', maxOutputTokens: 100_000, outputSource: 'catalog',
        automaticContextWindow: 262_144, automaticMaxOutputTokens: 262_144 },
      {},
      { contextWindow: 64_000, contextSource: 'user', maxOutputTokens: 4096, outputSource: 'user' },
    ])
    expect(capacities?.describe('novaflow-responses', 'deepseek-v4-pro')).toBeUndefined()
    expect(capacities?.describe('novaflow-chat', 'missing-model')).toBeUndefined()
    await owner.dispose()
    expect(ctx.get('modelCapacity')).toBeUndefined()
  })

  it('saves a change of a model on its route through the main process', async () => {
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    let update: ((configuration: unknown) => void) | undefined
    const save = vi.fn<NovaFlowCapacitySaver>(async (model, contextWindow) => {
      await Promise.resolve()
      update?.({ ...configuration(), revision: 3, models: models.map(entry => entry.id === model && contextWindow !== null
        ? { ...entry, userContextWindow: contextWindow } : entry) })
    })
    await ctx.plugin((scope) => { update = installNovaFlowProvider(scope, { ...configuration(), models }, save) })
    const capacities = ctx.get('modelCapacity')
    await capacities?.set({ provider: 'novaflow-chat', model: 'fixture-model', contextWindow: 64_000, maxOutputTokens: null })
    expect(save).toHaveBeenCalledExactlyOnceWith('fixture-model', 64_000, null)
    expect(capacities?.describe('novaflow-chat', 'fixture-model')).toMatchObject({ contextWindow: 64_000, contextSource: 'user' })
    expect((await ctx.llm.resolveModelInfo('novaflow-chat', 'fixture-model')).context?.contextWindow).toBe(64_000)
    await expect(capacities?.set({ provider: 'novaflow-responses', model: 'fixture-model', contextWindow: null, maxOutputTokens: null }))
      .rejects.toThrow('is not listed on "novaflow-responses"')
    expect(save).toHaveBeenCalledOnce()
  })

  it('caps requests only with a chosen output limit and lists a model only with both capacities', async () => {
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    await ctx.plugin((scope) => { installNovaFlowProvider(scope, { ...configuration(), models }, refuseSave) })
    const info = async (provider: string, model: string) => {
      const resolved = await ctx.llm.resolveModelInfo(provider, model)
      return { contextWindow: resolved.context?.contextWindow, defaultMaxTokens: resolved.defaultMaxTokens }
    }
    expect(await info('novaflow-chat', 'deepseek-v4-pro')).toEqual({ contextWindow: 1_000_000, defaultMaxTokens: undefined })
    expect(await info('novaflow-anthropic', 'claude-opus-4-7')).toEqual({ contextWindow: 200_000, defaultMaxTokens: 32_000 })
    expect(await info('novaflow-chat', 'fixture-model')).toEqual({ contextWindow: 128_000, defaultMaxTokens: 8192 })
    expect(await info('novaflow-responses', 'gpt-5.1')).toEqual({ contextWindow: 300_000, defaultMaxTokens: undefined })
    expect(await info('novaflow-chat', 'user-model')).toEqual({ contextWindow: 64_000, defaultMaxTokens: 4096 })
    expect((await ctx.llm.listModels('novaflow-chat')).map(model => model.id)).not.toContain('bare-model')
    const applied = parseNovaFlowHostConfiguration({ ...configuration(), models })
    expect(novaFlowDefaultSelection(applied, { provider: 'novaflow-responses', model: 'bare-model' })).toBeUndefined()
  })

  it('sends the catalog output limit as the model size of a request', async () => {
    const bodies = new Map<string, Record<string, unknown>>()
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body) as Record<string, unknown>
        bodies.set(String(parsed.model), parsed)
        response.statusCode = 400
        response.setHeader('content-type', 'application/json')
        response.end('{"error":{"type":"invalid_request_error","message":"fixture"}}')
      })
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    disposers.push(() => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) }))
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    await ctx.plugin((scope) => {
      installNovaFlowProvider(scope, { ...configuration(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`), models },
        refuseSave)
    })
    for (const model of ['deepseek-v4-pro', 'fixture-model']) {
      const prepared = await ctx.llm.prepareCall({ provider: 'novaflow-chat', model })
      const message = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider: 'novaflow-chat', model } })
      try {
        for await (const _chunk of prepared.stream({ ...prepared.config, messages: [message] })) { /* drain */ }
      } catch (_fixtureRejection) { /* the fixture server refuses every request after recording its body */ }
    }
    const limit = (model: string) => bodies.get(model)?.max_tokens ?? bodies.get(model)?.max_completion_tokens
    expect(limit('deepseek-v4-pro')).toBe(384_000)
    expect(limit('fixture-model')).toBe(8192)
  })
})

describe('NovaFlow identity', () => {
  it('opens the prompt with NovaFlow in place of the upstream harness line', async () => {
    const { default: SystemPrompt, renderPrompt } = await import('@deepseek-ai/dsh-system-prompt')
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: 'Deployment persona.' })
      installNovaFlowIdentity(ctx)
      await vi.waitFor(async () => {
        expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(`${NOVAFLOW_IDENTITY}\n\nDeployment persona.`)
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
