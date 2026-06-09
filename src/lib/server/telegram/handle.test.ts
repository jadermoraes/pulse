import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { mintLinkToken, getBinding, bindChat, setBindingConversation } from './bindings';
import { setBotToken } from './config';
import * as api from './api';
import { handleUpdate } from './handle';
import { createRole } from '../identity/roles';
import { createConsumer } from '../identity/consumers';
import { _resetKeyCache } from '../crypto';
import { verifyCallback } from './callback-sig';
import { createMessage, addAdminRef, getMessage } from '../consumer/messages';
import * as notify from '../notify';

let db: DB;
beforeEach(() => {
  // Set the stable key FIRST — getBotToken/setBotToken (via config.ts) call getKey(),
  // so the key must be pinned before anything encrypts or decrypts the bot token.
  process.env.PULSE_SECRET_KEY = 'b'.repeat(64);
  _resetKeyCache();
  db = openDb(':memory:'); migrate(db); setBotToken(db, 'TOK');
  vi.spyOn(api, 'tgSendMessage').mockResolvedValue({});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PULSE_SECRET_KEY;
  _resetKeyCache();
});

it('/start <token> binds the chat and confirms', async () => {
  const { token } = mintLinkToken(db, 'consumer', 5);
  await handleUpdate(db, { update_id: 1, message: { chat: { id: 100 }, from: { username: 'ana' }, text: `/start ${token}` } });
  expect(getBinding(db, 100)).toMatchObject({ kind: 'consumer', subjectId: 5 });
  expect(api.tgSendMessage).toHaveBeenCalledWith('TOK', 100, expect.stringContaining('Linked'), expect.anything());
});
it('/start with a bad token tells the user to regenerate', async () => {
  await handleUpdate(db, { update_id: 2, message: { chat: { id: 101 }, text: '/start nope' } });
  expect(getBinding(db, 101)).toBeNull();
  expect(api.tgSendMessage).toHaveBeenCalledWith('TOK', 101, expect.stringContaining('expired'), expect.anything());
});
it('an unbound chat message gets the link prompt', async () => {
  await handleUpdate(db, { update_id: 3, message: { chat: { id: 102 }, text: 'hello?' } });
  expect(api.tgSendMessage).toHaveBeenCalledWith('TOK', 102, expect.stringContaining('not linked'), expect.anything());
});
it('ignores malformed updates without throwing', async () => {
  await expect(handleUpdate(db, { update_id: 4 } as any)).resolves.toBeUndefined();
});

// ── Consumer agent routing (Task 12) ──────────────────────────────────────────

