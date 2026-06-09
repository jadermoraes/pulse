<script lang="ts">
  // The Pulse wordmark in the brand gradient (teal→blue) with a small glowing dot.
  // Used on the login card + the onboarding hero beats.
  let { size = 'lg' as 'lg' | 'md' } = $props();
</script>

<span class="wm wm-{size}">
  <span class="wm-dot" aria-hidden="true"></span>
  <span class="wm-text">Pulse</span>
</span>

<style>
  .wm {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-weight: 800;
    letter-spacing: -0.5px;
  }
  .wm-lg { font-size: 40px; }
  .wm-md { font-size: 28px; }

  .wm-text {
    background: linear-gradient(95deg, #34e0b0, #39a0f0);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }

  .wm-dot {
    width: 0.5em;
    height: 0.5em;
    border-radius: 50%;
    background: linear-gradient(135deg, #34e0b0, #39a0f0);
    box-shadow: 0 0 14px 2px rgba(52, 224, 176, 0.6);
    animation: wm-glow 2s ease-in-out infinite;
  }

  @keyframes wm-glow {
    0%, 100% { box-shadow: 0 0 12px 1px rgba(52, 224, 176, 0.45); }
    50%      { box-shadow: 0 0 20px 4px rgba(57, 160, 240, 0.7); }
  }

  @media (prefers-reduced-motion: reduce) {
    .wm-dot { animation: none; }
  }
</style>
