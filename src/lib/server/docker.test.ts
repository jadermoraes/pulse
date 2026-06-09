import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

// Fakes node:http.request for unix-socket Docker calls.
// `route(path)` returns { status, body } per requested socket path.
function mockHttp(route: (path: string) => { status: number; body: unknown } | Error) {
  vi.doMock('node:http', () => ({
    default: {
      request: (opts: any, cb: (res: any) => void) => {
        const req = new EventEmitter() as any;
        req.end = () => {
          const result = route(opts.path);
          if (result instanceof Error) { req.emit('error', result); return; }
          const res = new EventEmitter() as any;
          res.statusCode = result.status;
          cb(res);
          res.emit('data', Buffer.from(JSON.stringify(result.body)));
          res.emit('end');
        };
        req.destroy = () => {};
        return req;
      }
    }
  }));
}

const CONTAINERS = [
  { Id: 'abc123def456', Names: ['/jellyfin'], Image: 'jellyfin', State: 'running', Status: 'Up 2 hours' },
  { Id: 'def456', Names: ['/old'], Image: 'busybox', State: 'exited', Status: 'Exited (0)' }
];

const STATS = {
  cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 2 },
  precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
  memory_stats: { usage: 500, limit: 1000 }
};

describe('docker', () => {
  it('lists containers with normalized fields', async () => {
    mockHttp((p) => p.startsWith('/containers/json') ? { status: 200, body: CONTAINERS } : { status: 404, body: {} });
    const { listContainers } = await import('./docker');
    const r = await listContainers();
    expect(r.available).toBe(true);
    expect(r.containers[0]).toMatchObject({ id: 'abc123def456', name: 'jellyfin', image: 'jellyfin', state: 'running' });
    expect(r.containers[0].shortId).toBe('abc123def456'.slice(0, 12));
  });

  it('computes cpu% and mem% from stats deltas', async () => {
    mockHttp((p) => p.includes('/stats') ? { status: 200, body: STATS } : { status: 404, body: {} });
    const { containerStats } = await import('./docker');
    const s = await containerStats('abc');
    // cpuDelta=100, systemDelta=1000, online=2 → 100/1000 * 2 * 100 = 20
    expect(s).toMatchObject({ cpuPercent: 20, memPercent: 50 });
  });

  it('degrades gracefully when the socket is absent', async () => {
    mockHttp(() => new Error('ENOENT /var/run/docker.sock'));
    const { listContainers } = await import('./docker');
    const r = await listContainers();
    expect(r.available).toBe(false);
    expect(r.containers).toEqual([]);
  });
});

function mockHttpRich(route: (path: string, method: string) => { status: number; body: string } | Error) {
  const calls: any[] = [];
  vi.doMock('node:http', () => ({
    default: {
      request: (opts: any, cb: (res: any) => void) => {
        const req = new EventEmitter() as any;
        req.end = () => {
          calls.push({ path: opts.path, method: opts.method });
          const result = route(opts.path, opts.method ?? 'GET');
          if (result instanceof Error) { req.emit('error', result); return; }
          const res = new EventEmitter() as any;
          res.statusCode = result.status;
          cb(res);
          res.emit('data', Buffer.from(result.body));
          res.emit('end');
        };
        req.destroy = () => {};
        return req;
      }
    }
  }));
  return calls;
}

describe('docker write actions', () => {
  it('restartContainer POSTs /containers/{id}/restart', async () => {
    const calls = mockHttpRich((p, m) => p.includes('/restart') && m === 'POST'
      ? { status: 204, body: '' } : { status: 404, body: '' });
    const { restartContainer } = await import('./docker');
    const r = await restartContainer('abc');
    expect(r).toMatchObject({ ok: true });
    expect(calls.some((c) => c.path.includes('/containers/abc/restart') && c.method === 'POST')).toBe(true);
  });

  it('stopContainer POSTs /containers/{id}/stop', async () => {
    mockHttpRich((p, m) => p.includes('/stop') && m === 'POST' ? { status: 204, body: '' } : { status: 404, body: '' });
    const { stopContainer } = await import('./docker');
    expect((await stopContainer('abc')).ok).toBe(true);
  });

  it('restartContainer surfaces a permission error (read-only socket) as ok:false', async () => {
    mockHttpRich(() => ({ status: 403, body: 'permission denied' }));
    const { restartContainer } = await import('./docker');
    const r = await restartContainer('abc');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('403');
  });

  it('containerLogs returns recent log text (tail)', async () => {
    mockHttpRich((p) => p.includes('/logs') ? { status: 200, body: 'hello\nworld\n' } : { status: 404, body: '' });
    const { containerLogs } = await import('./docker');
    const r = await containerLogs('abc');
    expect(r.ok).toBe(true);
    expect(r.logs).toContain('hello');
  });
});