describe('consumer agent routing', () => {
  const CHAT_ID = 200;
  let roleId: number;
  let consumerId: number;

  beforeEach(() => {
    process.env.PULSE_AGENT_FAKE = '1';
    vi.spyOn(api, 'tgSendChatAction').mockResolvedValue({});
    roleId = createRole(db, { name: 'Member', allowList: [], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} });
    consumerId = createConsumer(db, { roleId, displayName: 'Bob', language: 'en' });
    bindChat(db, CHAT_ID, 'consumer', consumerId, 'bob');
  });

  afterEach(() => {
    delete process.env.PULSE_AGENT_FAKE;
  });

  it('a text message from a bound consumer runs a turn and persists a conversation_id', async () => {
    await handleUpdate(db, { update_id: 10, message: { chat: { id: CHAT_ID }, text: 'what can I watch?' } });

    // tgSendMessage was called with a reply (the fake turn emits text + done → telegramChannel posts)
    expect(api.tgSendMessage).toHaveBeenCalled();

    // binding now has a conversation_id
    const binding = getBinding(db, CHAT_ID);
    expect(binding?.conversationId).toBeTypeOf('number');
    expect(binding?.conversationId).toBeGreaterThan(0);
  });

  it('a second message reuses the same conversation_id', async () => {
    await handleUpdate(db, { update_id: 11, message: { chat: { id: CHAT_ID }, text: 'first message' } });
    const firstConvId = getBinding(db, CHAT_ID)?.conversationId;
    expect(firstConvId).toBeTypeOf('number');

    await handleUpdate(db, { update_id: 12, message: { chat: { id: CHAT_ID }, text: 'second message' } });
    const secondConvId = getBinding(db, CHAT_ID)?.conversationId;

    expect(secondConvId).toBe(firstConvId);
  });

  it('/new clears the conversation and sends a confirmation', async () => {
    // Establish a conversation first
    await handleUpdate(db, { update_id: 13, message: { chat: { id: CHAT_ID }, text: 'hello' } });
    const convId = getBinding(db, CHAT_ID)?.conversationId;
    expect(convId).toBeTypeOf('number');

    vi.clearAllMocks();
    vi.spyOn(api, 'tgSendMessage').mockResolvedValue({});
    vi.spyOn(api, 'tgSendChatAction').mockResolvedValue({});

    await handleUpdate(db, { update_id: 14, message: { chat: { id: CHAT_ID }, text: '/new' } });

    // conversation_id should be null now
    const binding = getBinding(db, CHAT_ID);
    expect(binding?.conversationId).toBeNull();

    // confirmation sent
    expect(api.tgSendMessage).toHaveBeenCalledWith('TOK', CHAT_ID, expect.stringContaining('fresh'), expect.anything());
  });

  it('/help posts a help message without running a turn', async () => {
    await handleUpdate(db, { update_id: 15, message: { chat: { id: CHAT_ID }, text: '/help' } });

    expect(api.tgSendMessage).toHaveBeenCalledWith('TOK', CHAT_ID, expect.stringContaining('/new'), expect.anything());
    // no conversation created
    expect(getBinding(db, CHAT_ID)?.conversationId).toBeNull();
    // no chat action (typing) sent — no LLM turn ran
    expect(api.tgSendChatAction).not.toHaveBeenCalled();
  });
});

// ── Admin confirm callback (Task 14) ──────────────────────────────────────────

