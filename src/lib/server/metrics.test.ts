import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

// Snapshots of /proc files; cpuPair lets us feed two /proc/stat samples.
function mockFs(opts: {
  stat?: [string, string];
  meminfo?: string;
  uptime?: string;
  loadavg?: string;
  statfs?: { bsize: number; blocks: number; bavail: number } | Error;
}) {
  let statCall = 0;
  vi.doMock('node:fs', () => ({
    readFileSync: (p: string) => {
      const path = String(p);
      if (path === '/proc/stat') {
        if (!opts.stat) throw new Error('ENOENT');
        return opts.stat[statCall++ % 2];
      }
      if (path === '/proc/meminfo') { if (opts.meminfo == null) throw new Error('ENOENT'); return opts.meminfo; }
      if (path === '/proc/uptime') { if (opts.uptime == null) throw new Error('ENOENT'); return opts.uptime; }
      if (path === '/proc/loadavg') { if (opts.loadavg == null) throw new Error('ENOENT'); return opts.loadavg; }
      throw new Error('ENOENT ' + path);
    },
    statfsSync: () => {
      if (opts.statfs instanceof Error || opts.statfs == null) throw (opts.statfs ?? new Error('ENOSYS'));
      return opts.statfs;
    }
  }));
}

const STAT_T0 = 'cpu  100 0 100 800 0 0 0 0 0 0\n';
const STAT_T1 = 'cpu  150 0 150 900 0 0 0 0 0 0\n'; // busy +100, total +200 → 50% over the window

describe('metrics', () => {
  it('parses memory percent from /proc/meminfo', async () => {
    mockFs({
      meminfo: 'MemTotal: 1000 kB\nMemAvailable: 250 kB\n',
      stat: [STAT_T0, STAT_T1],
      uptime: '3600.00 0.00\n',
      loadavg: '0.50 0.40 0.30 1/100 1234\n',
      statfs: { bsize: 4096, blocks: 1000, bavail: 250 }
    });
    const { collectStats } = await import('./metrics');
    const s = await collectStats({ mounts: ['/'], sampleMs: 1 });
    expect(s.memory).toMatchObject({ totalKb: 1000, availableKb: 250, percent: 75 });
  });

  it('computes cpu percent across two /proc/stat samples', async () => {
    mockFs({ meminfo: 'MemTotal: 1 kB\nMemAvailable: 1 kB\n', stat: [STAT_T0, STAT_T1],
      uptime: '10 0\n', loadavg: '0 0 0 1/1 1\n', statfs: { bsize: 1, blocks: 1, bavail: 1 } });
    const { collectStats } = await import('./metrics');
    const s = await collectStats({ mounts: ['/'], sampleMs: 1 });
    expect(s.cpu?.percent).toBe(50);
  });

  it('parses uptime and load', async () => {
    mockFs({ meminfo: 'MemTotal: 1 kB\nMemAvailable: 1 kB\n', stat: [STAT_T0, STAT_T1],
      uptime: '7200.5 0\n', loadavg: '1.50 1.00 0.50 2/200 9\n', statfs: { bsize: 1, blocks: 1, bavail: 1 } });
    const { collectStats } = await import('./metrics');
    const s = await collectStats({ mounts: ['/'], sampleMs: 1 });
    expect(s.uptimeSec).toBe(7200);
    expect(s.load).toEqual([1.5, 1.0, 0.5]);
  });

  it('reports disk usage per mount', async () => {
    mockFs({ meminfo: 'MemTotal: 1 kB\nMemAvailable: 1 kB\n', stat: [STAT_T0, STAT_T1],
      uptime: '10 0\n', loadavg: '0 0 0 1/1 1\n',
      statfs: { bsize: 4096, blocks: 1000, bavail: 250 } });
    const { collectStats } = await import('./metrics');
    const s = await collectStats({ mounts: ['/'], sampleMs: 1 });
    expect(s.disks[0]).toMatchObject({ mount: '/', percent: 75 });
    expect(s.disks[0].totalBytes).toBe(4096 * 1000);
  });

  it('degrades gracefully when /proc is unavailable', async () => {
    mockFs({ statfs: new Error('ENOSYS') }); // no proc files, no statfs
    const { collectStats } = await import('./metrics');
    const s = await collectStats({ mounts: ['/'], sampleMs: 1 });
    expect(s.available).toBe(false);
    expect(s.cpu).toBeNull();
    expect(s.memory).toBeNull();
    expect(s.disks).toEqual([]);
  });
});

