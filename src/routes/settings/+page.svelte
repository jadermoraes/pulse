<script lang="ts">
  import { enhance } from '$app/forms';
  import { onMount, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import {
    applyTheme, applyCustomTheme, loadCustomColors,
    THEMES, CUSTOM_DEFAULTS, CUSTOM_SWATCHES,
    applyDensity, loadDensity,
    saveClockFormat, loadClockFormat,
    type Density, type ClockFormat
  } from '$lib/theme';
  import { useMobile } from '$lib/media.svelte';
  import { _ } from 'svelte-i18n';
  import { setLocale, normaliseLocale, type Locale } from '$lib/i18n';
  import { planToCap, capToPlan, type PlanName } from '$lib/consumer/plan';
  import { temperaturePreset, presetToValue, type TemperaturePreset } from '$lib/ai/temperature';
  import CostModal from '$lib/components/CostModal.svelte';
  import ServicesConfigModal from '$lib/components/ServicesConfigModal.svelte';

  let { data, form } = $props();

  // Services-launcher editor lives in a modal (opened from the Appearance tab).
  let showServicesConfig = $state(false);

  // Reactive mobile breakpoint (≤768px). On mobile the master-detail stacks: the type
  // list shows first, tapping a type reveals its detail full-width with a back button.
  const m = useMobile();
  const isMobile = $derived(m.isMobile);
  // Mobile-only: whether the detail pane is showing (vs the type list).
  let mobileDetailOpen = $state(false);

  // ── Tab state (SSR-safe: no window access at parse time) ──
  type Tab = 'connections' | 'appearance' | 'backup' | 'ai' | 'users';
  let activeTab = $state<Tab>('connections');

  // ── Appearance ──
  let selectedTheme = $state('emerald');
  let customAccent = $state(CUSTOM_DEFAULTS.accent);
  let customAccent2 = $state(CUSTOM_DEFAULTS.accent2);
  let density = $state<Density>('comfy');
  let clockFmt = $state<ClockFormat>('24h');
  // Language: initialised from the SSR-resolved locale so the selector reflects the
  // active language immediately (no flash). Switching updates the UI + cookie live.
  let lang = $state<Locale>(normaliseLocale(untrack(() => data.locale)));

  onMount(() => {
    const theme = localStorage.getItem('pulse.theme') ?? 'emerald';
    selectedTheme = theme;
    const saved = loadCustomColors();
    customAccent = saved.accent;
    customAccent2 = saved.accent2;
    density = loadDensity();
    clockFmt = loadClockFormat();
    // Restore tab from URL hash if present
    const hash = window.location.hash.slice(1);
    if (
      hash === 'appearance' ||
      hash === 'connections' ||
      hash === 'backup' ||
      hash === 'ai' ||
      hash === 'users'
    ) {
      activeTab = hash as Tab;
    }
    if (activeTab === 'ai') void loadAi();
    if (activeTab === 'users') void loadUsers();
    // Default-select first type that has a connection, else first type
    if (allSections.length > 0) {
      const withConns = allSections.find((s: any) => s.conns.length > 0);
      selectedType = (withConns ?? allSections[0]).type;
    }
  });

  function setTab(t: Tab) {
    activeTab = t;
    if (typeof window !== 'undefined') {
      history.replaceState(null, '', `#${t}`);
    }
    if (t === 'ai') void loadAi();
    if (t === 'users') void loadUsers();
  }

  // ══════════════════ Users & Roles tab ══════════════════
  type Cap = 'discover' | 'request' | 'status' | 'watchlist' | 'message_admin';
  const ALL_CAPS: Cap[] = ['discover', 'request', 'status', 'watchlist', 'message_admin'];

  type RoleRow = {
    id: number;
    name: string;
    allowList: Cap[];
    monthlyTokenCap: number | null;
    planName: string | null;
    autoApprove: boolean;
    seerrQuota: { movie?: number; tv?: number };
    isAdmin: boolean;
    editable: boolean;
  };
  type UserRow = {
    id: number;
    displayName: string;
    roleId: number;
    roleName: string;
    status: string;
    language: string;
    capOverride: number | null;
    allowOverride: Cap[] | null;
    monthToDate: number;
    effectiveCap: number | null;
  };
  type InviteRow = {
    id: number;
    token: string;
    roleId: number;
    roleName: string;
    expiresAt: number;
    status: string;
    link: string;
  };

  let roles = $state<RoleRow[]>([]);
  let users = $state<UserRow[]>([]);
  let invites = $state<InviteRow[]>([]);

  // Show/hide accepted+expired invites (they clutter the list by default).
  let showOldInvites = $state(false);
  const pendingInvites = $derived(invites.filter((i) => i.status === 'pending'));
  const oldInvites = $derived(invites.filter((i) => i.status !== 'pending'));

  // Role editor draft (null = not editing).
  let roleDraft = $state<RoleRow | null>(null);
  let inviteRoleId = $state<number | null>(null);
  let lastInviteLink = $state<string | null>(null);

  let usersLoaded = false;
  async function loadUsers() {
    if (usersLoaded) return;
    usersLoaded = true;
    await Promise.all([loadRoles(), loadUserList(), loadInvites()]);
    adminContact = (await fetch('/api/app/contact').then((r) => r.json())).contact ?? '';
  }
  async function loadRoles() {
    roles = (await fetch('/api/roles').then((r) => r.json())).roles;
  }
  async function loadUserList() {
    users = (await fetch('/api/users').then((r) => r.json())).users;
  }
  async function loadInvites() {
    invites = (await fetch('/api/invites').then((r) => r.json())).invites;
  }

  function newRole() {
    roleDraft = {
      id: 0,
      name: '',
      allowList: [],
      monthlyTokenCap: null,
      planName: 'Unlimited',
      autoApprove: false,
      seerrQuota: {},
      isAdmin: false,
      editable: true
    };
  }

  // Plan picker ⇄ cap field. Choosing a named plan rewrites the cap; typing a raw cap reflects the plan.
  const PLAN_NAMES: PlanName[] = ['Light', 'Regular', 'Power', 'Unlimited', 'Custom'];
  function selectPlan(plan: PlanName) {
    if (!roleDraft) return;
    roleDraft.planName = plan;
    if (plan !== 'Custom') roleDraft.monthlyTokenCap = planToCap(plan);
  }
  function syncPlanFromCap() {
    if (!roleDraft) return;
    roleDraft.planName = capToPlan(roleDraft.monthlyTokenCap);
  }
  function editRole(r: RoleRow) {
    roleDraft = {
      ...r,
      allowList: [...r.allowList],
      seerrQuota: { ...r.seerrQuota },
      planName: r.planName ?? capToPlan(r.monthlyTokenCap)
    };
  }
  function toggleCap(c: Cap) {
    if (!roleDraft) return;
    roleDraft.allowList = roleDraft.allowList.includes(c)
      ? roleDraft.allowList.filter((x) => x !== c)
      : [...roleDraft.allowList, c];
  }
  async function saveRole() {
    if (!roleDraft) return;
    const method = roleDraft.id ? 'PUT' : 'POST';
    await fetch('/api/roles', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(roleDraft)
    });
    roleDraft = null;
    usersLoaded = false;
    await loadUsers();
  }
  async function removeRole(id: number) {
    await fetch('/api/roles', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    usersLoaded = false;
    await loadUsers();
  }
  async function mintInvite() {
    if (!inviteRoleId) return;
    const r = await fetch('/api/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: inviteRoleId })
    }).then((x) => x.json());
    lastInviteLink = r.link;
    inviteCopied = false;
    await loadInvites();
  }

  // Copy the freshly-generated invite URL to the clipboard with brief "Copied!" feedback.
  let inviteCopied = $state(false);
  let inviteCopyTimer: ReturnType<typeof setTimeout> | null = null;
  async function copyInviteLink() {
    if (!lastInviteLink) return;
    const url = `${location.origin}${lastInviteLink}`;
    try {
      await navigator.clipboard.writeText(url);
      inviteCopied = true;
      if (inviteCopyTimer) clearTimeout(inviteCopyTimer);
      inviteCopyTimer = setTimeout(() => (inviteCopied = false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  // Per-row copy feedback: tracks which invite id was just copied (null = none).
  let rowCopiedId = $state<number | null>(null);
  let rowCopyTimer: ReturnType<typeof setTimeout> | null = null;
  async function copyRowLink(inv: InviteRow) {
    const url = inv.link.startsWith('http') ? inv.link : `${location.origin}${inv.link}`;
    try {
      await navigator.clipboard.writeText(url);
      rowCopiedId = inv.id;
      if (rowCopyTimer) clearTimeout(rowCopyTimer);
      rowCopyTimer = setTimeout(() => (rowCopiedId = null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }
  async function cancelInvite(inv: InviteRow) {
    if (!confirm($_('users.cancelInvite') + '?')) return;
    await fetch('/api/invites', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: inv.id })
    });
    usersLoaded = false;
    await loadInvites();
  }
  async function changeUserRole(u: UserRow, roleId: number) {
    await fetch('/api/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: u.id, roleId })
    });
    await loadUserList();
  }
  async function setUserCap(u: UserRow, cap: number | null) {
    await fetch('/api/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: u.id, capOverride: cap })
    });
    await loadUserList();
  }
  async function toggleDisable(u: UserRow) {
    await fetch('/api/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: u.id, status: u.status === 'disabled' ? 'active' : 'disabled' })
    });
    await loadUserList();
  }
  async function removeUser(u: UserRow) {
    if (!confirm($_('users.confirmRemove'))) return;
    const res = await fetch('/api/users', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: u.id })
    });
    const out = await res.json().catch(() => ({}));
    if (out.warnings && (out.warnings as string[]).length > 0) {
      alert($_('users.removeWarnings', { values: { warnings: (out.warnings as string[]).join('; ') } }));
    }
    await loadUserList();
  }
  function usagePct(u: UserRow): number {
    if (!u.effectiveCap) return 0;
    return Math.min(100, Math.round((u.monthToDate / u.effectiveCap) * 100));
  }

  let resetLink = $state<string | null>(null);
  let resetErr = $state<string | null>(null);
  let adminContact = $state('');

  // ── Per-user sessions panel ──
  type SessionRow = { id: string; createdAt: number | null; expiresAt: number; ip: string | null; device: string };
  // Which user's sessions panel is open (null = none)
  let sessionsOpenId = $state<number | null>(null);
  // Sessions keyed by user id
  let sessionsMap = $state<Record<number, SessionRow[]>>({});
  // Loading flag per user id
  let sessionsLoading = $state<Record<number, boolean>>({});

  async function toggleSessions(u: UserRow) {
    if (sessionsOpenId === u.id) {
      sessionsOpenId = null;
      return;
    }
    sessionsOpenId = u.id;
    await loadSessions(u.id);
  }

  async function loadSessions(userId: number) {
    sessionsLoading = { ...sessionsLoading, [userId]: true };
    try {
      const r = await fetch(`/api/users/sessions?consumerId=${userId}`).then((x) => x.json());
      sessionsMap = { ...sessionsMap, [userId]: r.sessions ?? [] };
    } catch {
      sessionsMap = { ...sessionsMap, [userId]: [] };
    } finally {
      sessionsLoading = { ...sessionsLoading, [userId]: false };
    }
  }

  async function revokeSession(userId: number, sessionId: string) {
    await fetch('/api/users/sessions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sessionId })
    });
    await loadSessions(userId);
  }

  function fmtDate(ts: number | null): string {
    if (ts == null) return '—';
    try {
      return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return String(ts);
    }
  }

  async function resetUserPassword(u: { id: number; displayName: string }) {
    resetLink = null; resetErr = null;
    try {
      const res = await fetch('/api/users/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: u.id })
      });
      if (!res.ok) { resetErr = (await res.json().catch(() => ({}))).message ?? 'Reset failed'; return; }
      const r = await res.json();
      resetLink = `${location.origin}${r.link}`;
    } catch (e) { resetErr = (e as Error).message; }
  }
  async function saveAdminContact() {
    await fetch('/api/app/contact', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact: adminContact })
    });
  }

  // ══════════════════ AI tab state ══════════════════
  type AiProvider = 'anthropic' | 'openai' | 'google' | 'openai-compatible';

  // AI connection (one stored key per provider; secret-free public shape).
  type AiConnection = {
    id: number;
    label: string;
    provider: AiProvider;
    baseUrl: string | null;
    hasKey: boolean;
  };
  type AiModelEntry = { id: string; recommended: boolean };

  // ── Connections manager ──
  let aiConnections = $state<AiConnection[]>([]);
  // Add/Edit form (null = closed). id 0 = new connection.
  type AiConnDraft = {
    id: number;
    label: string;
    provider: AiProvider;
    baseUrl: string;
    apiKey: string; // write-only; blank on edit = keep existing
    hasKey: boolean;
  };
  let aiConnDraft = $state<AiConnDraft | null>(null);
  let aiConnSaving = $state(false);
  let aiConnResult = $state<{ ok: boolean; error?: string } | null>(null);

  function newAiConn() {
    aiConnResult = null;
    aiConnDraft = { id: 0, label: '', provider: 'anthropic', baseUrl: '', apiKey: '', hasKey: false };
  }
  function editAiConn(c: AiConnection) {
    aiConnResult = null;
    aiConnDraft = {
      id: c.id, label: c.label, provider: c.provider,
      baseUrl: c.baseUrl ?? '', apiKey: '', hasKey: c.hasKey
    };
  }
  function cancelAiConn() {
    aiConnDraft = null;
    aiConnResult = null;
  }
  // Base URL is only relevant for self-hosted / OpenAI-compatible (and optionally Google) endpoints.
  function connNeedsBaseUrl(p: AiProvider): boolean {
    return p === 'openai-compatible' || p === 'google';
  }

  async function saveAiConn() {
    if (!aiConnDraft) return;
    aiConnSaving = true;
    aiConnResult = null;
    try {
      const d = aiConnDraft;
      const isNew = d.id === 0;
      const body: Record<string, unknown> = {
        label: d.label.trim(),
        provider: d.provider,
        validate: true
      };
      if (connNeedsBaseUrl(d.provider)) body.baseUrl = d.baseUrl.trim() || undefined;
      if (d.apiKey.trim()) body.apiKey = d.apiKey.trim();
      if (!isNew) body.id = d.id;
      const res = await fetch('/api/ai/connections', {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const out = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (!res.ok || !out.ok) {
        aiConnResult = { ok: false, error: out.error ?? `HTTP ${res.status}` };
        return;
      }
      aiConnResult = { ok: true };
      aiConnDraft = null;
      await loadAiConnections();
    } catch (e) {
      aiConnResult = { ok: false, error: (e as Error).message };
    } finally {
      aiConnSaving = false;
    }
  }

  async function removeAiConn(id: number) {
    if (!confirm($_('settings.ai.connRemoveConfirm'))) return;
    await fetch('/api/ai/connections', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    await loadAiConnections();
  }

  async function loadAiConnections() {
    try {
      const r = await fetch('/api/ai/connections').then((x) => x.json());
      aiConnections = r.connections ?? [];
    } catch {
      /* none */
    }
  }

  function connLabel(c: AiConnection): string {
    const key = c.hasKey ? $_('settings.ai.connKeySet') : $_('settings.ai.connLocal');
    return `${c.label} · ${c.provider} · ${key}`;
  }

  // ── Model pickers (admin + consumer) ──
  let adminConnectionId = $state<number | null>(null);
  let adminModel = $state('');
  let adminTemperature = $state<number | null>(0.2);
  let consumerConnectionId = $state<number | null>(null);
  let consumerModel = $state('');
  let consumerTemperature = $state<number | null>(0.5);

  // Loaded model lists keyed by connection id, plus a "couldn't reach provider" flag.
  let adminModels = $state<AiModelEntry[]>([]);
  let adminModelsFallback = $state(false);
  let consumerModels = $state<AiModelEntry[]>([]);
  let consumerModelsFallback = $state(false);

  async function fetchModels(connectionId: number): Promise<{ models: AiModelEntry[]; fallback: boolean }> {
    try {
      const r = await fetch(`/api/ai/models?connectionId=${connectionId}`).then((x) => x.json());
      return { models: r.models ?? [], fallback: Boolean(r.fallback) };
    } catch {
      return { models: [], fallback: true };
    }
  }
  async function loadAdminModels() {
    if (adminConnectionId == null) { adminModels = []; adminModelsFallback = false; return; }
    const r = await fetchModels(adminConnectionId);
    adminModels = r.models;
    adminModelsFallback = r.fallback;
  }
  async function loadConsumerModels() {
    if (consumerConnectionId == null) { consumerModels = []; consumerModelsFallback = false; return; }
    const r = await fetchModels(consumerConnectionId);
    consumerModels = r.models;
    consumerModelsFallback = r.fallback;
  }
  function onAdminConnChange(id: number | null) {
    adminConnectionId = id;
    adminModel = '';
    void loadAdminModels();
  }
  function onConsumerConnChange(id: number | null) {
    consumerConnectionId = id;
    consumerModel = '';
    void loadConsumerModels();
  }

  // Temperature preset ⇄ value mapping (friendly select with a Custom escape hatch).
  function adminTempPreset(): TemperaturePreset {
    return temperaturePreset(adminTemperature, 'precise');
  }
  function consumerTempPreset(): TemperaturePreset {
    return temperaturePreset(consumerTemperature, 'balanced');
  }
  function selectAdminTemp(name: TemperaturePreset) {
    if (name === 'custom') {
      // Reveal the custom input; seed with current value or a sensible default.
      if (adminTemperature == null || temperaturePreset(adminTemperature) !== 'custom') adminTemperature = 0.3;
    } else {
      adminTemperature = presetToValue(name);
    }
  }
  function selectConsumerTemp(name: TemperaturePreset) {
    if (name === 'custom') {
      if (consumerTemperature == null || temperaturePreset(consumerTemperature) !== 'custom') consumerTemperature = 0.6;
    } else {
      consumerTemperature = presetToValue(name);
    }
  }

  let aiSaving = $state(false);
  let aiSaveResult = $state<{ ok: boolean; error?: string } | null>(null);

  // Token usage.
  let aiUsage = $state<{ input: number; output: number; total: number }>({ input: 0, output: 0, total: 0 });
  // Cost breakdown + spend-limits modal.
  let showCost = $state(false);

  // MCP servers.
  type McpRow = { name: string; transport: 'sse' | 'http'; url: string; enabled: boolean; headers: string; hasHeaders?: boolean };
  let mcpServers = $state<McpRow[]>([]);
  let mcpSaving = $state(false);
  let mcpSaveResult = $state<{ ok: boolean; error?: string } | null>(null);

  // Activity / audit.
  type AuditRow = {
    id: number; conversationId: number | null; ts: number; actor: number;
    tool: string; args: unknown; result: unknown; confirmed: boolean;
    undoToken: { tool: string; args: Record<string, unknown>; label: string } | null;
  };
  let auditRows = $state<AuditRow[]>([]);
  let undoBusy = $state<number | null>(null);

  let aiLoaded = false;
  async function loadAi() {
    if (aiLoaded) return;
    aiLoaded = true;
    await Promise.all([loadAiConfig(), loadAiUsage(), loadMcp(), loadAudit(), loadTelegramAdmin()]);
  }

  async function loadAiConfig() {
    try {
      const r = await fetch('/api/ai/config').then((x) => x.json());
      aiConnections = r.connections ?? [];
      adminConnectionId = r.adminConnectionId ?? null;
      adminModel = r.adminModel ?? '';
      adminTemperature = typeof r.adminTemperature === 'number' ? r.adminTemperature : 0.2;
      consumerConnectionId = r.consumerConnectionId ?? null;
      consumerModel = r.consumerModel ?? '';
      consumerTemperature = typeof r.consumerTemperature === 'number' ? r.consumerTemperature : 0.5;
      // Eagerly load the model lists for any already-selected connections.
      await Promise.all([loadAdminModels(), loadConsumerModels()]);
    } catch {
      /* leave defaults */
    }
  }

  async function loadAiUsage() {
    try {
      aiUsage = await fetch('/api/ai/usage').then((x) => x.json());
    } catch {
      /* keep zeros */
    }
  }

  async function loadMcp() {
    try {
      const r = await fetch('/api/ai/mcp').then((x) => x.json());
      mcpServers = (r.servers ?? []).map((s: any) => ({
        name: s.name, transport: s.transport, url: s.url, enabled: s.enabled, headers: '', hasHeaders: s.hasHeaders
      }));
    } catch {
      /* none */
    }
  }

  async function loadAudit() {
    try {
      const r = await fetch('/api/agent/audit?limit=50').then((x) => x.json());
      auditRows = r.actions ?? [];
    } catch {
      /* none */
    }
  }

  async function saveAiConfig() {
    aiSaving = true;
    aiSaveResult = null;
    try {
      const body: Record<string, unknown> = {
        adminConnectionId,
        adminModel: adminModel.trim(),
        adminTemperature: adminTemperature ?? undefined,
        validate: true
      };
      // Consumer is optional — leaving the connection unset means "use the admin model".
      if (consumerConnectionId != null && consumerModel.trim()) {
        body.consumerConnectionId = consumerConnectionId;
        body.consumerModel = consumerModel.trim();
        body.consumerTemperature = consumerTemperature ?? undefined;
      } else {
        body.consumerConnectionId = null;
        body.consumerModel = null;
      }
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => `HTTP ${res.status}`);
        aiSaveResult = { ok: false, error: msg || `HTTP ${res.status}` };
        return;
      }
      const out = await res.json();
      aiSaveResult = out;
      if (out.ok) await loadAiConfig();
    } catch (e) {
      aiSaveResult = { ok: false, error: (e as Error).message };
    } finally {
      aiSaving = false;
    }
  }

  function addMcpServer() {
    mcpServers = [...mcpServers, { name: '', transport: 'sse', url: '', enabled: true, headers: '' }];
  }
  function removeMcpServer(i: number) {
    mcpServers = mcpServers.filter((_, idx) => idx !== i);
  }

  // Parse "Key: Value" lines into a headers object; blank → undefined.
  function parseHeaders(text: string): Record<string, string> | undefined {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k && v) out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }

  async function saveMcp() {
    mcpSaving = true;
    mcpSaveResult = null;
    try {
      const servers = mcpServers
        .filter((s) => s.name.trim() && s.url.trim())
        .map((s) => {
          const headers = parseHeaders(s.headers);
          return {
            name: s.name.trim(),
            transport: s.transport,
            url: s.url.trim(),
            enabled: s.enabled,
            ...(headers ? { headers } : {})
          };
        });
      const res = await fetch('/api/ai/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers })
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => `HTTP ${res.status}`);
        mcpSaveResult = { ok: false, error: msg };
        return;
      }
      mcpSaveResult = { ok: true };
      await loadMcp();
    } catch (e) {
      mcpSaveResult = { ok: false, error: (e as Error).message };
    } finally {
      mcpSaving = false;
    }
  }

  // Undo re-enters the confirm/audit path: register the inverse as a pending action,
  // then approve it. The resumed SSE stream is consumed (and discarded) here.
  async function undoAction(row: AuditRow) {
    if (undoBusy !== null) return;
    undoBusy = row.id;
    try {
      const res = await fetch('/api/agent/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auditId: row.id })
      });
      const out = await res.json().catch(() => ({}));
      if (out.ok && out.pendingId) {
        const confirmRes = await fetch('/api/agent/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pendingId: out.pendingId, approved: true })
        });
        // Drain the SSE body so the request completes server-side.
        await confirmRes.text().catch(() => '');
      }
      await loadAudit();
    } catch {
      /* ignore */
    } finally {
      undoBusy = null;
    }
  }

  function fmtTime(ts: number): string {
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return String(ts);
    }
  }

  // ── Telegram (admin) ──
  let tgToken = $state('');
  let tgConfigured = $state(false);
  let tgBotUsername = $state<string | null>(null);
  let tgAdminBound = $state(false);
  let tgSaving = $state(false);
  let tgSaveResult = $state<{ ok: boolean; error?: string; botUsername?: string } | null>(null);

  type NotifyPrefs = { container_down: boolean; disk_high: boolean; download_stalled: boolean };
  let tgNotifyPrefs = $state<NotifyPrefs>({ container_down: true, disk_high: true, download_stalled: true });

  async function loadTelegramAdmin() {
    try {
      const [cfg, status, prefsRes] = await Promise.all([
        fetch('/api/telegram/config').then((x) => x.json()),
        fetch('/api/telegram/status').then((x) => x.json()),
        fetch('/api/telegram/prefs').then((x) => x.json())
      ]);
      tgConfigured = cfg.configured ?? false;
      tgBotUsername = cfg.botUsername ?? null;
      tgAdminBound = status.adminBound ?? false;
      if (prefsRes.prefs) tgNotifyPrefs = prefsRes.prefs;
    } catch { /* ignore */ }
  }

  async function saveTelegramPref(key: keyof NotifyPrefs, value: boolean) {
    tgNotifyPrefs = { ...tgNotifyPrefs, [key]: value };
    try {
      await fetch('/api/telegram/prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefs: tgNotifyPrefs })
      });
    } catch { /* best-effort */ }
  }

  async function saveTelegramConfig() {
    tgSaving = true;
    tgSaveResult = null;
    try {
      const res = await fetch('/api/telegram/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tgToken })
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        tgSaveResult = { ok: false, error: out.message ?? `HTTP ${res.status}` };
        return;
      }
      tgSaveResult = { ok: true, botUsername: out.botUsername };
      tgConfigured = true;
      tgBotUsername = out.botUsername ?? null;
      tgToken = '';
    } catch (e) {
      tgSaveResult = { ok: false, error: (e as Error).message };
    } finally {
      tgSaving = false;
    }
  }

  async function connectAdminTelegram() {
    try {
      const r = await fetch('/api/telegram/link', { method: 'POST' }).then((x) => x.json());
      if (r.url) window.open(r.url, '_blank', 'noopener');
    } catch { /* ignore */ }
  }

  // ── Backup / Config ──
  let exportIncludeSecrets = $state(false);
  let importText = $state('');
  let importFile = $state<FileList | null>(null);
  let importStatus = $state<{ ok: boolean; created: number; updated: number; layoutApplied: boolean } | null>(null);
  let importError = $state<string | null>(null);
  let importBusy = $state(false);

  function doExport() {
    const qs = exportIncludeSecrets ? '?secrets=1' : '?secrets=0';
    const a = document.createElement('a');
    a.href = `/api/config/export${qs}`;
    a.download = 'pulse-config.yaml';
    a.click();
  }

  async function doImport() {
    importStatus = null;
    importError = null;
    importBusy = true;
    try {
      let body = importText.trim();
      if (!body && importFile && importFile.length > 0) {
        body = await importFile[0].text();
      }
      if (!body) {
        importError = get(_)('settings.backup.noBody');
        return;
      }
      const res = await fetch('/api/config/import', {
        method: 'POST',
        headers: { 'Content-Type': 'text/yaml' },
        body
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => `HTTP ${res.status}`);
        importError = msg || `HTTP ${res.status}`;
        return;
      }
      importStatus = await res.json();
      // Refresh the page so new connections + layout are visible
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      importError = e instanceof Error ? e.message : get(_)('settings.backup.unknownError');
    } finally {
      importBusy = false;
    }
  }

  const themeNames = Object.keys(THEMES) as string[];
  const themeLabels: Record<string, string> = {
    emerald: 'Emerald', aurora: 'Aurora', nova: 'Nova', ember: 'Ember'
  };

  function handleThemeClick(name: string) {
    selectedTheme = name;
    applyTheme(name);
  }

  function handleCustomThemeClick() {
    selectedTheme = 'custom';
    applyCustomTheme({ accent: customAccent, accent2: customAccent2 });
  }

  function handleCustomColorChange() {
    if (selectedTheme === 'custom') {
      applyCustomTheme({ accent: customAccent, accent2: customAccent2 });
    }
  }

  function applyCustomSwatch(s: { accent: string; accent2: string }) {
    customAccent = s.accent;
    customAccent2 = s.accent2;
    if (selectedTheme === 'custom') {
      applyCustomTheme({ accent: customAccent, accent2: customAccent2 });
    }
  }

  function handleDensityChange(d: Density) {
    density = d;
    applyDensity(d);
  }

  function handleClockFormatChange(fmt: ClockFormat) {
    clockFmt = fmt;
    saveClockFormat(fmt);
    // Notify TopBar to refresh immediately
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('pulse:clockformat', { detail: fmt }));
    }
  }

  function handleLanguageChange(next: Locale) {
    lang = next;
    // Updates the active locale (UI re-renders live) + persists the cookie for SSR.
    setLocale(next);
  }

  // ── Add-form state: one open panel per integration type (null = closed) ──
  let addOpenType = $state<string | null>(null);
  let addName = $state('');
  let addFields = $state<Record<string, string>>({});

  function openAddPanel(type: string) {
    if (addOpenType === type) { addOpenType = null; return; }
    addOpenType = type;
    addName = '';
    const integ = data.integrations.find((i: any) => i.type === type);
    if (integ) {
      const v: Record<string, string> = {};
      for (const f of integ.schema) v[f.key] = '';
      addFields = v;
    }
  }

  // Reset add panel fields after a successful create
  let lastForm = $state<any>(null);
  $effect(() => {
    if (form && form !== lastForm) {
      lastForm = form;
      if ((form as any)?.created === true) {
        addOpenType = null;
        addName = '';
        addFields = {};
      }
    }
  });

  // ── Edit-form state ──
  // One card may be in edit mode at a time; keyed by conn.id
  let editId = $state<number | null>(null);
  let editName = $state('');
  let editBaseUrl = $state('');
  let editFields = $state<Record<string, string>>({});  // schema fields excluding reserved
  let editSecret = $state('');

  function openEdit(conn: any) {
    if (editId === conn.id) { editId = null; return; }
    editId = conn.id;
    editName = conn.name;
    editBaseUrl = conn.baseUrl;
    editSecret = '';

    // Find schema fields (non-reserved) — we can't populate secret, but we can populate options if we had them
    // (options are not in ConnectionPublic, so we start blank)
    const integ = data.integrations.find((i: any) => i.type === conn.type);
    const reserved = new Set(['name', 'baseUrl', 'secret', 'type']);
    const v: Record<string, string> = {};
    if (integ) {
      for (const f of integ.schema) {
        if (!reserved.has(f.key)) v[f.key] = '';
      }
    }
    editFields = v;
  }

  function cancelEdit() { editId = null; }

  // Close edit panel after a successful update
  $effect(() => {
    if (form && (form as any)?.updated === true) {
      editId = null;
    }
  });

  // ── Test result / error state ──
  const testResult = $derived((form as any)?.test ?? null);
  const createError = $derived((form as any)?.error ?? null);
  const updateError = $derived((form as any)?.updateError ?? null);

  // ── Group connections by integration type ──
  const allSections = $derived(
    data.integrations.map((integ: any) => {
      const reserved = new Set(['baseUrl', 'secret', 'name', 'type']);
      return {
        type: integ.type,
        label: integ.label,
        icon: integ.icon ?? integ.type,
        schema: integ.schema,
        baseUrlLabel: (integ.schema.find((f: any) => f.key === 'baseUrl') as any)?.label ?? 'Server URL',
        hasSecret: integ.schema.some((f: any) => f.key === 'secret'),
        secretLabel: (integ.schema.find((f: any) => f.key === 'secret') as any)?.label ?? 'API Key / Password',
        extraFields: integ.schema.filter((f: any) => !reserved.has(f.key)),
        conns: data.connections.filter((c: any) => c.type === integ.type)
      };
    })
  );

  // ── Master-detail: selected integration type ──
  // SSR-safe: initialized empty; onMount selects first type that has a connection (or first type).
  let selectedType = $state<string>('');

  const activeSection = $derived(allSections.find((s: any) => s.type === selectedType) ?? allSections[0]);

  // Icon emoji map for integration types
  const integIcons: Record<string, string> = {
    jellyfin: '🎬',
    jellystat: '📊',
    radarr: '🎥',
    sonarr: '📺',
    seerr: '🔍',
    qbittorrent: '⬇',
    tautulli: '📈',
    proxmox: '🖥',
  };

  function integIcon(type: string): string {
    return integIcons[type] ?? '⚙';
  }
