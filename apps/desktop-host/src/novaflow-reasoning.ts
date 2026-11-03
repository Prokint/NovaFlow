/** Verified Ark Chat Completions capabilities for NovaFlow's public model aliases. */
import { ReasoningEffortId, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { PiAiModelProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { LEGACY_DESKTOP_BRAND } from './brand-compat.ts'

interface ReasoningProfile {
  readonly ids: readonly string[]
  readonly defaultEffort: 'high' | 'max'
  readonly model: Pick<PiAiModelProfile, 'reasoningEfforts' | 'compat'>
}

// Ark defines these wire values independently of the names published by Now API.
// https://docs.volcengine.com/docs/ark/deep-thinking?lang=en
const profiles: readonly ReasoningProfile[] = [
  {
    ids: ['DeepSeek V4.1 Flash 1017 Eco', 'deepseek-v4-1-flash-economy-261017'],
    defaultEffort: 'high',
    model: {
      reasoningEfforts: { off: 'none', low: 'low', high: 'high', max: 'max' },
      compat: { thinkingFormat: 'openai', supportsReasoningEffort: true, requiresReasoningContentOnAssistantMessages: true },
    },
  },
  {
    ids: ['Kimi K3.1 Pro', 'kimi-k3-1-pro-261024'],
    defaultEffort: 'max',
    model: {
      reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
      compat: { thinkingFormat: 'openai', supportsReasoningEffort: true, requiresReasoningContentOnAssistantMessages: true },
    },
  },
]

/**
 * Look up verified parameters without inferring capabilities from a model family.
 * @param api - protocol advertised by the account route.
 * @param id - exact public alias or Ark model id; it remains the request's model name.
 * @returns the matching Chat Completions profile, or undefined for an unverified id or protocol.
 */
export function novaFlowReasoningProfile(api: string, id: string): ReasoningProfile | undefined {
  return api === 'openai-completions' ? profiles.find(profile => profile.ids.includes(id)) : undefined
}

/**
 * Expose Ark's default as a logged adapter default, keeping an absent selection distinct from explicit off.
 * @param model - resolved account model, including its adapter's supported efforts.
 * @returns the model with its verified default, or unchanged when no Chat Completions profile applies.
 */
export function withNovaFlowReasoningDefault(model: LlmResolvedModelInfo): LlmResolvedModelInfo {
  if (model.provider !== 'novaflow-chat' && model.provider !== `${LEGACY_DESKTOP_BRAND}-chat`) return model
  const profile = novaFlowReasoningProfile('openai-completions', model.id)
  if (profile === undefined || model.reasoning === undefined) return model
  return { ...model, reasoning: { ...model.reasoning, defaultEffort: ReasoningEffortId(profile.defaultEffort) } }
}
