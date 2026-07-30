// Fullscreen slide preview. Mirrors the image/diagram viewer chrome:
// theme-aware backdrop, centered content surface, prev/next controls,
// and Escape cleanup. The caller owns the editor read-only state via
// the returned close handle and onClose callback. The slide DOM itself
// (markdown render, diagram/image hydration, editor tokens, page CSS)
// comes from editor/slide_dom, shared with the PDF export engine; the
// preview discards the hydration completion promises by design.

import { isTauriDesktop, setWindowFullscreen } from "../api/desktop";
import {
  contentStyle,
  cssNumber,
  editorTokens,
  prepareSlideImages,
  renderSlideDiagrams,
  renderSlideMarkdown,
  type SlideMediaChrome,
  slidePreviewCss,
} from "../editor/slide_dom";
import {
  copyActionButton,
  diagramCopyButton,
} from "../editor/widgets/diagram_copy";
import {
  copyImagePixels,
  copySvgFileMarkup,
  isSvgImageSrc,
} from "../editor/widgets/image_copy";
import { openDiagramZoom } from "./diagramZoom";
import { openImageZoom } from "./imageZoom";
import {
  parseSlidesSpec,
  slideIndexForLine,
  splitSlidePages,
  type SlideAspectRatio,
  type SlidePage,
} from "../editor/slides";

export type SlidePreviewTheme = "light" | "dark";
export type SlidePreviewMode = "preview" | "play";

export type OpenSlidePreviewOptions = {
  source: string;
  currentLine: number | null;
  initialIndex?: number | null;
  fromPath: string | null;
  styleSource?: Element | null;
  theme: SlidePreviewTheme;
  mode?: SlidePreviewMode;
  onSlideChange?: (index: number) => void;
  onClose?: () => void;
};

export type SlidePreviewUpdate = Partial<
  Pick<
    OpenSlidePreviewOptions,
    "source" | "fromPath" | "initialIndex" | "styleSource" | "theme" | "mode"
  >
>;

export type SlidePreviewHandle = {
  update: (opts: SlidePreviewUpdate) => void;
  close: (opts?: { notify?: boolean }) => void;
};

type SlidePreviewState = {
  pages: SlidePage[];
  aspectRatio: SlideAspectRatio;
  zoomFactor: number;
  index: number;
  source: string;
  fromPath: string | null;
  styleSource: Element | null | undefined;
  theme: SlidePreviewTheme;
  mode: SlidePreviewMode;
};

