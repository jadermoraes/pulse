/**
 * Shared UI state for the agent chat panel, so both the Rail entry, the floating
 * button, and the notification bell can drive the same panel. Svelte 5 runes class
 * singleton — read/write `agentUi.open` reactively across components.
 */
class AgentUi {
  /** Whether the chat panel is open. */
  open = $state(false);
  /**
   * A prompt to seed into the chat input the next time the panel opens (e.g. from a
   * notification "Ask the agent" deep-link). Consumed (cleared) by AgentChat.
   */
  seedPrompt = $state<string | null>(null);

  /** Open the panel, optionally pre-seeding the input with a prompt. */
  openWith(prompt?: string) {
    if (prompt) this.seedPrompt = prompt;
    this.open = true;
  }
}

export const agentUi = new AgentUi();