describe('admin confirm callback', () => {
  const ADMIN_CHAT = 400;
  const ADMIN_USER_ID = 99;

  beforeEach(() => {
    process.env.PULSE_AGENT_FAKE = '1';
    vi.spyOn(api, 'tgSendChatAction').mockResolvedValue({});
    vi.spyOn(api, 'tgAnswerCallback').mockResolvedValue({});
    bindChat(db, ADMIN_CHAT, 'admin', ADMIN_USER_ID, 'boss');
  });

  afterEach(() => {
    delete process.env.PULSE_AGENT_FAKE;
  });

  it('valid approve → answerCallback called + pending consumed + resume runs', async () => {
    // First, run a turn that triggers confirmation_required to get a real pendingId.
    await handleUpdate(db, { update_id: 30, message: { chat: { id: ADMIN_CHAT }, text: 'restart jellyfin' } });

    // The inline keyboard was sent; extract the pendingId from the approve button.
    const kbCall = vi.mocked(api.tgSendMessage).mock.calls.find((c) => (c[3] as any)?.inlineKeyboard);
    expect(kbCall).toBeDefined();
    const approveBtn = (kbCall![3] as any).inlineKeyboard[0][0] as { callback_data: string };
    const parsed = verifyCallback(approveBtn.callback_data);
    expect(parsed).not.toBeNull();
    const { pendingId } = parsed!;

    vi.clearAllMocks();
    vi.spyOn(api, 'tgSendMessage').mockResolvedValue({});
    vi.spyOn(api, 'tgAnswerCallback').mockResolvedValue({});

    // Now send the callback_query update for the approve button.
    await handleUpdate(db, {
      update_id: 31,
      callback_query: {
        id: 'cq-approve-1',
        data: approveBtn.callback_data,
        message: { chat: { id: ADMIN_CHAT } }
      }
    });

    // answerCallback must have been called (spinner cleared)
    expect(api.tgAnswerCallback).toHaveBeenCalledWith('TOK', 'cq-approve-1', expect.any(String));

    // The fake resume path sends a "Done" message via telegramChannel
    expect(api.tgSendMessage).toHaveBeenCalled();
  });

  it('valid deny → answerCallback called + pending consumed', async () => {
    await handleUpdate(db, { update_id: 32, message: { chat: { id: ADMIN_CHAT }, text: 'restart jellyfin' } });

    const kbCall = vi.mocked(api.tgSendMessage).mock.calls.find((c) => (c[3] as any)?.inlineKeyboard);
    expect(kbCall).toBeDefined();
    const denyBtn = (kbCall![3] as any).inlineKeyboard[0][1] as { callback_data: string };

    vi.clearAllMocks();
    vi.spyOn(api, 'tgSendMessage').mockResolvedValue({});
    vi.spyOn(api, 'tgAnswerCallback').mockResolvedValue({});

    await handleUpdate(db, {
      update_id: 33,
      callback_query: {
        id: 'cq-deny-1',
        data: denyBtn.callback_data,
        message: { chat: { id: ADMIN_CHAT } }
      }
    });

    expect(api.tgAnswerCallback).toHaveBeenCalledWith('TOK', 'cq-deny-1', expect.any(String));
    // After deny, resumeAgentTurn also runs (fake emits done → tgSendMessage)
    expect(api.tgSendMessage).toHaveBeenCalled();
  });

  it('tampered callback_data → answerCallback with invalid text + no execution (pending still present)', async () => {
    // Register a pending directly so we can check it was NOT consumed.
    const { registerPending, getPending, __resetPending } = await import('../agent/confirm');
    __resetPending();
    const conversationId = db.prepare('insert into ai_conversations(title,created_at) values(?,?)').run(null, Date.now()).lastInsertRowid as number;
    setBindingConversation(db, ADMIN_CHAT, Number(conversationId));
    const pendingId = registerPending({ conversationId, tool: 'restartContainer', args: {}, summary: 'restart' });

    // Craft a signed callback data for the pendingId, then tamper the sig.
    const { signCallback } = await import('./callback-sig');
    const valid = signCallback('approve', pendingId);
    const tampered = valid.slice(0, -4) + 'xxxx';

    vi.clearAllMocks();
    vi.spyOn(api, 'tgSendMessage').mockResolvedValue({});
    vi.spyOn(api, 'tgAnswerCallback').mockResolvedValue({});

    await handleUpdate(db, {
      update_id: 34,
      callback_query: { id: 'cq-bad-1', data: tampered, message: { chat: { id: ADMIN_CHAT } } }
    });

    // answerCallback called with invalid/error text
    expect(api.tgAnswerCallback).toHaveBeenCalledWith('TOK', 'cq-bad-1', expect.stringMatching(/valid|expired|invalid/i));
    // Pending was NOT consumed
    expect(getPending(pendingId)).toBeDefined();
    // No execution (no tgSendMessage for narration)
    expect(api.tgSendMessage).not.toHaveBeenCalled();

    __resetPending();
  });

  it('callback from a non-admin (consumer) chat → rejected with "Not allowed", no execution', async () => {
    const { registerPending, getPending, __resetPending } = await import('../agent/confirm');
    __resetPending();
    const conversationId = db.prepare('insert into ai_conversations(title,created_at) values(?,?)').run(null, Date.now()).lastInsertRowid as number;
    const pendingId = registerPending({ conversationId, tool: 'restartContainer', args: {}, summary: 'restart' });

    const { signCallback } = await import('./callback-sig');
    const validData = signCallback('approve', pendingId);

    // Bind a CONSUMER (not admin) chat
    const CONSUMER_CHAT = 401;
    const { createRole } = await import('../identity/roles');
    const { createConsumer } = await import('../identity/consumers');
    const roleId = createRole(db, { name: 'R', allowList: [], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} });
    const consumerId = createConsumer(db, { roleId, displayName: 'C', language: 'en' });
    bindChat(db, CONSUMER_CHAT, 'consumer', consumerId, 'consumer');

    vi.clearAllMocks();
    vi.spyOn(api, 'tgSendMessage').mockResolvedValue({});
    vi.spyOn(api, 'tgAnswerCallback').mockResolvedValue({});

    await handleUpdate(db, {
      update_id: 35,
      callback_query: { id: 'cq-consumer-1', data: validData, message: { chat: { id: CONSUMER_CHAT } } }
    });

    expect(api.tgAnswerCallback).toHaveBeenCalledWith('TOK', 'cq-consumer-1', expect.stringContaining('Not allowed'));
    expect(getPending(pendingId)).toBeDefined();
    expect(api.tgSendMessage).not.toHaveBeenCalled();

    __resetPending();
  });

  it('callback from an unbound chat → rejected with "Not allowed", no execution', async () => {
    const { registerPending, getPending, __resetPending } = await import('../agent/confirm');
    __resetPending();
    const conversationId = db.prepare('insert into ai_conversations(title,created_at) values(?,?)').run(null, Date.now()).lastInsertRowid as number;
    const pendingId = registerPending({ conversationId, tool: 'restartContainer', args: {}, summary: 'restart' });

    const { signCallback } = await import('./callback-sig');
    const validData = signCallback('approve', pendingId);

    const UNBOUND_CHAT = 999;

    vi.clearAllMocks();
    vi.spyOn(api, 'tgSendMessage').mockResolvedValue({});
    vi.spyOn(api, 'tgAnswerCallback').mockResolvedValue({});

    await handleUpdate(db, {
      update_id: 36,
      callback_query: { id: 'cq-unbound-1', data: validData, message: { chat: { id: UNBOUND_CHAT } } }
    });

    expect(api.tgAnswerCallback).toHaveBeenCalledWith('TOK', 'cq-unbound-1', expect.stringContaining('Not allowed'));
    expect(getPending(pendingId)).toBeDefined();
    expect(api.tgSendMessage).not.toHaveBeenCalled();

    __resetPending();
  });
});