function mockFsExt(opts: {
  stat?: [string, string]; meminfo?: string; uptime?: string; loadavg?: string;
  statfs?: { bsize: number; blocks: number; bavail: number } | Error;
  netdev?: string; diskstats?: string; thermal?: Record<string, string>;
}) {
  let statCall = 0;
  vi.doMock('node:fs', () => ({
    readFileSync: (p: string) => {
      const path = String(p);
      if (path === '/proc/stat') { if (!opts.stat) throw new Error('ENOENT'); return opts.stat[statCall++ % 2]; }
      if (path === '/proc/meminfo') { if (opts.meminfo == null) throw new Error('ENOENT'); return opts.meminfo; }
      if (path === '/proc/uptime') { if (opts.uptime == null) throw new Error('ENOENT'); return opts.uptime; }
      if (path === '/proc/loadavg') { if (opts.loadavg == null) throw new Error('ENOENT'); return opts.loadavg; }
      if (path === '/proc/net/dev') { if (opts.netdev == null) throw new Error('ENOENT'); return opts.netdev; }
      if (path === '/proc/diskstats') { if (opts.diskstats == null) throw new Error('ENOENT'); return opts.diskstats; }
      if (opts.thermal && opts.thermal[path] != null) return opts.thermal[path];
      throw new Error('ENOENT ' + path);
    },
    readdirSync: (p: string) => {
      const path = String(p);
      if (path === '/sys/class/thermal') return ['thermal_zone0'];
      return [];
    },
    statfsSync: () => {
      if (opts.statfs instanceof Error || opts.statfs == null) throw (opts.statfs ?? new Error('ENOSYS'));
      return opts.statfs;
    }
  }));
}

const NETDEV =
  'Inter-|   Receive                                                |  Transmit\n' +
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets\n' +
  '    lo: 1000 10 0 0 0 0 0 0 1000 10\n' +
  '  eth0: 5000 50 0 0 0 0 0 0 2000 20\n';
const DISKSTATS =
  '   8       0 sda 100 0 2048 0 50 0 1024 0 0 0 0\n' +
  '   8       1 sda1 10 0 200 0 5 0 100 0 0 0 0\n';

