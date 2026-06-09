import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { DB } from '../db';
import { getSetting, setSetting } from '../settings';
import { decryptSecret } from '../crypto';
import {
  createAiConnection, getAiConnection, type AiConnection
} from './ai-connections';

export type AiProvider = 'anthropic' | 'openai' | 'google' | 'openai-compatible';

const KEY = 'ai_config';

/**
 * The new reference shape stored in the `ai_config` setting. No keys live here —
 * the key lives only in `ai_connections.secret`. Any field may be null when unconfigured.
 */
export interface AiRefs {
  adminConnectionId: number | null;
  adminModel: string | null;
  adminTemperature?: number;
  consumerConnectionId: number | null;
  consumerModel: string | null;
  consumerTemperature?: number;
}

/** OLD inlined-key shape (pre-connections). Used only to detect + migrate legacy config. */
interface LegacyStoredConfig {
  provider?: AiProvider;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  apiKeyEnc?: string | null;
  consumerProvider?: AiProvider;
  consumerModel?: string;
  consumerApiKeyEnc?: string | null;
}

function emptyRefs(): AiRefs {
  return {
    adminConnectionId: null, adminModel: null,
    consumerConnectionId: null, consumerModel: null
  };
}

/** Is this parsed JSON the new reference shape (vs the legacy inlined-key shape)? */
function isRefShape(p: any): p is AiRefs {
  return p && (
    'adminConnectionId' in p || 'consumerConnectionId' in p
  ) && !('apiKeyEnc' in p) && !('provider' in p);
}

/** Is this parsed JSON the legacy shape that still needs migrating? */
function isLegacyShape(p: any): p is LegacyStoredConfig {
  return p && ('provider' in p || 'apiKeyEnc' in p || 'consumerProvider' in p || 'consumerApiKeyEnc' in p);
}

/**
 * One-time, idempotent migration from the legacy inlined-key `ai_config` to the
 * reference shape backed by `ai_connections`. Creates a connection from the old
 * admin provider+key (label "Default"); if a distinct consumer provider/key existed,
 * creates a second connection (or reuses the admin one when identical). Then rewrites
 * `ai_config` to the reference shape. Returns the resulting refs.
 */
function migrateLegacy(db: DB, legacy: LegacyStoredConfig): AiRefs {
  const refs = emptyRefs();

  // Admin connection from the legacy provider/key (if any provider was set).
  if (legacy.provider) {
    const adminKey = legacy.apiKeyEnc ? decryptSecret(legacy.apiKeyEnc) : null;
    const adminId = createAiConnection(db, {
      label: 'Default',
      provider: legacy.provider,
      baseUrl: legacy.baseUrl ?? null,
      apiKey: adminKey
    });
    refs.adminConnectionId = adminId;
    refs.adminModel = legacy.model ?? null;
    refs.adminTemperature = legacy.temperature;
  }

  // Consumer connection from the legacy consumer provider/key (if any).
  if (legacy.consumerProvider && legacy.consumerModel) {
    const consumerKey = legacy.consumerApiKeyEnc ? decryptSecret(legacy.consumerApiKeyEnc) : null;
    const adminKey = legacy.apiKeyEnc ? decryptSecret(legacy.apiKeyEnc) : null;
    // Reuse the admin connection when provider + key match (same credentials).
    const sameAsAdmin = refs.adminConnectionId != null
      && legacy.consumerProvider === legacy.provider
      && consumerKey === adminKey;
    if (sameAsAdmin) {
      refs.consumerConnectionId = refs.adminConnectionId;
    } else {
      refs.consumerConnectionId = createAiConnection(db, {
        label: 'Consumer',
        provider: legacy.consumerProvider,
        baseUrl: legacy.baseUrl ?? null,
        apiKey: consumerKey
      });
    }
    refs.consumerModel = legacy.consumerModel;
  }

  setSetting(db, KEY, JSON.stringify(refs));
  return refs;
}

/**
 * Load the AI reference config, migrating legacy inlined-key config on first read.
 * Returns empty (all-null) refs cleanly when nothing is configured.
 */
export function loadAiRefs(db: DB): AiRefs {
  const raw = getSetting(db, KEY);
  if (!raw) return emptyRefs();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return emptyRefs(); }
  if (isRefShape(parsed)) {
    return { ...emptyRefs(), ...(parsed as AiRefs) };
  }
  if (isLegacyShape(parsed)) {
    return migrateLegacy(db, parsed as LegacyStoredConfig);
  }
  return emptyRefs();
}

/** Persist the reference shape (overwrites the whole record; no keys stored here). */
export function saveAiRefs(db: DB, refs: AiRefs): void {
  setSetting(db, KEY, JSON.stringify(refs));
}

/** Build a configured AI-SDK language model from an `ai_connections` row + a model id. */
export function modelFromConnection(conn: AiConnection | null, model: string | null): LanguageModel | null {
  if (!conn || !model) return null;
  const apiKey = conn.secret ?? '';
  switch (conn.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(model);
    case 'openai':
      return createOpenAI({ apiKey })(model);
    case 'google':
      // Gemini via its OpenAI-compatible endpoint (avoids an extra dependency).
      return createOpenAICompatible({
        name: 'google',
        apiKey,
        baseURL: conn.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta/openai'
      })(model);
    case 'openai-compatible':
      // Ollama / LM Studio / OpenRouter — key optional.
      return createOpenAICompatible({
        name: 'compat',
        apiKey: apiKey || 'not-needed',
        baseURL: conn.baseUrl ?? ''
      })(model);
    default:
      return null;
  }
}

/** Resolve the admin LanguageModel (admin ref → connection → model), or null if unconfigured. */
export function getModel(db: DB): LanguageModel | null {
  const refs = loadAiRefs(db);
  if (refs.adminConnectionId == null) return null;
  const conn = getAiConnection(db, refs.adminConnectionId);
  return modelFromConnection(conn, refs.adminModel);
}

export function getConfigTemperature(db: DB): number | undefined {
  return loadAiRefs(db).adminTemperature;
}

/**
 * Resolve the consumer LanguageModel. Falls back to the admin model when no consumer
 * ref is set (preserves prior behavior).
 */
export function getConsumerModel(db: DB): LanguageModel | null {
  const refs = loadAiRefs(db);
  if (refs.consumerConnectionId != null && refs.consumerModel) {
    const conn = getAiConnection(db, refs.consumerConnectionId);
    return modelFromConnection(conn, refs.consumerModel);
  }
  return getModel(db); // fall back to the admin brain
}

export function getConsumerTemperature(db: DB): number | undefined {
  return loadAiRefs(db).consumerTemperature;
}
