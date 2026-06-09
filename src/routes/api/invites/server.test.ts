import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GET, POST, DELETE } from './+server';
import { getDb } from '$lib/server/db';
import { createRole } from '$lib/server/identity/roles';
import { getInvite } from '$lib/server/identity/invites';

// The mint endpoint returns an absolute invite link when PULSE_PUBLIC_URL is set (so the admin
// can hand it directly to an invitee on the public origin), and a relative path otherwise.

function callPost(roleId: number) {
  const request = new Request('http://localhost/api/invites', {
    method: 'POST',
    body: JSON.stringify({ roleId })
  });
  return POST({ request, locals: { user: { id: 1, email: 'a@b.c' } } } as any);
}

let roleId: number;
let n = 0;
beforeEach(() => {
  const db = getDb();
  roleId = createRole(db, { name: `Member${n++}`, allowList: ['discover'], monthlyTokenCap: 1000, autoApprove: false, seerrQuota: {} });
});
afterEach(() => {
  delete process.env.PULSE_PUBLIC_URL;
});

function callDelete(body: unknown, authed = true) {
  const request = new Request('http://localhost/api/invites', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return DELETE({ request, locals: authed ? { user: { id: 1, email: 'a@b.c' } } : { user: null } } as any);
}

function callGet(authed = true) {
  const request = new Request('http://localhost/api/invites', { method: 'GET' });
  return GET({ request, locals: authed ? { user: { id: 1, email: 'a@b.c' } } : { user: null } } as any);
}

describe('DELETE /api/invites', () => {
  it('rejects unauthenticated requests with 401', async () => {
    await expect(callDelete({ id: 1 }, false)).rejects.toMatchObject({ status: 401 });
  });

  it('requires id in body', async () => {
    await expect(callDelete({})).rejects.toMatchObject({ status: 400 });
  });

  it('deletes an existing pending invite and returns {ok:true}', async () => {
    // Mint an invite first via POST
    const postRes = await callPost(roleId);
    const { token } = await postRes.json();
    const db = getDb();
    const inv = getInvite(db, token)!;
    expect(inv).not.toBeNull();

    const res = await callDelete({ id: inv.id });
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    // Verify it is gone
    expect(getInvite(db, token)).toBeNull();
  });

  it('is idempotent — deleting a non-existent id returns {ok:true}', async () => {
    const res = await callDelete({ id: 99999 });
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});

describe('GET /api/invites — link field', () => {
  it('includes a link field for each invite', async () => {
    await callPost(roleId);
    const res = await callGet();
    const body = await res.json();
    expect(body.invites.length).toBeGreaterThan(0);
    expect(body.invites[0].link).toBeDefined();
  });

  it('link is relative by default', async () => {
    await callPost(roleId);
    const res = await callGet();
    const body = await res.json();
    expect(body.invites[0].link).toMatch(/^\/app\/join\//);
  });

  it('link is absolute when PULSE_PUBLIC_URL is set', async () => {
    process.env.PULSE_PUBLIC_URL = 'https://app.example.com';
    await callPost(roleId);
    const res = await callGet();
    const body = await res.json();
    expect(body.invites[0].link).toMatch(/^https:\/\/app\.example\.com\/app\/join\//);
  });

  it('rejects unauthenticated GET with 401', async () => {
    await expect(callGet(false)).rejects.toMatchObject({ status: 401 });
  });
});

describe('invite link', () => {
  it('is absolute on the public origin when PULSE_PUBLIC_URL is set', async () => {
    process.env.PULSE_PUBLIC_URL = 'https://app.example.com';
    const res = await callPost(roleId);
    const body = await res.json();
    expect(body.link).toBe(`https://app.example.com/app/join/${body.token}`);
  });

  it('strips a trailing slash on PULSE_PUBLIC_URL', async () => {
    process.env.PULSE_PUBLIC_URL = 'https://app.example.com/';
    const res = await callPost(roleId);
    const body = await res.json();
    expect(body.link).toBe(`https://app.example.com/app/join/${body.token}`);
  });

  it('falls back to a relative path when PULSE_PUBLIC_URL is unset', async () => {
    const res = await callPost(roleId);
    const body = await res.json();
    expect(body.link).toBe(`/app/join/${body.token}`);
  });
});
