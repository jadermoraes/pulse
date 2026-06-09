import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { createConnection, deleteConnection, getConnection, listConnectionsPublic, updateConnection } from '$lib/server/connections';
import { getIntegration, listIntegrations } from '$lib/server/integrations';

export const load: PageServerLoad = async () => ({
  integrations: listIntegrations().map((i) => ({ type: i.type, label: i.label, icon: i.icon ?? i.type, schema: i.configSchema })),
  connections: listConnectionsPublic(getDb())
});

function parse(form: FormData) {
  const type = String(form.get('type'));
  const name = String(form.get('name'));
  const baseUrl = String(form.get('baseUrl'));
  const secret = String(form.get('secret') ?? '') || null;
  // Any other configSchema field for this type → options (excludes the reserved column keys).
  const reserved = new Set(['type', 'name', 'baseUrl', 'secret']);
  const options: Record<string, unknown> = {};
  const integ = getIntegration(type);
  if (integ) {
    for (const field of integ.configSchema) {
      if (reserved.has(field.key)) continue;
      const v = form.get(field.key);
      if (v != null && String(v) !== '') options[field.key] = String(v);
    }
  }
  return { type, name, baseUrl, secret, options };
}

export const actions: Actions = {
  test: async ({ request }) => {
    const f = parse(await request.formData());
    const integ = getIntegration(f.type);
    if (!integ) return fail(400, { test: { ok: false, message: 'Unknown integration type' } });
    const res = await integ.testConnection({ id: 0, enabled: true, ...f } as any);
    return { test: res };
  },

  create: async ({ request }) => {
    const f = parse(await request.formData());
    if (!f.name || !f.baseUrl) return fail(400, { error: 'Name and URL required' });
    createConnection(getDb(), f);
    return { created: true };
  },

  update: async ({ request }) => {
    const form = await request.formData();
    const id = Number(form.get('id'));
    if (!id) return fail(400, { updateError: 'Missing connection id' });

    const db = getDb();
    const existing = getConnection(db, id);
    if (!existing) return fail(404, { updateError: 'Connection not found' });

    const type = String(form.get('type') ?? existing.type);
    const name = String(form.get('name') ?? existing.name);
    const baseUrl = String(form.get('baseUrl') ?? existing.baseUrl);
    // Blank secret means keep existing; non-blank means update it.
    const secretRaw = String(form.get('secret') ?? '');
    const secret = secretRaw !== '' ? secretRaw : existing.secret;

    const reserved = new Set(['id', 'type', 'name', 'baseUrl', 'secret']);
    const options: Record<string, unknown> = { ...existing.options };
    const integ = getIntegration(type);
    if (integ) {
      for (const field of integ.configSchema) {
        if (reserved.has(field.key)) continue;
        const v = form.get(field.key);
        if (v != null && String(v) !== '') options[field.key] = String(v);
      }
    }

    updateConnection(db, id, { type, name, baseUrl, secret, options });
    return { updated: true };
  },

  toggle: async ({ request }) => {
    const form = await request.formData();
    const id = Number(form.get('id'));
    const enabled = String(form.get('enabled')) === '1';
    if (!id) return fail(400, { updateError: 'Missing id' });
    const db = getDb();
    const existing = getConnection(db, id);
    if (!existing) return fail(404, { updateError: 'Not found' });
    updateConnection(db, id, { enabled });
    return { updated: true };
  },

  testUpdate: async ({ request }) => {
    const form = await request.formData();
    const id = Number(form.get('id'));
    const db = getDb();
    const existing = getConnection(db, id);
    if (!existing) return fail(404, { test: { ok: false, message: 'Connection not found' } });

    const type = String(form.get('type') ?? existing.type);
    const baseUrl = String(form.get('baseUrl') ?? existing.baseUrl);
    const secretRaw = String(form.get('secret') ?? '');
    const secret = secretRaw !== '' ? secretRaw : existing.secret;

    const integ = getIntegration(type);
    if (!integ) return fail(400, { test: { ok: false, message: 'Unknown integration type' } });
    const res = await integ.testConnection({ ...existing, baseUrl, secret } as any);
    return { test: res };
  },

  delete: async ({ request }) => {
    deleteConnection(getDb(), Number((await request.formData()).get('id')));
    return { deleted: true };
  }
};
