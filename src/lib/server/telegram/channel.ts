import type { Channel, AgentEvent } from '../agent/channel';
import { tgSendMessage } from './api';

export interface TelegramChannelOpts {
  /** Phase 3: how to render a write-confirmation as an inline keyboard. */
  onConfirm?: (pendingId: string, summary: string) => Promise<void>;
}

/** A Channel that buffers agent text and posts ONE Telegram message per turn. */
export function telegramChannel(token: string, chatId: number, opts: TelegramChannelOpts = {}): Channel {
  let buf = '';
  return {
    async send(e: AgentEvent) {
      switch (e.type) {
        case 'text': buf += e.delta; break;
        case 'tool_call': break;
        case 'tool_result': break;
        case 'confirmation_required':
          if (opts.onConfirm) await opts.onConfirm(e.pendingId, e.summary);
          break;
        case 'blocked':
          await tgSendMessage(token, chatId, "You've used your chats for this month — they reset soon.", {});
          break;
        case 'error':
          await tgSendMessage(token, chatId, `⚠️ ${e.message}`, {});
          break;
        case 'done':
          if (buf.trim()) await tgSendMessage(token, chatId, buf, { parseMode: 'Markdown' });
          buf = '';
          break;
      }
    }
  };
}
