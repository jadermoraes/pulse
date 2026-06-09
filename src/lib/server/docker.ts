import http from 'node:http';

const SOCKET = process.env.PULSE_DOCKER_SOCKET ?? '/var/run/docker.sock';

export interface ContainerInfo {
  id: string; shortId: string; name: string; image: string; state: string; status: string;
}
export interface ContainerListResult { available: boolean; containers: ContainerInfo[]; }
export interface ContainerStats { cpuPercent: number; memPercent: number; }

// Minimal HTTP GET over the Docker unix socket. Rejects on socket/HTTP error.
function dockerGet<T>(path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET, path, method: 'GET', headers: { Host: 'docker' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) { reject(new Error(`HTTP ${status}`)); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T); }
          catch (e) { reject(e as Error); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

export async function listContainers(): Promise<ContainerListResult> {
  try {
    const raw = await dockerGet<any[]>('/containers/json?all=1');
    const containers: ContainerInfo[] = (raw ?? []).map((c) => ({
      id: c.Id,
      shortId: String(c.Id).slice(0, 12),
      name: (c.Names?.[0] ?? '').replace(/^\//, '') || c.Id,
      image: c.Image ?? '',
      state: c.State ?? 'unknown',
      status: c.Status ?? ''
    }));
    return { available: true, containers };
  } catch {
    return { available: false, containers: [] };
  }
}

export async function containerStats(id: string): Promise<ContainerStats | null> {
  try {
    const s = await dockerGet<any>(`/containers/${encodeURIComponent(id)}/stats?stream=false`);
    const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const systemDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
    const cpus = s.cpu_stats?.online_cpus ?? 1;
    const cpuPercent = systemDelta > 0 ? Math.round((cpuDelta / systemDelta) * cpus * 100) : 0;
    const memUsage = s.memory_stats?.usage ?? 0;
    const memLimit = s.memory_stats?.limit ?? 0;
    const memPercent = memLimit > 0 ? Math.round((memUsage / memLimit) * 100) : 0;
    return { cpuPercent, memPercent };
  } catch {
    return null;
  }
}

export interface ActionOutcome { ok: boolean; message?: string; }
export interface LogsOutcome { ok: boolean; logs?: string; message?: string; }

// POST with no body (restart/stop take query params, not a body). Resolves on 2xx, rejects otherwise.
function dockerSend(path: string, method: 'POST' = 'POST'): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET, path, method, headers: { Host: 'docker' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`));
            return;
          }
          resolve();
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// GET raw text (Docker log streams are not JSON). Strips the 8-byte stream header per line if present.
function dockerGetText(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET, path, method: 'GET', headers: { Host: 'docker' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) { reject(new Error(`HTTP ${status}`)); return; }
          // Best-effort: drop non-printable stream-multiplex headers, keep readable text.
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve(raw.replace(/[\x00-\x08\x0e-\x1f]/g, ''));
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

export interface DockerApiResult { status: number; data: unknown; }

/**
 * Generic passthrough to the Docker Engine API over the unix socket — same transport as
 * {@link listContainers}. Returns { status, data } for ANY HTTP status (never throws on a
 * non-2xx, so the agent can react) and { status: 0, data: { error } } on a transport error.
 * Body is JSON-encoded for non-GET requests. JSON responses are parsed; non-JSON bodies are
 * surfaced as { raw: <text> }.
 */
export function dockerRequest(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown
): Promise<DockerApiResult> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { Host: 'docker' };
    let payload: string | undefined;
    if (body !== undefined && method !== 'GET') {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const req = http.request(
      { socketPath: SOCKET, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8');
          let data: unknown;
          if (text.length === 0) data = {};
          else { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
          resolve({ status, data });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, data: { error: (e as Error).message } }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export async function restartContainer(id: string): Promise<ActionOutcome> {
  try { await dockerSend(`/containers/${encodeURIComponent(id)}/restart`); return { ok: true, message: 'Restarted' }; }
  catch (e) { return { ok: false, message: (e as Error).message }; }
}

export async function stopContainer(id: string): Promise<ActionOutcome> {
  try { await dockerSend(`/containers/${encodeURIComponent(id)}/stop`); return { ok: true, message: 'Stopped' }; }
  catch (e) { return { ok: false, message: (e as Error).message }; }
}

export async function containerLogs(id: string, tail = 200): Promise<LogsOutcome> {
  try {
    const logs = await dockerGetText(`/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true&tail=${tail}`);
    return { ok: true, logs };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export interface TopContainer { name: string; cpuPercent: number; memPercent: number; }
export interface TopResult { available: boolean; top: TopContainer[]; }

export async function topContainersByCpu(limit = 5): Promise<TopResult> {
  const list = await listContainers();
  if (!list.available) return { available: false, top: [] };
  const running = list.containers.filter((c) => c.state === 'running');
  const withStats = await Promise.all(running.map(async (c) => {
    const s = await containerStats(c.id);
    return { name: c.name, cpuPercent: s?.cpuPercent ?? 0, memPercent: s?.memPercent ?? 0 };
  }));
  withStats.sort((a, b) => b.cpuPercent - a.cpuPercent);
  return { available: true, top: withStats.slice(0, limit) };
}
