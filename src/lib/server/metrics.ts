import { readFileSync, statfsSync, readdirSync } from 'node:fs';

export interface CpuStat { percent: number; }
export interface MemStat { totalKb: number; availableKb: number; percent: number; }
export interface DiskStat { mount: string; totalBytes: number; freeBytes: number; percent: number; }
export interface NetStat { rxBytes: number; txBytes: number; }
export interface DiskIOStat { readBytes: number; writeBytes: number; }

export interface ServerStats {
  available: boolean;
  cpu: CpuStat | null;
  memory: MemStat | null;
  disks: DiskStat[];
  uptimeSec: number | null;
  load: [number, number, number] | null;
  network: NetStat | null;
  diskIO: DiskIOStat | null;
  cpuTempC: number | null;
}

interface Options { mounts?: string[]; sampleMs?: number; }

// Configurable proc/sys roots so the container can read HOST metrics.
// When running in Docker, set:
//   PULSE_PROC_ROOT=/host/proc   (bind-mount /proc:/host/proc:ro)
//   PULSE_SYS_ROOT=/host/sys     (bind-mount /sys:/host/sys:ro)
// Defaults to the native roots so behaviour is unchanged when env vars are absent.
const PROC_ROOT = (process.env.PULSE_PROC_ROOT ?? '/proc').replace(/\/$/, '');
const SYS_ROOT = (process.env.PULSE_SYS_ROOT ?? '/sys').replace(/\/$/, '');

function readProc(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

// Sum the busy+idle jiffies from a `/proc/stat` "cpu …" line.
function parseCpuLine(text: string): { busy: number; total: number } | null {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const nums = line.trim().split(/\s+/).slice(1).map(Number);
  if (nums.length < 4 || nums.some(Number.isNaN)) return null;
  const idle = nums[3] + (nums[4] ?? 0); // idle + iowait
  const total = nums.reduce((a, b) => a + b, 0);
  return { busy: total - idle, total };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function readCpu(sampleMs: number): Promise<CpuStat | null> {
  const a = readProc(`${PROC_ROOT}/stat`);
  if (!a) return null;
  const s1 = parseCpuLine(a);
  if (!s1) return null;
  await sleep(Math.max(1, sampleMs));
  const b = readProc(`${PROC_ROOT}/stat`);
  const s2 = b ? parseCpuLine(b) : null;
  if (!s2) return null;
  const dTotal = s2.total - s1.total;
  const dBusy = s2.busy - s1.busy;
  if (dTotal <= 0) return { percent: 0 };
  return { percent: Math.round((dBusy / dTotal) * 100) };
}

function readMem(): MemStat | null {
  const text = readProc(`${PROC_ROOT}/meminfo`);
  if (!text) return null;
  const get = (key: string) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const totalKb = get('MemTotal');
  const availableKb = get('MemAvailable');
  if (totalKb == null || availableKb == null || totalKb === 0) return null;
  const percent = Math.round(((totalKb - availableKb) / totalKb) * 100);
  return { totalKb, availableKb, percent };
}

function readUptime(): number | null {
  const text = readProc(`${PROC_ROOT}/uptime`);
  if (!text) return null;
  const v = Number(text.trim().split(/\s+/)[0]);
  return Number.isFinite(v) ? Math.floor(v) : null;
}

function readLoad(): [number, number, number] | null {
  const text = readProc(`${PROC_ROOT}/loadavg`);
  if (!text) return null;
  const p = text.trim().split(/\s+/).slice(0, 3).map(Number);
  if (p.length < 3 || p.some(Number.isNaN)) return null;
  return [p[0], p[1], p[2]];
}

function readDisks(mounts: string[]): DiskStat[] {
  const out: DiskStat[] = [];
  for (const mount of mounts) {
    try {
      const s = statfsSync(mount) as { bsize: number; blocks: number; bavail: number };
      const totalBytes = s.bsize * s.blocks;
      const freeBytes = s.bsize * s.bavail;
      const percent = totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0;
      out.push({ mount, totalBytes, freeBytes, percent });
    } catch {
      // mount unreadable — skip it, don't fail the whole collection
    }
  }
  return out;
}

// Sum rx/tx bytes across all non-loopback interfaces in /proc/net/dev (cumulative counters).
function readNetwork(): NetStat | null {
  const text = readProc(`${PROC_ROOT}/net/dev`);
  if (!text) return null;
  let rxBytes = 0, txBytes = 0, found = false;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m) continue;
    const iface = m[1].trim();
    if (iface === 'lo') continue;
    const cols = m[2].trim().split(/\s+/).map(Number);
    if (cols.length < 9 || Number.isNaN(cols[0])) continue;
    rxBytes += cols[0];   // first column = receive bytes
    txBytes += cols[8];   // ninth column = transmit bytes
    found = true;
  }
  return found ? { rxBytes, txBytes } : null;
}

// Sum read/write bytes across whole-disk devices in /proc/diskstats (partitions skipped).
function readDiskIO(): DiskIOStat | null {
  const text = readProc(`${PROC_ROOT}/diskstats`);
  if (!text) return null;
  let readBytes = 0, writeBytes = 0, found = false;
  for (const line of text.trim().split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    const name = f[2];
    // Skip partitions (e.g. sda1, nvme0n1p1) — keep whole disks (sda, nvme0n1).
    if (/\d$/.test(name) && !/^nvme\d+n\d+$/.test(name)) continue;
    const readSectors = Number(f[5]);
    const writeSectors = Number(f[9]);
    if (Number.isNaN(readSectors) || Number.isNaN(writeSectors)) continue;
    readBytes += readSectors * 512;
    writeBytes += writeSectors * 512;
    found = true;
  }
  return found ? { readBytes, writeBytes } : null;
}

// First readable CPU temperature, milli-°C → °C. Tries thermal zones then hwmon.
function readCpuTemp(): number | null {
  try {
    for (const zone of readdirSync(`${SYS_ROOT}/class/thermal`)) {
      if (!zone.startsWith('thermal_zone')) continue;
      const raw = readProc(`${SYS_ROOT}/class/thermal/${zone}/temp`);
      if (raw) {
        const v = Number(raw.trim());
        if (Number.isFinite(v) && v > 0) return Math.round(v / 1000);
      }
    }
  } catch { /* no thermal dir */ }
  return null;
}

export async function collectStats(opts: Options = {}): Promise<ServerStats> {
  const mounts = opts.mounts ?? ['/'];
  const sampleMs = opts.sampleMs ?? 200;
  const cpu = await readCpu(sampleMs);
  const memory = readMem();
  const disks = readDisks(mounts);
  const uptimeSec = readUptime();
  const load = readLoad();
  const network = readNetwork();
  const diskIO = readDiskIO();
  const cpuTempC = readCpuTemp();
  const available = !!(cpu || memory || disks.length || uptimeSec != null || load);
  return { available, cpu, memory, disks, uptimeSec, load, network, diskIO, cpuTempC };
}
