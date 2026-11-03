/** Use the built desktop adapter for request preparation; the replay waterfall replaces only inference. */
import { installNovaFlowProvider } from '../../../apps/desktop-host/lib/novaflow.js'

export const name = 'novaflow-reasoning-fixture'
export const inject = ['llm']

/**
 * Publish the verified account model without making an external model request.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario context.
 */
export function apply(ctx) {
  installNovaFlowProvider(ctx, {
    type: 'novaflow-config', baseURL: 'http://127.0.0.1:43210', localCapability: 't'.repeat(43), revision: 1,
    models: [{ id: 'DeepSeek V4.1 Flash 1017 Eco', endpoints: ['/v1/chat/completions'], contextWindow: 128000, maxOutputTokens: 8192 }],
  }, () => Promise.reject(new Error('fixture does not save capacities')))
}
