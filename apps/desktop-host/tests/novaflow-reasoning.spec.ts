import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ReasoningEffortId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildModelCatalog } from '@deepseek-ai/dsh-api-session-controller/src/catalog.ts'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { installNovaFlowProvider, LEGACY_DESKTOP_BRAND } from '../src/novaflow.ts'

const deepseek = 'DeepSeek V4.1 Flash 1017 Eco'
const kimi = 'Kimi K3.1 Pro'
const provider = 'novaflow-chat'
const source = { provider, model: deepseek }
const disposers: (() => Promise<void>)[] = []
afterEach(async () => { while (disposers.length) await disposers.pop()?.() })

function configuration(baseURL = 'http://127.0.0.1:43210') {
  return {
    type: 'novaflow-config' as const, baseURL, localCapability: 't'.repeat(43), revision: 2,
    models: [deepseek, kimi, 'deepseek-v4-1-flash-economy-261017', 'kimi-k3-1-pro-261024', 'Kimi K3.2 Pro'].map(id => ({
      id, endpoints: ['/v1/chat/completions'], contextWindow: 128_000, maxOutputTokens: 8192,
    })),
  }
}

async function host(initial = configuration()) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  disposers.push(() => ctx.fiber.dispose())
  let refresh!: (configuration: unknown) => void
  await ctx.plugin((scope) => {
    refresh = installNovaFlowProvider(scope, initial, () => Promise.reject(new Error('unexpected capacity save')))
  })
  return { ctx, refresh }
}

describe('NovaFlow Ark reasoning', () => {
  it('publishes exact alias capabilities after refresh, retaining model ids and vendor defaults', async () => {
    const initial = configuration()
    const { ctx, refresh } = await host({ ...initial, models: [] })
    expect((await buildModelCatalog(ctx, source)).groups).toEqual([])
    refresh({ ...initial, revision: 3 })
    const catalog = await buildModelCatalog(ctx, source)
    expect(catalog.failures).toEqual([])
    const models = catalog.groups.flatMap(group => group.models.map(model => ({
      provider: group.id, id: model.id, reasoning: model.reasoning,
    })))
    expect(models).toMatchSnapshot()
    expect(models[0]?.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'low', 'high', 'max'])
    expect(models[1]?.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'high', 'max'])
    expect(models[4]?.reasoning).toBeUndefined()
    expect((await ctx.llm.resolveModelInfo(`${LEGACY_DESKTOP_BRAND}-chat`, kimi)).reasoning?.defaultEffort).toBe('max')
    await expect(ctx.llm.prepareCall({ provider, model: kimi, reasoningEffort: ReasoningEffortId('off') }))
      .rejects.toThrow('does not support reasoning effort')
    await expect(ctx.llm.prepareCall({ provider, model: deepseek, reasoningEffort: ReasoningEffortId('medium') }))
      .rejects.toThrow('does not support reasoning effort')
    refresh({ ...initial, revision: 4, models: initial.models.slice(0, 2).map(model => ({ ...model, endpoints: ['/v1/responses'] })) })
    expect((await ctx.llm.resolveModelInfo('novaflow-responses', deepseek)).reasoning).toBeUndefined()
  })

  it('serializes defaults and every supported effort, replays reasoning and receives streaming replies', async () => {
    const bodies: Record<string, unknown>[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body) as Record<string, unknown>
        bodies.push(parsed)
        response.setHeader('content-type', 'text/event-stream')
        if (Array.isArray(parsed.messages) && JSON.stringify(parsed.messages.at(-1)).includes('use tool')) {
          response.end('data: {"id":"fixture","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"fixture reasoning"},"finish_reason":null}]}\n\ndata: {"id":"fixture","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":null}]}\n\ndata: {"id":"fixture","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n')
          return
        }
        response.end('data: {"id":"fixture","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"fixture reasoning"},"finish_reason":null}]}\n\ndata: {"id":"fixture","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"id":"fixture","object":"chat.completion.chunk","created":1,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    disposers.push(() => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    }))
    const { ctx } = await host(configuration(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`))
    const cases = [
      { model: deepseek, effort: undefined, wire: 'high' },
      ...['off', 'low', 'high', 'max'].map(effort => ({ model: deepseek, effort, wire: effort === 'off' ? 'none' : effort })),
      { model: kimi, effort: undefined, wire: 'max' },
      ...['low', 'high', 'max'].map(effort => ({ model: kimi, effort, wire: effort })),
    ]
    for (const { model, effort, wire } of cases) {
      const selection = { provider, model,
        ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
      }
      const previous = await ctx.llm.prepareCall(selection)
      const firstReply = []
      const question = createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'model', ...source, model } })
      for await (const chunk of previous.stream({ ...previous.config, messages: [question] })) firstReply.push(chunk)
      const finish = firstReply.at(-1)
      if (finish?.type !== 'finish' || finish.replayState === undefined) throw new Error('fixture reply has no replay state')
      const prepared = await ctx.llm.prepareCall(selection)
      expect(prepared.config.reasoningEffort).toBe(effort ?? wire)
      expect(prepared.adapterDefaults.reasoningEffort).toBe(effort === undefined ? true : undefined)
      const chunks = []
      for await (const chunk of prepared.stream({ ...prepared.config, messages: [
        question,
        createAssistantMessage({ source: { ...source, model, replayState: finish.replayState }, content: [
          { type: 'reasoning', text: 'fixture reasoning' }, { type: 'text', text: 'hello' },
        ] }),
        createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'model', ...source, model } }),
      ] })) chunks.push(chunk)
      expect(JSON.stringify(chunks)).toContain('hello')
      expect(JSON.stringify(chunks)).toContain('fixture reasoning')
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(bodies.at(-1)).toMatchObject({ model, stream: true, reasoning_effort: wire,
        messages: [expect.anything(), { role: 'assistant', content: 'hello', reasoning_content: 'fixture reasoning' }, expect.anything()],
      })
      expect(bodies.at(-1)).not.toHaveProperty('thinking')
    }
    expect(bodies).toHaveLength(cases.length * 2)
    for (const model of [deepseek, kimi]) {
      const tools = [{ name: 'lookup', description: 'Look up a fixture.', parameters: { type: 'object', properties: {} } }]
      const selection = { provider, model, reasoningEffort: ReasoningEffortId('high') }
      const prepared = await ctx.llm.prepareCall(selection)
      const question = createUserMessage({ content: [{ type: 'text', text: 'use tool' }], source: { kind: 'model', ...source, model } })
      const chunks = []
      for await (const chunk of prepared.stream({ ...prepared.config, messages: [question], tools })) chunks.push(chunk)
      const finish = chunks.at(-1)
      expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
      if (finish?.type !== 'finish' || finish.replayState === undefined) throw new Error('fixture reply has no replay state')
      const content = chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])
      const call = content.find(block => block.type === 'tool-call')
      if (call?.type !== 'tool-call') throw new Error('fixture reply has no tool call')
      const next = await ctx.llm.prepareCall(selection)
      const continued = []
      for await (const chunk of next.stream({ ...next.config, tools, messages: [
        question, createAssistantMessage({ source: { ...source, model, replayState: finish.replayState }, content }),
        createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'fixture result' }], isError: false }),
      ] })) continued.push(chunk)
      expect(continued.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(bodies.at(-1)).toMatchObject({ model, reasoning_effort: 'high',
        tools: [{ type: 'function', function: { name: 'lookup' } }],
        messages: [expect.anything(), { role: 'assistant', reasoning_content: 'fixture reasoning',
          tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{}' } }],
        }, { role: 'tool', tool_call_id: 'call-1' }],
      })
    }
  })
})
