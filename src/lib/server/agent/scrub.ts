// Defence-in-depth: tools already return scrubbed shapes, but every arg/result that
// touches the LLM, an SSE event, the audit log, or a stored message passes through here.
const SECRET_KEY = /(api[_-]?key|secret|token|password|passwd|authorization|auth[_-]?token|x-api-key|api[_-]?token|cookie)/i;
const SECRET_IN_URL = /([?&](?:api_?key|apikey|api_?token|token|password)=)[^&\s]+/gi;

export function scrub(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return value.replace(SECRET_IN_URL, '$1[redacted]');
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(scrub);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : scrub(v);
  }
  return out;
}
