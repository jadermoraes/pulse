import { it, expect, afterEach, vi } from 'vitest';
import { stremioLogin, datastoreGet, datastorePut, StremioError } from './stremio';

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

function mockJson(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  global.fetch = spy as any;
  return spy;
}

const ITEM = {
  _id: 'tt0111161', name: 'Shawshank', type: 'movie', poster: 'p.jpg',
  removed: false, temp: false, _ctime: '2026-01-01T00:00:00.000Z',
  _mtime: '2026-01-01T00:00:00.000Z', state: { timeOffset: 0 }
};

it('login returns the authKey and posts the documented body', async () => {
  const spy = mockJson(200, { result: { authKey: 'ak-123' } });
  expect(await stremioLogin('fixture@example.invalid', 'pw')).toBe('ak-123');
  const [url, init] = spy.mock.calls[0] as any;
  expect(url).toBe('https://api.strem.io/api/login');
  expect(JSON.parse(init.body)).toEqual({ email: 'fixture@example.invalid', password: 'pw', type: 'Login' });
});

it('login surfaces an error carried INSIDE a 200 body', async () => {
  mockJson(200, { error: { code: 2, message: 'User not found', wrongEmail: true } });
  await expect(stremioLogin('fixture@example.invalid', 'pw')).rejects.toBeInstanceOf(StremioError);
});

it('login never puts the password in the thrown message', async () => {
  mockJson(200, { error: { code: 2, message: 'User not found' } });
  await expect(stremioLogin('fixture@example.invalid', 'fixture-not-a-password')).rejects.toThrow(/^(?!.*hunter2).*$/s);
});

it('datastoreGet returns the library array', async () => {
  const spy = mockJson(200, { result: [ITEM] });
  const items = await datastoreGet('ak');
  expect(items).toHaveLength(1);
  expect(items[0]._id).toBe('tt0111161');
  const [url, init] = spy.mock.calls[0] as any;
  expect(url).toBe('https://api.strem.io/api/datastoreGet');
  expect(JSON.parse(init.body)).toMatchObject({ authKey: 'ak', collection: 'libraryItem' });
});

it('datastoreGet rejects a malformed item rather than returning a partial library', async () => {
  mockJson(200, { result: [{ _id: 'tt1' }] }); // missing name/type/state
  await expect(datastoreGet('ak')).rejects.toThrow();
});

it('datastoreGet surfaces an in-body error', async () => {
  mockJson(200, { error: { code: 1, message: 'Invalid auth' } });
  await expect(datastoreGet('ak')).rejects.toBeInstanceOf(StremioError);
});

it('datastorePut posts the changes under the documented envelope', async () => {
  const spy = mockJson(200, { result: {} });
  await datastorePut('ak', [ITEM]);
  const [url, init] = spy.mock.calls[0] as any;
  expect(url).toBe('https://api.strem.io/api/datastorePut');
  expect(JSON.parse(init.body)).toEqual({ authKey: 'ak', collection: 'libraryItem', changes: [ITEM] });
});

it('datastorePut does nothing when there are no changes', async () => {
  const spy = mockJson(200, {});
  await datastorePut('ak', []);
  expect(spy).not.toHaveBeenCalled();
});

it('an authKey never appears in a thrown message', async () => {
  mockJson(500, {});
  await expect(datastoreGet('secret-key')).rejects.toThrow(/^(?!.*secret-key).*$/s);
});
