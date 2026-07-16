import type { ModelMessage } from 'ai';

/**
 * Anthropic ephemeral prompt-cache marker. Verified against @ai-sdk/anthropic@3.0.81: the
 * provider reads `providerOptions.anthropic.cacheControl` PER message/content-part — NOT at
 * streamText's top level — and emits a `cache_control` breakpoint there. Provider-agnostic:
 * non-Anthropic providers ignore the `anthropic` namespace without error.
 */
export const CACHE_OPTS = { anthropic: { cacheControl: { type: 'ephemeral' } } } as const;

/**
 * Place a cache breakpoint on the LAST message of the conversation history.
 *
 * The system-message breakpoint only caches the system prompt + tool schemas — a few k tokens.
 * The history itself (which grows every turn and can carry large tool results) was re-billed at
 * FULL input price on every call: every turn, every step of a multi-step turn, every retry.
 * Marking the last message caches the entire prefix up to it; Anthropic's cache lookup matches
 * the longest previously-cached prefix even as the breakpoint moves forward each turn, so
 * follow-up turns re-read the whole history at ~10% of the input rate.
 *
 * Returns a copy — the marker is a send-time concern and must never be persisted to ai_messages.
 */
export function withHistoryCacheMarker(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1] as ModelMessage & {
    providerOptions?: Record<string, Record<string, unknown>>;
  };
  const marked = {
    ...last,
    providerOptions: {
      ...last.providerOptions,
      anthropic: { ...last.providerOptions?.anthropic, ...CACHE_OPTS.anthropic }
    }
  } as ModelMessage;
  return [...messages.slice(0, -1), marked];
}
