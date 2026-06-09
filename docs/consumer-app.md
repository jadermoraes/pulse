# Consumer App (PWA) — operator + viewer guide

This guide covers the Pulse **consumer app** at `/app`: what an invited viewer can do, the
token plans, configuring the separate consumer AI model, setting up web push (with the iOS
caveat), and how requests are attributed to each viewer's own seerr identity. For the feature
overview see the [README](../README.md#consumer-app-pwa); for roles, invites, and downstream
provisioning see the [accounts guide](accounts.md).

> **Two audiences, fully separated.** The **admin cockpit** lives behind the `pulse_session`
> cookie; the **consumer app** at `/app` lives behind the `pulse_app` cookie, with disjoint
> route guards. A viewer can never reach the cockpit, and the consumer chat is built from a
> **filtered toolset** that never exposes admin tools (container restart, etc.) — only the
> read/request tools the viewer's role allow-list permits.

---

## What a viewer can do

A viewer signs in with their **Jellyfin** username + password (the same account provisioned at
onboarding — Pulse stores no consumer password). The app is mobile-first and in their language
(EN / pt-BR), and it is **installable** (see [Install + push](#install--push)).

- **Home (`/app`)** — a hybrid landing page that blends:
  - an **ask-bar** that drops them straight into the scoped AI chat;
  - a **request strip** showing their live requests + current status;
  - **discover rows** — *Continue watching*, *New on the server* (Jellyfin/Plex recently-added),
    and *Hot right now* (seerr trending). On-server titles show **▶ Watch** (a deep-link into
    Jellyfin/Plex); missing titles show **+ Request**.
- **Discover (`/app/discover`)** — full browse + search across the server and seerr; tapping a
  title opens a detail sheet to watch or request.
- **Requests (`/app/requests`)** — the status list for everything they've requested
  (*pending → approved → processing → available*, or *declined*).
- **Chat (`/app/chat`)** — the scoped AI assistant (see [The consumer chat](#the-consumer-chat)).
- **Account (`/app/account`)** — their plan + usage ("~N chats left"), language, optional Plex
  link, the **Enable notifications** toggle, and log out.

---

## How requests are attributed to the viewer

When a viewer taps **+ Request**, Pulse creates the request in **seerr under that viewer's own
seerr user** — the `seerrUserId` provisioned during onboarding — applying the role's
**auto-approve** flag and **seerr quota**. The request therefore appears in seerr as *their*
request, not a shared admin one.

Pulse also stores a local **tracked request** (`consumer_requests`) keyed to the viewer and the
seerr request id. The session-scoped endpoints (`POST /api/app/request`, `GET /api/app/requests`)
are **self-scoped** — a viewer only ever sees and creates their own requests (a body
`consumerId` is ignored; there is no IDOR).

**Ready detection + one-shot push.** The existing event poller already watches seerr for
requests that flip to **Available**. When one matches a tracked request, Pulse marks that row
`available` and — **exactly once** (`notified` flag) — sends the viewer a "ready to watch" web
push that deep-links to `/app/requests`. No new poller is added; this rides the events pipeline.

---

## The consumer chat

The chat reuses the agent core, but consumer-scoped:

- **Filtered tools.** The toolset is filtered through the role's capability allow-list
  (`discover` / `request` / `status` / …). Admin/system tools (e.g. `listContainers`,
  `restartContainer`) are **never** offered to a consumer turn. Write tools still pass the same
  policy checks as the cockpit.
- **Separate consumer model.** Consumer chat uses its **own** model + provider + API key,
  configured in **Settings → AI** (see below) — so you can run a cheaper model for viewers than
  for the admin agent. If no consumer model is set, the chat reports it is unavailable rather
  than falling through to the admin model's billing.
- **Metering + cap.** Every turn meters its token usage against the viewer's **monthly cap**
  (`addUsage`). The cap is checked at the **start** of each turn: at/over cap the chat returns a
  `blocked: 'cap'` message ("you've reached your chat limit … you can still browse and request")
  and the input is disabled — **but discover, search, and requests keep working**, because they
  never touch the LLM. Caps reset on the **1st of the month (UTC)**.

---

## Token plans

Roles carry a **named token plan** rather than a bare number. Pick one in **Settings → Users &
Roles** when editing a role:

| Plan | Monthly token cap |
| --- | --- |
| **Light** | 250,000 |
| **Regular** | 1,000,000 |
| **Power** | 5,000,000 |
| **Unlimited** | no cap |
| **Custom** | any number you type |

The plan name maps to the role's monthly cap. On **My Account** a viewer sees their plan plus a
friendly "**~N chats left**, resets in N days" line. That figure is an **estimate**: it divides
the remaining budget by an average tokens-per-chat constant (`AVG_TOKENS_PER_CHAT`, recalibrated
post-launch), so it is guidance, not an exact quota.

---

## Configuring the consumer model (Settings → AI)

In **Settings → AI** the **consumer model** selector is separate from the admin agent model:

1. Choose the **provider** and **model** for consumer chat.
2. Enter the provider **API key**. It is stored **encrypted at rest** (the same `v1:` envelope
   used for all secrets) and is **never sent to the client**.
3. Save. New consumer chat turns use this model immediately.

If the consumer model is left unset, consumer chat is unavailable (it does not silently fall
back to the admin model).

---

## Install + push

`/app` ships a **web app manifest + service worker**, so the app is installable to a phone's
home screen and can receive **web-push** notifications.

**VAPID keys.** On first use Pulse generates a **VAPID** keypair and persists it: the public key
in plain settings, the **private key encrypted at rest**. Push payloads carry **no secrets** —
just a title, body, and a relative `url`. Endpoints that 404/410 are pruned automatically.

**Enabling push.** A viewer enables notifications from the **onboarding tour** or from **My
Account** ("Enable notifications"), which registers a push subscription for their device. The
ready-to-watch push is then delivered when their request becomes available.

> ### iOS caveat — add to Home Screen **first**
> iPhone and iPad only deliver web push to a site that has been **added to the Home Screen** as
> a PWA. A viewer on iOS must first use Safari's **Share → Add to Home Screen**, open Pulse from
> that home-screen icon, and **then** enable notifications. The onboarding tour and My Account
> both surface this notice. On Android/desktop, enabling notifications from the browser is
> enough.

---

## Configuration

The consumer app needs **no new environment variables**. Everything it relies on is configured
in-app and stored in the database:

- the **consumer model** provider/model/API key — **Settings → AI** (API key encrypted);
- the **VAPID** keypair — generated and stored automatically on first push use (private key
  encrypted);
- per-role **token plans**, **allow-lists**, **auto-approve**, and **seerr quota** — **Settings
  → Users & Roles**.

The standard `PULSE_SECRET_KEY` (see the [README](../README.md#environment-variables)) is the
master key that protects the encrypted consumer API key and VAPID private key — set it in
production for a stable key across restarts.
