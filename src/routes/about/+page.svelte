<svelte:head>
  <title>About · Pulse</title>
</svelte:head>

<div class="about-wrap">
  <div class="about-card">
    <div class="about-logo">
      <!-- Pulse waveform mark (matches the favicon/brand) -->
      <svg class="about-logo-mark" viewBox="0 0 60 24" fill="none" stroke="#fff" stroke-width="2.5"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2 12h10l4-9 6 18 4-9h6l3 5 4-5h9" />
      </svg>
    </div>

    <h1 class="about-title">Pulse</h1>
    <span class="about-version">v0.0.1</span>

    <p class="about-blurb">
      A self-hosted homelab dashboard with an embedded AI assistant
      and an invite-only consumer PWA.
    </p>

    <div class="about-features">
      <span>AI assistant</span>
      <span>Media stack</span>
      <span>Consumer PWA</span>
    </div>

    <hr class="about-divider" />

    <a
      href="https://github.com/jadermoraes"
      target="_blank"
      rel="noopener noreferrer"
      class="about-gh"
    >
      <svg class="about-gh-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
        />
      </svg>
      <span>github.com/jadermoraes</span>
    </a>

    <p class="about-stack">SvelteKit · better-sqlite3 · self-hosted</p>

    <div class="about-back">
      <a href="/" class="about-back-link">← Dashboard</a>
      <a href="/settings" class="about-back-link">Settings</a>
    </div>
  </div>
</div>

<style>
  .about-wrap {
    min-height: 70vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem 1rem;
  }

  .about-card {
    position: relative;
    background: var(--card-bg, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.1));
    border-radius: 20px;
    padding: 2.75rem 2.25rem 2rem;
    text-align: center;
    max-width: 440px;
    width: 100%;
    overflow: hidden;
  }

  /* Subtle accent glow at the top of the card */
  .about-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 60%;
    height: 3px;
    background: linear-gradient(90deg, transparent, var(--accent, #28e0a0), var(--accent2, #36c6ff), transparent);
    opacity: 0.8;
  }

  .about-logo {
    width: 72px;
    height: 72px;
    border-radius: 18px;
    background: linear-gradient(135deg, var(--accent, #28e0a0), var(--accent2, #36c6ff));
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 1.25rem;
    box-shadow: 0 8px 24px color-mix(in srgb, var(--accent, #28e0a0) 30%, transparent);
  }

  .about-logo-mark {
    width: 42px;
    height: auto;
  }

  .about-title {
    font-size: 1.9rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--txt, #fff);
    margin: 0 0 0.5rem;
  }

  .about-version {
    display: inline-block;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--sub, rgba(255, 255, 255, 0.6));
    background: color-mix(in srgb, var(--sub, #8b95a7) 14%, transparent);
    border-radius: 999px;
    padding: 0.15rem 0.6rem;
    margin-bottom: 1.1rem;
  }

  .about-blurb {
    font-size: 0.95rem;
    color: var(--sub, rgba(255, 255, 255, 0.7));
    line-height: 1.6;
    margin: 0 auto 1.25rem;
    max-width: 32ch;
  }

  .about-features {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.5rem;
  }

  .about-features span {
    font-size: 0.75rem;
    color: var(--txt, #e7ecf3);
    background: color-mix(in srgb, var(--accent, #28e0a0) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent, #28e0a0) 25%, transparent);
    border-radius: 999px;
    padding: 0.2rem 0.7rem;
  }

  .about-divider {
    border: none;
    border-top: 1px solid var(--card-brd, rgba(255, 255, 255, 0.1));
    margin: 1.5rem 0;
  }

  .about-gh {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--txt, #e7ecf3);
    text-decoration: none;
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.12));
    border-radius: 10px;
    padding: 0.5rem 0.9rem;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }

  .about-gh:hover {
    color: #fff;
    border-color: color-mix(in srgb, var(--accent, #28e0a0) 55%, transparent);
    background: color-mix(in srgb, var(--accent, #28e0a0) 8%, transparent);
  }

  .about-gh-icon {
    width: 18px;
    height: 18px;
    fill: currentColor;
    flex-shrink: 0;
  }

  .about-stack {
    font-size: 0.75rem;
    color: var(--sub, rgba(255, 255, 255, 0.45));
    margin: 1rem 0 0;
  }

  .about-back {
    display: flex;
    justify-content: center;
    gap: 1.5rem;
    margin-top: 1.5rem;
  }

  .about-back-link {
    font-size: 0.85rem;
    color: var(--sub, rgba(255, 255, 255, 0.6));
    text-decoration: none;
    transition: color 0.15s;
  }

  .about-back-link:hover {
    color: var(--accent, #28e0a0);
  }
</style>
