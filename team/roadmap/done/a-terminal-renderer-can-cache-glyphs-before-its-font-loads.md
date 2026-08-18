# A terminal renderer can cache its glyphs before its font has loaded

Status: SHIPPED in [v0.92.0](../../release/release-v0.92.0.md). Commit `bd0b2cb7` makes renderer construction wait for the selected webfont and fixes the fallback chain when that face cannot load.

## What

Both terminal backends rasterize glyphs into an atlas and measure the cell from the font resolved **at construction**. The bundled Source Code Pro is a webfont: declared with `font-display: swap` in `web/packages/workspace-app/src/fonts.css`, registered at app boot by `main.ts`, and leading the chain on every Linux terminal as well as any terminal whose user picked it in Settings. Nothing made the renderer wait for it.

A terminal that spawns while the woff2 is still in flight therefore builds its atlas from the fallback face, and the bundled face then swaps in underneath it. The result the fix names is one live renderer holding fallback and webfont metrics in the same atlas: cells measured against one face, glyphs drawn from another.

Whether this was seen in the wild or found by reading is not recorded on the branch. What is established is that the swap is unsequenced with respect to atlas warmup, and that the window in which it matters is exactly the one every Linux user hits on a cold cache: first terminal of a fresh page load.

## Why that matters

The terminal is where the cost of a wrong cell metric lands hardest. Column alignment, the cursor's fit inside its cell, and every box-drawing seam are all derived from the measurement taken once at construction, and none of them is re-derived when the face changes. A renderer in that state is not repairable by redrawing; it has to be rebuilt.

It is also the platform-parity surface: Linux leads with the bundled face precisely because it has no native mono to lead with, so the arm most exposed to this race is the one the bundled face exists to make deterministic.

## Desired contract

- A terminal renderer is constructed only against a font chain that is ready to draw with. A system chain needs no wait; a bundled face is awaited first.
- A face that fails to load is dropped from the chain the renderer receives, so a later arrival cannot change a live renderer. Falling back is a visible console statement, not a silent downgrade.
- The per-OS chains and the Settings preference keep the meaning they have today. This sequences the existing choice; it does not re-open which font wins.

## What the branch does

- `web/packages/workspace-app/src/terminal/font.ts` is new and owns both halves: `selectTerminalFont` (the per-OS chain plus the preference) and `resolveReadyTerminalFont` (awaits `document.fonts.load` for the bundled face and answers `system`, `loaded`, or `fallback`).
- `TerminalTab.svelte` awaits that before either backend is constructed, and warns on the fallback path. The chain tables move out of the component into the module.
- The test split follows: `terminal/font.test.ts` owns the OS and preference matrix, `TerminalTab.font.test.ts` keeps the component-integration pins, and `TerminalTab.test.ts` waits for the socket now that spawn is asynchronous.
- `fonts.css`, `main.ts`, and `api/types.ts` comments are corrected to say who waits for the face, since the old ones described the swap as visually subtle and unmanaged.

## Acceptance

- On Linux with a cold cache, the first terminal of a page load renders in the bundled face, with no metric change after first paint.
- With the face unavailable (blocked or missing), the terminal renders in the system mono, says so once, and stays there if the face later becomes available.
- macOS and Windows `os-default` terminals never wait on a webfont: their chains are system faces, and spawn is not delayed behind a load that cannot help them.
- The web unit suite and the pre-push gate are green on the branch, and the gate is re-run at intake rather than taken on the branch's word.

## Closing evidence

The implementation passed the web suite and the v0.92.0 pre-push gate, and the release report records it as shipped. The release record does not contain a separate cold-cache pixel measurement or hand-run for the "no metric change after first paint" line. That visual acceptance remains an evidence gap rather than being claimed complete; the related Linux renderer item continues in [v0.93.0](../v0.93.0/the-linux-desktop-still-refuses-webgl-after-its-blocker-was-fixed.md).