describe('dockerRequest (generic passthrough)', () => {
  it('GET /containers/json returns { status, data } with parsed JSON', async () => {
    const calls = mockHttpRich((p, m) => p.startsWith('/containers/json') && m === 'GET'
      ? { status: 200, body: JSON.stringify(CONTAINERS) } : { status: 404, body: '{}' });
    const { dockerRequest } = await import('./docker');
    const r = await dockerRequest('GET', '/containers/json?all=1');
    expect(r.status).toBe(200);
    expect((r.data as any[])[0]).toMatchObject({ Id: 'abc123def456' });
    expect(calls.some((c) => c.path === '/containers/json?all=1' && c.method === 'GET')).toBe(true);
  });

  it('POST passes the JSON body through to the socket', async () => {
    let captured: any = null;
    vi.doMock('node:http', () => ({
      default: {
        request: (opts: any, cb: (res: any) => void) => {
          const req = new EventEmitter() as any;
          req.write = (chunk: any) => { captured = (captured ?? '') + chunk; };
          req.end = (chunk?: any) => {
            if (chunk) captured = (captured ?? '') + chunk;
            const res = new EventEmitter() as any;
            res.statusCode = 201;
            cb(res);
            res.emit('data', Buffer.from('{"Id":"new"}'));
            res.emit('end');
          };
          req.destroy = () => {};
          return req;
        }
      }
    }));
    const { dockerRequest } = await import('./docker');
    const r = await dockerRequest('POST', '/containers/create', { Image: 'busybox' });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ Id: 'new' });
    expect(JSON.parse(captured)).toMatchObject({ Image: 'busybox' });
  });

  it('returns the real status on non-2xx WITHOUT throwing', async () => {
    mockHttpRich(() => ({ status: 409, body: '{"message":"conflict"}' }));
    const { dockerRequest } = await import('./docker');
    const r = await dockerRequest('POST', '/containers/abc/start');
    expect(r.status).toBe(409);
    expect(r.data).toMatchObject({ message: 'conflict' });
  });

  it('catches transport errors as { status: 0, data: { error } }', async () => {
    mockHttpRich(() => new Error('ENOENT /var/run/docker.sock'));
    const { dockerRequest } = await import('./docker');
    const r = await dockerRequest('GET', '/info');
    expect(r.status).toBe(0);
    expect((r.data as any).error).toContain('ENOENT');
  });

  it('returns raw text wrapped when the body is not JSON', async () => {
    mockHttpRich(() => ({ status: 200, body: 'plain text not json' }));
    const { dockerRequest } = await import('./docker');
    const r = await dockerRequest('GET', '/_ping');
    expect(r.status).toBe(200);
    // non-JSON body must not throw; surfaced in some readable form
    expect(JSON.stringify(r.data)).toContain('plain text');
  });
});

describe('topContainersByCpu', () => {
  it('returns running containers sorted by cpu desc', async () => {
    // Two running containers; stats differ so ordering is deterministic.
    mockHttp((p) => {
      if (p.startsWith('/containers/json')) return { status: 200, body: [
        { Id: 'aaa', Names: ['/low'], Image: 'i', State: 'running', Status: 'Up' },
        { Id: 'bbb', Names: ['/high'], Image: 'i', State: 'running', Status: 'Up' },
        { Id: 'ccc', Names: ['/stopped'], Image: 'i', State: 'exited', Status: 'Exited' }
      ] };
      if (p.includes('/aaa/stats')) return { status: 200, body: {
        cpu_stats: { cpu_usage: { total_usage: 110 }, system_cpu_usage: 2000, online_cpus: 1 },
        precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
        memory_stats: { usage: 100, limit: 1000 } } };
      if (p.includes('/bbb/stats')) return { status: 200, body: {
        cpu_stats: { cpu_usage: { total_usage: 600 }, system_cpu_usage: 2000, online_cpus: 1 },
        precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
        memory_stats: { usage: 500, limit: 1000 } } };
      return { status: 404, body: {} };
    });
    const { topContainersByCpu } = await import('./docker');
    const r = await topContainersByCpu(5);
    expect(r.available).toBe(true);
    expect(r.top.map((c: any) => c.name)).toEqual(['high', 'low']); // exited excluded, sorted desc
    expect(r.top[0].cpuPercent).toBeGreaterThan(r.top[1].cpuPercent);
  });

  it('degrades when the socket is absent', async () => {
    mockHttp(() => new Error('ENOENT'));
    const { topContainersByCpu } = await import('./docker');
    const r = await topContainersByCpu(5);
    expect(r.available).toBe(false);
    expect(r.top).toEqual([]);
  });
});

// Unit-level guard: the container id allowlist regex used in the [id]/[action] route.
// We test the pattern directly here so this stays a pure unit test (no SvelteKit harness needed).
describe('container id shape validation', () => {
  const CONTAINER_ID_RE = /^[a-zA-Z0-9_.-]+$/;

  it('accepts valid hex id (short)', () => expect(CONTAINER_ID_RE.test('abc123def456')).toBe(true));
  it('accepts valid hex id (full 64 char)', () => expect(CONTAINER_ID_RE.test('a'.repeat(64))).toBe(true));
  it('accepts user-defined names with allowed chars', () => {
    expect(CONTAINER_ID_RE.test('my-container_01.v2')).toBe(true);
  });
  it('rejects id containing "/"', () => expect(CONTAINER_ID_RE.test('abc/def')).toBe(false));
  it('rejects path traversal "../evil"', () => expect(CONTAINER_ID_RE.test('../evil')).toBe(false));
  it('rejects id with space', () => expect(CONTAINER_ID_RE.test('abc def')).toBe(false));
  it('rejects empty string', () => expect(CONTAINER_ID_RE.test('')).toBe(false));
  it('rejects id with query string characters', () => expect(CONTAINER_ID_RE.test('abc?x=1')).toBe(false));
});
