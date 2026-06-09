<script lang="ts">
  import { _ } from 'svelte-i18n';
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { enablePush, pushFailMessage } from '$lib/push-client';
  import { setLocale, normaliseLocale } from '$lib/i18n';
  import { saveCredential } from '$lib/consumer/saveCredential';
  import {
    validateOnboarding,
    validateUsername,
    validatePassword,
    validateDisplayName
  } from '$lib/consumer/validate';
  import { AVG_TOKENS_PER_CHAT } from '$lib/consumer/plan';
  import PosterWall from '$lib/components/app/PosterWall.svelte';
  import Wordmark from '$lib/components/app/Wordmark.svelte';
  import StoryChat from '$lib/components/app/StoryChat.svelte';

  let { data } = $props();

  const token = $derived(($page.params as Record<string, string>).token);
  let displayName = $state('');
  let username = $state('');
  let password = $state('');
  let language = $state('en');
  let posters = $state<string[]>([]);

  // Respect prefers-reduced-motion: disable auto-advance + use fades instead of slides.
  let reduceMotion = $state(false);

  onMount(async () => {
    reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // Default the language switch to the browser/cookie locale so the whole tour is localized.
    const cookieLang = document.cookie
      .split('; ')
      .find((c) => c.startsWith('pulse_locale='))
      ?.split('=')[1];
    language = normaliseLocale(cookieLang ?? navigator.language);
    setLocale(language);
    try {
      const res = await fetch('/api/app/showcase');
      if (res.ok) posters = (await res.json()).posters ?? [];
    } catch { /* gradient fallback */ }
    try { telegramAvailable = (await fetch('/api/app/telegram/available').then(r => r.json())).enabled; } catch { /* hidden */ }
  });

  function chooseLanguage(lang: string) {
    language = normaliseLocale(lang);
    setLocale(language); // applies immediately so the rest of the tour is in their language
  }

  // ── Plan beat (only when the role is capped) ──
  // Rough "chats a month" from the token cap; gentle, not technical. Unlimited ⇒ beat skipped.
  const hasCap = $derived(data.tokenCap != null);
  const planLabel = $derived(data.planName && data.planName !== 'Custom' ? data.planName : '');
  const chatsPerMonth = $derived(
    data.tokenCap != null ? Math.max(1, Math.round(data.tokenCap / AVG_TOKENS_PER_CHAT)) : 0
  );

  // ── Story beats ──
  // Each beat is { id }. The plan beat is conditionally included. The final beat advances to
  // the account form. Indices are derived so adding/removing the plan beat stays consistent.
  const beats = $derived([
    'welcome',
    'discover',
    'already',
    'request',
    'assistant',
    'notified',
    'watch',
    ...(hasCap ? ['plan'] : []),
    'allset'
  ]);

  let step = $state(0); // index into beats
  let phase = $state<'story' | 'form' | 'done'>('story');
  const beat = $derived(beats[step]);
  const total = $derived(beats.length);

  let autoTimer: ReturnType<typeof setTimeout> | null = null;
  // Comfortable ~7s dwell per beat so the viewer never feels rushed. The "Ask the assistant"
  // beat runs a multi-turn chat demo that takes longer, so it gets extra time to play out.
  const AUTO_MS = 7000;
  const AUTO_MS_ASSISTANT = 13000;

  // Pause auto-advance on any user interaction (tap/swipe/hover). Once paused, the story
  // becomes manual (Back/Next/Skip) — the user is clearly engaged and steering themselves.
  let paused = $state(false);

  function clearAuto() {
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  }

  function pauseAuto() {
    if (paused) return;
    paused = true;
    clearAuto();
  }

  // Auto-advance through the story unless reduced-motion is on, the user has interacted,
  // or we're on the last beat (which waits for the explicit "Create your account" tap).
  $effect(() => {
    clearAuto();
    if (phase !== 'story') return;
    if (reduceMotion) return;
    if (paused) return;
    if (step >= total - 1) return;
    const s = step; // capture
    const dwell = beats[s] === 'assistant' ? AUTO_MS_ASSISTANT : AUTO_MS;
    autoTimer = setTimeout(() => { if (step === s && !paused) next(); }, dwell);
    return clearAuto;
  });

  function next() {
    clearAuto();
    if (step < total - 1) step += 1;
    else startForm();
  }
  function back() {
    clearAuto();
    if (step > 0) step -= 1;
  }
  function skip() {
    clearAuto();
    startForm();
  }
  function startForm() {
    clearAuto();
    phase = 'form';
  }

  // ── Swipe / keyboard navigation on the story ──
  // Horizontal swipes flip beats; any touch/pointer/key interaction pauses auto-advance.
  let touchX = 0;
  let touchY = 0;
  function onTouchStart(e: TouchEvent) {
    pauseAuto();
    touchX = e.touches[0].clientX;
    touchY = e.touches[0].clientY;
  }
  function onTouchEnd(e: TouchEvent) {
    const dx = e.changedTouches[0].clientX - touchX;
    const dy = e.changedTouches[0].clientY - touchY;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) next();
      else back();
    }
  }
  function onKey(e: KeyboardEvent) {
    if (phase !== 'story') return;
    if (e.key === 'ArrowRight') { pauseAuto(); next(); }
    else if (e.key === 'ArrowLeft') { pauseAuto(); back(); }
  }

  // ── Account form + provisioning (unchanged logic) ──
  let busy = $state(false);
  let err = $state<string | null>(null);

  // B.2 optional Plex link — obtain the token during onboarding; provisioning links it best-effort.
  let plexToken = $state<string | null>(null);
  let plexBusy = $state(false);
  let plexErr = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const plexLinked = $derived(plexToken != null);

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function linkPlex() {
    plexErr = null;
    plexBusy = true;
    try {
      const res = await fetch('/api/app/plex/pin', { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      const pin = await res.json();
      window.open(pin.authUrl, 'plex-link', 'width=600,height=700');
      stopPolling();
      let tries = 0;
      pollTimer = setInterval(async () => {
        tries++;
        try {
          const p = await fetch(`/api/app/plex/pin?pinId=${pin.id}`);
          if (!p.ok) throw new Error(await p.text());
          const dataP = await p.json();
          if (dataP.token) {
            stopPolling();
            plexBusy = false;
            plexToken = dataP.token;
          }
        } catch (e) {
          stopPolling();
          plexBusy = false;
          plexErr = (e as Error).message || $_('app.plexLinkFailed');
        }
        if (tries > 60) { stopPolling(); plexBusy = false; }
      }, 3000);
    } catch (e) {
      plexBusy = false;
      plexErr = (e as Error).message || $_('app.plexLinkFailed');
    }
  }

  $effect(() => () => stopPolling());

  // D.3 optional notification-permission step shown after the account is created.
  let pushBusy = $state(false);
  let pushOn = $state(false);
  let pushMsg = $state<string | null>(null);
  async function turnOnNotifications() {
    pushBusy = true; pushMsg = null;
    try {
      const r = await enablePush();
      pushOn = r.ok;
      if (!r.ok) pushMsg = pushFailMessage(r.reason);
    } catch { pushOn = false; pushMsg = pushFailMessage('error'); }
    finally { pushBusy = false; }
  }

  // D.4 optional Telegram connect step — shown only when Telegram is enabled on the server.
  let telegramAvailable = $state(false);
  async function connectTelegram() {
    try {
      const r = await fetch('/api/app/telegram/link', { method: 'POST' }).then((x) => x.json());
      if (r.url) window.open(r.url, '_blank', 'noopener');
    } catch { /* ignore */ }
  }

  async function submit() {
    err = null;
    busy = true;
    try {
      const res = await fetch('/api/app/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, displayName, username, password, language, plexToken })
      });
      if (!res.ok) {
        err = (await res.json().catch(() => ({}))).message ?? $_('app.joinFailed');
        return;
      }
      // Offer to save the login so the browser can autofill it on Jellyfin/Seerr later
      // (Credential Management API — Chromium-only; degrade silently elsewhere).
      // Do this before showing the notifications step / navigating so the browser registers it.
      await saveCredential(username, password, displayName || username);
      phase = 'done'; // enable-notifications step, then continue to /app
    } catch (e) {
      err = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  // Real title cards for the "already here" / "request" beats (from the invite-gated loader).
  // `available` = genuinely on the server (▶ Watch now); `request` = trending, not yet here (+ Request).
  // Empty (seerr down / no invite) ⇒ gradient placeholders so the beat is never blank.
  const availableTitles = $derived(data.available ?? []);
  const requestTitles = $derived(data.request ?? []);

  // Account-form validation (mirrors the server's authoritative checks in $lib/consumer/validate).
  // Field errors only show once a field has been touched (blurred); the submit button stays
  // disabled until every field is valid.
  let touched = $state<{ displayName?: boolean; username?: boolean; password?: boolean }>({});
  const displayNameErr = $derived(touched.displayName ? validateDisplayName(displayName) : null);
  const usernameErr = $derived(touched.username ? validateUsername(username) : null);
  const passwordErr = $derived(touched.password ? validatePassword(password, username) : null);
  const formInvalid = $derived(validateOnboarding({ displayName, username, password }) != null);
</script>

<svelte:head><title>Join · Pulse</title></svelte:head>

<svelte:window onkeydown={onKey} />

<div class="ob-stage">
  <!-- Cinematic poster-wall backdrop present behind every beat (blurred/darkened by the
       component's own veil). On the "discover" beat it drifts a touch more prominently. -->
  <PosterWall {posters} drift={!reduceMotion} />
  <div class="ob-stage-veil" aria-hidden="true"></div>

  <!-- Language switch — present from beat 1 so the whole tour is in the viewer's language. -->
  {#if phase === 'story'}
    <div class="ob-lang">
      <select value={language} onchange={(e) => chooseLanguage((e.currentTarget as HTMLSelectElement).value)} aria-label={$_('app.chooseLanguage')}>
        <option value="en">English</option>
        <option value="pt-BR">Português</option>
      </select>
    </div>
  {/if}

  {#if phase === 'story'}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="ob-story"
      onpointerdown={pauseAuto}
      onmouseenter={pauseAuto}
      ontouchstart={onTouchStart}
      ontouchend={onTouchEnd}
    >
      <!-- progress dots -->
      <div class="ob-dots" role="tablist" aria-label="progress">
        {#each beats as b, i (b)}
          <span class="ob-dot" class:on={i === step} class:past={i < step}></span>
        {/each}
      </div>

      <div class="ob-beat-wrap">
        {#key step}
          <div class="ob-beat" class:fade={reduceMotion}>
            {#if beat === 'welcome'}
              <Wordmark size="lg" />
              <h2 class="ob-h ob-h-grad">{$_('ob.welcomeTitle')}</h2>
              <p class="ob-p">{$_('ob.welcomeSub')}</p>
            {:else if beat === 'discover'}
              <div class="ob-emoji">🍿</div>
              <h2 class="ob-h ob-h-grad">{$_('ob.discoverTitle')}</h2>
              <p class="ob-p">{$_('ob.discoverSub')}</p>
            {:else if beat === 'already'}
              <h2 class="ob-h ob-h-grad">{$_('ob.alreadyTitle')}</h2>
              <div class="ob-strip">
                <div class="ob-tiles" class:ph={!availableTitles.length}>
                  {#if availableTitles.length}
                    {#each availableTitles.slice(0, 8) as m, i (m.title + i)}
                      <div class="ob-mtile">
                        <div class="ob-mtile-art">
                          <img src={m.poster} alt={m.title} loading="lazy" />
                          <span class="ob-badge ob-badge-watch">{$_('ob.watchNow')}</span>
                        </div>
                        <div class="ob-mtile-meta">
                          <span class="ob-mtile-title">{m.title}</span>
                          {#if m.year}<span class="ob-mtile-sub">{m.year}{#if m.rating} · ★ {m.rating}{/if}</span>{/if}
                        </div>
                      </div>
                    {/each}
                  {:else}
                    {#each [0, 1, 2] as i (i)}
                      <div class="ob-mtile">
                        <div class="ob-mtile-art"><div class="ob-ph a{(i % 8) + 1}"></div>
                          <span class="ob-badge ob-badge-watch">{$_('ob.watchNow')}</span></div>
                      </div>
                    {/each}
                  {/if}
                </div>
              </div>
              <p class="ob-p">{$_('ob.alreadySub')}</p>
            {:else if beat === 'request'}
              <h2 class="ob-h ob-h-grad">{$_('ob.requestTitle')}</h2>
              <div class="ob-strip">
                <div class="ob-tiles" class:ph={!requestTitles.length}>
                  {#if requestTitles.length}
                    {#each requestTitles.slice(0, 8) as m, i (m.title + i)}
                      <div class="ob-mtile">
                        <div class="ob-mtile-art">
                          <img src={m.poster} alt={m.title} loading="lazy" />
                          <span class="ob-badge ob-badge-req">{$_('ob.requestBadge')}</span>
                        </div>
                        <div class="ob-mtile-meta">
                          <span class="ob-mtile-title">{m.title}</span>
                          {#if m.year}<span class="ob-mtile-sub">{m.year}{#if m.rating} · ★ {m.rating}{/if}</span>{/if}
                        </div>
                      </div>
                    {/each}
                  {:else}
                    {#each [0, 1, 2] as i (i)}
                      <div class="ob-mtile">
                        <div class="ob-mtile-art"><div class="ob-ph a{(i % 8) + 4}"></div>
                          <span class="ob-badge ob-badge-req">{$_('ob.requestBadge')}</span></div>
                      </div>
                    {/each}
                  {/if}
                </div>
              </div>
              <p class="ob-p">{$_('ob.requestSub')}</p>
            {:else if beat === 'assistant'}
              <h2 class="ob-h ob-h-grad">{$_('ob.assistantTitle')}</h2>
              <StoryChat active={beat === 'assistant'} {reduceMotion} />
              <p class="ob-p">{$_('ob.assistantSub')}</p>
            {:else if beat === 'notified'}
              <div class="ob-toast" class:still={reduceMotion}>
                <span class="ob-toast-ico">🔔</span>
                <div>
                  <b>Pulse</b>
                  <p>{$_('ob.notifiedToast')}</p>
                </div>
              </div>
              <h2 class="ob-h ob-h-grad">{$_('ob.notifiedTitle')}</h2>
              <p class="ob-p">{$_('ob.notifiedSub')}</p>
            {:else if beat === 'watch'}
              <div class="ob-emoji">📺</div>
              <h2 class="ob-h ob-h-grad">{$_('ob.watchTitle')}</h2>
              <p class="ob-p">{$_('ob.watchSub')}</p>
              <ul class="ob-platforms">
                <li>📺 {$_('ob.platformTv')}</li>
                <li>🤖 {$_('ob.platformAndroid')}</li>
                <li>🍎 {$_('ob.platformIphone')}</li>
                <li>🌐 {$_('ob.platformWeb')}</li>
              </ul>
              <p class="ob-p ob-p-sm">{$_('ob.watchInstall')}</p>
            {:else if beat === 'plan'}
              <div class="ob-emoji">📊</div>
              <h2 class="ob-h ob-h-grad">{$_('ob.planTitle')}</h2>
              <p class="ob-p">
                {$_('ob.planLine', { values: { plan: planLabel || $_('ob.planGeneric'), n: chatsPerMonth } })}
              </p>
              <p class="ob-p ob-p-sm">{$_('ob.planTrack')}</p>
            {:else if beat === 'allset'}
              <Wordmark size="md" />
              <h2 class="ob-h ob-h-grad">{$_('ob.allSetTitle')}</h2>
              <ul class="ob-recap">
                <li><span class="ob-recap-check">✓</span> {$_('ob.recapDiscover')}</li>
                <li><span class="ob-recap-check">✓</span> {$_('ob.recapWatch')}</li>
                <li><span class="ob-recap-check">✓</span> {$_('ob.recapRequest')}</li>
                <li><span class="ob-recap-check">✓</span> {$_('ob.recapAsk')}</li>
                <li><span class="ob-recap-check">✓</span> {$_('ob.recapNotified')}</li>
              </ul>
            {/if}
          </div>
        {/key}
      </div>

      <!-- controls -->
      <div class="ob-controls">
        <button type="button" class="ob-skip" onclick={skip}>{$_('ob.skip')}</button>
        <div class="ob-nav">
          {#if step > 0}
            <button type="button" class="btn btn-s ob-btn" onclick={back}>{$_('ob.back')}</button>
          {/if}
          {#if step < total - 1}
            <button type="button" class="btn btn-p ob-btn" onclick={next}>{$_('ob.next')}</button>
          {:else}
            <button type="button" class="btn btn-p ob-btn" onclick={startForm}>{$_('ob.createAccountCta')}</button>
          {/if}
        </div>
      </div>
    </div>
  {:else if phase === 'form'}
    <main class="glass-card ob-card">
      <h1 class="ob-form-title">{$_('app.welcome')}</h1>
      <p class="app-sub">{$_('app.joinIntro')}</p>
      <form onsubmit={(e) => { e.preventDefault(); submit(); }}>
        <label>{$_('app.displayName')}
          <input bind:value={displayName} onblur={() => (touched.displayName = true)} required />
          {#if displayNameErr}<span class="field-err">{displayNameErr}</span>{/if}
        </label>
        <label>{$_('app.username')}
          <input bind:value={username} autocomplete="username" onblur={() => (touched.username = true)} required />
          {#if usernameErr}<span class="field-err">{usernameErr}</span>{/if}
        </label>
        <label>{$_('app.password')}
          <input type="password" bind:value={password} autocomplete="new-password" minlength="8" onblur={() => (touched.password = true)} required />
          {#if passwordErr}<span class="field-err">{passwordErr}</span>{/if}
        </label>
        <p class="app-hint">{$_('app.sameLoginNote')}</p>
        <!-- B.2 optional Plex link — skippable; onboarding completes without it. -->
        {#if plexLinked}
          <span class="badge badge-ok">{$_('app.plexLinked')}</span>
        {:else}
          <button type="button" class="btn btn-s" onclick={linkPlex} disabled={plexBusy}>
            {plexBusy ? $_('app.plexLinking') : $_('app.linkPlexOptional')}
          </button>
        {/if}
        {#if plexErr}<p class="app-error">{plexErr}</p>{/if}
        <button class="btn btn-p" disabled={busy || formInvalid}>{$_('app.createAccount')}</button>
        {#if err}<p class="app-error">{err}</p>{/if}
      </form>
    </main>
  {:else}
    <!-- phase === 'done' — enable-notifications step, then into /app -->
    <main class="glass-card ob-card">
      <Wordmark size="md" />
      <h1 class="ob-form-title">{$_('ob.allSetTitle')}</h1>
      <div class="ob-notify">
        {#if pushOn}
          <span class="badge badge-ok">{$_('app.notificationsOn')}</span>
        {:else}
          <button type="button" class="btn btn-s" onclick={turnOnNotifications} disabled={pushBusy}>
            {$_('app.enableNotifications')}
          </button>
          {#if pushMsg}
            <p class="app-hint">{pushMsg}</p>
          {/if}
        {/if}
        <p class="app-hint">{$_('app.iosNotice')}</p>
      </div>
      {#if telegramAvailable}
        <button type="button" class="btn btn-s" onclick={connectTelegram}>{$_('app.connectTelegram')}</button>
        <p class="app-hint">{$_('app.telegramHint')}</p>
      {/if}
      <button class="btn btn-p" onclick={() => goto('/app')}>{$_('app.tourNext')}</button>
    </main>
  {/if}
</div>

<style>
  .ob-stage {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    /* Safe horizontal padding + safe-area insets so beat content never clips at the edges. */
    padding: 24px max(18px, env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom))
      max(18px, env(safe-area-inset-left));
    overflow: hidden;
  }

  /* Extra cinematic veil over the poster wall so the foreground stays legible on every beat. */
  .ob-stage-veil {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    background:
      radial-gradient(140% 100% at 50% 30%, transparent 0%, rgba(10, 13, 19, 0.35) 60%, rgba(10, 13, 19, 0.75) 100%),
      linear-gradient(180deg, rgba(10, 13, 19, 0.25), rgba(10, 13, 19, 0.55));
  }

  .ob-lang {
    position: absolute;
    top: calc(14px + env(safe-area-inset-top));
    right: 14px;
    z-index: 3;
  }
  .ob-lang select {
    background: color-mix(in srgb, var(--bg) 60%, rgba(255, 255, 255, 0.06));
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 999px;
    color: var(--txt);
    font-size: 13px;
    padding: 7px 30px 7px 14px;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none'><path d='M1 1.5L6 6.5L11 1.5' stroke='%238b95a7' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>");
    background-repeat: no-repeat;
    background-position: right 11px center;
    backdrop-filter: blur(10px);
    cursor: pointer;
  }

  .ob-story {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 460px;
    height: min(660px, 90vh);
    display: flex;
    flex-direction: column;
    gap: 18px;
    /* Premium frosted card — matches the login's cinematic glass treatment. */
    padding: 22px 22px calc(20px + env(safe-area-inset-bottom));
    border-radius: 26px;
    background: color-mix(in srgb, var(--bg) 60%, rgba(255, 255, 255, 0.06));
    border: 1px solid rgba(255, 255, 255, 0.12);
    backdrop-filter: blur(22px) saturate(1.2);
    -webkit-backdrop-filter: blur(22px) saturate(1.2);
    box-shadow:
      0 30px 80px rgba(0, 0, 0, 0.6),
      inset 0 1px 0 rgba(255, 255, 255, 0.08);
  }

  .ob-dots {
    display: flex;
    gap: 7px;
    justify-content: center;
    flex-shrink: 0;
  }
  .ob-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.22);
    transition: background 0.25s, width 0.25s;
  }
  .ob-dot.on {
    width: 22px;
    background: linear-gradient(95deg, #34e0b0, #39a0f0);
  }
  .ob-dot.past { background: rgba(255, 255, 255, 0.5); }

  .ob-beat-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .ob-beat {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 16px;
    animation: ob-slide-in 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .ob-beat.fade {
    animation: ob-fade-in 0.4s ease both;
  }
  @keyframes ob-slide-in {
    from { opacity: 0; transform: translateX(22px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  @keyframes ob-fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .ob-beat { animation: ob-fade-in 0.3s ease both; }
  }

  .ob-emoji {
    font-size: 46px;
    line-height: 1;
    filter: drop-shadow(0 6px 16px rgba(0, 0, 0, 0.45));
  }
  .ob-h {
    font-size: 27px;
    font-weight: 800;
    letter-spacing: -0.5px;
    line-height: 1.18;
  }
  /* Gradient accent on beat titles — the cinematic mock look. */
  .ob-h-grad {
    background: linear-gradient(96deg, #ffffff 18%, #7fe9cf 60%, #6bb8f5 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .ob-p {
    color: var(--sub);
    font-size: 15px;
    line-height: 1.5;
    max-width: 34ch;
  }
  .ob-p-sm { font-size: 13px; }

  /* badge poster tiles (already / request beats) — horizontally scrollable so the strip
     fits any phone width without clipping at the edges. */
  .ob-strip {
    width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    /* bleed to the card edges so the strip can scroll fully, but keep inner content padded */
    margin: 0 -22px;
    padding: 4px 22px 6px;
    scroll-snap-type: x proximity;
  }
  .ob-strip::-webkit-scrollbar { display: none; }
  .ob-tiles {
    display: flex;
    gap: 10px;
    justify-content: center;
    width: max-content;
    min-width: 100%;
    margin: 0 auto;
  }
  .ob-ph, .ob-mtile-art img { width: 100%; height: 100%; object-fit: cover; display: block; }

  /* Richer title card: poster art + title/year beneath. Used on the available/request beats. */
  .ob-tiles.ph { justify-content: center; }
  .ob-mtile {
    flex: 0 0 96px;
    width: 96px;
    scroll-snap-align: center;
  }
  .ob-mtile-art {
    position: relative;
    width: 100%;
    aspect-ratio: 2 / 3;
    border-radius: 13px;
    overflow: hidden;
    box-shadow: 0 12px 26px rgba(0, 0, 0, 0.45);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }
  .ob-mtile-meta {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-top: 7px;
    text-align: left;
  }
  .ob-mtile-title {
    font-size: 12.5px;
    font-weight: 700;
    color: var(--txt);
    line-height: 1.25;
    /* clamp to two lines so long titles don't blow out the row height */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .ob-mtile-sub { font-size: 11px; color: var(--sub); }
  .ob-badge {
    position: absolute;
    bottom: 6px;
    left: 6px;
    right: 6px;
    font-size: 10px;
    font-weight: 700;
    padding: 4px 6px;
    border-radius: 7px;
    text-align: center;
    backdrop-filter: blur(4px);
  }
  .ob-badge-watch { background: rgba(8, 17, 13, 0.78); color: #34e0b0; }
  .ob-badge-req { background: rgba(8, 13, 19, 0.78); color: #39a0f0; }

  /* notification toast */
  .ob-toast {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    max-width: 340px;
    padding: 14px 16px;
    border-radius: 14px;
    background: color-mix(in srgb, var(--bg) 55%, rgba(255, 255, 255, 0.08));
    border: 1px solid rgba(255, 255, 255, 0.14);
    backdrop-filter: blur(16px);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
    text-align: left;
    animation: ob-toast-in 0.6s cubic-bezier(0.16, 1, 0.3, 1) both;
    animation-delay: 0.15s;
  }
  .ob-toast.still { animation: none; }
  .ob-toast-ico { font-size: 24px; }
  .ob-toast b { font-size: 13px; }
  .ob-toast p { font-size: 13px; color: var(--sub); margin-top: 2px; }
  @keyframes ob-toast-in {
    from { opacity: 0; transform: translateY(-26px) scale(0.95); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .ob-toast { animation: none; }
  }

  /* watch-anywhere platform list */
  .ob-platforms {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
  }
  .ob-platforms li {
    font-size: 13px;
    font-weight: 600;
    padding: 7px 12px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid var(--card-brd);
  }

  /* recap checklist — premium card with gradient check pills */
  .ob-recap {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: stretch;
    width: 100%;
    max-width: 300px;
    margin-top: 4px;
  }
  .ob-recap li {
    display: flex;
    align-items: center;
    gap: 11px;
    font-size: 15px;
    font-weight: 600;
    color: var(--txt);
    text-align: left;
    padding: 11px 14px;
    border-radius: 13px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--card-brd);
  }
  .ob-recap-check {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    font-size: 12px;
    font-weight: 800;
    color: #08110d;
    background: linear-gradient(135deg, #34e0b0, #39a0f0);
    box-shadow: 0 4px 12px rgba(52, 224, 176, 0.3);
  }

  /* controls */
  .ob-controls {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .ob-skip {
    background: none;
    border: none;
    color: var(--sub);
    font-size: 14px;
    cursor: pointer;
    padding: 8px 4px;
  }
  .ob-skip:hover { color: var(--txt); }
  .ob-nav { display: flex; gap: 10px; }
  .ob-btn { padding: 12px 22px; border-radius: 12px; }
  .ob-btn.btn-p {
    box-shadow: 0 10px 26px color-mix(in srgb, var(--accent) 36%, transparent);
  }

  /* account/done card */
  .ob-card {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 400px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 26px;
    max-height: 88vh;
    overflow-y: auto;
  }
  .ob-form-title { font-size: 22px; font-weight: 700; letter-spacing: -0.4px; }
  .ob-card .app-sub { margin-top: 0; }
  .ob-card form { display: flex; flex-direction: column; gap: 14px; }
  .ob-card label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--sub);
  }
  .ob-card input {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid var(--card-brd);
    border-radius: 10px;
    color: var(--txt);
    font-size: 16px; /* >=16px so iOS Safari doesn't zoom the page on focus */
    padding: 11px 14px;
    outline: none;
    transition: border-color 0.15s;
  }
  .ob-card input:focus { border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
  .ob-card .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .ob-card .app-hint { font-size: 12px; color: var(--sub); line-height: 1.4; }
  .field-err { font-size: 11.5px; font-weight: 500; color: #ff7a92; line-height: 1.35; }
  .ob-notify { display: flex; flex-direction: column; gap: 8px; }
  .ob-notify .app-hint { font-size: 12px; color: var(--sub); line-height: 1.4; }

  /* ── Mobile (≤480px): go FULL-BLEED. A frosted card floating mid-screen reads like a dialog
       on a phone, so we drop the card chrome (border/radius/blur/shadow) and let the poster-wall
       backdrop + veil BE the background — content just pads to the safe areas. The glass card is
       kept only on tablet/desktop, where a centered card feels right. ── */
  @media (max-width: 480px) {
    .ob-stage {
      padding: 0;
      align-items: stretch;
    }
    .ob-story {
      max-width: none;
      height: auto;
      min-height: 100%;
      flex: 1;
      gap: 14px;
      /* safe-area padding only — no card box */
      padding: calc(18px + env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
        calc(18px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
      border: 0;
      border-radius: 0;
      background: none;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      box-shadow: none;
      justify-content: space-between;
    }
    .ob-strip {
      margin: 0 max(-16px, calc(-1 * env(safe-area-inset-right))) 0
        max(-16px, calc(-1 * env(safe-area-inset-left)));
      padding: 4px 16px 6px;
    }
    .ob-h { font-size: 24px; }
    .ob-p { font-size: 14px; }
    .ob-emoji { font-size: 40px; }
    /* Account/done form goes full-bleed too — same rationale. */
    .ob-card {
      max-width: none;
      min-height: 100%;
      flex: 1;
      justify-content: center;
      max-height: none;
      padding: calc(24px + env(safe-area-inset-top)) 20px calc(24px + env(safe-area-inset-bottom));
      border: 0;
      border-radius: 0;
      background: none;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      box-shadow: none;
    }
  }
</style>