describe('metrics extended series', () => {
  it('sums network counters across non-loopback interfaces', async () => {
    mockFsExt({ meminfo: 'MemTotal: 1 kB\nMemAvailable: 1 kB\n', stat: [STAT_T0, STAT_T1],
      uptime: '10 0\n', loadavg: '0 0 0 1/1 1\n', statfs: { bsize: 1, blocks: 1, bavail: 1 },
      netdev: NETDEV, diskstats: DISKSTATS, thermal: { '/sys/class/thermal/thermal_zone0/temp': '42000\n' } });
    const { collectStats } = await import('./metrics');
    const s = await collectStats({ mounts: ['/'], sampleMs: 1 });
    expect(s.network).toMatchObject({ rxBytes: 5000, txBytes: 2000 }); // eth0 only, lo excluded
  });

  it('reads CPU temperature from thermal zone (milli-°C → °C)', async () => {
    mockFsExt({ meminfo: 'MemTotal: 1 kB\nMemAvailable: 1 kB\n', stat: [STAT_T0, STAT_T1],
      uptime: '10 0\n', loadavg: '0 0 0 1/1 1\n', statfs: { bsize: 1, blocks: 1, bavail: 1 },
      netdev: NETDEV, diskstats: DISKSTATS, thermal: { '/sys/class/thermal/thermal_zone0/temp': '42000\n' } });
    const { collectStats } = await import('./metrics');
    const s = await collectStats({ mounts: ['/'], sampleMs: 1 });
    expect(s.cpuTempC).toBe(42);
  });

  it('sums disk IO bytes across whole-disk devices (sectors × 512)', async () => {
    mockFsExt({ meminfo: 'MemTotal: 1 kB\nMemAvailable: 1 kB\n', stat: [STAT_T0, STAT_T1],
      uptime: '10 0\n', loadavg: '0 0 0 1/1 1\n', statfs: { bsize: 1, blocks: 1, bavail: 1 },
      netdev: NETDEV, diskstats: DISKSTATS, thermal: {} });
    const { collectStats } = await import('./metrics');
    const s = await collectStats({ mounts: ['/'], sampleMs: 1 });
    // sda: read sectors 2048 → 2048*512, write sectors 1024 → 1024*512 (sda1 partition skipped)
    expect(s.diskIO).toMatchObject({ readBytes: 2048 * 512, writeBytes: 1024 * 512 });
  });

  it('null for the new series when their sources are unavailable', async () => {
    mockFsExt({ meminfo: 'MemTotal: 1 kB\nMemAvailable: 1 kB\n', stat: [STAT_T0, STAT_T1],
      uptime: '10 0\n', loadavg: '0 0 0 1/1 1\n', statfs: { bsize: 1, blocks: 1, bavail: 1 } });
    const { collectStats } = await import('./metrics');
    const s = await collectStats({ mounts: ['/'], sampleMs: 1 });
    expect(s.network).toBeNull();
    expect(s.diskIO).toBeNull();
    expect(s.cpuTempC).toBeNull();
  });
});

// Verify that PULSE_PROC_ROOT / PULSE_SYS_ROOT redirect all file reads to the custom root.
describe('configurable proc/sys root (PULSE_PROC_ROOT / PULSE_SYS_ROOT)', () => {
  it('reads from a custom PULSE_PROC_ROOT when the env var is set', async () => {
    const PROC = '/host/proc';
    const SYS = '/host/sys';
    process.env.PULSE_PROC_ROOT = PROC;
    process.env.PULSE_SYS_ROOT = SYS;
    let statCall = 0;
    vi.doMock('node:fs', () => ({
      readFileSync: (p: string) => {
        const path = String(p);
        if (path === `${PROC}/stat`) return [STAT_T0, STAT_T1][statCall++ % 2];
        if (path === `${PROC}/meminfo`) return 'MemTotal: 2000 kB\nMemAvailable: 500 kB\n';
        if (path === `${PROC}/uptime`) return '100.0 0\n';
        if (path === `${PROC}/loadavg`) return '1.0 0.5 0.25 1/100 1\n';
        if (path === `${PROC}/net/dev`) return NETDEV;
        if (path === `${PROC}/diskstats`) return DISKSTATS;
        if (path === `${SYS}/class/thermal/thermal_zone0/temp`) return '55000\n';
        throw new Error('ENOENT unexpected path: ' + path);
      },
      readdirSync: (p: string) => {
        if (String(p) === `${SYS}/class/thermal`) return ['thermal_zone0'];
        return [];
      },
      statfsSync: () => ({ bsize: 4096, blocks: 100, bavail: 25 })
    }));
    try {
      const { collectStats } = await import('./metrics');
      const s = await collectStats({ mounts: ['/'], sampleMs: 1 });
      expect(s.memory).toMatchObject({ totalKb: 2000, availableKb: 500, percent: 75 });
      expect(s.cpu?.percent).toBe(50);
      expect(s.cpuTempC).toBe(55);
      expect(s.network).toMatchObject({ rxBytes: 5000, txBytes: 2000 });
    } finally {
      delete process.env.PULSE_PROC_ROOT;
      delete process.env.PULSE_SYS_ROOT;
    }
  });
});