</script>

<svelte:boundary>
<div class="settings-page">
  <div class="settings-header">
    <h2>{$_('settings.title')}</h2>
    <p class="settings-sub">{$_('settings.subtitle')}</p>
  </div>

  <!-- ── Tab bar ── -->
  <div class="tab-bar" role="tablist">
    <button
      role="tab"
      aria-selected={activeTab === 'connections'}
      class="tab-btn {activeTab === 'connections' ? 'active' : ''}"
      onclick={() => setTab('connections')}
    >{$_('settings.tabs.connections')}</button>
    <button
      role="tab"
      aria-selected={activeTab === 'appearance'}
      class="tab-btn {activeTab === 'appearance' ? 'active' : ''}"
      onclick={() => setTab('appearance')}
    >{$_('settings.tabs.appearance')}</button>
    <button
      role="tab"
      aria-selected={activeTab === 'backup'}
      class="tab-btn {activeTab === 'backup' ? 'active' : ''}"
      onclick={() => setTab('backup')}
    >{$_('settings.tabs.backup')}</button>
    <button
      role="tab"
      aria-selected={activeTab === 'ai'}
      class="tab-btn {activeTab === 'ai' ? 'active' : ''}"
      onclick={() => setTab('ai')}
    >{$_('settings.tabs.ai')}</button>
    <button
      role="tab"
      aria-selected={activeTab === 'users'}
      class="tab-btn {activeTab === 'users' ? 'active' : ''}"
      onclick={() => setTab('users')}
    >{$_('settings.tabs.users')}</button>
  </div>

  <!-- ══════════════════ APPEARANCE TAB ══════════════════ -->
  {#if activeTab === 'appearance'}
    <!-- Theme presets + Custom -->
    <div class="card settings-card">
      <div class="ch"><h3>{$_('settings.appearance.theme')}</h3></div>
      <div class="theme-swatches">
        {#each themeNames as name}
          {@const t = THEMES[name]}
          <button
            type="button"
            class="swatch-btn {selectedTheme === name ? 'selected' : ''}"
            onclick={() => handleThemeClick(name)}
            style="--s1:{t.accent};--s2:{t.accent2}"
            title={themeLabels[name] ?? name}
          >
            <span class="swatch-dot"></span>
            <span class="swatch-lbl">{themeLabels[name] ?? name}</span>
          </button>
        {/each}

        <!-- Custom theme button -->
        <button
          type="button"
          class="swatch-btn {selectedTheme === 'custom' ? 'selected' : ''}"
          onclick={handleCustomThemeClick}
          style="--s1:{customAccent};--s2:{customAccent2}"
          title={$_('settings.appearance.custom')}
        >
          <span class="swatch-dot"></span>
          <span class="swatch-lbl">{$_('settings.appearance.custom')}</span>
        </button>
      </div>

      <!-- Custom theme color pickers — shown when custom is selected -->
      {#if selectedTheme === 'custom'}
        <div class="custom-section">
          <p class="pref-hint">{$_('settings.appearance.customHint')}</p>

          <!-- Quick-start swatches -->
          <div class="custom-swatches-row">
            {#each CUSTOM_SWATCHES as sw}
              <button
                type="button"
                class="custom-swatch-pill"
                onclick={() => applyCustomSwatch(sw)}
                style="--s1:{sw.accent};--s2:{sw.accent2}"
                title={sw.label}
              >
                <span class="custom-swatch-dot"></span>
                <span class="custom-swatch-lbl">{sw.label}</span>
              </button>
            {/each}
          </div>

          <!-- Color pickers -->
          <div class="color-pickers">
            <div class="color-picker-row">
              <label for="cp-accent" class="color-label">{$_('settings.appearance.accent')}</label>
              <div class="color-input-wrap">
                <input
                  id="cp-accent"
                  type="color"
                  class="color-input"
                  bind:value={customAccent}
                  oninput={handleCustomColorChange}
                />
                <span class="color-hex">{customAccent}</span>
              </div>
            </div>
            <div class="color-picker-row">
              <label for="cp-accent2" class="color-label">{$_('settings.appearance.accent2')} <span class="pref-hint">{$_('settings.appearance.gradientEnd')}</span></label>
              <div class="color-input-wrap">
                <input
                  id="cp-accent2"
                  type="color"
                  class="color-input"
                  bind:value={customAccent2}
                  oninput={handleCustomColorChange}
                />
                <span class="color-hex">{customAccent2}</span>
              </div>
            </div>
          </div>

          <!-- Live gradient preview -->
          <div class="gradient-preview" style="background: linear-gradient(135deg, {customAccent}, {customAccent2})"></div>
        </div>
      {/if}
    </div>

    <!-- Preferences -->
    <div class="card settings-card">
      <div class="ch"><h3>{$_('settings.appearance.preferences')}</h3></div>

      <!-- Density -->
      <div class="pref-row">
        <div class="pref-label-group">
          <span class="pref-label">{$_('settings.appearance.density')}</span>
          <span class="pref-hint">{$_('settings.appearance.densityHint')}</span>
        </div>
        <div class="seg-ctrl">
          <button
            type="button"
            class="seg-btn {density === 'comfy' ? 'seg-active' : ''}"
            onclick={() => handleDensityChange('comfy')}
          >{$_('settings.appearance.comfy')}</button>
          <button
            type="button"
            class="seg-btn {density === 'compact' ? 'seg-active' : ''}"
            onclick={() => handleDensityChange('compact')}
          >{$_('settings.appearance.compact')}</button>
        </div>
      </div>

      <!-- Clock format -->
      <div class="pref-row">
        <div class="pref-label-group">
          <span class="pref-label">{$_('settings.appearance.clock')}</span>
          <span class="pref-hint">{$_('settings.appearance.clockHint')}</span>
        </div>
        <div class="seg-ctrl">
          <button
            type="button"
            class="seg-btn {clockFmt === '24h' ? 'seg-active' : ''}"
            onclick={() => handleClockFormatChange('24h')}
          >{$_('settings.appearance.clock24')}</button>
          <button
            type="button"
            class="seg-btn {clockFmt === '12h' ? 'seg-active' : ''}"
            onclick={() => handleClockFormatChange('12h')}
          >{$_('settings.appearance.clock12')}</button>
        </div>
      </div>

      <!-- Language -->
      <div class="pref-row">
        <div class="pref-label-group">
          <span class="pref-label">{$_('settings.appearance.language')}</span>
          <span class="pref-hint">{$_('settings.appearance.languageHint')}</span>
        </div>
        <div class="seg-ctrl">
          <button
            type="button"
            class="seg-btn {lang === 'en' ? 'seg-active' : ''}"
            onclick={() => handleLanguageChange('en')}
          >{$_('settings.appearance.langEn')}</button>
          <button
            type="button"
            class="seg-btn {lang === 'pt-BR' ? 'seg-active' : ''}"
            onclick={() => handleLanguageChange('pt-BR')}
          >{$_('settings.appearance.langPtBr')}</button>
        </div>
      </div>
    </div>

    <!-- Services Launcher editor — opens in a modal to keep the page compact -->
    <div class="card settings-card">
      <div class="ch"><h3>{$_('settings.services.title')}</h3></div>
      <div class="pref-row">
        <div class="pref-label-group">
          <span class="pref-hint">Choose which service links appear in the launcher.</span>
        </div>
        <button type="button" class="btn btn-s" onclick={() => (showServicesConfig = true)}>
          Edit services launcher
        </button>
      </div>
    </div>
  {/if}

  <!-- ══════════════════ BACKUP / CONFIG TAB ══════════════════ -->
  {#if activeTab === 'backup'}
    <!-- Export -->
    <div class="card settings-card">
      <div class="ch"><h3>{$_('settings.backup.exportTitle')}</h3></div>
      <p class="pref-hint">{$_('settings.backup.exportHint')}</p>

      <div class="backup-row">
        <label class="backup-checkbox-label">
          <input type="checkbox" bind:checked={exportIncludeSecrets} />
          {$_('settings.backup.includeSecrets')}
        </label>
      </div>

      {#if exportIncludeSecrets}
        <div class="secret-warning">
          {$_('settings.backup.secretWarning')}
        </div>
      {/if}

      <div class="form-actions">
        <button type="button" class="btn btn-p" onclick={doExport}>
          {$_('settings.backup.downloadConfig')}
        </button>
      </div>
    </div>

    <!-- Import -->
    <div class="card settings-card">
      <div class="ch"><h3>{$_('settings.backup.importTitle')}</h3></div>
      <p class="pref-hint">
        {$_('settings.backup.importHint')}
      </p>

      <div class="field-row">
        <label for="import-file" class="backup-file-label">{$_('settings.backup.chooseFile')}</label>
        <input
          id="import-file"
          type="file"
          accept=".yaml,.yml,.json"
          class="field-input backup-file-input"
          onchange={(e) => { importFile = (e.currentTarget as HTMLInputElement).files; importText = ''; }}
        />
      </div>

      <div class="backup-or">{$_('settings.backup.orPaste')}</div>

      <div class="field-row">
        <label for="import-text">{$_('settings.backup.yamlJson')}</label>
        <textarea
          id="import-text"
          class="field-input import-textarea"
          placeholder="version: 1&#10;connections:&#10;  - type: jellyfin&#10;    name: My Jellyfin&#10;    baseUrl: http://localhost:8096"
          bind:value={importText}
          oninput={() => { importFile = null; }}
          rows="8"
        ></textarea>
      </div>

      {#if importError}
        <div class="import-error">{importError}</div>
      {/if}

      {#if importStatus}
        <div class="import-ok">
          {$_('settings.backup.imported', { values: { created: importStatus.created, updated: importStatus.updated, layout: importStatus.layoutApplied ? $_('settings.backup.layoutApplied') : '' } })}
        </div>
      {/if}

      <div class="form-actions">
        <button
          type="button"
          class="btn btn-p"
          onclick={doImport}
          disabled={importBusy}
        >
          {importBusy ? $_('settings.backup.importing') : $_('settings.backup.import')}
        </button>
      </div>
    </div>
  {/if}

  <!-- ══════════════════ AI TAB ══════════════════ -->
  {#if activeTab === 'ai'}
    <!-- AI Connections manager — one stored key per provider. -->
    <div class="card settings-card">
      <div class="ch"><h3>{$_('settings.ai.connections')}</h3></div>
      <p class="pref-hint">{$_('settings.ai.connectionsHint')}</p>

      {#if aiConnections.length === 0}
        <p class="empty-hint">{$_('settings.ai.connEmpty')}</p>
      {:else}
        <div class="conn-list">
          {#each aiConnections as c (c.id)}
            <div class="conn-card">
              <div class="conn-card-top">
                <div class="conn-info">
                  <span class="conn-name">{c.label}</span>
                  <span class="conn-meta">
                    {c.provider} · {c.hasKey ? $_('settings.ai.connKeySet') : $_('settings.ai.connLocal')}
                  </span>
                </div>
                <div class="conn-actions">
                  <button type="button" class="icon-btn" title={$_('settings.ai.connEdit')} onclick={() => editAiConn(c)}>✎</button>
                  <button type="button" class="icon-btn danger" title={$_('settings.ai.connRemove')} onclick={() => removeAiConn(c.id)}>✕</button>
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      {#if aiConnDraft}
        <div class="add-form">
          <div class="field-row">
            <label for="ai-conn-label">{$_('settings.ai.connLabel')}</label>
            <input id="ai-conn-label" type="text" class="field-input" bind:value={aiConnDraft.label} placeholder={$_('settings.ai.connLabelPlaceholder')} />
          </div>
          <div class="field-row">
            <label for="ai-conn-provider">{$_('settings.ai.providerLabel')}</label>
            <select id="ai-conn-provider" class="field-input" bind:value={aiConnDraft.provider}>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI</option>
              <option value="google">Google (Gemini)</option>
              <option value="openai-compatible">OpenAI-compatible (Ollama / LM Studio / OpenRouter)</option>
            </select>
          </div>
          {#if connNeedsBaseUrl(aiConnDraft.provider)}
            <div class="field-row">
              <label for="ai-conn-baseurl">{$_('settings.ai.endpoint')}</label>
              <input id="ai-conn-baseurl" type="url" class="field-input" placeholder="http://localhost:11434/v1" bind:value={aiConnDraft.baseUrl} />
            </div>
          {/if}
          <div class="field-row">
            <label for="ai-conn-key">
              {$_('settings.ai.apiKey')}
              <span class="hint">{aiConnDraft.hasKey ? $_('settings.ai.apiKeyHint') : ''}</span>
            </label>
            <input
              id="ai-conn-key"
              type="password"
              class="field-input"
              autocomplete="new-password"
              placeholder={aiConnDraft.hasKey ? '••••••••' : ''}
              bind:value={aiConnDraft.apiKey}
            />
          </div>
          <div class="form-actions">
            <button type="button" class="btn btn-s" onclick={cancelAiConn}>{$_('settings.ai.connCancel')}</button>
            <button type="button" class="btn btn-p" onclick={saveAiConn} disabled={aiConnSaving || !aiConnDraft.label.trim()}>
              {aiConnSaving ? $_('settings.ai.connTesting') : $_('settings.ai.connSaveTest')}
            </button>
          </div>
          {#if aiConnResult && !aiConnResult.ok}
            <div class="test-result test-fail">✕ {aiConnResult.error ?? $_('settings.ai.invalid')}</div>
          {/if}
        </div>
      {:else}
        <div class="form-actions">
          <button type="button" class="btn btn-s" onclick={newAiConn}>{$_('settings.ai.connAdd')}</button>
        </div>
        {#if aiConnResult && aiConnResult.ok}
          <div class="test-result test-ok">✓ {$_('settings.ai.connSaved')}</div>
        {/if}
      {/if}
    </div>

    <!-- Admin + Consumer model pickers -->
    <div class="card settings-card">
      <div class="ch"><h3>{$_('settings.ai.adminModel')}</h3></div>
      <p class="pref-hint">{$_('settings.ai.adminModelHint')}</p>
      {@render modelPicker(
        'admin',
        adminConnectionId,
        (id) => onAdminConnChange(id),
        adminModels,
        adminModelsFallback,
        adminModel,
        (v) => (adminModel = v),
        adminTempPreset(),
        (n) => selectAdminTemp(n),
        adminTemperature,
        (v) => (adminTemperature = v)
      )}

      <div class="ch" style="margin-top: 1rem;"><h3>{$_('settings.ai.consumerModel')}</h3></div>
      <p class="pref-hint">{$_('settings.ai.consumerModelHint')}</p>
      {@render modelPicker(
        'consumer',
        consumerConnectionId,
        (id) => onConsumerConnChange(id),
        consumerModels,
        consumerModelsFallback,
        consumerModel,
        (v) => (consumerModel = v),
        consumerTempPreset(),
        (n) => selectConsumerTemp(n),
        consumerTemperature,
        (v) => (consumerTemperature = v),
        true
      )}

      <div class="form-actions">
        <button type="button" class="btn btn-p" onclick={saveAiConfig} disabled={aiSaving || adminConnectionId == null || !adminModel.trim()}>
          {aiSaving ? $_('settings.ai.validating') : $_('settings.ai.validateSave')}
        </button>
      </div>

      {#if aiSaveResult}
        <div class="test-result {aiSaveResult.ok ? 'test-ok' : 'test-fail'}">
          {aiSaveResult.ok ? `✓ ${$_('settings.ai.valid')}` : `✕ ${$_('settings.ai.invalid')}: ${aiSaveResult.error ?? ''}`}
        </div>
      {/if}
    </div>

    <!-- Token usage — click to open the per-model cost breakdown + spend-limit editor. -->
    <button type="button" class="card settings-card usage-card-btn" onclick={() => (showCost = true)}>
      <div class="ch usage-card-head">
        <h3>{$_('settings.ai.usage')}</h3>
        <span class="usage-breakdown-link">View breakdown →</span>
      </div>
      <div class="ai-usage-grid">
        <div class="ai-usage-stat">
          <span class="ai-usage-num">{aiUsage.input.toLocaleString()}</span>
          <span class="ai-usage-lbl">{$_('settings.ai.usageInput')}</span>
        </div>
        <div class="ai-usage-stat">
          <span class="ai-usage-num">{aiUsage.output.toLocaleString()}</span>
          <span class="ai-usage-lbl">{$_('settings.ai.usageOutput')}</span>
        </div>
        <div class="ai-usage-stat">
          <span class="ai-usage-num">{aiUsage.total.toLocaleString()}</span>
          <span class="ai-usage-lbl">{$_('settings.ai.usageTotal')}</span>
        </div>
      </div>
    </button>
    <CostModal bind:open={showCost} />

    <!-- MCP servers -->
    <div class="card settings-card">
      <div class="ch"><h3>{$_('settings.ai.mcpServers')}</h3></div>
      <p class="pref-hint">{$_('settings.ai.mcpHint')}</p>

      {#if mcpServers.length === 0}
        <p class="empty-hint">{$_('settings.ai.mcpEmpty')}</p>
      {/if}

      {#each mcpServers as server, i}
        <div class="mcp-row">
          <div class="field-row">
            <label for="mcp-name-{i}">{$_('settings.ai.mcpName')}</label>
            <input id="mcp-name-{i}" type="text" class="field-input" bind:value={server.name} />
          </div>
          <div class="field-row">
            <label for="mcp-transport-{i}">{$_('settings.ai.mcpTransport')}</label>
            <select id="mcp-transport-{i}" class="field-input" bind:value={server.transport}>
              <option value="sse">SSE</option>
              <option value="http">HTTP</option>
            </select>
          </div>
          <div class="field-row">
            <label for="mcp-url-{i}">{$_('settings.ai.mcpUrl')}</label>
            <input id="mcp-url-{i}" type="url" class="field-input" bind:value={server.url} />
          </div>
          <div class="field-row">
            <label for="mcp-headers-{i}">
              {$_('settings.ai.mcpHeaders')}
              <span class="hint">{server.hasHeaders ? $_('settings.ai.mcpHeadersSet') : ''}</span>
            </label>
            <textarea
              id="mcp-headers-{i}"
              class="field-input"
              rows="2"
              placeholder="Authorization: Bearer token"
              bind:value={server.headers}
            ></textarea>
          </div>
          <div class="mcp-row-foot">
            <label class="backup-checkbox-label">
              <input type="checkbox" bind:checked={server.enabled} />
              {$_('settings.ai.mcpEnabled')}
            </label>
            <button type="button" class="btn btn-d" onclick={() => removeMcpServer(i)}>{$_('settings.ai.mcpRemove')}</button>
          </div>
        </div>
      {/each}

      <div class="form-actions">
        <button type="button" class="btn btn-s" onclick={addMcpServer}>{$_('settings.ai.addServer')}</button>
        <button type="button" class="btn btn-p" onclick={saveMcp} disabled={mcpSaving}>
          {mcpSaving ? $_('settings.ai.saving') : $_('settings.ai.saveServers')}
        </button>
      </div>

      {#if mcpSaveResult}
        <div class="test-result {mcpSaveResult.ok ? 'test-ok' : 'test-fail'}">
          {mcpSaveResult.ok ? `✓ ${$_('settings.ai.saved')}` : `✕ ${mcpSaveResult.error ?? ''}`}
        </div>
      {/if}
    </div>

    <!-- Activity / audit log -->
    <div class="card settings-card">
      <div class="ch"><h3>{$_('settings.ai.activity')}</h3></div>
      <p class="pref-hint">{$_('settings.ai.activityHint')}</p>

      {#if auditRows.length === 0}
        <p class="empty-hint">{$_('settings.ai.activityEmpty')}</p>
      {:else}
        <div class="audit-list">
          {#each auditRows as row (row.id)}
            <div class="audit-row">
              <div class="audit-main">
                <span class="audit-tool">{row.tool}</span>
                <span class="pill {row.confirmed ? 'ok' : 'proc'}">
                  {row.confirmed ? $_('settings.ai.confirmed') : $_('settings.ai.declined')}
                </span>
                <span class="audit-ts">{fmtTime(row.ts)}</span>
              </div>
              {#if row.undoToken}
                <button
                  type="button"
                  class="btn btn-s"
                  disabled={undoBusy === row.id}
                  onclick={() => undoAction(row)}
                >{undoBusy === row.id ? $_('settings.ai.saving') : `${$_('settings.ai.undo')}: ${row.undoToken.label}`}</button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Telegram integration -->
    <div class="card settings-card">
      <div class="ch"><h3>{$_('settings.telegram.title')}</h3></div>

      <div class="field-row">
        <label for="tg-token">{$_('settings.telegram.tokenLabel')}</label>
        <input
          id="tg-token"
          type="password"
          class="field-input"
          autocomplete="new-password"
          placeholder="••••••••"
          bind:value={tgToken}
        />
      </div>

      <div class="form-actions">
        <button type="button" class="btn btn-p" onclick={saveTelegramConfig} disabled={tgSaving || !tgToken.trim()}>
          {tgSaving ? $_('settings.ai.saving') : $_('settings.telegram.save')}
        </button>
      </div>

      {#if tgSaveResult}
        <div class="test-result {tgSaveResult.ok ? 'test-ok' : 'test-fail'}">
          {tgSaveResult.ok
            ? `✓ ${tgSaveResult.botUsername ? $_('settings.telegram.connected', { values: { username: tgSaveResult.botUsername } }) : $_('settings.telegram.save')}`
            : `✕ ${tgSaveResult.error ?? ''}`}
        </div>
      {/if}

      <div class="pref-row" style="margin-top: 0.75rem;">
        <span class="pref-hint">
          {tgConfigured && tgBotUsername
            ? $_('settings.telegram.connected', { values: { username: tgBotUsername } })
            : $_('settings.telegram.notConfigured')}
          {' · '}
          {tgAdminBound ? $_('settings.telegram.boundCount', { values: { n: 1 } }) : $_('settings.telegram.boundCount', { values: { n: 0 } })}
        </span>
      </div>

      {#if tgConfigured}
        <div class="form-actions">
          <button type="button" class="btn btn-s" onclick={connectAdminTelegram}>
            {$_('settings.telegram.connectMine')}
          </button>
        </div>

        <div class="ch" style="margin-top: 1rem;"><h4 style="margin:0;font-size:0.875rem;font-weight:600;">{$_('settings.telegram.notifyTitle')}</h4></div>
        <div class="backup-row">
          <label class="backup-checkbox-label">
            <input
              type="checkbox"
              checked={tgNotifyPrefs.container_down}
              onchange={(e) => saveTelegramPref('container_down', (e.currentTarget as HTMLInputElement).checked)}
            />
            {$_('settings.telegram.notifyContainerDown')}
          </label>
        </div>
        <div class="backup-row">
          <label class="backup-checkbox-label">
            <input
              type="checkbox"
              checked={tgNotifyPrefs.disk_high}
              onchange={(e) => saveTelegramPref('disk_high', (e.currentTarget as HTMLInputElement).checked)}
            />
            {$_('settings.telegram.notifyDiskHigh')}
          </label>
        </div>
        <div class="backup-row">
          <label class="backup-checkbox-label">
            <input
              type="checkbox"
              checked={tgNotifyPrefs.download_stalled}
              onchange={(e) => saveTelegramPref('download_stalled', (e.currentTarget as HTMLInputElement).checked)}
            />
            {$_('settings.telegram.notifyStalled')}
          </label>
        </div>
      {/if}
    </div>
  {/if}

  <!-- ══════════════════ USERS & ROLES TAB ══════════════════ -->
  {#if activeTab === 'users'}
    <section class="card users-pane">
      <!-- Roles -->
      <h3>{$_('users.roles')}</h3>
      <div class="role-list">
        {#each roles as r}
          <div class="role-row">
            <b>{r.name}</b>
            {#if r.isAdmin}<span class="pill">{$_('users.builtin')}</span>{/if}
            <span class="role-meta">{r.allowList.join(', ') || '—'}</span>
            <span class="role-meta"
              >{r.monthlyTokenCap == null ? $_('users.unlimited') : r.monthlyTokenCap}</span
            >
            {#if r.editable}
              <div class="acts">
                <button class="btn btn-s" onclick={() => editRole(r)}>{$_('users.edit')}</button>
                <button class="btn btn-d" onclick={() => removeRole(r.id)}>{$_('users.delete')}</button
                >
              </div>
            {/if}
          </div>
        {/each}
      </div>
      <button class="btn btn-p" onclick={newRole}>{$_('users.newRole')}</button>

      {#if roleDraft}
        <div class="role-editor card">
          <label>{$_('users.roleName')}<input bind:value={roleDraft.name} /></label>
          <fieldset class="caps">
            <legend>{$_('users.capabilities')}</legend>
            {#each ALL_CAPS as c}
              <label class="cap"
                ><input
                  type="checkbox"
                  checked={roleDraft.allowList.includes(c)}
                  onchange={() => toggleCap(c)}
                /> {$_(`users.cap.${c}`)}</label
              >
            {/each}
          </fieldset>
          <label
            >{$_('users.plan')}
            <select
              value={roleDraft.planName ?? capToPlan(roleDraft.monthlyTokenCap)}
              onchange={(e) => selectPlan((e.currentTarget as HTMLSelectElement).value as PlanName)}
            >
              <option value="Light">{$_('users.planLight')}</option>
              <option value="Regular">{$_('users.planRegular')}</option>
              <option value="Power">{$_('users.planPower')}</option>
              <option value="Unlimited">{$_('users.planUnlimited')}</option>
              <option value="Custom">{$_('users.planCustom')}</option>
            </select>
          </label>
          <label
            >{$_('users.monthlyCap')}
            <input
              type="number"
              min="0"
              value={roleDraft.monthlyTokenCap ?? ''}
              oninput={(e) => {
                if (!roleDraft) return;
                roleDraft.monthlyTokenCap =
                  (e.currentTarget as HTMLInputElement).value === ''
                    ? null
                    : Number((e.currentTarget as HTMLInputElement).value);
                syncPlanFromCap();
              }}
            />
          </label>
          <label class="cap"
            ><input type="checkbox" bind:checked={roleDraft.autoApprove} /> {$_('users.autoApprove')}</label
          >
          <fieldset class="quota">
            <legend>{$_('users.quota')}</legend>
            <p class="quota-help">{$_('users.quotaHelp')}</p>
            <label
              >{$_('users.quotaMovie')}<input
                type="number"
                min="0"
                placeholder={$_('users.quotaUnlimited')}
                bind:value={roleDraft.seerrQuota.movie}
              />
              {#if !roleDraft.seerrQuota.movie}<span class="quota-hint">{$_('users.quotaUnlimited')}</span>{/if}</label
            >
            <label
              >{$_('users.quotaTv')}<input
                type="number"
                min="0"
                placeholder={$_('users.quotaUnlimited')}
                bind:value={roleDraft.seerrQuota.tv}
              />
              {#if !roleDraft.seerrQuota.tv}<span class="quota-hint">{$_('users.quotaUnlimited')}</span>{/if}</label
            >
          </fieldset>
          <div class="acts">
            <button class="btn btn-p" onclick={saveRole}>{$_('users.save')}</button>
            <button class="btn btn-s" onclick={() => (roleDraft = null)}>{$_('users.cancel')}</button>
          </div>
        </div>
      {/if}

      <!-- Invites -->
      <h3>{$_('users.invites')}</h3>
      <div class="invite-gen acts">
        <select bind:value={inviteRoleId}>
          <option value={null}>{$_('users.pickRole')}</option>
          {#each roles.filter((r) => !r.isAdmin) as r}<option value={r.id}>{r.name}</option>{/each}
        </select>
        <button class="btn btn-p" onclick={mintInvite} disabled={!inviteRoleId}
          >{$_('users.generate')}</button
        >
      </div>
      {#if lastInviteLink}
        <div class="invite-link-box">
          <input
            class="field-input invite-link-input"
            type="text"
            readonly
            value={`${location.origin}${lastInviteLink}`}
            onclick={(e) => (e.currentTarget as HTMLInputElement).select()}
          />
          <button
            type="button"
            class="btn btn-s invite-copy-btn"
            class:copied={inviteCopied}
            onclick={copyInviteLink}
          >
            {#if inviteCopied}
              <span aria-hidden="true">✓</span> {$_('users.copied')}
            {:else}
              <span aria-hidden="true">⧉</span> {$_('users.copy')}
            {/if}
          </button>
        </div>
      {/if}

      <!-- Pending invites (primary list) -->
      {#if pendingInvites.length === 0}
        <p class="empty-hint">{$_('users.noPendingInvites')}</p>
      {:else}
        <ul class="invite-list">
          {#each pendingInvites as i (i.id)}
            <li class="invite-row">
              <span class="pill pill-{i.status}">{$_(`users.status.${i.status}`)}</span>
              <span class="invite-role">{i.roleName}</span>
              <code class="invite-token">{i.token.slice(0, 8)}…</code>
              <div class="invite-actions">
                <button
                  type="button"
                  class="btn btn-s invite-copy-btn"
                  class:copied={rowCopiedId === i.id}
                  onclick={() => copyRowLink(i)}
                >
                  {#if rowCopiedId === i.id}
                    <span aria-hidden="true">✓</span> {$_('users.copied')}
                  {:else}
                    <span aria-hidden="true">⧉</span> {$_('users.copyLink')}
                  {/if}
                </button>
                <button
                  type="button"
                  class="btn btn-d btn-s"
                  onclick={() => cancelInvite(i)}
                >{$_('users.cancelInvite')}</button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}

      <!-- Accepted/expired invites — collapsed by default -->
      {#if oldInvites.length > 0}
        <button
          type="button"
          class="invite-old-toggle"
          onclick={() => (showOldInvites = !showOldInvites)}
        >
          {showOldInvites
            ? $_('users.hideOldInvites')
            : $_('users.showOldInvites', { values: { n: oldInvites.length } })}
        </button>
        {#if showOldInvites}
          <ul class="invite-list invite-list-old">
            {#each oldInvites as i (i.id)}
              <li class="invite-row">
                <span class="pill pill-{i.status}">{$_(`users.status.${i.status}`)}</span>
                <span class="invite-role">{i.roleName}</span>
                <code class="invite-token">{i.token.slice(0, 8)}…</code>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}

      <!-- Users -->
      <h3>{$_('users.consumers')}</h3>
      <div class="user-list">
        {#each users as u}
          <div class="user-card" class:disabled={u.status === 'disabled'}>
            <!-- Top row: name + role pill + usage -->
            <div class="user-card-top">
              <div class="user-identity">
                <span class="user-name">{u.displayName}</span>
                <span class="role-pill">{u.roleName}</span>
                {#if u.status === 'disabled'}
                  <span class="pill" style="opacity:0.6">{$_('users.disabled')}</span>
                {/if}
              </div>
              <!-- Compact usage indicator -->
              <div class="user-usage" title={`${u.monthToDate} / ${u.effectiveCap ?? '∞'} tokens`}>
                {#if u.effectiveCap}
                  <div class="usage-mini-bar">
                    <div class="usage-mini-fill" style={`width:${usagePct(u)}%`}></div>
                  </div>
                {/if}
                <span class="usage-text-sm">
                  {u.monthToDate.toLocaleString()}{u.effectiveCap ? ` / ${u.effectiveCap.toLocaleString()}` : ''}
                </span>
              </div>
            </div>
            <!-- Bottom row: controls -->
            <div class="user-card-foot">
              <select
                class="user-role-select"
                value={u.roleId}
                onchange={(e) =>
                  changeUserRole(u, Number((e.currentTarget as HTMLSelectElement).value))}
              >
                {#each roles.filter((r) => !r.isAdmin) as r}<option value={r.id}>{r.name}</option>{/each}
              </select>
              <input
                class="user-cap-input"
                type="number"
                min="0"
                placeholder={$_('users.capOverride')}
                value={u.capOverride ?? ''}
                onchange={(e) =>
                  setUserCap(
                    u,
                    (e.currentTarget as HTMLInputElement).value === ''
                      ? null
                      : Number((e.currentTarget as HTMLInputElement).value)
                  )}
              />
              <div class="user-card-acts">
                <a class="btn btn-s btn-sm" href={`/access?user=${u.id}`}>{$_('users.log')}</a>
                <button class="btn btn-s btn-sm" onclick={() => resetUserPassword(u)}>{$_('users.resetPassword')}</button>
                <button
                  class="btn btn-s btn-sm"
                  class:active={sessionsOpenId === u.id}
                  onclick={() => toggleSessions(u)}
                >{$_('users.sessions')}</button>
                <button class="btn btn-s btn-sm" onclick={() => toggleDisable(u)}
                  >{u.status === 'disabled' ? $_('users.enable') : $_('users.disable')}</button
                >
                <button class="btn btn-d btn-sm" onclick={() => removeUser(u)}>{$_('users.remove')}</button>
              </div>
            </div>
            <!-- Inline sessions panel -->
            {#if sessionsOpenId === u.id}
              <div class="sessions-panel">
                {#if sessionsLoading[u.id]}
                  <span class="session-empty">Loading…</span>
                {:else if !sessionsMap[u.id] || sessionsMap[u.id].length === 0}
                  <span class="session-empty">{$_('users.noSessions')}</span>
                {:else}
                  {#each sessionsMap[u.id] as s (s.id)}
                    <div class="session-row">
                      <span class="session-meta">
                        {s.device || '—'}{s.ip ? ` · ${s.ip}` : ''} · {$_('users.since')} {fmtDate(s.createdAt)}
                      </span>
                      <button class="btn btn-d btn-sm" onclick={() => revokeSession(u.id, s.id)}>{$_('users.revoke')}</button>
                    </div>
                  {/each}
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>

      {#if resetErr}<p class="app-error">{resetErr}</p>{/if}
      {#if resetLink}
        <div class="invite-link-box" style="flex-direction:column; align-items:stretch; gap:4px">
          <p class="app-hint">{$_('users.resetLinkLabel')}</p>
          <input class="field-input" type="text" readonly value={resetLink} onclick={(e) => (e.currentTarget as HTMLInputElement).select()} />
        </div>
      {/if}
      <div class="acts" style="margin-top:12px">
        <a class="btn btn-s" href="/access">{$_('users.viewAccessLog')}</a>
      </div>
      <label class="admin-contact">
        {$_('users.adminContact')}
        <input class="field-input" type="text" bind:value={adminContact} onblur={saveAdminContact} placeholder="admin@home.lan" />
      </label>
    </section>
  {/if}

  <!-- ══════════════════ CONNECTIONS TAB ══════════════════ -->
  {#if activeTab === 'connections'}
    <div class="master-detail" class:mobile-detail-open={isMobile && mobileDetailOpen}>
      <!-- Left rail: integration type list -->
      <nav class="md-rail" aria-label={$_('settings.connections.integrationTypes')}>
        {#each allSections as section}
          {@const hasActive = section.conns.some((c: any) => c.enabled)}
          <button
            type="button"
            class="md-rail-item {selectedType === section.type ? 'selected' : ''}"
            onclick={() => { selectedType = section.type; mobileDetailOpen = true; }}
            aria-current={selectedType === section.type ? 'page' : undefined}
          >
            <span class="md-icon">{integIcon(section.type)}</span>
            <span class="md-label">{section.label}</span>
            <span class="md-badges">
              {#if section.conns.length > 0}
                <span class="md-count">{section.conns.length}</span>
              {/if}
              {#if hasActive}
                <span class="md-dot" title={$_('settings.connections.hasActive')}></span>
              {/if}
            </span>
          </button>
        {/each}
      </nav>

      <!-- Right detail pane -->
      {#if activeSection}
        <div class="md-detail">
          <!-- Detail header -->
          <div class="md-detail-header">
            <!-- Mobile-only back button: returns to the type list. -->
            <button
              type="button"
              class="md-back"
              onclick={() => (mobileDetailOpen = false)}
              aria-label={$_('settings.connections.back')}
            >‹</button>
            <span class="md-detail-icon">{integIcon(activeSection.type)}</span>
            <div class="md-detail-title">
              <h3>{activeSection.label}</h3>
              {#if activeSection.conns.length > 0}
                <span class="cnt-badge">{activeSection.conns.length}</span>
              {/if}
            </div>
            <button
              type="button"
              class="add-btn {addOpenType === activeSection.type ? 'active' : ''}"
              onclick={() => openAddPanel(activeSection.type)}
              aria-label={$_('settings.connections.addConnection', { values: { label: activeSection.label } })}
            >
              {addOpenType === activeSection.type ? $_('settings.connections.cancel') : $_('settings.connections.add')}
            </button>
          </div>

          <!-- Configured connection cards -->
          {#if activeSection.conns.length > 0}
            <div class="conn-list">
              {#each activeSection.conns as conn}
                <div class="conn-card {editId === conn.id ? 'editing' : ''}">
                  <!-- Card top row -->
                  <div class="conn-card-top">
                    <div class="conn-info">
                      <span class="conn-name">{conn.name}</span>
                      <span class="conn-meta">{conn.baseUrl}</span>
                    </div>

                    <div class="conn-actions">
                      <!-- Enabled toggle -->
                      <form method="POST" action="?/toggle" use:enhance class="inline-form">
                        <input type="hidden" name="id" value={conn.id} />
                        <input type="hidden" name="enabled" value={conn.enabled ? '0' : '1'} />
                        <button
                          type="submit"
                          class="toggle-btn {conn.enabled ? 'on' : 'off'}"
                          title={conn.enabled ? $_('settings.connections.enabledTitle') : $_('settings.connections.disabledTitle')}
                        >
                          <span class="toggle-track"><span class="toggle-thumb"></span></span>
                          <span class="toggle-lbl">{conn.enabled ? $_('settings.connections.on') : $_('settings.connections.off')}</span>
                        </button>
                      </form>

                      <!-- Edit button -->
                      <button
                        type="button"
                        class="icon-btn {editId === conn.id ? 'active' : ''}"
                        title={$_('settings.connections.edit')}
                        onclick={() => openEdit(conn)}
                      >✎</button>

                      <!-- Delete -->
                      <form method="POST" action="?/delete" use:enhance class="inline-form">
                        <input type="hidden" name="id" value={conn.id} />
                        <button type="submit" class="icon-btn danger" title={$_('settings.connections.delete')}>✕</button>
                      </form>
                    </div>
                  </div>

                  <!-- Inline edit form -->
                  {#if editId === conn.id}
                    <form
                      method="POST"
                      action="?/update"
                      use:enhance={() => ({ update }) => update({ reset: false })}
                      class="edit-form"
                    >
                      <input type="hidden" name="id" value={conn.id} />
                      <input type="hidden" name="type" value={conn.type} />

                      <div class="field-row">
                        <label for="edit-name-{conn.id}">{$_('settings.connections.name')}</label>
                        <input
                          id="edit-name-{conn.id}"
                          name="name"
                          type="text"
                          class="field-input"
                          required
                          bind:value={editName}
                        />
                      </div>

                      <!-- baseUrl from schema -->
                      <div class="field-row">
                        <label for="edit-url-{conn.id}">{activeSection.baseUrlLabel}</label>
                        <input
                          id="edit-url-{conn.id}"
                          name="baseUrl"
                          type="url"
                          class="field-input"
                          required
                          bind:value={editBaseUrl}
                        />
                      </div>

                      <!-- Secret field -->
                      {#if activeSection.hasSecret}
                        <div class="field-row">
                          <label for="edit-secret-{conn.id}">{activeSection.secretLabel} <span class="hint">{$_('settings.connections.secretKeepHint')}</span></label>
                          <input
                            id="edit-secret-{conn.id}"
                            name="secret"
                            type="password"
                            class="field-input"
                            placeholder={$_('settings.connections.secretPlaceholder')}
                            bind:value={editSecret}
                            autocomplete="new-password"
                          />
                        </div>
                      {/if}

                      <!-- Extra schema fields (not reserved) -->
                      {#each activeSection.extraFields as field}
                        <div class="field-row">
                          <label for="edit-{field.key}-{conn.id}">{field.label}</label>
                          <input
                            id="edit-{field.key}-{conn.id}"
                            name={field.key}
                            type={field.type === 'password' ? 'password' : 'text'}
                            class="field-input"
                            placeholder={field.placeholder ?? ''}
                            bind:value={editFields[field.key]}
                          />
                        </div>
                      {/each}

                      {#if updateError}
                        <p class="err">{updateError}</p>
                      {/if}

                      <div class="form-actions">
                        <button type="button" class="btn btn-s" onclick={cancelEdit}>{$_('settings.connections.cancelPlain')}</button>
                        <button
                          type="submit"
                          formaction="?/testUpdate"
                          class="btn btn-s"
                        >{$_('settings.connections.test')}</button>
                        <button type="submit" formaction="?/update" class="btn btn-p">{$_('settings.connections.save')}</button>
                      </div>

                      {#if testResult}
                        <div class="test-result {testResult.ok ? 'test-ok' : 'test-fail'}">
                          {testResult.ok ? '✓' : '✕'} {testResult.message}
                        </div>
                      {/if}
                    </form>
                  {/if}
                </div>
              {/each}
            </div>
          {:else}
            <p class="empty-hint">{$_('settings.connections.noneConfigured', { values: { label: activeSection.label } })}</p>
          {/if}

          <!-- Inline Add form for active section -->
          {#if addOpenType === activeSection.type}
            <form
              method="POST"
              action="?/create"
              use:enhance={() => ({ update }) => update({ reset: false })}
              class="add-form"
            >
              <input type="hidden" name="type" value={activeSection.type} />

              <div class="field-row">
                <label for="add-name-{activeSection.type}">{$_('settings.connections.name')}</label>
                <input
                  id="add-name-{activeSection.type}"
                  name="name"
                  type="text"
                  class="field-input"
                  placeholder={$_('settings.connections.namePlaceholder', { values: { label: activeSection.label } })}
                  required
                  bind:value={addName}
                />
              </div>

              {#each activeSection.schema.filter((f: any) => f.key !== 'type') as field (field.key)}
                <div class="field-row">
                  <label for="add-{field.key}-{activeSection.type}">{field.label}</label>
                  <input
                    id="add-{field.key}-{activeSection.type}"
                    name={field.key}
                    type={field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'}
                    class="field-input"
                    placeholder={field.placeholder ?? ''}
                    required={field.required ?? false}
                    bind:value={addFields[field.key]}
                  />
                </div>
              {/each}

              {#if createError}
                <p class="err">{createError}</p>
              {/if}

              <div class="form-actions">
                <button
                  type="submit"
                  formaction="?/test"
                  class="btn btn-s"
                >{$_('settings.connections.test')}</button>
                <button type="submit" formaction="?/create" class="btn btn-p">{$_('settings.connections.save')}</button>
              </div>

              {#if testResult}
                <div class="test-result {testResult.ok ? 'test-ok' : 'test-fail'}">
                  {testResult.ok ? '✓' : '✕'} {testResult.message}
                </div>
              {/if}
            </form>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <div class="settings-about-footer">
    <a href="/about" class="settings-about-link">About Pulse →</a>
  </div>
</div>

<ServicesConfigModal bind:open={showServicesConfig} />

{#snippet failed(error: unknown, reset: () => void)}
  <div style="padding:24px;color:#ff7a92;font-size:14px;">
    <p>{$_('settings.failed')}</p>
    {#if error instanceof Error}<p style="font-size:12px;color:var(--sub);margin-top:6px;">{error.message}</p>{/if}
    <button onclick={reset} style="margin-top:12px;padding:7px 16px;border-radius:8px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);color:var(--txt);cursor:pointer;font-size:12px;">{$_('settings.retry')}</button>
  </div>
{/snippet}

</svelte:boundary>

{#snippet modelPicker(
  idPrefix: string,
  connId: number | null,
  onConn: (id: number | null) => void,
  models: AiModelEntry[],
  fallback: boolean,
  model: string,
  onModel: (v: string) => void,
  tempPreset: TemperaturePreset,
  onTemp: (n: TemperaturePreset) => void,
  tempValue: number | null,
  onTempValue: (v: number | null) => void,
  allowUnset: boolean = false
)}
  <div class="field-row">
    <label for="{idPrefix}-conn">{$_('settings.ai.connection')}</label>
    <select
      id="{idPrefix}-conn"
      class="field-input"
      value={connId ?? ''}
      onchange={(e) => {
        const v = (e.currentTarget as HTMLSelectElement).value;
        onConn(v === '' ? null : Number(v));
      }}
    >
      {#if allowUnset}
        <option value="">{$_('settings.ai.useAdminModel')}</option>
      {:else}
        <option value="" disabled>{$_('settings.ai.pickConnection')}</option>
      {/if}
      {#each aiConnections as c (c.id)}
        <option value={c.id}>{connLabel(c)}</option>
      {/each}
    </select>
  </div>

  {#if connId != null}
    <div class="field-row">
      <label for="{idPrefix}-model">{$_('settings.ai.model')}</label>
      <select
        id="{idPrefix}-model"
        class="field-input"
        value={models.some((m) => m.id === model) ? model : '__custom__'}
        onchange={(e) => {
          const v = (e.currentTarget as HTMLSelectElement).value;
          onModel(v === '__custom__' ? '' : v);
        }}
      >
        {#each models as m (m.id)}
          <option value={m.id}>{m.recommended ? '★ ' : ''}{m.id}</option>
        {/each}
        <option value="__custom__">{$_('settings.ai.modelCustom')}</option>
      </select>
    </div>
    {#if fallback}
      <p class="pref-hint">{$_('settings.ai.modelsFallback')}</p>
    {/if}
    {#if !models.some((m) => m.id === model)}
      <div class="field-row">
        <label for="{idPrefix}-model-custom">{$_('settings.ai.modelCustomLabel')}</label>
        <input
          id="{idPrefix}-model-custom"
          type="text"
          class="field-input"
          placeholder="model-id"
          value={model}
          oninput={(e) => onModel((e.currentTarget as HTMLInputElement).value)}
        />
      </div>
    {/if}

    <div class="field-row">
      <label for="{idPrefix}-temp">{$_('settings.ai.temperature')}</label>
      <select
        id="{idPrefix}-temp"
        class="field-input"
        value={tempPreset}
        onchange={(e) => onTemp((e.currentTarget as HTMLSelectElement).value as TemperaturePreset)}
      >
        <option value="precise">{$_('settings.ai.tempPrecise')}</option>
        <option value="balanced">{$_('settings.ai.tempBalanced')}</option>
        <option value="creative">{$_('settings.ai.tempCreative')}</option>
        <option value="custom">{$_('settings.ai.tempCustom')}</option>
      </select>
    </div>
    <p class="pref-hint">{$_('settings.ai.temperatureHelp')}</p>
    {#if tempPreset === 'custom'}
      <div class="field-row">
        <label for="{idPrefix}-temp-custom">{$_('settings.ai.tempCustomLabel')}</label>
        <input
          id="{idPrefix}-temp-custom"
          type="number"
          step="0.1"
          min="0"
          max="1"
          class="field-input"
          value={tempValue ?? ''}
          oninput={(e) => {
            const v = (e.currentTarget as HTMLInputElement).value;
            onTempValue(v === '' ? null : Number(v));
          }}
        />
      </div>
    {/if}
  {/if}
{/snippet}

<style>
  .settings-page {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .settings-header h2 {
    font-size: 20px;
    font-weight: 700;
    margin-bottom: 4px;
  }

  .settings-sub {
    font-size: 13px;
    color: var(--sub);
  }

  /* ── Tab bar ── */
  .tab-bar {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--card-brd);
    padding-bottom: 0;
  }

  .tab-btn {
    padding: 9px 20px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    background: none;
    border: none;
    color: var(--sub);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: color 0.15s, border-color 0.15s;
  }

  .tab-btn:hover { color: var(--txt); }

  .tab-btn.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  /* ── Card ── */
  .settings-card {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  /* ── Theme swatches ── */
  .theme-swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .swatch-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 16px;
    border-radius: 10px;
    border: 1px solid var(--card-brd);
    background: rgba(255, 255, 255, 0.04);
    cursor: pointer;
    color: var(--txt);
    font-size: 13px;
    font-weight: 500;
    transition: border-color 0.15s, background 0.15s;
  }

  .swatch-btn:hover {
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  }

  .swatch-btn.selected {
    border-color: var(--s1);
    background: color-mix(in srgb, var(--s1) 12%, transparent);
  }

  .swatch-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--s1), var(--s2));
    flex-shrink: 0;
  }

  .swatch-lbl {
    font-size: 13px;
  }

  /* ══════════════════════════════════════════════
     Master-detail layout
     ══════════════════════════════════════════════ */
  .master-detail {
    display: flex;
    gap: 0;
    background: var(--card);
    border: 1px solid var(--card-brd);
    border-radius: var(--radius);
    overflow: hidden;
    min-height: 480px;
    width: 100%;
  }

  /* ── Left rail ── */
  .md-rail {
    display: flex;
    flex-direction: column;
    width: 192px;
    flex-shrink: 0;
    border-right: 1px solid var(--card-brd);
    padding: 8px 6px;
    gap: 2px;
    overflow-y: auto;
  }

  .md-rail-item {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 9px 10px;
    border-radius: 9px;
    border: none;
    background: none;
    cursor: pointer;
    color: var(--sub);
    font-size: 13px;
    font-weight: 500;
    text-align: left;
    transition: background 0.13s, color 0.13s;
    width: 100%;
  }

  .md-rail-item:hover {
    background: rgba(255, 255, 255, 0.04);
    color: var(--txt);
  }

  .md-rail-item.selected {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent);
    font-weight: 600;
  }

  .md-icon {
    font-size: 16px;
    flex-shrink: 0;
    width: 22px;
    text-align: center;
  }

  .md-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .md-badges {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
  }

  .md-count {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 99px;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--accent);
    line-height: 16px;
  }

  .md-rail-item:not(.selected) .md-count {
    background: rgba(255, 255, 255, 0.08);
    color: var(--sub);
  }

  .md-dot {
    width: 6px;
    height: 6px;
    border-radius: 99px;
    background: var(--accent);
    flex-shrink: 0;
  }

  /* ── Right detail pane ── */
  .md-detail {
    flex: 1;
    min-width: 0;
    padding: 20px 22px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow-y: auto;
  }

  .md-detail-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--card-brd);
  }

  .md-detail-icon {
    font-size: 22px;
    flex-shrink: 0;
  }

  .md-detail-title {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .md-detail-title h3 {
    margin-bottom: 0;
    font-size: 16px;
  }

  .add-btn {
    padding: 6px 14px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--card-brd);
    background: rgba(255, 255, 255, 0.04);
    color: var(--accent);
    transition: background 0.15s, border-color 0.15s;
    white-space: nowrap;
  }

  .add-btn:hover, .add-btn.active {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  }

  /* ── Connection cards ── */
  .conn-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .conn-card {
    background: rgba(255, 255, 255, 0.025);
    border: 1px solid var(--card-brd);
    border-radius: 12px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    transition: border-color 0.15s;
  }

  .conn-card.editing {
    border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  }

  .conn-card-top {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .conn-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .conn-name {
    font-size: 14px;
    font-weight: 600;
  }

  .conn-meta {
    font-size: 12px;
    color: var(--sub);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .conn-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  /* ── Toggle button ── */
  .toggle-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    background: none;
    border: none;
    padding: 4px 2px;
  }

  .toggle-track {
    width: 32px;
    height: 18px;
    border-radius: 99px;
    background: rgba(255, 255, 255, 0.12);
    position: relative;
    transition: background 0.2s;
  }

  .toggle-btn.on .toggle-track {
    background: color-mix(in srgb, var(--accent) 55%, transparent);
  }

  .toggle-thumb {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 12px;
    height: 12px;
    border-radius: 99px;
    background: #fff;
    transition: transform 0.2s;
  }

  .toggle-btn.on .toggle-thumb {
    transform: translateX(14px);
  }

  .toggle-lbl {
    font-size: 11px;
    color: var(--sub);
    font-weight: 600;
    width: 20px;
  }

  .toggle-btn.on .toggle-lbl { color: var(--accent); }

  /* ── Icon action buttons ── */
  .icon-btn {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    border: 1px solid var(--card-brd);
    background: rgba(255, 255, 255, 0.03);
    color: var(--sub);
    cursor: pointer;
    font-size: 14px;
    display: grid;
    place-items: center;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }

  .icon-btn:hover, .icon-btn.active {
    color: var(--txt);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }

  .icon-btn.danger:hover {
    color: #ff7a92;
    border-color: rgba(255, 92, 122, 0.4);
    background: rgba(255, 92, 122, 0.08);
  }

  .inline-form {
    display: contents;
  }

  /* ── Edit / Add forms ── */
  .edit-form,
  .add-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-top: 8px;
    border-top: 1px solid var(--card-brd);
  }

  .field-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .field-row label {
    font-size: 12px;
    color: var(--sub);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    font-weight: 600;
  }

  .hint {
    font-size: 11px;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    opacity: 0.75;
  }

  .field-input {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--card-brd);
    border-radius: 10px;
    color: var(--txt);
    font-size: 14px;
    padding: 10px 14px;
    outline: none;
    transition: border-color 0.15s;
    width: 100%;
  }

  .field-input:focus {
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  }

  .form-actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
    flex-wrap: wrap;
  }

  .btn {
    padding: 9px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    transition: opacity 0.15s;
  }

  .btn:hover { opacity: 0.85; }

  .btn-p {
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    color: #08110d;
    flex: 1;
  }

  .btn-s {
    background: rgba(255, 255, 255, 0.05);
    color: var(--txt);
    border: 1px solid var(--card-brd);
  }

  /* Pending invite list rows */
  .invite-list {
    list-style: none;
    padding: 0;
    margin: 8px 0 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .invite-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .invite-role {
    font-size: 13px;
    color: var(--txt);
  }

  .invite-token {
    font-size: 12px;
    color: var(--txt-sub, var(--txt));
    opacity: 0.65;
  }

  .invite-actions {
    display: flex;
    gap: 6px;
    margin-left: auto;
  }

  /* Freshly-generated invite link: read-only field + copy button. */
  .invite-link-box {
    display: flex;
    gap: 8px;
    align-items: stretch;
    margin: 10px 0 4px;
  }

  .invite-link-input {
    flex: 1;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12.5px;
    cursor: text;
  }

  .invite-copy-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }

  .invite-copy-btn.copied {
    border-color: color-mix(in srgb, var(--accent) 60%, transparent);
    color: var(--accent);
  }

  .test-result {
    padding: 10px 14px;
    border-radius: 9px;
    font-size: 13px;
    font-weight: 600;
  }

  .test-ok {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  }

  .test-fail {
    background: rgba(255, 92, 122, 0.10);
    color: #ff7a92;
    border: 1px solid rgba(255, 92, 122, 0.25);
  }

  .err {
    color: #ff7a92;
    font-size: 13px;
  }

  .empty-hint {
    font-size: 13px;
    color: var(--sub);
    padding: 4px 2px;
  }

  /* Mobile-only back button (hidden on desktop). */
  .md-back {
    display: none;
  }

  /* ══════════════════════════════════════════════
     Mobile master-detail (≤768px): stack the list and detail.
     The type list shows first (full-width); tapping a type opens its
     detail full-width with a back button. .mobile-detail-open toggles which
     pane is visible.
     ══════════════════════════════════════════════ */
  @media (max-width: 768px) {
    .master-detail {
      flex-direction: column;
      min-height: 0;
    }

    .md-rail {
      width: 100%;
      border-right: none;
      border-bottom: 1px solid var(--card-brd);
      max-height: none;
    }

    .md-rail-item {
      /* ≥44px tap targets */
      min-height: 48px;
    }

    .md-detail {
      display: none;
    }

    /* When a type is selected, swap: hide the list, show the detail full-width. */
    .master-detail.mobile-detail-open .md-rail {
      display: none;
    }
    .master-detail.mobile-detail-open .md-detail {
      display: flex;
    }

    .md-back {
      display: grid;
      place-items: center;
      width: 40px;
      height: 40px;
      flex-shrink: 0;
      border: 1px solid var(--card-brd);
      border-radius: 9px;
      background: none;
      color: var(--sub);
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
      margin-right: 2px;
    }
    .md-back:hover {
      color: var(--txt);
      border-color: color-mix(in srgb, var(--accent) 45%, transparent);
    }

    /* Settle stacked action buttons to comfortable touch height. */
    .form-actions .btn {
      min-height: 44px;
    }

    /* Comfortable tab + control tap targets. */
    .tab-btn {
      min-height: 44px;
    }
    .icon-btn {
      width: 40px;
      height: 40px;
    }
    .swatch-btn {
      min-height: 44px;
    }
    .seg-ctrl {
      width: 100%;
    }
    .pref-row {
      flex-direction: column;
      align-items: flex-start;
      gap: 10px;
    }
    .color-pickers {
      flex-direction: column;
    }
  }

  /* ── Custom theme section ── */
  .custom-section {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--card-brd);
    margin-top: 4px;
  }

  .custom-swatches-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .custom-swatch-pill {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    border-radius: 99px;
    border: 1px solid var(--card-brd);
    background: rgba(255, 255, 255, 0.03);
    cursor: pointer;
    color: var(--sub);
    font-size: 12px;
    font-weight: 500;
    transition: border-color 0.15s, background 0.15s, color 0.15s;
  }

  .custom-swatch-pill:hover {
    border-color: color-mix(in srgb, var(--s1, var(--accent)) 50%, transparent);
    color: var(--txt);
  }

  .custom-swatch-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--s1), var(--s2));
    flex-shrink: 0;
  }

  .custom-swatch-lbl {
    font-size: 12px;
  }

  .color-pickers {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }

  .color-picker-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
    min-width: 160px;
  }

  .color-label {
    font-size: 12px;
    color: var(--sub);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .color-input-wrap {
    display: flex;
    align-items: center;
    gap: 10px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--card-brd);
    border-radius: 10px;
    padding: 6px 12px;
    transition: border-color 0.15s;
  }

  .color-input-wrap:focus-within {
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  }

  .color-input {
    width: 28px;
    height: 28px;
    border: none;
    background: none;
    cursor: pointer;
    padding: 0;
    border-radius: 6px;
    overflow: hidden;
    flex-shrink: 0;
  }

  .color-input::-webkit-color-swatch-wrapper {
    padding: 0;
    border-radius: 6px;
  }

  .color-input::-webkit-color-swatch {
    border: none;
    border-radius: 6px;
  }

  .color-input::-moz-color-swatch {
    border: none;
    border-radius: 6px;
  }

  .color-hex {
    font-size: 13px;
    color: var(--sub);
    font-variant-numeric: tabular-nums;
    font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
    letter-spacing: 0.5px;
  }

  .gradient-preview {
    height: 6px;
    border-radius: 99px;
    width: 100%;
  }

  /* ── Backup / Config section ── */
  .backup-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 0;
  }

  .backup-checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--txt);
    cursor: pointer;
    user-select: none;
  }

  .backup-checkbox-label input[type='checkbox'] {
    width: 16px;
    height: 16px;
    accent-color: var(--accent);
    cursor: pointer;
  }

  .secret-warning {
    padding: 10px 14px;
    border-radius: 9px;
    font-size: 12px;
    font-weight: 500;
    background: rgba(255, 92, 122, 0.10);
    color: #ff7a92;
    border: 1px solid rgba(255, 92, 122, 0.25);
    line-height: 1.5;
  }

  .backup-or {
    text-align: center;
    font-size: 12px;
    color: var(--sub);
    padding: 4px 0;
    position: relative;
  }

  .backup-or::before,
  .backup-or::after {
    content: '';
    position: absolute;
    top: 50%;
    width: 42%;
    height: 1px;
    background: var(--card-brd);
  }

  .backup-or::before { left: 0; }
  .backup-or::after { right: 0; }

  .backup-file-label {
    font-size: 12px;
    color: var(--sub);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    font-weight: 600;
  }

  .backup-file-input {
    padding: 8px 12px;
    font-size: 13px;
    color: var(--txt);
    cursor: pointer;
  }

  .import-textarea {
    font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
    font-size: 12px;
    resize: vertical;
    min-height: 120px;
    line-height: 1.6;
  }

  .import-error {
    padding: 10px 14px;
    border-radius: 9px;
    font-size: 13px;
    font-weight: 500;
    background: rgba(255, 92, 122, 0.10);
    color: #ff7a92;
    border: 1px solid rgba(255, 92, 122, 0.25);
    white-space: pre-wrap;
  }

  .import-ok {
    padding: 10px 14px;
    border-radius: 9px;
    font-size: 13px;
    font-weight: 600;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  }

  /* ── Preferences section ── */
  .pref-row {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 10px 0;
    border-bottom: 1px solid var(--card-brd);
  }

  .pref-row:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }

  .pref-row:first-of-type {
    padding-top: 0;
  }

  .pref-label-group {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .pref-label {
    font-size: 14px;
    font-weight: 600;
    color: var(--txt);
  }

  .pref-hint {
    font-size: 12px;
    color: var(--sub);
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }

  .seg-ctrl {
    display: flex;
    border: 1px solid var(--card-brd);
    border-radius: 9px;
    overflow: hidden;
    flex-shrink: 0;
  }

  .seg-btn {
    padding: 7px 14px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    background: none;
    border: none;
    color: var(--sub);
    transition: background 0.15s, color 0.15s;
    white-space: nowrap;
  }

  .seg-btn + .seg-btn {
    border-left: 1px solid var(--card-brd);
  }

  .seg-btn:hover {
    color: var(--txt);
    background: rgba(255, 255, 255, 0.04);
  }

  .seg-btn.seg-active {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    font-weight: 600;
  }

  /* ── AI tab ── */
  /* Themed chevron + room for it. The .field-input shorthand sets background-color
     only (rgba above), so this background-image survives and replaces the white OS
     dropdown arrow. */
  select.field-input {
    appearance: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    cursor: pointer;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none'><path d='M1 1.5L6 6.5L11 1.5' stroke='%238b95a7' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>");
    background-repeat: no-repeat;
    background-position: right 12px center;
    padding-right: 34px;
  }

  select.field-input option {
    background: #11151d;
    color: var(--txt);
  }

  /* Clickable token-usage card — opens the cost breakdown modal. */
  .usage-card-btn {
    display: block;
    width: 100%;
    text-align: left;
    cursor: pointer;
    font: inherit;
    color: inherit;
    transition: border-color 0.15s;
  }
  .usage-card-btn:hover {
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  }
  .usage-card-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .usage-breakdown-link {
    font-size: 12px;
    font-weight: 500;
    color: var(--accent);
  }

  .ai-usage-grid {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }

  .ai-usage-stat {
    flex: 1;
    min-width: 110px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 14px 16px;
    border: 1px solid var(--card-brd);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.025);
  }

  .ai-usage-num {
    font-size: 22px;
    font-weight: 700;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }

  .ai-usage-lbl {
    font-size: 11px;
    color: var(--sub);
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-weight: 600;
  }

  .mcp-row {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 16px;
    border: 1px solid var(--card-brd);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.025);
  }

  .mcp-row + .mcp-row {
    margin-top: 4px;
  }

  .mcp-row-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .mcp-row-foot .btn {
    flex: 0 0 auto;
    padding: 7px 14px;
  }

  .audit-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .audit-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 14px;
    border: 1px solid var(--card-brd);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.025);
  }

  .audit-main {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .audit-tool {
    font-size: 13px;
    font-weight: 600;
    font-family: ui-monospace, 'Cascadia Code', monospace;
  }

  .audit-ts {
    font-size: 12px;
    color: var(--sub);
  }

  .audit-row .btn {
    flex: 0 0 auto;
    padding: 7px 12px;
  }

  /* ── Invite old-invite toggle ── */
  .invite-old-toggle {
    background: none;
    border: none;
    color: var(--sub);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    padding: 4px 0;
    text-decoration: underline;
    text-decoration-color: transparent;
    transition: color 0.15s, text-decoration-color 0.15s;
    align-self: flex-start;
  }
  .invite-old-toggle:hover {
    color: var(--accent);
    text-decoration-color: color-mix(in srgb, var(--accent) 50%, transparent);
  }
  .invite-list-old {
    opacity: 0.65;
  }

  /* ── Redesigned user cards ── */
  .user-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 14px;
    border: 1px solid var(--card-brd);
    border-radius: 12px;
    background: var(--card);
    transition: opacity 0.2s;
  }
  .user-card.disabled { opacity: 0.5; }

  .user-card-top {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .user-identity {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex-wrap: wrap;
  }

  .user-name {
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
  }

  .role-pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 9px;
    border-radius: 99px;
    font-size: 11px;
    font-weight: 600;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    white-space: nowrap;
  }

  .user-usage {
    display: flex;
    align-items: center;
    gap: 7px;
    flex-shrink: 0;
  }

  .usage-mini-bar {
    width: 60px;
    height: 5px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    overflow: hidden;
    flex-shrink: 0;
  }

  .usage-mini-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 999px;
    transition: width 0.25s;
  }

  .usage-text-sm {
    font-size: 11px;
    color: var(--sub);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .user-card-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .user-role-select {
    padding: 5px 30px 5px 9px;
    border: 1px solid var(--card-brd);
    border-radius: 8px;
    background-color: rgba(255, 255, 255, 0.03);
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none'><path d='M1 1.5L6 6.5L11 1.5' stroke='%238b95a7' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>");
    background-repeat: no-repeat;
    background-position: right 8px center;
    appearance: none;
    -webkit-appearance: none;
    color: var(--txt);
    font-size: 12px;
    cursor: pointer;
    min-width: 100px;
  }

  .user-role-select option {
    background: #11151d;
    color: var(--txt);
  }

  .user-cap-input {
    width: 120px;
    padding: 5px 9px;
    border: 1px solid var(--card-brd);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.03);
    color: var(--txt);
    font-size: 12px;
  }

  .user-card-acts {
    display: flex;
    gap: 6px;
    margin-left: auto;
  }

  .app-hint {
    font-size: 12px;
    color: var(--sub);
    margin: 0 0 4px;
  }

  .admin-contact {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: var(--sub);
    margin-top: 12px;
  }

  .btn-sm {
    padding: 5px 12px !important;
    font-size: 12px !important;
  }

  /* Sessions inline panel */
  .sessions-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.025);
    border: 1px solid var(--card-brd);
    border-radius: 10px;
  }

  .session-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }

  .session-meta {
    font-size: 12px;
    color: var(--sub);
    flex: 1;
    min-width: 0;
  }

  .session-empty {
    font-size: 12px;
    color: var(--sub);
  }

  @media (max-width: 768px) {
    .user-card-foot {
      flex-direction: column;
      align-items: stretch;
    }
    .user-role-select,
    .user-cap-input { width: 100%; }
    .user-card-acts { margin-left: 0; }
  }

  /* Role request-quota block (movie/TV per week). */
  .quota {
    border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
    border-radius: 8px;
    padding: 10px 12px;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .quota legend {
    font-size: 12px;
    font-weight: 600;
    padding: 0 6px;
  }
  .quota-help {
    font-size: 12px;
    color: var(--sub);
    margin: 0;
  }
  .quota-hint {
    font-size: 11px;
    color: var(--sub);
    margin-left: 6px;
  }

  .settings-about-footer {
    text-align: center;
    padding: 1.25rem 0 0.25rem;
  }

  .settings-about-link {
    font-size: 0.8125rem;
    color: var(--sub);
    text-decoration: none;
    opacity: 0.7;
    transition: opacity 0.15s;
  }

  .settings-about-link:hover {
    opacity: 1;
    color: var(--accent);
    text-decoration: underline;
  }

</style>
