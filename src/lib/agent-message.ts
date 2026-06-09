// Extract display text from a conversation message as returned by GET /api/agent/conversations,
// where each item is `{ role, content: <persisted ModelMessage> }`.
//
// The persisted ModelMessage's `.content` is either:
//   - a plain string  (user messages: `{ role:'user', content:'hi' }`)
//   - an array of parts (assistant/tool: `{ role:'assistant', content:[{type:'text',text:'…'}, …] }`)
//
// The old inline extractor only handled the array case, so USER messages (string body) came back
// empty and were dropped on reload — leaving "only the replies". This handles every shape.
export function modelMessageText(m: { content?: unknown } | null | undefined): string {
  const c = m?.content;
  if (typeof c === 'string') return c;
  // Unwrap the ModelMessage body (`.content`) when present, else treat `c` itself as the body.
  const body =
    c && typeof c === 'object' && 'content' in (c as Record<string, unknown>)
      ? (c as { content: unknown }).content
      : c;
  if (typeof body === 'string') return body;
  if (Array.isArray(body)) {
    return body
      .filter((p) => p && typeof p === 'object' && (p as { type?: string }).type === 'text' && typeof (p as { text?: unknown }).text === 'string')
      .map((p) => (p as { text: string }).text)
      .join('');
  }
  if (body && typeof body === 'object' && typeof (body as { text?: unknown }).text === 'string') {
    return (body as { text: string }).text;
  }
  return '';
}
