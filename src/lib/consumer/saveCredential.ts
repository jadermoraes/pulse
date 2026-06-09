// Persist the just-used login to the browser's credential store so it can autofill
// the SAME username/password on Jellyfin and Seerr later (one password for all three).
//
// Uses the Credential Management API, which is Chromium-only — every call is
// feature-detected and wrapped in try/catch so it degrades silently on Firefox/Safari.
// Call this BEFORE navigating away so the browser registers the credential.
export async function saveCredential(
  id: string,
  password: string,
  name?: string
): Promise<void> {
  try {
    const w = window as unknown as {
      PasswordCredential?: new (data: { id: string; password: string; name?: string }) => Credential;
    };
    if (w.PasswordCredential && navigator.credentials?.store) {
      const cred = new w.PasswordCredential({ id, password, name: name ?? id });
      await navigator.credentials.store(cred);
    }
  } catch {
    /* ignore — not supported or user declined */
  }
}
