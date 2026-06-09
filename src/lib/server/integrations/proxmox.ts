import * as https from 'node:https';
import * as http from 'node:http';
import type { Connection } from '../connections';
import type { Integration, WidgetResult } from './types';
import { registerIntegration } from './registry';

function base(conn: Connection): string { return conn.baseUrl.replace(/\/$/, ''); }
function tokenId(conn: Connection): string {
  return String((conn.options as any)?.tokenId ?? '');
}
function tokenSecret(conn: Connection): string {
  return conn.secret ?? '';
}

/**
 * Transport interface — injectable in tests so no real HTTP calls are made.
 * The default implementation uses node:https/http directly with
 * rejectUnauthorized:false, scoped only to this module.
 */
export interface PveTransport {
  request(opts: {
    protocol: string;
    hostname: string;
    port: number;
    path: string;
    headers: Record<string, string>;
    timeoutMs: number;
    method?: string;
    body?: string;
  }): Promise<{ status: number; body: string }>;
}

/** Default transport: node:https with rejectUnauthorized:false (self-signed PVE cert). */
export const defaultTransport: PveTransport = {
  request({ protocol, hostname, port, path, headers, timeoutMs, method, body }) {
    return new Promise((resolve, reject) => {
      const isHttps = protocol === 'https:';
      const mod = isHttps ? https : http;
      const reqOptions: https.RequestOptions = {
        hostname,
        port,
        path,
        method: method ?? 'GET',
        headers,
        // Only skip TLS verification for HTTPS Proxmox calls — never touches the global flag.
        ...(isHttps ? { rejectUnauthorized: false } : {})
      };

      const req = mod.request(reqOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      });

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Proxmox request timed out after ${timeoutMs}ms`));
      });

      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
};

/** Low-level GET helper — injectable in tests via the optional `transport` parameter. */
export async function pveGet(
  baseUrl: string,
  path: string,
  tid: string,
  tsecret: string,
  transport: PveTransport = defaultTransport
): Promise<any> {
  const url = new URL(baseUrl.replace(/\/$/, '') + path);

  const { status, body } = await transport.request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    headers: { Authorization: `PVEAPIToken=${tid}=${tsecret}` },
    timeoutMs: 8_000
  });

  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);

  const parsed = JSON.parse(body);
  return parsed?.data ?? parsed;
}

/** Resolve the node name: use configured value or fetch the first node from /nodes. */
async function resolveNode(
  conn: Connection,
  transport: PveTransport
): Promise<string> {
  const configured = String((conn.options as any)?.node ?? '').trim();
  if (configured) return configured;
  const nodes = await pveGet(base(conn), '/api2/json/nodes', tokenId(conn), tokenSecret(conn), transport);
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('No nodes returned by Proxmox');
  return String(nodes[0].node);
}

/**
 * Internal factory — creates the integration object with an injectable transport.
 * This enables full unit testing of testConnection and status without touching
 * the real network. The exported `proxmox` uses defaultTransport.
 */
export function createProxmoxIntegration(transport: PveTransport = defaultTransport): Integration {
  return {
    type: 'proxmox',
    label: 'Proxmox',
    icon: 'proxmox',
    configSchema: [
      { key: 'baseUrl',      label: 'Server URL',     type: 'url',      required: true,  placeholder: 'https://192.168.1.20:8006' },
      { key: 'tokenId',      label: 'Token ID',        type: 'text',     required: true,  placeholder: 'pulse@pve!token' },
      { key: 'secret',       label: 'Token Secret',    type: 'password', required: true  },
      { key: 'node',         label: 'Node name',       type: 'text',     required: false, placeholder: 'pve' }
    ],

    async testConnection(conn) {
      try {
        const data = await pveGet(base(conn), '/api2/json/version', tokenId(conn), tokenSecret(conn), transport);
        const version = data?.version ?? data?.release ?? '';
        return { ok: true, message: `Connected · Proxmox VE ${version}`.trim() };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },

    widgets: {
      async status(conn): Promise<WidgetResult> {
        try {
          const node = await resolveNode(conn, transport);
          const s = await pveGet(base(conn), `/api2/json/nodes/${node}/status`, tokenId(conn), tokenSecret(conn), transport);

          const cpuFraction = Number(s.cpu ?? 0);
          const cpuPercent = Math.round(cpuFraction * 100);

          const memUsed  = Number(s.memory?.used  ?? 0);
          const memTotal = Number(s.memory?.total ?? 0);
          const memPercent = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;

          const diskUsed  = Number(s.rootfs?.used  ?? 0);
          const diskTotal = Number(s.rootfs?.total ?? 0);
          const diskPercent = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;

          const uptime = Number(s.uptime ?? 0);
          const loadavg = (s.loadavg as string[] | undefined) ?? [];
          const load = loadavg.slice(0, 3).map(Number);

          // Best-effort guest counts — failures are silently swallowed.
          let guests: { lxc: { total: number; running: number }; qemu: { total: number; running: number } } | undefined;
          try {
            const [lxcList, qemuList] = await Promise.all([
              pveGet(base(conn), `/api2/json/nodes/${node}/lxc`,  tokenId(conn), tokenSecret(conn), transport),
              pveGet(base(conn), `/api2/json/nodes/${node}/qemu`, tokenId(conn), tokenSecret(conn), transport)
            ]);
            const lxcArr  = Array.isArray(lxcList)  ? lxcList  : [];
            const qemuArr = Array.isArray(qemuList) ? qemuList : [];
            guests = {
              lxc:  { total: lxcArr.length,  running: lxcArr.filter((g: any)  => g.status === 'running').length },
              qemu: { total: qemuArr.length, running: qemuArr.filter((g: any) => g.status === 'running').length }
            };
          } catch {
            // guest counts are optional — ignore any error
          }

          return {
            ok: true,
            data: {
              node,
              cpuPercent,
              mem:     { used: memUsed,  total: memTotal  },
              memPercent,
              uptime,
              load,
              disk:    { used: diskUsed, total: diskTotal },
              diskPercent,
              ...(guests ? { guests } : {})
            }
          };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      }
    }
  };
}

export const proxmox: Integration = createProxmoxIntegration();

registerIntegration(proxmox);
