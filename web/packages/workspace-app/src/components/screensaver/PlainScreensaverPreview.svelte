<script lang="ts">
  // Static plain/Default screensaver preview for the screen lock section of
  // Settings (ScreenLockControl). Mirrors MatrixRainPreview's interface (a
  // fixed width/height box), with no timers. The look matches
  // the real lock screen's non-matrix theme: the chan enso mark on a dark
  // backdrop, the same treatment as ScreensaverOverlay.svelte's
  // `.screensaver-mark` (masked /chan-mark.png over --text-secondary).
  let {
    width = 320,
    height = 180,
  }: { width?: number; height?: number } = $props();
</script>

<div
  class="plain-screensaver-preview"
  style="width: {width}px; height: {height}px;"
  aria-hidden="true"
>
  <div class="mark"></div>
</div>

<style>
  .plain-screensaver-preview {
    display: block;
    position: relative;
    background: var(--bg);
    border-radius: 6px;
    overflow: hidden;
  }
  .mark {
    position: absolute;
    inset: 0;
    background-color: var(--text-secondary);
    -webkit-mask: url("/chan-mark.png") center / auto 62% no-repeat;
    mask: url("/chan-mark.png") center / auto 62% no-repeat;
    opacity: 0.38;
    pointer-events: none;
  }
</style>
