import { describe, it, expect, vi, afterEach } from 'vitest';
import { createProxmoxIntegration, pveGet, type PveTransport } from './proxmox';
import type { Connection } from '../connections';

const conn: Connection = {
  id: 1, type: 'proxmox', name: 'homelab',
  baseUrl: 'https://pve:8006',
  secret: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff',
  options: { tokenId: 'pulse@pve!token', node: 'pve' },
  enabled: true
};

const connNoNode: Connection = {
  ...conn,
  id: 2,
  options: { tokenId: 'pulse@pve!token' }   // no node configured
};

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a transport mock that maps request path → JSON data payload.
 * Wraps data in {data: ...} to simulate Proxmox's API envelope.
 */
function mockTransport(
  map: Record<string, unknown>,
  opts: { status?: Record<string, number> } = {}
): PveTransport {
  return {
    request: vi.fn(async ({ path }) => {
      const pathname = path.split('?')[0];
      const body = map[pathname];
      const status = opts.status?.[pathname] ?? (body !== undefined ? 200 : 404);
      return {
        status,
        body: JSON.stringify(body !== undefined ? { data: body } : {})
      };
    })
  };
}

// ---------------------------------------------------------------------------
// pveGet unit
// ---------------------------------------------------------------------------

describe('pveGet helper', () => {
  it('sends Authorization header with correct PVEAPIToken format', async () => {
    const transport: PveTransport = {
      request: vi.fn(async () => ({
        status: 200,
        body: JSON.stringify({ data: { version: '8.2' } })
      }))
    };

    await pveGet('https://pve:8006', '/api2/json/version', 'pulse@pve!dash', 'mysecret', transport);

    expect(transport.request).toHaveBeenCalledOnce();
    const call = (transport.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.headers.Authorization).toBe('PVEAPIToken=pulse@pve!dash=mysecret');
  });

  it('throws on non-2xx status', async () => {
    const transport: PveTransport = {
      request: vi.fn(async () => ({ status: 401, body: '{}' }))
    };

    await expect(
      pveGet('https://pve:8006', '/api2/json/version', 'tid', 'tsecret', transport)
    ).rejects.toThrow('HTTP 401');
  });

  it('returns the data property of the response body', async () => {
    const transport: PveTransport = {
      request: vi.fn(async () => ({
        status: 200,
        body: JSON.stringify({ data: { version: '8.3', release: '8' } })
      }))
    };

    const result = await pveGet('https://pve:8006', '/api2/json/version', 't', 's', transport);
    expect(result).toMatchObject({ version: '8.3' });
  });
});

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