export function openSlidePreview(opts: OpenSlidePreviewOptions): SlidePreviewHandle | null {
  const spec = parseSlidesSpec(opts.source);
  if (!spec) return null;
  const pages = splitSlidePages(opts.source);
  if (pages.length === 0) return null;

  const state: SlidePreviewState = {
    pages,
    aspectRatio: spec.aspectRatio,
    zoomFactor: spec.zoomFactor,
    index: initialSlideIndex(pages, opts.initialIndex, opts.currentLine),
    source: opts.source,
    fromPath: opts.fromPath,
    styleSource: opts.styleSource,
    theme: opts.theme,
    mode: opts.mode ?? "preview",
  };

  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const backdrop = document.createElement("div");
  backdrop.className = "md-image-zoom md-slide-preview";
  backdrop.tabIndex = -1;
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", "Slide preview");

  const style = document.createElement("style");
  style.textContent = slidePreviewCss();
  backdrop.appendChild(style);

  const page = document.createElement("article");
  page.className = "md-slide-preview-page";
  page.addEventListener("click", (event) => event.stopPropagation());

  const content = document.createElement("div");
  content.className = "md-slide-preview-content";
  page.appendChild(content);
  backdrop.appendChild(page);

  const prev = navButton("prev", "‹", "Previous slide", () => step(-1));
  const next = navButton("next", "›", "Next slide", () => step(1));
  const counter = document.createElement("div");
  counter.className = "md-image-zoom-counter md-slide-preview-counter";
  backdrop.append(prev, next, counter);
  let diagramRenderRun = 0;

  // Per-media View/copy chrome, mounted only on this live overlay (the
  // document render and PDF export paths pass no hook, so their DOM
  // stays chrome-free). Reveal is hover/focus-only via slidePreviewCss
  // in both preview and play. The viewers open above the play-mode
  // fullscreen backdrop; see the append-target note in imageZoom /
  // diagramZoom.
  const mediaChrome: SlideMediaChrome = {
    image: (img, raw) => {
      const wrap = document.createElement("span");
      wrap.className = "md-slide-media-wrap";
      img.replaceWith(wrap);
      wrap.appendChild(img);
      const row = document.createElement("span");
      row.className = "md-slide-media-actions";
      const svgSource = isSvgImageSrc(raw);
      row.appendChild(
        slideActionButton("View", "view fullscreen", () =>
          openImageZoom(raw, state.fromPath),
        ),
      );
      const copies: HTMLButtonElement[] = [];
      if (svgSource) {
        copies.push(
          copyActionButton(
            "md-slide-media-action",
            "SVG",
            "copy SVG markup to clipboard",
            () => copySvgFileMarkup(img.src),
            true,
          ),
        );
      }
      copies.push(
        copyActionButton(
          "md-slide-media-action",
          "PNG",
          "copy PNG image to clipboard",
          () => copyImagePixels(img.src, svgSource),
          true,
        ),
      );
      for (const btn of copies) {
        // The hook only fires after the image loaded, so the buttons
        // start revealed (the factory's hidden default gates async
        // renders).
        btn.style.display = "";
        row.appendChild(btn);
      }
      wrap.appendChild(row);
    },
    diagram: (shell, _svg, renderLight) => {
      const row = document.createElement("span");
      row.className = "md-slide-media-actions";
      row.appendChild(
        slideActionButton("View", "view fullscreen", () => {
          void renderLight().then((light) => {
            if (!light) return;
            // The light re-render is async; if the slide stepped or the
            // preview closed meanwhile, the originating shell left the
            // DOM - do not open a stale viewer over whatever replaced it.
            if (!shell.isConnected) return;
            openDiagramZoom(light);
          });
        }),
      );
      for (const format of ["svg", "png"] as const) {
        const btn = diagramCopyButton(
          "md-slide-media-action",
          renderLight,
          format,
          true,
        );
        btn.style.display = "";
        row.appendChild(btn);
      }
      shell.appendChild(row);
    },
  };

  function applyTheme(): void {
    backdrop.dataset.theme = state.theme;
    backdrop.dataset.mode = state.mode;
    backdrop.setAttribute(
      "aria-label",
      state.mode === "play" ? "Slide player" : "Slide preview",
    );
    backdrop.style.cssText = backdropStyle(state.theme);
    page.style.cssText = pageStyle(
      state.aspectRatio,
      state.styleSource,
      state.theme,
      state.mode,
    );
    content.style.cssText = contentStyle(state.zoomFactor);
    content.dataset.zoomFactor = cssNumber(state.zoomFactor);
    applyNavTheme(prev, state.theme, prev.disabled);
    applyNavTheme(next, state.theme, next.disabled);
    counter.style.cssText = counterStyle(state.theme);
    applyChromeMode(prev, next, counter, state.mode);
  }

  function show(): void {
    const current = state.pages[state.index]!;
    const renderRun = ++diagramRenderRun;
    content.innerHTML = renderSlideMarkdown(current.markdown);
    void prepareSlideImages(
      content,
      state.fromPath,
      state.theme,
      () => {
        return !closed && renderRun === diagramRenderRun;
      },
      mediaChrome,
    );
    void renderSlideDiagrams(
      content,
      current.markdown,
      state.theme,
      () => {
        return !closed && renderRun === diagramRenderRun;
      },
      mediaChrome,
    );
    page.setAttribute("aria-label", `Slide ${current.number}`);
    counter.textContent =
      state.mode === "preview" ? `${state.index + 1} / ${state.pages.length}` : "";
    syncNavButton(prev, state.index === 0);
    syncNavButton(next, state.index === state.pages.length - 1);
    applyChromeMode(prev, next, counter, state.mode);
  }

  function step(delta: number): void {
    const nextIndex = state.index + delta;
    if (nextIndex < 0 || nextIndex >= state.pages.length) return;
    state.index = nextIndex;
    show();
    opts.onSlideChange?.(state.index);
  }

  function update(next: SlidePreviewUpdate): void {
    let needsShow = false;
    const previousIndex = state.index;
    if (typeof next.source === "string" && next.source !== state.source) {
      const spec = parseSlidesSpec(next.source);
      if (!spec) return;
      state.source = next.source;
      state.aspectRatio = spec.aspectRatio;
      state.zoomFactor = spec.zoomFactor;
      state.pages = splitSlidePages(next.source);
      state.index = clampSlideIndex(state.pages, state.index);
      needsShow = true;
    }
    if (next.fromPath !== undefined) state.fromPath = next.fromPath;
    if (next.styleSource !== undefined) state.styleSource = next.styleSource;
    if (next.theme && next.theme !== state.theme) {
      state.theme = next.theme;
      needsShow = true;
    }
    if (next.mode && next.mode !== state.mode) {
      state.mode = next.mode;
      needsShow = true;
    }
    if (next.initialIndex !== undefined && next.initialIndex !== null) {
      const idx = clampSlideIndex(state.pages, next.initialIndex);
      if (idx !== state.index) {
        state.index = idx;
        needsShow = true;
      }
    }
    applyTheme();
    if (needsShow) show();
    if (next.mode === "play") requestSlideFullscreen(backdrop);
    else if (next.mode === "preview") exitSlideFullscreen(backdrop);
    if (state.index !== previousIndex) opts.onSlideChange?.(state.index);
  }

  let closed = false;
  const dismiss = ({ notify = true }: { notify?: boolean } = {}): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    exitSlideFullscreen(backdrop);
    backdrop.remove();
    if (notify) opts.onClose?.();
    previouslyFocused?.focus({ preventScroll: true });
  };

  const onKey = (event: KeyboardEvent): void => {
    // A media viewer opened from the slide chrome sits above this
    // overlay with its own document-capture keymap. Both listeners
    // share the document node, so stopPropagation alone cannot keep
    // this one from stepping slides (or closing) underneath the
    // viewer; yield while one is up.
    if (viewerAboveSlides()) return;
    switch (event.key) {
      case "Escape":
        consume(event);
        dismiss();
        break;
      case "Backspace":
      case "ArrowUp":
      case "ArrowLeft":
        consume(event);
        step(-1);
        break;
      case " ":
      case "Spacebar":
      case "ArrowDown":
      case "ArrowRight":
        consume(event);
        step(1);
        break;
    }
  };

  backdrop.addEventListener("click", () => dismiss());
  document.addEventListener("keydown", onKey, true);
  applyTheme();
  show();
  opts.onSlideChange?.(state.index);
  document.body.appendChild(backdrop);
  if (state.mode === "play") requestSlideFullscreen(backdrop);
  backdrop.focus({ preventScroll: true });
  return { update, close: dismiss };
}

