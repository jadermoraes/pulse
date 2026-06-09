import { describe, it, expect } from 'vitest';
import { parseSseChunk, streamSse, type AgentSseEvent } from './sse';

describe('parseSseChunk', () => {
  it('parses a single complete frame', () => {
    const { events, rest } = parseSseChunk('data: {"type":"meta","conversationId":7}\n\n');
    expect(events).toEqual([{ type: 'meta', conversationId: 7 }]);
    expect(rest).toBe('');
  });

  it('parses multiple frames in one chunk', () => {
    const buf =
      'data: {"type":"text","delta":"Hi"}\n\n' +
      'data: {"type":"text","delta":" there"}\n\n';
    const { events } = parseSseChunk(buf);
    expect(events).toEqual([
      { type: 'text', delta: 'Hi' },
      { type: 'text', delta: ' there' }
    ]);
  });

  it('holds back an incomplete trailing frame as rest', () => {
    const buf = 'data: {"type":"text","delta":"a"}\n\ndata: {"type":"text","del';
    const { events, rest } = parseSseChunk(buf);
    expect(events).toEqual([{ type: 'text', delta: 'a' }]);
    expect(rest).toBe('data: {"type":"text","del');
  });

  it('skips malformed JSON frames without throwing', () => {
    const buf = 'data: not-json\n\ndata: {"type":"done","usage":{"input":1,"output":2,"total":3}}\n\n';
    const { events } = parseSseChunk(buf);
    expect(events).toEqual([{ type: 'done', usage: { input: 1, output: 2, total: 3 } }]);
  });

  it('parses the confirmation_required frame shape', () => {
    const buf =
      'data: {"type":"confirmation_required","pendingId":"p1","tool":"runAction","summary":"do it","args":{"x":1}}\n\n';
    const { events } = parseSseChunk(buf);
    expect(events[0]).toEqual({
      type: 'confirmation_required',
      pendingId: 'p1',
      tool: 'runAction',
      summary: 'do it',
      args: { x: 1 }
    });
  });

  it('ignores non-data lines (comments / keep-alives)', () => {
    const { events } = parseSseChunk(':keep-alive\n\ndata: {"type":"text","delta":"x"}\n\n');
    expect(events).toEqual([{ type: 'text', delta: 'x' }]);
  });
});

describe('streamSse', () => {
  function responseFrom(chunks: string[]): Response {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      }
    });
    return new Response(stream);
  }

  it('dispatches events split across chunk boundaries', async () => {
    const res = responseFrom([
      'data: {"type":"meta","conversationId":3}\n\ndata: {"type":"te',
      'xt","delta":"Hello"}\n\n',
      'data: {"type":"done","usage":{"input":5,"output":6,"total":11}}\n\n'
    ]);
    const got: AgentSseEvent[] = [];
    await streamSse(res, (e) => got.push(e));
    expect(got).toEqual([
      { type: 'meta', conversationId: 3 },
      { type: 'text', delta: 'Hello' },
      { type: 'done', usage: { input: 5, output: 6, total: 11 } }
    ]);
  });

  it('no-ops on a body-less response', async () => {
    const got: AgentSseEvent[] = [];
    await streamSse(new Response(null), (e) => got.push(e));
    expect(got).toEqual([]);
  });
});
