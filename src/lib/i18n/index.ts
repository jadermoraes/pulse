import { addMessages, init, locale, getLocaleFromNavigator } from 'svelte-i18n';
import en from './en.json';
import ptBR from './pt-BR.json';

export const SUPPORTED_LOCALES = ['en', 'pt-BR'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'pulse_locale';

let registered = false;

/** Register both dictionaries exactly once. Safe to call on both server and client. */
function registerMessages(): void {
  if (registered) return;
  addMessages('en', en);
  addMessages('pt-BR', ptBR);
  registered = true;
}

/** Normalise an arbitrary string into a supported locale, falling back to `en`. */
export function normaliseLocale(value: string | null | undefined): Locale {
  if (!value) return DEFAULT_LOCALE;
  if ((SUPPORTED_LOCALES as readonly string[]).includes(value)) return value as Locale;
  // Accept e.g. "pt", "pt_BR" → "pt-BR"
  const lower = value.toLowerCase();
  if (lower.startsWith('pt')) return 'pt-BR';
  if (lower.startsWith('en')) return 'en';
  return DEFAULT_LOCALE;
}

/**
 * Initialise svelte-i18n. Called from the root layout with the locale resolved
 * server-side from the cookie, so SSR renders the correct language (no flash).
 */
export function setupI18n(initialLocale?: string): void {
  registerMessages();
  init({
    fallbackLocale: DEFAULT_LOCALE,
    initialLocale: normaliseLocale(
      initialLocale ?? (typeof window !== 'undefined' ? getLocaleFromNavigator() : DEFAULT_LOCALE)
    )
  });
}

/**
 * Switch the active locale at runtime (client-only). Persists the choice to the
 * `pulse_locale` cookie so the next SSR render uses the same language (no flash).
 */
export function setLocale(value: string): void {
  const next = normaliseLocale(value);
  locale.set(next);
  if (typeof document !== 'undefined') {
    // 1 year, root path, Lax — readable during SSR on the next request.
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  }
}
