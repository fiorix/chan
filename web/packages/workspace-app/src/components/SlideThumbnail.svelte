<script lang="ts">
  import { onMount } from "svelte";
  import type { SlidesSpec } from "../editor/slides";
  import {
    contentStyle, prepareSlideImages, renderSlideDiagrams, renderSlideMarkdown,
    slidePageBoxStyle, type SlideDomTheme,
  } from "../editor/slide_dom";

  let { markdown, spec, fromPath, theme }: {
    markdown: string;
    spec: SlidesSpec;
    fromPath: string | null;
    theme: SlideDomTheme;
  } = $props();

  let host: HTMLSpanElement;
  let visible = $state(false);
  const zoomFactor = $derived(spec.zoomFactor);
  const ratio = $derived(spec.aspectRatio === "4:3" ? 4 / 3 : 16 / 9);

  onMount(() => {
    if (typeof IntersectionObserver === "undefined") { visible = true; return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        visible = true;
        observer.disconnect();
      }
    }, { rootMargin: "200px" });
    observer.observe(host);
    return () => observer.disconnect();
  });

  $effect(() => {
    if (!visible) return;
    const source = markdown, path = fromPath, palette = theme, zoom = zoomFactor, aspect = ratio;
    let current = true;
    // Coalesce typing; unchanged slides retain their DOM and hydrated media.
    const timer = setTimeout(() => {
      const page = document.createElement("div");
      page.className = "md-slide-preview-page";
      page.style.cssText = slidePageBoxStyle({ widthPx: 1280, heightPx: 1280 / aspect }, host, palette, 54);
      page.style.transformOrigin = "top left";
      const body = document.createElement("div");
      body.className = "md-slide-preview-content";
      body.style.cssText = contentStyle(zoom);
      body.innerHTML = renderSlideMarkdown(source);
      page.append(body);
      host.replaceChildren(page);
      const fit = () => { page.style.transform = `scale(${host.clientWidth / 1280})`; };
      fit();
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(fit);
        resizeObserver.observe(host);
      }
      void prepareSlideImages(body, path, palette, () => current);
      void renderSlideDiagrams(body, source, palette, () => current);
    }, 120);
    let resizeObserver: ResizeObserver | undefined;
    return () => { current = false; clearTimeout(timer); resizeObserver?.disconnect(); };
  });
</script>

<span class="slide-miniature" bind:this={host} style:aspect-ratio={ratio} aria-hidden="true" inert></span>

<style>
  .slide-miniature {
    display: block;
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--chan-editor-bg, white);
    box-shadow: 0 2px 4px #0001;
    pointer-events: none;
    contain: layout paint;
  }
</style>
