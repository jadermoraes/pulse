<script lang="ts">
  import { _ } from 'svelte-i18n';

  // A polished, multi-turn scripted chat demo for the onboarding "Ask the assistant" beat.
  // It shows off the agent's range: it recommends what's already on the server (each as a
  // little detail CARD — poster, title, year, one-line synopsis + an "⭐ available now" marker),
  // pivots on a follow-up, offers to *request* a missing title, confirms the request, and closes
  // with a hint at its broader abilities. The cards mirror how the real assistant presents a
  // title so the viewer can decide whether to watch/request it.
  //
  // Bubbles reveal one at a time; assistant bubbles type out character-by-character and their
  // media cards fade in after the line finishes. The body auto-scrolls to keep the latest line
  // in view (so nothing gets cut off). With reduced motion (or while inactive) everything shows
  // instantly.
  let { active = false, reduceMotion = false } = $props();

  // Each suggestion is a media card. `titleKey`/`blurbKey` localize with the rest of the tour;
  // `year` is a plain number (no translation needed). `available` ⇒ ⭐ on-server marker;
  // `request` ⇒ the "+ request" treatment for a title that isn't on the server yet.
  type Card = {
    titleKey: string;
    year: number;
    blurbKey: string;
    available?: boolean;
    request?: boolean;
  };
  type Line = { from: 'user' | 'assistant'; key: string; cards?: Card[] };
  const script: Line[] = [
    { from: 'user', key: 'ob.chatU1' },
    {
      from: 'assistant',
      key: 'ob.chatA1',
      cards: [
        { titleKey: 'ob.chatA1Title1', year: 2014, blurbKey: 'ob.chatA1Blurb1', available: true },
        { titleKey: 'ob.chatA1Title2', year: 2018, blurbKey: 'ob.chatA1Blurb2', available: true },
        { titleKey: 'ob.chatA1Title3', year: 2019, blurbKey: 'ob.chatA1Blurb3', available: true }
      ]
    },
    { from: 'user', key: 'ob.chatU2' },
    {
      from: 'assistant',
      key: 'ob.chatA2',
      cards: [{ titleKey: 'ob.chatA2Title1', year: 2013, blurbKey: 'ob.chatA2Blurb1', request: true }]
    },
    { from: 'user', key: 'ob.chatU3' },
    { from: 'assistant', key: 'ob.chatA3' },
    { from: 'assistant', key: 'ob.chatA4' }
  ];

  let shown = $state<number>(0); // number of bubbles revealed
  let typed = $state<Record<number, number>>({}); // bubble index → chars revealed (assistant)
  let cardsOn = $state<Record<number, boolean>>({}); // bubble index → cards revealed
  let bodyEl = $state<HTMLDivElement | null>(null);

  let timers: ReturnType<typeof setTimeout>[] = [];
  function clearTimers() {
    for (const t of timers) clearTimeout(t);
    timers = [];
  }

  function texts(): string[] {
    return script.map((l) => $_(l.key));
  }

  // Keep the most recent line in view as the demo plays — that's what stops the bottom getting cut.
  function scrollDown() {
    requestAnimationFrame(() => {
      if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
    });
  }

  function run() {
    clearTimers();
    shown = 0;
    typed = {};
    cardsOn = {};

    if (reduceMotion) {
      // Show everything at once, fully typed, all cards visible.
      shown = script.length;
      const all: Record<number, number> = {};
      const cards: Record<number, boolean> = {};
      texts().forEach((t, i) => {
        all[i] = t.length;
        if (script[i].cards) cards[i] = true;
      });
      typed = all;
      cardsOn = cards;
      return;
    }

    const t = texts();
    let delay = 350;
    script.forEach((line, i) => {
      timers.push(
        setTimeout(() => {
          shown = i + 1;
          if (line.from === 'assistant') {
            // typewriter, then reveal media cards
            const full = t[i];
            let c = 0;
            const tick = () => {
              c += 1;
              typed = { ...typed, [i]: c };
              if (c < full.length) timers.push(setTimeout(tick, 20));
              else if (line.cards) {
                timers.push(
                  setTimeout(() => {
                    cardsOn = { ...cardsOn, [i]: true };
                  }, 180)
                );
              }
            };
            tick();
          } else {
            typed = { ...typed, [i]: t[i].length };
          }
        }, delay)
      );
      // Space out: assistant lines take longer (typing + cards); user lines are quick.
      const cardTime = line.cards ? 520 : 0;
      delay += line.from === 'assistant' ? 1100 + t[i].length * 20 + cardTime : 850;
    });
  }

  // Restart the animation whenever the beat becomes active (or locale changes the texts).
  $effect(() => {
    if (active) run();
    else clearTimers();
    return clearTimers;
  });

  // Auto-follow the latest content as bubbles/typing/cards reveal.
  $effect(() => {
    // touch the reactive deps so this re-runs as the demo progresses
    void shown;
    void typed;
    void cardsOn;
    scrollDown();
  });

  function display(i: number): string {
    const t = texts()[i];
    const n = typed[i];
    return n == null ? '' : t.slice(0, n);
  }

  function lineDone(i: number): boolean {
    return (typed[i] ?? 0) >= texts()[i].length;
  }
