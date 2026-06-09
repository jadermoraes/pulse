<script lang="ts">
  // Cinematic drifting blurred poster-wall backdrop for the login + onboarding.
  // Builds a rotated, blurred, darkened grid of poster tiles that slowly drifts via CSS.
  // `prefers-reduced-motion` disables the drift (handled in CSS). Empty posters ⇒ gradient tiles.
  let { posters = [] as string[], drift = true } = $props();

  // We tile a fixed-size grid; repeat the available posters to fill it so a small list still
  // covers the wall. With no posters we render gradient placeholder tiles (8 art classes).
  const TILE_COUNT = 48;
  const ART = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];

  const tiles = $derived(
    Array.from({ length: TILE_COUNT }, (_, i) => {
      const src = posters.length ? posters[i % posters.length] : null;
      return { src, art: ART[i % ART.length] };
    })
  );
</script>

<div class="pw" class:pw-drift={drift} aria-hidden="true">
  <div class="pw-grid">
    {#each tiles as tile, i (i)}
      <div class="pw-tile">
        {#if tile.src}
          <img src={tile.src} alt="" loading="lazy" decoding="async" />
        {:else}
          <div class="pw-ph {tile.art}"></div>
        {/if}
      </div>
    {/each}
  </div>
  <div class="pw-veil"></div>
</div>

<style>
  .pw {
    position: absolute;
    inset: 0;
    overflow: hidden;
    z-index: 0;
  }

  /* The grid is oversized + rotated so the drift never reveals an edge. */
  .pw-grid {
    position: absolute;
    top: -30%;
    left: -30%;
    width: 160%;
    height: 160%;
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 14px;
    transform: rotate(-8deg) scale(1.1);
    filter: blur(7px) brightness(0.55) saturate(1.1);
    opacity: 0.7;
  }

  @media (max-width: 768px) {
    .pw-grid {
      grid-template-columns: repeat(5, 1fr);
      gap: 10px;
    }
  }

  .pw-tile {
    aspect-ratio: 2 / 3;
    border-radius: 10px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.03);
  }

  .pw-tile img,
  .pw-ph {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /* Slow vertical drift; the rotated oversize grid keeps edges off-screen. */
  .pw-drift .pw-grid {
    animation: pw-drift 60s linear infinite alternate;
  }

  @keyframes pw-drift {
    from { transform: rotate(-8deg) scale(1.1) translateY(0); }
    to   { transform: rotate(-8deg) scale(1.1) translateY(-8%); }
  }

  /* Dark radial veil over the wall so foreground content stays legible. */
  .pw-veil {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(120% 90% at 50% 40%, transparent 0%, rgba(8, 11, 17, 0.55) 55%, rgba(8, 11, 17, 0.92) 100%),
      linear-gradient(180deg, rgba(8, 11, 17, 0.4), rgba(8, 11, 17, 0.7));
  }

  @media (prefers-reduced-motion: reduce) {
    .pw-drift .pw-grid {
      animation: none;
    }
  }
</style>
