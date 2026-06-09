import type { DB } from '../db';
import { getBotToken } from './config';
import { tgSendMessage, tgSendChatAction, tgAnswerCallback } from './api';
import { consumeLinkToken, bindChat, getBinding, setBindingConversation, clearBindingConversation, type Binding } from './bindings';
import { getConsumer } from '../identity/consumers';
import { telegramChannel } from './channel';
import { runConsumerTurn } from '../consumer/consumer-turn';
import { runAgentTurn, executeConfirmed, resumeAgentTurn } from '../agent/run';
import { signCallback, verifyCallback } from './callback-sig';
import { refForReply, replyToMessage, getMessage } from '../consumer/messages';
import { notifyConsumer } from '../notify';
import type { AgentContext } from '../agent/types';

/** Process one Telegram update. Best-effort: never throws out (the poller keeps going). */
export async function handleUpdate(db: DB, update: any): Promise<void> {
  const token = getBotToken(db);
  if (!token) return;
  try {
    if (update?.callback_query) { await handleCallback(db, token, update.callback_query); return; }
    const msg = update?.message;
    const chatId = msg?.chat?.id;
    const text: string = msg?.text ?? '';
    if (typeof chatId !== 'number') return;

    if (text.startsWith('/start')) {
      const payload = text.split(/\s+/)[1];
      if (!payload) { await tgSendMessage(token, chatId, 'Open Pulse → Connect Telegram to link your account.', {}); return; }
      try {
        const { kind, subjectId } = consumeLinkToken(db, payload);
        bindChat(db, chatId, kind, subjectId, msg?.from?.username ?? null);
        await tgSendMessage(token, chatId, '✅ Linked to Pulse. You can chat with me or get notifications here.', {});
      } catch {
        await tgSendMessage(token, chatId, 'That link is invalid or has expired — generate a new one in the app.', {});
      }
      return;
    }

    const binding = getBinding(db, chatId);
    if (!binding) {
      await tgSendMessage(token, chatId, "👋 You're not linked yet. Open Pulse → Connect Telegram.", {});
      return;
    }

    // Admin replying (in Telegram) to a tracked "Message from X" notification: deliver that
    // text back to the viewer and short-circuit — this must NOT run as an agent turn. Non-reply
    // admin messages (and replies to untracked messages) fall through to the agent unchanged.
    const replyTo = msg?.reply_to_message?.message_id;
    if (binding.kind === 'admin' && typeof replyTo === 'number' && text.trim()) {
      const cmId = refForReply(db, chatId, replyTo);
      if (cmId != null) {
        const cm = getMessage(db, cmId);
        if (cm) {
          replyToMessage(db, cmId, text);
          await notifyConsumer(db, cm.consumerId, {
            title: 'Reply from the admin', body: text, url: '/app/messages'
          }).catch(() => {});
          await tgSendMessage(token, chatId, '✓ Delivered to the viewer.', {});
          return;
        }
      }
    }

    await handleBoundMessage(db, token, binding, text);
  } catch {
    /* swallow — one bad update must never kill the poll loop */
  }
}

/** Create a new conversation owned by the consumer and persist it on the binding. */
function ensureConsumerConversation(db: DB, binding: Binding, consumerId: number): number {
  if (binding.conversationId) return binding.conversationId;
  const info = db
    .prepare('insert into ai_conversations(title,created_at,consumer_id) values(?,?,?)')
    .run(null, Date.now(), consumerId);
  const id = Number(info.lastInsertRowid);
  setBindingConversation(db, binding.chatId, id);
  return id;
}

