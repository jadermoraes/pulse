# AI setup — providers, MCP, and the safety model

This guide covers configuring the Pulse AI agent: choosing a provider (cloud or local),
adding external MCP tool servers, and the confirmation / audit / undo model that gates every
write. For the feature overview and example prompts, see the [README](../README.md).

> The agent is **admin-only** in v1. All provider keys and MCP credentials are **encrypted
> at rest** (via the app's `crypto.ts`) and are **never sent to the LLM** — the model only
> ever receives tool *results*, which are scrubbed of secret-looking fields.

---

## 1. Configure a provider (Settings → AI)

Open **Settings → AI**, choose a provider type, fill in the fields, and click **Validate &
Save**. Save runs a cheap one-token "ping" to confirm the key/endpoint works before storing
the config. If validation fails, fix the key/URL and retry.

### Cloud (bring-your-own-key)

| Provider | Type | Suggested model |
| --- | --- | --- |
| **Anthropic** | `anthropic` | `claude-3-5-haiku-latest` (cheap, strong tool-calling) |
| **OpenAI** | `openai` | `gpt-4o-mini` |
| **Google (Gemini)** | `google` | `gemini-1.5-flash` (via Gemini's OpenAI-compatible endpoint) |

Paste your provider API key into the **API key** field. It is encrypted before it touches
the database. Leaving the key blank on a later save keeps the previously-stored key.

### Local / self-hosted (OpenAI-compatible)

Choose type **`openai-compatible`** and set a **Base URL**. This covers any endpoint that
speaks the OpenAI API:

| Runtime | Base URL | Notes |
| --- | --- | --- |
| **Ollama** | `http://localhost:11434/v1` | No key needed (any placeholder works). Pull a tool-calling model, e.g. `ollama pull llama3.1`. |
| **LM Studio** | `http://localhost:1234/v1` | Start LM Studio's local server; pick a tool-capable model. |
| **OpenRouter** | `https://openrouter.ai/api/v1` | BYO OpenRouter key; pick any tool-calling model id. |

Pick a model that supports **tool / function calling** — the agent relies on it for every
read and write.

### No AI configured?

The Assistant degrades gracefully: it shows a **"Configure AI"** CTA and never crashes the
app. Provider errors (bad key, rate limit, timeout) surface as a clear chat error with retry.

---

## 2. Add an MCP server (Settings → AI → Tools)

External **MCP** (Model Context Protocol) servers extend the agent with tools beyond Pulse's
built-in integrations. On each agent run, Pulse connects to your enabled servers, discovers
their tools, and **merges them into the registry** under the **same policy + confirmation +
audit gate** (default `risk: write`).

Each server entry:

- **name** — a label; its tools are namespaced as `mcp__<server>__<tool>`.
- **transport** — `http` or `sse` (v1 supports remote transports, not local `stdio`).
- **url** — the server endpoint.
- **headers** *(optional)* — a JSON map for auth (e.g. `{ "Authorization": "Bearer …" }`).
  Stored **encrypted**.
- **enabled** — toggle without deleting.

A server that's unreachable **degrades gracefully**: its tools are skipped, a warning is
surfaced in the chat, and everything else keeps working.

### Useful MCP servers

- **Web search** — current info your model lacks (release dates, news).
- **Read-only filesystem on `/mnt/tank`** — "what are the biggest files on the NAS?"; powers
  the *"free up 50 GB safely"* flow **without** giving the LLM shell access.
- **Home Assistant** — bridge the homelab into home automation; HA *write* tools still pass
  the confirm gate.
- **TMDB / Trakt** — richer metadata + watchlists for requests and recommendations.

> **MCP servers are a trust surface.** They are admin-added only. Their tools run with the
> same write-confirmation + audit guarantees as built-in tools, and their credentials are
> encrypted at rest. Add only servers you trust.

---

## 3. The confirmation / audit / undo model

- **Reads run freely.** The agent calls read tools inline and streams results back.
- **Every write is confirmed.** A write tool call pauses the turn and shows a **Confirm /
  Cancel** card. The mutation runs **only** after you click Confirm — this gate is the
  **only** path by which a write reaches your services.
- **Everything is audited.** Confirmed and declined actions are recorded in **Activity**
  (who / when / tool / args / result / confirmed). Reads are not logged (noise).
- **Undo where possible.** Reversible actions (e.g. *stop → start*) store an undo token; the
  **Undo** button re-enters the same confirm + audit path.
- **Pending confirmations expire safely.** They're server-held with a TTL; if you navigate
  away, they expire **without** executing.

This model is the foundation for later sub-projects (roles/policy, external channels): the
`policy(ctx, tool, args)` hook and the `channel` abstraction already wrap every tool call and
transport, so per-role allow-lists, token caps, and Telegram/Discord channels slot in without
changing the agent loop.

---

## Related env vars

Provider keys and MCP creds are **in-app, encrypted** — not env vars. The relevant runtime
env vars are documented in the [README](../README.md#environment-variables); the most
agent-relevant:

- `PULSE_DISK_WARN`, `PULSE_EVENT_POLL_MS`, `PULSE_DISABLE_POLLER` — the event/notification
  poller the agent reads via `getEvents`.
- `PULSE_AGENT_FAKE=1` — **test-only** deterministic agent driver (no real provider). Used by
  the e2e suite.