</script>

<div class="sc" class:still={reduceMotion}>
  <div class="sc-head">
    <span class="sc-orb" aria-hidden="true"></span>
    <span class="sc-head-name">{$_('ob.chatHeader')}</span>
    <span class="sc-head-dot" aria-hidden="true"></span>
  </div>

  <div class="sc-body" bind:this={bodyEl}>
    {#each script as line, i (i)}
      {#if i < shown}
        <div class="sc-row {line.from}">
          <div class="sc-bubble {line.from}">
            <span class="sc-text"
              >{display(i)}{#if line.from === 'assistant' && !reduceMotion && !lineDone(i)}<span
                  class="sc-caret"
                ></span>{/if}</span
            >
            {#if line.cards && cardsOn[i]}
              <div class="sc-cards">
                {#each line.cards as card (card.titleKey)}
                  <div class="sc-card" class:avail={card.available}>
                    <div class="sc-poster" class:req={card.request} aria-hidden="true">🎬</div>
                    <div class="sc-card-meta">
                      <span class="sc-card-title">{$_(card.titleKey)}</span>
                      <span class="sc-card-year">{card.year}</span>
                      <span class="sc-card-blurb">{$_(card.blurbKey)}</span>
                      <span class="sc-pill" class:avail={card.available}>
                        {#if card.available}<span class="sc-star" aria-hidden="true">⭐</span>{$_('ob.watchNow')}
                        {:else}{$_('ob.requestBadge')}{/if}
                      </span>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}
    {/each}
  </div>
</div>

<style>
  .sc {
    width: 100%;
    max-width: 360px;
    display: flex;
    flex-direction: column;
    border-radius: 18px;
    background: linear-gradient(
      160deg,
      color-mix(in srgb, var(--bg) 50%, rgba(255, 255, 255, 0.07)),
      color-mix(in srgb, var(--bg) 70%, rgba(57, 160, 240, 0.05))
    );
    border: 1px solid rgba(255, 255, 255, 0.12);
    backdrop-filter: blur(16px) saturate(1.2);
    -webkit-backdrop-filter: blur(16px) saturate(1.2);
    box-shadow:
      0 18px 48px rgba(0, 0, 0, 0.5),
      inset 0 1px 0 rgba(255, 255, 255, 0.08);
    text-align: left;
    overflow: hidden;
  }

  /* Header strip — a tiny "assistant" identity bar. */
  .sc-head {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
  }
  .sc-orb {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    flex-shrink: 0;
    background: linear-gradient(135deg, #34e0b0, #39a0f0);
    box-shadow: 0 0 12px 1px rgba(52, 224, 176, 0.5);
    animation: sc-orb 2.4s ease-in-out infinite;
  }
  .sc-head-name {
    font-size: 12.5px;
    font-weight: 700;
    color: var(--txt);
    letter-spacing: 0.2px;
  }
  .sc-head-dot {
    margin-left: auto;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #34e0b0;
    box-shadow: 0 0 8px 1px rgba(52, 224, 176, 0.7);
  }
  @keyframes sc-orb {
    0%,
    100% {
      box-shadow: 0 0 10px 1px rgba(52, 224, 176, 0.4);
    }
    50% {
      box-shadow: 0 0 18px 3px rgba(57, 160, 240, 0.65);
    }
  }

  .sc-body {
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding: 14px;
    /* Bounded + scrollable so a multi-turn demo with detail cards never spills past the card
       (which is what was clipping the bottom). It auto-scrolls to follow the latest line. */
    min-height: 150px;
    max-height: min(46vh, 340px);
    overflow-y: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    scroll-behavior: smooth;
  }
  .sc-body::-webkit-scrollbar {
    display: none;
  }

  .sc-row {
    display: flex;
    flex-shrink: 0;
  }
  .sc-row.user {
    justify-content: flex-end;
  }
  .sc-row.assistant {
    justify-content: flex-start;
  }

  .sc-bubble {
    max-width: 88%;
    padding: 9px 13px;
    border-radius: 15px;
    font-size: 13.5px;
    line-height: 1.45;
    animation: sc-pop 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .sc-bubble.user {
    background: linear-gradient(135deg, #34e0b0, #39a0f0);
    color: #08110d;
    border-bottom-right-radius: 5px;
    font-weight: 600;
    box-shadow: 0 6px 18px rgba(52, 224, 176, 0.22);
  }
  .sc-bubble.assistant {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid var(--card-brd);
    color: var(--txt);
    border-bottom-left-radius: 5px;
  }

  /* Suggestion cards inside an assistant bubble — poster + title/year/synopsis + a status pill. */
  .sc-cards {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin-top: 9px;
  }
  .sc-card {
    display: flex;
    gap: 9px;
    padding: 7px;
    border-radius: 11px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--card-brd);
    animation: sc-card-in 0.34s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .sc-card.avail {
    background: color-mix(in srgb, #34e0b0 9%, transparent);
    border-color: color-mix(in srgb, #34e0b0 26%, transparent);
  }
  .sc-poster {
    flex: 0 0 38px;
    width: 38px;
    aspect-ratio: 2 / 3;
    border-radius: 7px;
    display: grid;
    place-items: center;
    font-size: 16px;
    background: linear-gradient(150deg, #2a3a55, #16202f);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
  }
  .sc-poster.req {
    background: linear-gradient(150deg, #1d3a52, #122231);
  }
  .sc-card-meta {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .sc-card-title {
    font-size: 12.5px;
    font-weight: 700;
    color: var(--txt);
    line-height: 1.2;
  }
  .sc-card-year {
    font-size: 10.5px;
    color: var(--sub);
  }
  .sc-card-blurb {
    font-size: 11px;
    color: var(--sub);
    line-height: 1.35;
    margin-top: 1px;
    /* one line, ellipsized — "some detail, not a wall of text" */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .sc-pill {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-top: 5px;
    font-size: 10.5px;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid var(--card-brd);
    color: var(--sub);
  }
  .sc-pill.avail {
    background: color-mix(in srgb, #34e0b0 16%, transparent);
    border-color: color-mix(in srgb, #34e0b0 38%, transparent);
    color: #6ef0c8;
  }
  .sc-star {
    font-size: 9px;
    line-height: 1;
  }
  @keyframes sc-card-in {
    from {
      opacity: 0;
      transform: translateY(6px) scale(0.96);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  @keyframes sc-pop {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.96);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .sc.still .sc-bubble,
  .sc.still .sc-card,
  .sc.still .sc-orb {
    animation: none;
  }
  .sc.still .sc-body {
    scroll-behavior: auto;
  }
  @media (prefers-reduced-motion: reduce) {
    .sc-bubble,
    .sc-card,
    .sc-orb {
      animation: none;
    }
    .sc-body {
      scroll-behavior: auto;
    }
  }

  .sc-caret {
    display: inline-block;
    width: 2px;
    height: 1em;
    margin-left: 1px;
    vertical-align: text-bottom;
    background: var(--accent);
    animation: sc-blink 0.9s step-end infinite;
  }
  @keyframes sc-blink {
    50% {
      opacity: 0;
    }
  }
</style>
