# The About widget's bottom row touches the window edge

Status: SHIPPED in [v0.92.0](../../release/release-v0.92.0.md). The browser check measured equal 32px margins, and the owner confirmed the fixed native window on macOS/WKWebView.

## What was seen

The About surface ends flush against the bottom of its window: the free/open-source credits line has no visible space below it, while the top of the same surface keeps its full margin. The two ends of one card no longer read as a pair.

The desktop About window is the surface where the content grew. `desktop/src/about.html` puts the build id on the version line (`chan version <v> build <id>`), and at the 380px column that line no longer fits on one row, so the head block is one line taller than the height the window was sized against. That height is fixed: `open_about_window` in `desktop/src-tauri/src/main.rs` builds a non-resizable window at `inner_size(420.0, 426.0)`, and its comment still claims the size fits the content "with equal top/bottom margin". The CSS margin is symmetric already (`.about-wrap { padding: 26px 22px }` in `desktop/src/about.css`); it is the window that is a line too short to show the bottom 26px.

The SPA Dashboard About slide (`web/packages/workspace-app/src/components/EmptyPaneCarousel.svelte`) mirrors this layout and has its own asymmetry, independent of the build id. `.carousel` pads `2rem` at the top and `1rem` at the bottom, `.slide-about` adds no vertical padding, and `.slide` owns the scroll (`overflow-y: auto`), so once the About content is taller than the stage the last line ends hard against the stage edge with nothing under it. The slide does not show a build id today: it renders `buildInfo.version` plus the Apache 2.0 link, and `/api/build-info` (`crates/chan-server/src/routes/build_info.rs`) returns version and the embeddings feature flag, no commit. If the build id is ever mirrored into the SPA About, that slide grows the same line the desktop window already grew.

## Why that matters

About is the surface a user opens to read what build they are on, and it is the one place both the desktop app and the workspace app claim to render the same card. A bottom edge that clips its own margin makes the window read as truncated, which is exactly the wrong impression on the surface that exists to be trusted about identity.

## Boundaries

The desktop side is the About window's fixed height and the comment that justifies it; the SPA side is the carousel's vertical padding, or the About slide's own, whichever keeps the other two slides unchanged. No content changes: the build id line stays, the QR card stays, the credits line stays. Nothing outside the About surfaces moves, and the desktop window stays non-resizable.

## Acceptance

On both surfaces, the space below the last row matches the space above the first row, with the build id line present and wrapped as it wraps today. On the desktop window that is checked at its shipped fixed size with no scrollbar; on the Dashboard slide it is checked with the slide scrolled to its bottom.

## Implementation and validation

Commit `3a315f8a` separates the desktop version and build id onto fixed lines, raises the non-resizable window to 420x460, centers the card's spare vertical space safely, and gives the Dashboard About slide a 2rem bottom pad matching its top gap. Check `114-about-slide-margin` now fails closed unless it finds a viewport where the slide scrolls. It passed at height 460 with `above=32`, `below=32`, and `scrolls=true`, so the browser-driven half is complete.

The owner confirmed the fixed-size desktop window on macOS/WKWebView with the build id present. WebKitGTK was not exercised because the validation container had no display or GTK/WebKit runtime; that remains a named release evidence gap rather than a claimed acceptance pass.