async function handleBoundMessage(db: DB, token: string, binding: Binding, text: string): Promise<void> {
  if (text === '/help') {
    await tgSendMessage(token, binding.chatId, 'Ask me to find or request something, or check your requests. /new starts a fresh chat.', {});
    return;
  }
  if (text === '/new') {
    clearBindingConversation(db, binding.chatId);
    await tgSendMessage(token, binding.chatId, 'Started a fresh chat.', {});
    return;
  }
  if (!text.trim()) return;

  if (binding.kind === 'consumer') {
    const consumer = getConsumer(db, binding.subjectId);
    if (!consumer) {
      await tgSendMessage(token, binding.chatId, 'Your account is no longer active.', {});
      return;
    }
    // Re-read the binding so any previously-set conversation_id is fresh
    const fresh = getBinding(db, binding.chatId) ?? binding;
    const conversationId = ensureConsumerConversation(db, fresh, consumer.id);
    const ctx: AgentContext = {
      db,
      user: { id: 0, email: 'consumer' },
      consumer: { id: consumer.id, roleId: consumer.roleId },
      channel: 'telegram',
      conversationId
    };
    const ch = telegramChannel(token, binding.chatId);
    await tgSendChatAction(token, binding.chatId);
    await runConsumerTurn(ctx, ch, text);
    return;
  }

  await handleAdminMessage(db, token, binding, text);
}

/** Create (or reuse) an admin conversation with no consumer_id. */
function ensureAdminConversation(db: DB, binding: Binding): number {
  if (binding.conversationId) return binding.conversationId;
  const info = db.prepare('insert into ai_conversations(title,created_at) values(?,?)').run(null, Date.now());
  const id = Number(info.lastInsertRowid);
  setBindingConversation(db, binding.chatId, id);
  return id;
}

async function handleAdminMessage(db: DB, token: string, binding: Binding, text: string): Promise<void> {
  // Re-read the binding so any previously-set conversation_id is fresh.
  const fresh = getBinding(db, binding.chatId) ?? binding;
  const conversationId = ensureAdminConversation(db, fresh);
  const ctx: AgentContext = {
    db,
    user: { id: binding.subjectId, email: '' },
    channel: 'telegram',
    conversationId
  };
  const ch = telegramChannel(token, binding.chatId, {
    onConfirm: async (pendingId, summary) => {
      await tgSendMessage(token, binding.chatId, `🔐 ${summary}`, {
        inlineKeyboard: [[
          { text: '✅ Approve', callback_data: signCallback('approve', pendingId) },
          { text: '✕ Deny', callback_data: signCallback('deny', pendingId) }
        ]]
      });
    }
  });
  await tgSendChatAction(token, binding.chatId);
  await runAgentTurn(ctx, ch, text);
}

/** Handle an inline-keyboard callback_query from an admin confirmation card. */
async function handleCallback(db: DB, token: string, cq: any): Promise<void> {
  const chatId = cq?.message?.chat?.id;
  if (typeof chatId !== 'number') return;

  const parsed = verifyCallback(cq?.data ?? '');
  if (!parsed) {
    await tgAnswerCallback(token, cq.id, 'This action is no longer valid.');
    return;
  }

  const binding = getBinding(db, chatId);
  if (!binding || binding.kind !== 'admin') {
    await tgAnswerCallback(token, cq.id, 'Not allowed.');
    return;
  }

  // Clear the Telegram spinner promptly with a neutral ack; the resumed turn (or the
  // expired-message below) conveys the real outcome, so we never show "Approved ✅" for an
  // action that actually expired.
  await tgAnswerCallback(token, cq.id, parsed.action === 'approve' ? 'Working…' : 'Denied ✕');

  const conversationId = binding.conversationId ?? ensureAdminConversation(db, binding);
  const ctx: AgentContext = {
    db,
    user: { id: binding.subjectId, email: '' },
    channel: 'telegram',
    conversationId
  };

  const outcome = await executeConfirmed(ctx, parsed.pendingId, parsed.action === 'approve');
  if (!outcome.ok) {
    await tgSendMessage(token, chatId, '⚠️ This action has already been handled or expired.', {});
    return;
  }

  const ch = telegramChannel(token, chatId);
  await resumeAgentTurn(ctx, ch);
}