describe('proxmox.testConnection', () => {
  it('returns ok with version string on success', async () => {
    const transport = mockTransport({ '/api2/json/version': { version: '8.2', release: '2' } });
    const integration = createProxmoxIntegration(transport);
    const r = await integration.testConnection(conn);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('8.2');
  });

  it('returns ok=false on auth failure (HTTP 401)', async () => {
    const transport: PveTransport = {
      request: vi.fn(async () => ({ status: 401, body: '{}' }))
    };
    const integration = createProxmoxIntegration(transport);
    const r = await integration.testConnection(conn);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('401');
  });

  it('returns ok=false on network error', async () => {
    const transport: PveTransport = {
      request: vi.fn(async () => { throw new Error('ECONNREFUSED'); })
    };
    const integration = createProxmoxIntegration(transport);
    const r = await integration.testConnection(conn);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// status widget
// ---------------------------------------------------------------------------

const nodeStatus = {
  cpu: 0.35,
  memory: { used: 4_294_967_296, total: 17_179_869_184 },  // 4 GB / 16 GB
  rootfs: { used: 10_737_418_240, total: 53_687_091_200 },  // 10 GB / 50 GB
  uptime: 93_600,                                             // 26 hours
  loadavg: ['0.15', '0.13', '0.09']
};

const lxcList  = [{ status: 'running' }, { status: 'running' }, { status: 'stopped' }];
const qemuList = [{ status: 'running' }];

describe('proxmox.widgets.status', () => {
  it('maps cpu fraction to cpuPercent', async () => {
    const transport = mockTransport({
      '/api2/json/nodes/pve/status': nodeStatus,
      '/api2/json/nodes/pve/lxc':    lxcList,
      '/api2/json/nodes/pve/qemu':   qemuList
    });
    const integration = createProxmoxIntegration(transport);
    const r = await integration.widgets.status(conn);
    expect(r.ok).toBe(true);
    expect((r.data as any).cpuPercent).toBe(35);
  });

  it('maps memory used/total bytes and percent', async () => {
    const transport = mockTransport({
      '/api2/json/nodes/pve/status': nodeStatus,
      '/api2/json/nodes/pve/lxc':    lxcList,
      '/api2/json/nodes/pve/qemu':   qemuList
    });
    const integration = createProxmoxIntegration(transport);
    const r = await integration.widgets.status(conn);
    const d = r.data as any;
    expect(d.mem.used).toBe(4_294_967_296);
    expect(d.mem.total).toBe(17_179_869_184);
    expect(d.memPercent).toBe(25);
  });

  it('maps disk used/total bytes and percent', async () => {
    const transport = mockTransport({
      '/api2/json/nodes/pve/status': nodeStatus,
      '/api2/json/nodes/pve/lxc':    lxcList,
      '/api2/json/nodes/pve/qemu':   qemuList
    });
    const integration = createProxmoxIntegration(transport);
    const r = await integration.widgets.status(conn);
    const d = r.data as any;
    expect(d.disk.used).toBe(10_737_418_240);
    expect(d.disk.total).toBe(53_687_091_200);
    expect(d.diskPercent).toBe(20);
  });

  it('passes uptime and load array', async () => {
    const transport = mockTransport({
      '/api2/json/nodes/pve/status': nodeStatus,
      '/api2/json/nodes/pve/lxc':    lxcList,
      '/api2/json/nodes/pve/qemu':   qemuList
    });
    const integration = createProxmoxIntegration(transport);
    const r = await integration.widgets.status(conn);
    const d = r.data as any;
    expect(d.uptime).toBe(93_600);
    expect(d.load).toEqual([0.15, 0.13, 0.09]);
  });

  it('includes guest counts when lxc/qemu succeed', async () => {
    const transport = mockTransport({
      '/api2/json/nodes/pve/status': nodeStatus,
      '/api2/json/nodes/pve/lxc':    lxcList,
      '/api2/json/nodes/pve/qemu':   qemuList
    });
    const integration = createProxmoxIntegration(transport);
    const r = await integration.widgets.status(conn);
    const d = r.data as any;
    expect(d.guests).toBeDefined();
    expect(d.guests.lxc).toMatchObject({ total: 3, running: 2 });
    expect(d.guests.qemu).toMatchObject({ total: 1, running: 1 });
  });

  it('omits guests but still succeeds when lxc/qemu endpoints fail', async () => {
    const transport = mockTransport({
      '/api2/json/nodes/pve/status': nodeStatus
      // lxc/qemu endpoints will return 404 → throw → guests omitted
    });
    const integration = createProxmoxIntegration(transport);
    const r = await integration.widgets.status(conn);
    expect(r.ok).toBe(true);
    expect((r.data as any).guests).toBeUndefined();
  });

  it('never includes the token secret in widget output', async () => {
    const transport = mockTransport({
      '/api2/json/nodes/pve/status': nodeStatus,
      '/api2/json/nodes/pve/lxc':    lxcList,
      '/api2/json/nodes/pve/qemu':   qemuList
    });
    const integration = createProxmoxIntegration(transport);
    const r = await integration.widgets.status(conn);
    const serialised = JSON.stringify(r);
    expect(serialised).not.toContain(conn.secret!);
  });

  it('auto-picks first node when node option is blank', async () => {
    const transport: PveTransport = {
      request: vi.fn(async ({ path }) => {
        if (path === '/api2/json/nodes') {
          return { status: 200, body: JSON.stringify({ data: [{ node: 'auto-node' }] }) };
        }
        if (path.startsWith('/api2/json/nodes/auto-node')) {
          return { status: 200, body: JSON.stringify({ data: nodeStatus }) };
        }
        return { status: 404, body: '{}' };
      })
    };
    const integration = createProxmoxIntegration(transport);
    const r = await integration.widgets.status(connNoNode);
    expect(r.ok).toBe(true);
    expect((r.data as any).node).toBe('auto-node');
  });

  it('returns ok=false when status endpoint unreachable', async () => {
    const transport: PveTransport = {
      request: vi.fn(async () => { throw new Error('ECONNREFUSED'); })
    };
    const integration = createProxmoxIntegration(transport);
    const r = await integration.widgets.status(conn);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });
});
