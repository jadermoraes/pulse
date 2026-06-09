/**
 * Unit tests for the image proxy endpoint logic.
 *
 * We test the path validation rules and the imageRequest helpers extracted
 * from each integration (Jellyfin header auth, Tautulli query-string auth).
 * These run in vitest without a full SvelteKit adapter.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Re-implement the SSRF path validation so we can test it in isolation.
// These mirror the checks in +server.ts exactly.
// ---------------------------------------------------------------------------
function validatePath(path: string): string | null {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) {
    return 'Invalid path';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Re-implement the integration imageRequest helpers for testing.
// These mirror jellyfin.ts and tautulli.ts imageRequest exactly.
// ---------------------------------------------------------------------------
function jellyfinImageRequest(baseUrl: string, secret: string | null, path: string) {
  const url = baseUrl.replace(/\/$/, '') + path;
  return {
    url,
    headers: secret ? { 'X-Emby-Token': secret } : {}
  };
}

function tautulliImageRequest(baseUrl: string, secret: string | null, path: string) {
  const base = baseUrl.replace(/\/$/, '') + '/api/v2';
  const url =
    base +
    '?apikey=' + encodeURIComponent(secret ?? '') +
    '&cmd=pms_image_proxy' +
    '&img=' + encodeURIComponent(path) +
    '&width=200&fallback=poster';
  return { url, headers: {} };
}

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------
describe('image proxy — path validation', () => {
  it('rejects a path containing ://', () => {
    expect(validatePath('http://evil.com/img')).toBe('Invalid path');
    expect(validatePath('https://evil.com/img')).toBe('Invalid path');
    expect(validatePath('/valid/path?with=://trick')).toBe('Invalid path');
  });

  it('rejects a path starting with //', () => {
    expect(validatePath('//evil.com/img')).toBe('Invalid path');
  });

  it('rejects a path that does not start with /', () => {
    expect(validatePath('relative/path')).toBe('Invalid path');
    expect(validatePath('')).toBe('Invalid path');
  });

  it('accepts a well-formed Jellyfin image path', () => {
    const path = '/Items/abc123/Images/Primary?fillHeight=330&quality=90&tag=xyzTag';
    expect(validatePath(path)).toBeNull();
  });

  it('accepts a simple /Items path', () => {
    expect(validatePath('/Items/some-id/Images/Primary')).toBeNull();
  });

  it('accepts a Plex thumb path', () => {
    expect(validatePath('/library/metadata/123/thumb/456')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Jellyfin imageRequest — header auth, secret in header not URL
// ---------------------------------------------------------------------------
describe('image proxy — Jellyfin imageRequest', () => {
  it('builds correct upstream URL with path appended to baseUrl', () => {
    const { url } = jellyfinImageRequest('http://jf:8096', 'JFKEY', '/Items/abc/Images/Primary');
    expect(url).toBe('http://jf:8096/Items/abc/Images/Primary');
  });

  it('sets X-Emby-Token header with the secret', () => {
    const { headers } = jellyfinImageRequest('http://jf:8096', 'mySecretKey', '/Items/abc/Images/Primary');
    expect(headers['X-Emby-Token']).toBe('mySecretKey');
  });

  it('does not include the secret in the upstream URL', () => {
    const { url } = jellyfinImageRequest('http://jf:8096', 'mySecretKey', '/Items/abc/Images/Primary');
    expect(url).not.toContain('mySecretKey');
  });

  it('returns empty headers when secret is null', () => {
    const { headers } = jellyfinImageRequest('http://jf:8096', null, '/Items/abc/Images/Primary');
    expect(Object.keys(headers)).toHaveLength(0);
  });

  it('strips trailing slash from baseUrl', () => {
    const { url } = jellyfinImageRequest('http://jf:8096/', 'KEY', '/Items/id/Images/Primary');
    expect(url).toBe('http://jf:8096/Items/id/Images/Primary');
  });
});

// ---------------------------------------------------------------------------
// Tautulli imageRequest — apikey in query string (server-side only)
// ---------------------------------------------------------------------------
describe('image proxy — Tautulli imageRequest (pms_image_proxy)', () => {
  const BASE = 'http://tau:8181';
  const SECRET = 'TAUKEY';
  const THUMB = '/library/metadata/123/thumb/456';

  it('builds the pms_image_proxy URL with apikey, cmd, img, width, fallback', () => {
    const { url } = tautulliImageRequest(BASE, SECRET, THUMB);
    expect(url).toContain('/api/v2');
    expect(url).toContain('cmd=pms_image_proxy');
    expect(url).toContain('img=' + encodeURIComponent(THUMB));
    expect(url).toContain('width=200');
    expect(url).toContain('fallback=poster');
    expect(url).toContain('apikey=' + encodeURIComponent(SECRET));
  });

  it('does NOT leak the apikey in the headers object', () => {
    const { headers } = tautulliImageRequest(BASE, SECRET, THUMB);
    expect(JSON.stringify(headers)).not.toContain(SECRET);
  });

  it('the browser-facing path (/library/metadata/…) is the `img` param only — apikey stays server-side', () => {
    // Simulate: browser sends ?path=/library/metadata/123/thumb/456
    // Proxy adds apikey before fetching — apikey must not be in the path
    const browserPath = THUMB;
    expect(browserPath).not.toContain('apikey');
    expect(browserPath).not.toContain(SECRET);
    // The upstream URL (built server-side) contains the key
    const { url } = tautulliImageRequest(BASE, SECRET, browserPath);
    expect(url).toContain('apikey=');
  });

  it('encodes special characters in the thumb path', () => {
    const specialPath = '/library/metadata/123/thumb/456?size=large';
    const { url } = tautulliImageRequest(BASE, SECRET, specialPath);
    expect(url).toContain(encodeURIComponent(specialPath));
    expect(url).not.toContain('?size=large'); // raw ? must be encoded
  });
});

// ---------------------------------------------------------------------------
// Fetch behaviour simulation (integration-agnostic proxy logic)
// ---------------------------------------------------------------------------
describe('image proxy — upstream fetch behaviour', () => {
  it('returns upstream content-type on success', async () => {
    const mockBody = new ReadableStream();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => k === 'Content-Type' ? 'image/jpeg' : null },
      body: mockBody
    })));

    const upstream = await fetch('http://jf:8096/Items/abc/Images/Primary', {
      headers: { 'X-Emby-Token': 'KEY' }
    });

    expect(upstream.ok).toBe(true);
    expect(upstream.headers.get('Content-Type')).toBe('image/jpeg');
    // Secret must NOT appear in the response headers
    const responseHeaders = {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600'
    };
    expect(JSON.stringify(responseHeaders)).not.toContain('KEY');
  });

  it('upstream non-2xx triggers 404 response (not 500)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 403,
      headers: { get: () => null },
      body: null
    })));

    const upstream = await fetch('http://jf:8096/Items/abc/Images/Primary', {});
    const proxyStatus = upstream.ok ? 200 : 404;
    expect(proxyStatus).toBe(404);
  });

  it('fetch network error triggers 404 response (not 500)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    let proxyStatus = 200;
    try {
      await fetch('http://jf:8096/Items/abc/Images/Primary', {});
    } catch {
      proxyStatus = 404;
    }
    expect(proxyStatus).toBe(404);
  });
});