// ── Admin agent routing (Task 13) ─────────────────────────────────────────────
// Uses PULSE_AGENT_FAKE=1 so the fake drive runs: write-keywords trigger
// confirmation_required (with a real pendingId UUID) without a real LLM.

describe('admin agent routing', () => {
  const ADMIN_CHAT = 300;
  const ADMIN_USER_ID = 42;

  beforeEach(() => {
    process.env.PULSE_AGENT_FAKE = '1';
    vi.spyOn(api, 'tgSendChatAction').mockResolvedValue({});
    bindChat(db, ADMIN_CHAT, 'admin', ADMIN_USER_ID, 'boss');
  });

  afterEach(() => {
    delete process.env.PULSE_AGENT_FAKE;
  });

  it('sends an inline approve/deny keyboard when the agent emits confirmation_required', async () => {
    // "restart" is a write keyword in fakeDrive → emits confirmation_required
    await handleUpdate(db, { update_id: 20, message: { chat: { id: ADMIN_CHAT }, text: 'restart jellyfin' } });

    // Should have sent tgSendChatAction (typing indicator)
    expect(api.tgSendChatAction).toHaveBeenCalledWith('TOK', ADMIN_CHAT);

    // Should have sent an inline keyboard message with the approval prompt
    const calls = vi.mocked(api.tgSendMessage).mock.calls;
    const kbCall = calls.find((c) => (c[3] as any)?.inlineKeyboard);
    expect(kbCall).toBeDefined();

    const keyboard: api.InlineButton[][] = (kbCall![3] as any).inlineKeyboard;
    expect(keyboard).toHaveLength(1);
    expect(keyboard[0]).toHaveLength(2);

    const [approveBtn, denyBtn] = keyboard[0];

    // Both buttons' callback_data must pass HMAC verification (same pendingId)
    const approveResult = verifyCallback(approveBtn.callback_data);
    expect(approveResult).not.toBeNull();
    expect(approveResult!.action).toBe('approve');

    const denyResult = verifyCallback(denyBtn.callback_data);
    expect(denyResult).not.toBeNull();
    expect(denyResult!.action).toBe('deny');

    // Both buttons reference the same pending action
    expect(approveResult!.pendingId).toBe(denyResult!.pendingId);
  });

  it('creates a conversation and persists it on the binding', async () => {
    // "status" is a read keyword in fakeDrive → emits done (no confirmation)
    await handleUpdate(db, { update_id: 21, message: { chat: { id: ADMIN_CHAT }, text: 'show status' } });

    const binding = getBinding(db, ADMIN_CHAT);
    expect(binding?.conversationId).toBeTypeOf('number');
    expect(binding?.conversationId).toBeGreaterThan(0);
  });

  it('a second message reuses the same conversation_id', async () => {
    await handleUpdate(db, { update_id: 22, message: { chat: { id: ADMIN_CHAT }, text: 'show status' } });
    const firstConvId = getBinding(db, ADMIN_CHAT)?.conversationId;
    expect(firstConvId).toBeTypeOf('number');

    await handleUpdate(db, { update_id: 23, message: { chat: { id: ADMIN_CHAT }, text: 'show status' } });
    const secondConvId = getBinding(db, ADMIN_CHAT)?.conversationId;

    expect(secondConvId).toBe(firstConvId);
  });
});