function consume(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

/// Whether an image/diagram viewer overlay is open above the slide
/// overlay. The slide backdrop itself carries `md-image-zoom` (for the
/// shared backdrop styling), hence the `:not` filter.
function viewerAboveSlides(): boolean {
  return !!document.querySelector(
    ".md-diagram-zoom, .md-image-zoom:not(.md-slide-preview)",
  );
}

/// Plain action button for the slide media chrome (View). The copy
/// buttons come from the shared copy factory instead, for the Check
/// feedback and title-flash failure surface.
function slideActionButton(
  label: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "md-slide-media-action";
  btn.textContent = label;
  btn.title = title;
  btn.setAttribute("aria-label", title);
  // Swallow the press so it neither dismisses the overlay nor starts a
  // selection; the action runs on click, like the widget action rows.
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function navButton(
  kind: "prev" | "next",
  glyph: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `md-image-zoom-nav md-image-zoom-${kind} md-slide-preview-${kind}`;
  btn.setAttribute("aria-label", label);
  btn.textContent = glyph;
  const side = kind === "prev" ? "left:12px;" : "right:12px;";
  btn.style.cssText =
    "position:fixed;top:50%;transform:translateY(-50%);" +
    side +
    "width:48px;height:64px;border:none;border-radius:8px;" +
    "background:rgba(0,0,0,0.45);color:#fff;cursor:pointer;" +
    "font-size:34px;line-height:1;display:flex;align-items:center;" +
    "justify-content:center;";
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return btn;
}

function syncNavButton(btn: HTMLButtonElement, disabled: boolean): void {
  btn.disabled = disabled;
  applyNavTheme(
    btn,
    (btn.closest(".md-slide-preview") as HTMLElement | null)?.dataset.theme === "light"
      ? "light"
      : "dark",
    disabled,
  );
}

function applyChromeMode(
  prev: HTMLButtonElement,
  next: HTMLButtonElement,
  counter: HTMLElement,
  mode: SlidePreviewMode,
): void {
  const hidden = mode === "play";
  for (const el of [prev, next, counter]) {
    el.hidden = hidden;
    el.setAttribute("aria-hidden", hidden ? "true" : "false");
    el.style.display = hidden ? "none" : "";
  }
}

function requestSlideFullscreen(el: HTMLElement): void {
  if (isTauriDesktop()) {
    // chan-desktop's WKWebView disables the HTML element Fullscreen API, so
    // "play" drives the native window fullscreen through Tauri instead. Unlike
    // element.requestFullscreen() this needs no user activation, so every play
    // transition (open, mode change, restore) goes fullscreen deterministically.
    void setWindowFullscreen(true);
    return;
  }
  const request = el.requestFullscreen?.bind(el);
  if (!request) return;
  try {
    void request().catch(() => {});
  } catch {
    // Browsers can reject fullscreen when Play is restored without a
    // user activation. The slide player still opens in-window.
  }
}

function exitSlideFullscreen(el: HTMLElement): void {
  if (isTauriDesktop()) {
    void setWindowFullscreen(false);
    return;
  }
  if (document.fullscreenElement !== el) return;
  const exit = document.exitFullscreen?.bind(document);
  if (!exit) return;
  try {
    void exit().catch(() => {});
  } catch {
    // Best effort cleanup; removing the fullscreen element also exits.
  }
}

function pageStyle(
  aspectRatio: SlideAspectRatio,
  styleSource: Element | null | undefined,
  theme: SlidePreviewTheme,
  mode: SlidePreviewMode,
): string {
  const [w, h] = aspectRatio.split(":").map((part) => Number(part));
  const ratio = w! / h!;
  const previewWidthLimit = `${Math.round(86 * ratio * 100) / 100}vh`;
  const playWidthLimit = `${cssNumber(100 * ratio)}vh`;
  const isPlay = mode === "play";
  const tokens = editorTokens(styleSource, theme);

  return [
    tokens.vars,
    "box-sizing:border-box",
    `color-scheme:${theme}`,
    isPlay ? "width:100vw" : `width:min(86vw,${previewWidthLimit})`,
    ...(isPlay ? [`max-width:${playWidthLimit}`] : []),
    `aspect-ratio:${w} / ${h}`,
    isPlay ? "max-height:100vh" : "max-height:86vh",
    "overflow:auto",
    "padding:clamp(22px,4vw,54px)",
    `background:${tokens.bg}`,
    `color:${tokens.fg}`,
    `font-family:${tokens.bodyFamily}`,
    `font-size:${tokens.bodySize}`,
    "line-height:1.55",
    isPlay
      ? "box-shadow:none"
      : `box-shadow:${theme === "dark" ? "0 10px 48px rgba(0,0,0,0.55)" : "0 16px 56px rgba(31,41,55,0.22)"}`,
    `border-radius:${isPlay ? "0" : "4px"}`,
    "cursor:auto",
  ].join(";");
}

function backdropStyle(theme: SlidePreviewTheme): string {
  // Fully opaque: a translucent backdrop let the editor's own layered
  // backgrounds (the dark tab bar over the light content, the outline/pane
  // divider) bleed through at different shades, so the presenter surface showed
  // a two-tone horizontal/vertical seam. A solid fill reads as one clean stage.
  const bg = theme === "dark" ? "rgb(0,0,0)" : "rgb(238,241,245)";
  return (
    "position:fixed;inset:0;z-index:40000;" +
    `background:${bg};display:flex;align-items:center;` +
    "justify-content:center;cursor:zoom-out;overflow:hidden;"
  );
}

function counterStyle(theme: SlidePreviewTheme): string {
  return (
    "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);" +
    "font:13px/1.4 ui-monospace,Menlo,monospace;" +
    "padding:2px 10px;border-radius:10px;pointer-events:none;" +
    (theme === "dark"
      ? "color:#ddd;background:rgba(0,0,0,0.5);"
      : "color:#1f2937;background:rgba(255,255,255,0.86);box-shadow:0 2px 10px rgba(31,41,55,0.12);")
  );
}

function applyNavTheme(
  btn: HTMLButtonElement,
  theme: SlidePreviewTheme,
  disabled: boolean,
): void {
  const kind = btn.classList.contains("md-slide-preview-prev") ? "prev" : "next";
  const side = kind === "prev" ? "left:12px;" : "right:12px;";
  btn.style.cssText =
    "position:fixed;top:50%;transform:translateY(-50%);" +
    side +
    "width:48px;height:64px;border-radius:8px;cursor:pointer;" +
    "font-size:34px;line-height:1;display:flex;align-items:center;" +
    "justify-content:center;" +
    (theme === "dark"
      ? "border:none;background:rgba(0,0,0,0.45);color:#fff;"
      : "border:1px solid rgba(31,41,55,0.16);background:rgba(255,255,255,0.88);color:#111827;box-shadow:0 6px 24px rgba(31,41,55,0.16);") +
    `opacity:${disabled ? "0.35" : "1"};cursor:${disabled ? "default" : "pointer"};`;
}

function initialSlideIndex(
  pages: readonly Pick<SlidePage, "startLine">[],
  initialIndex: number | null | undefined,
  currentLine: number | null,
): number {
  if (initialIndex !== undefined && initialIndex !== null) {
    return clampSlideIndex(pages, initialIndex);
  }
  return slideIndexForLine(pages, currentLine);
}

function clampSlideIndex(pages: readonly unknown[], index: number): number {
  if (pages.length === 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(pages.length - 1, Math.floor(index)));
}
