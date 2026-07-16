export interface TurnUsage { input: number; output: number; cached: number }

/** The subset of streamText's result we need to read final usage. */
interface StreamUsageSource {
  consumeStream?: () => PromiseLike<void>;
  totalUsage: PromiseLike<{ inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }>;
}

/**
 * Read the REAL token totals from a streamText result after breaking out of its fullStream early.
 *
 * The confirmation-pause and auto-resume paths exit the stream loop at the `tool-call` part,
 * BEFORE the `finish` part populates the loop's usage tracker — so they used to meter {0,0}
 * ($0.00 rows in ai_usage_log) and the tokens of those calls (which can carry the largest tool
 * results of the turn) were never billed against the spend guardrails. By the time a write
 * tool-call surfaces the model has already stopped generating, so draining the remaining
 * buffered parts and awaiting totalUsage is cheap and safe. Never throws: metering must not
 * break a turn — zeros (today's behavior) are the fallback.
 */
export async function usageFromResult(result: StreamUsageSource): Promise<TurnUsage> {
  try {
    await result.consumeStream?.();
    const u = await result.totalUsage;
    return { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cached: u.cachedInputTokens ?? 0 };
  } catch {
    return { input: 0, output: 0, cached: 0 };
  }
}