// ── Admin telegram reply routing (Task 5) ─────────────────────────────────────

describe('admin telegram reply routing', () => {
  const ADMIN_CHAT = 555;
  const ADMIN_USER_ID = 1;

  beforeEach(() => {
    process.env.PULSE_AGENT_FAKE = '1';
    vi.spyOn(api, 'tgSendChatAction').mockResolvedValue({});
    bindChat(db, ADMIN_CHAT, 'admin', ADMIN_USER_ID, 'boss');
  });

  afterEach(() => {
    delete process.env.PULSE_AGENT_FAKE;
  });

  it('an admin telegram REPLY to a tracked message delivers it to the viewer (no agent turn)', async () => {
    const spy = vi.spyOn(notify, 'notifyConsumer').mockResolvedValue(undefined);
    const id = createMessage(db, 7, 'help');
    addAdminRef(db, ADMIN_CHAT, 9001, id);

    await handleUpdate(db, {
      update_id: 40,
      message: { chat: { id: ADMIN_CHAT }, from: { id: ADMIN_USER_ID }, text: 'try now', reply_to_message: { message_id: 9001 } }
    });

    expect(getMessage(db, id)!.replyBody).toBe('try now');
    expect(spy).toHaveBeenCalledWith(db, 7, expect.objectContaining({ body: 'try now' }));
    // The reply path must short-circuit before any agent turn: no typing indicator.
    expect(api.tgSendChatAction).not.toHaveBeenCalled();
  });

  it('a non-reply admin message still reaches the agent (not intercepted)', async () => {
    const spy = vi.spyOn(notify, 'notifyConsumer').mockResolvedValue(undefined);

    await handleUpdate(db, { update_id: 41, message: { chat: { id: ADMIN_CHAT }, from: { id: ADMIN_USER_ID }, text: 'show status' } });

    // Agent turn ran (typing indicator + conversation persisted), reply path NOT taken.
    expect(api.tgSendChatAction).toHaveBeenCalledWith('TOK', ADMIN_CHAT);
    expect(getBinding(db, ADMIN_CHAT)?.conversationId).toBeTypeOf('number');
    expect(spy).not.toHaveBeenCalled();
  });

  it('an admin reply to an UNTRACKED message falls through to the agent', async () => {
    const spy = vi.spyOn(notify, 'notifyConsumer').mockResolvedValue(undefined);

    await handleUpdate(db, {
      update_id: 42,
      message: { chat: { id: ADMIN_CHAT }, from: { id: ADMIN_USER_ID }, text: 'show status', reply_to_message: { message_id: 8888 } }
    });

    expect(api.tgSendChatAction).toHaveBeenCalledWith('TOK', ADMIN_CHAT);
    expect(spy).not.toHaveBeenCalled();
  });
});
