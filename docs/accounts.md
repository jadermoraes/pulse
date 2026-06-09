# Accounts & roles — operator guide

This guide covers running the Pulse **consumer app**: defining roles, inviting people,
what gets provisioned downstream, and how monthly caps + usage work. For the feature
overview, see the [README](../README.md#accounts--roles).

> Two audiences, fully separated. The **admin cockpit** (dashboard, settings, agent) lives
> behind the `pulse_session` cookie; the **consumer app** at `/app` lives behind the
> `pulse_app` cookie. They have **disjoint route guards** — a consumer can never reach the
> cockpit, and an admin session does not grant consumer access. Login and invite-accept are
> rate-limited, and a role with an empty allow-list can do nothing (least privilege).

---

## Roles

Manage roles in **Settings → Users & Roles**. A role bundles:

- **Allow-list** — any subset of the five capabilities:
  | Capability | Unlocks |
  | --- | --- |
  | `discover` | Browse / search / recommend media. |
  | `request` | Submit a media request (the seerr write). |
  | `status` | See "what's happening / what's wrong for me" (events, now-playing). |
  | `watchlist` | Watchlist tools (wired with the consumer bot/PWA slices). |
  | `message_admin` | Reach the admin from the app (wired with the consumer slices). |
- **Monthly token cap** — `null` = unlimited; otherwise the month-to-date AI token budget.
- **Auto-approve** — when on, a `request` is submitted without a confirmation step; when off,
  it lands as a **seerr-pending** request for approval.
- **seerr quota** — optional per-period movie / TV request limits applied on the seerr user.

The built-in **Admin** role is **immutable** (you can't edit or delete it, and you can't
invite anyone *into* it). A good starting consumer role is a **"Member"**:
`['discover', 'request', 'status']`, a sane monthly cap, auto-approve off, a small seerr
quota.

**Per-user overrides.** From the user list you can override a single user's **cap** or
**allow-list** without changing their role; `null` falls back to the role value.

---

## Invites

From **Settings → Users & Roles**, generate a **role-bound invite** → you get a link of the
form `/app/join/<token>`. Invites are:

- **Single-use** — burned the moment an onboarding **succeeds**.
- **Expiring** — default 7 days.
- **Role-bound** — acceptance can never escalate the role the invite was minted for.

The invite list shows **pending / accepted / expired** state. Send the link to the person;
they open it, choose a **Jellyfin username + password**, and Pulse does the rest.

---

## What gets provisioned

When someone completes onboarding, `provisionConsumer` runs an **ordered, idempotent**
sequence against your configured connections (it needs an **enabled Jellyfin** and an
**enabled seerr** connection — add them in **Settings → Connections** first):

1. **Jellyfin** — `ensureJellyfinUser` creates (or reuses) the user with the chosen password,
   grants a baseline library policy (all folders, **not** admin).
2. **seerr** — `ensureSeerrUserFromJellyfin` imports that Jellyfin user into seerr, then
   applies the role's **permissions** (derived from the allow-list + auto-approve) and
   **quota**.

> **seerr permission bits (this jellyseerr fork).** Verified live against the fork's
> `permissions.js`, these differ from stock Overseerr: `REQUEST=32` (not 2 — **2 is ADMIN**),
> `AUTO_APPROVE=128`. A consumer's allow-list `request` maps to `32`, plus `128` when
> auto-approve is on (so `160`). A normal consumer **never** receives the ADMIN bit.
> **Quota** does *not* apply via `PUT /api/v1/user/{id}` — it is sent separately to
> `POST /api/v1/user/{id}/settings/main` (`{ movieQuotaLimit, movieQuotaDays, tvQuotaLimit,
> tvQuotaDays, username, email }`) and only takes effect for users without `MANAGE_USERS`
> (i.e. consumers). No quota set → that call is skipped.

**Idempotent + retryable.** Re-running an invite is safe — existing users are reused, not
duplicated. If a step **fails**, Pulse **rolls back** the freshly created Jellyfin user and
leaves the consumer record removed **and the invite reusable**, because the invite is only
marked accepted **after** provisioning succeeds. A provider being down therefore just means
"try the same link again".

> **Live-verify the provider endpoints.** The Jellyfin/seerr endpoint constants in
> `src/lib/server/provisioning/jellyfin.ts` and `seerr.ts` are version-sensitive. Before
> relying on provisioning in production, verify them against your live servers (see the
> "VERIFY" steps in the provisioning tasks): the Jellyfin `Users` / `Users/New` /
> `Users/{id}/Policy` shapes and the seerr `import-from-jellyfin` + `user/{id}` permission /
> quota fields.

---

## Caps & usage

A role's **monthly token cap** meters only the **AI-consuming** turns:

- **At/over the cap**, AI **write** turns (e.g. an agent-driven request) are **blocked** with
  a `cap` reason — but cheap **reads** (discover/search, status, the My Account view) keep
  working, so nobody is locked out of browsing.
- The counter is **month-to-date** and **resets on the 1st of the month (UTC)**.
- **My Account** (`/app`) shows a usage bar plus **"resets in N days"** copy; an unlimited
  role (`cap = null`) shows the raw month-to-date total instead.

Need to give one person more headroom? Set a **cap override** on that user — no new role
required.

---

## Jellyfin-login model

Consumers log in at `/app/login` with their **Jellyfin** username + password. Pulse
**re-validates every login** against Jellyfin (`AuthenticateByName`) and **stores no consumer
password** — it only keeps the mapping from the Jellyfin user id to the Pulse consumer (plus
the seerr id). Disabling a user in **Settings → Users & Roles** immediately blocks their
login and invalidates their session.

---

## Plex & WatchState (B.2 — shipped, optional + additive)

A purely additive slice layers an optional **Plex** link and a **WatchState** cross-server map
**on top of** the solid Jellyfin+seerr core. **Nothing changes when Plex/WatchState aren't
configured** — the B.1 onboarding completes exactly as before.

**Plex OAuth PIN link.** Both the onboarding wizard (a skippable **"Link Plex (optional)"**
button) and **My Account** (a **"Link Plex"** button → **"Plex linked"** badge once done) run
the standard Plex PIN flow:

1. `createPlexPin(clientId)` → `POST https://plex.tv/api/v2/pins` returns `{ id, code }`; Pulse
   builds the `https://app.plex.tv/auth#?clientID=…&code=…` URL and opens it in a popup. The
   `clientId` is a stable per-instance id persisted in settings (`plex_client_id`).
2. The browser **polls** until the user authorizes; `pollPlexPin(id, clientId)` → `GET
   https://plex.tv/api/v2/pins/{id}` eventually returns the **authToken**.
3. `plexAccountFromToken(token)` → `GET https://plex.tv/api/v2/user` resolves the Plex
   `{ id, email }`; Pulse stores `plexAccountId` on the consumer.
4. **Library share (the "Wizarr trick").** Requires an **admin Plex connection** (Settings →
   Connections → **Plex**: the owner's Server URL + `X-Plex-Token`). When that connection
   exists, provisioning resolves the owner's `machineIdentifier` (`GET /identity`), enumerates
   **all** library sections (`GET /library/sections`), and calls
   `sharePlexLibraries(ownerToken, machineId, sectionIds, email)` →
   `POST https://plex.tv/api/servers/{machineId}/shared_servers` (the **legacy v1** endpoint,
   authed with the owner token; payload `{ server_id, shared_server: { library_section_ids,
   invited_email }, sharing_settings }`). **No Plex connection → the share is skipped** and the
   account still links. The share is **best-effort**: a failure surfaces as a warning and never
   rolls back the core or 502s.

**WatchState cross-server map — manual for now.** `mapWatchStateUser` is a **documented no-op**:
it logs and returns without calling WatchState. The previously-attempted
`POST /api/v1/users/map` does not exist on WatchState 1.8.5, and real cross-backend mapping is a
**batch** `/v1/api/identities/provision` operation (not per-user) requiring a `WS_API_KEY` that
isn't configured. So **cross-server play-state mapping remains a manual operator step** — and
onboarding is never affected by it.

**Best-effort — degrades, never rolls back.** The Plex/WatchState step runs **after** the
consumer is already marked **active** with their working Jellyfin+seerr accounts. If Plex or
WatchState fails, `provisionConsumer` returns a **warning** but leaves the consumer **active**
— the core is never rolled back and never 502s. The operator (or the user, via My Account) can
**retry the link** later.

> **Plex/WatchState endpoint notes.** The Plex PIN-link constants
> (`src/lib/server/provisioning/plex.ts`, `plex-account.ts`) — `https://plex.tv/api/v2/pins`
> create/poll, the `X-Plex-Client-Identifier` / `X-Plex-Product` headers, the
> `https://app.plex.tv/auth#?` URL, and the `https://plex.tv/api/v2/user` response — are still
> version-sensitive. The **library share** is now pinned to the **legacy v1**
> `POST /api/servers/{machineId}/shared_servers` shape, verified against python-plexapi
> `inviteFriend`. **WatchState** is intentionally a no-op (see above); there is no per-user
> endpoint to verify.

---

## Testing note

The accounts flow — including B.2 Plex/WatchState — is covered end-to-end with the provider
boundary mocked: set `PULSE_PROVISION_FAKE=1` (alongside `PULSE_AGENT_FAKE=1` /
`PULSE_DISABLE_POLLER=1`) to run onboarding, provisioning, federated login, **and the Plex
link** against deterministic fakes — no live Jellyfin/seerr/Plex/WatchState/LLM. Under the fake,
`createPlexPin` returns `{ id: 1, code: 'FAKE', authUrl }`, `pollPlexPin` returns
`'plex-fake-tok'`, `plexAccountFromToken` returns `{ id: 'px-fake', email: 'x@y' }`,
`sharePlexLibraries`/`mapWatchStateUser` resolve as no-ops. See `e2e/accounts.spec.ts`,
`e2e/plex-link.spec.ts`, and `playwright.config.ts`.
