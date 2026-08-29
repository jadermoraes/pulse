import { z } from 'zod';

// Unofficial. Stremio's Library is cloud datastore state, NOT addon-served: an addon can only
// produce a Discover row, so writing to the Library tab means these endpoints. No published
// contract, so every response is validated and a shape we do not recognise fails closed.
const API = 'https://api.strem.io/api';

export class StremioError extends Error {
  code: number | null;
  /** HTTP status of the response, when the error came from a non-2xx response. `null` for an
   *  in-body error envelope on an otherwise-2xx response. */
  status: number | null;
  constructor(message: string, code: number | null, status: number | null = null) {
    super(message);
    this.name = 'StremioError';
    this.code = code;
    this.status = status;
  }
}

export interface StremioLibraryItem {
  _id: string;
  name: string;
  type: string;
  poster: string | null;
  removed: boolean;
  temp: boolean;
  _ctime: string;
  _mtime: string;
  state: Record<string, unknown>;
  [k: string]: unknown;
}

const ErrorEnvelope = z.object({
  error: z.object({ code: z.number().nullish(), message: z.string().nullish() })
});

/** Stremio returns errors INSIDE a 200 body, so `res.ok` alone is not a success check. */
function throwIfErrorBody(body: unknown): void {
  const parsed = ErrorEnvelope.safeParse(body);
  if (parsed.success) {
    throw new StremioError(parsed.data.error.message ?? 'Stremio error', parsed.data.error.code ?? null);
  }
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  // Never interpolate the request body into an error — it carries the authKey or the password.
  if (!res.ok) throw new StremioError(`Stremio HTTP ${res.status}`, null, res.status);
  const json = await res.json();
  throwIfErrorBody(json);
  return json;
}

const LoginResult = z.object({ result: z.object({ authKey: z.string() }) });

export async function stremioLogin(email: string, password: string): Promise<string> {
  const json = await post('/login', { email, password, type: 'Login' });
  return LoginResult.parse(json).result.authKey;
}

const LibraryItem = z.object({
  _id: z.string(),
  name: z.string(),
  type: z.string(),
  poster: z.string().nullish(),
  removed: z.boolean().nullish(),
  temp: z.boolean().nullish(),
  _ctime: z.string().nullish(),
  _mtime: z.string().nullish(),
  state: z.record(z.string(), z.unknown()).nullish()
}).passthrough();

const GetResult = z.object({ result: z.array(LibraryItem) });

export async function datastoreGet(authKey: string): Promise<StremioLibraryItem[]> {
  const json = await post('/datastoreGet', { authKey, collection: 'libraryItem', all: true });
  return GetResult.parse(json).result.map((r) => ({
    ...r,
    poster: r.poster ?? null,
    removed: !!r.removed,
    temp: !!r.temp,
    _ctime: r._ctime ?? new Date(0).toISOString(),
    _mtime: r._mtime ?? new Date(0).toISOString(),
    state: r.state ?? {}
  })) as StremioLibraryItem[];
}

export async function datastorePut(authKey: string, changes: StremioLibraryItem[]): Promise<void> {
  if (changes.length === 0) return;
  await post('/datastorePut', { authKey, collection: 'libraryItem', changes });
}
