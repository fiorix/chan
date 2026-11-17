# Terminals come back at half scale in their old grid after a sleep on macOS

Status: raised by the owner on 2026-11-17 from chan-desktop 0.130.0 on macOS, and taken into v0.132.0 on his report; not started.

Record: the owner's words: "second time that aftercoming back from sleep all terminals zoom to min font and each window needs a reload; new bug from v0.130 - im not on v131 yet". His report and screenshot are in `dev/v0132-team/evidence/Lead132/wakefont-0/`. Seen twice; each time every window needed a reload. The cause is not established: the picture and the code agree on one mechanism in the page, and nothing read shows what sets it off on the Mac. The terminal regression list holds the earlier wake entries (T099, T180, T181, T216) and T184 (grid rendering never measured at a device pixel ratio other than 1), and none for this picture. The repaint this row builds on is [v0.124.0's](../done/a-ghostty-terminal-comes-back-blank-after-its-window-sits-off-screen.md).

## What is there now

Read at `v0.130.0`, by reading; not run. A number in parentheses is the same line at `v0.131.0` where it moved. The files named here are unchanged from `v0.131.0` at the integration tip `871ecf178`.

- **The picture.** The screenshot is a scale-2 capture of one window with two panes. Each terminal holds 105 columns by 51 rows, the grid a 9.5 by 24 CSS px cell fits in those panes with the ghostty fitter (`web/packages/workspace-app/src/terminal/resize.ts:17-36`), and the programs still wrap at 105 columns. The cells are drawn at 9.50 by 24.0 device px, measured in both panes: one device pixel per CSS pixel, half the fitted size. The grid sits in the top-left quarter of each pane and the rest is blank, with no remnant of the full-size frame. The tab strip in the title bar, which the page draws (`desktop/src-tauri/src/titlebar_tabs.rs:1-14`), is at its usual size.
- **Not the font size.** The preference is read once, when a terminal starts (`web/packages/workspace-app/src/components/TerminalTab.svelte:1147-1148`, 1146), and Settings says a mounted terminal keeps its size (`components/settings/TerminalSection.svelte:281`). A font of 8 px at ratio 2 gives a cell of 9 device px (`terminal/ghosttyCompat.ts:95-106`), and the picture has 9.5. The bounds are 8 to 32 (`terminal/fontSize.ts:11-12`); the server clamps a write below 8 to 8 (`crates/chan-server/src/routes/preferences.rs:524-537`).
- **Not the page zoom.** The desktop's zoom moves in steps of 0.10 on Cmd+=, Cmd+- and Cmd+0 (`desktop/src-tauri/src/main.rs:5056-5124`, `key_bridge.js:145-162`). A page zoom resizes the terminal's host, which refits the grid (`TerminalTab.svelte:1540-1541`, 1533-1534), and shrinks the page-drawn tab strip.
- **The widget sets its canvas scale in one place.** `CanvasRenderer.resize` sizes the canvas and calls `ctx.scale(dpr, dpr)` (`web/packages/ghostty-web-ng/lib/renderer.ts:202-224`, 195-217), with the ratio read once in the constructor (`:141`). Every row, glyph and cursor is drawn in CSS units (`:452-481`, `:536`). `render` calls `resize` only when the backing store's size differs from the grid's (`:259-266`, 252-259).
- **The wake recovery repaints without it.** On a wake the tab queues a fit and forces a full pass (`TerminalTab.svelte:961-976`, 959-974; `terminal/renderer.ts:24-36`). The fit returns at an unchanged grid (`TerminalTab.svelte:1288-1301`, 1281-1294), so nothing reaches `resize`.
- **So a canvas whose 2D state the host resets at an unchanged size stays at 1 over the ratio.** Bitmap blank, transform identity, same width and height: the size check passes, the full pass and every later frame (`web/packages/ghostty-web-ng/lib/terminal.ts:1182-1210`, 1106-1122) draw at one device pixel per CSS pixel, and only a changed grid (`:675-718`, 673) or a new page puts the scale back. At ratio 2 that is the picture. Nothing in the repository resets a live terminal's canvas that way, and neither the widget nor the tab listens for a lost or restored 2D context.
- **Whether WKWebView does that across a sleep is not established.** The v0.124.0 row records a host dropping a hidden page's canvas pixels, "same size, blank, the page not told", and its repaint was proven against an emulated discard only. That emulation, `c.width = c.width` (`scripts/e2e/browser-smoke/checks/204-terminal-ghostty-offscreen-repaint.mjs:130-133`), resets the transform too; headless Chrome runs it at ratio 1, where the scale is 1 and the reset cannot show. Every renderer test builds its renderer at ratio 1 (`terminal/ghosttyRenderer.test.ts:142`, `:294`, `:466`, `:753`).
- **xterm.js is not this picture.** Its fit reserves 14 px for a scrollbar and would hold 104 columns here, and it follows a ratio change by itself.
- **New in v0.130.0 is not explained.** `v0.129.0..v0.130.0` changes nothing in the canvas sizing, the ratio, the font size, the zoom or the wake path, and `v0.130.0..v0.131.0` does not either. The forced pass has been there since v0.124.0. The owner ran v0.129.0 for under a day.

## Desired contract

1. A reading on the owner's Mac, at the next occurrence and before a reload, settles the cause. It records, for an affected window: which backend its terminals run; each terminal canvas's backing size, CSS size, laid-out box and context transform, and the device pixel ratio; whether the painted pixels lie in the top-left quarter of the backing store or across it; whether setting the transform again and a repaint restore full scale with the grid as it was; whether a new terminal in that window opens at full size; what Settings shows for the terminal font size; and whether WebKit's GPU process was replaced across the sleep. It names one of: the canvas's drawing state was reset; the bitmap is right and its presentation is wrong; another cause, which then gets its own contract here.
2. After a wake, every terminal in every window draws its grid at the cell size the grid was fitted with, with no reload and no input: the drawn cell pitch in device pixels is the renderer's cell size times the device pixel ratio.
3. A ghostty terminal whose canvas drawing state the host reset at an unchanged size draws at full scale from its next repaint, on every host-resume path, and its pixels then equal those of a terminal opened fresh with the same content.
4. The repair changes no grid and resizes no PTY: columns and rows are as before, and no size is published for it.
5. No page reloads on a wake to hide the defect.
6. The font size preference stays as it is: read when a terminal starts.

Contract 3 rests on a gap established by reading and can be built against the emulated reset. The row closes when the reading ties the owner's picture to that gap, or names the other cause and it is fixed.

## Boundaries

- The widget's renderer and the tab's host-resume recovery, with their tests; which of the two owns the canvas scale is the build's choice.
- Not here: applying a font size change to a mounted terminal; following a device pixel ratio change on ghostty, which keeps the ratio it opened with (T184); the timing of the first frame after a wake (T180) and the redials of a suspended page (T181); xterm.js.
- The desktop's wake repaint keeps changing no geometry, and windows stay transparent.
- Linux can show the page's half only. Whether and when WKWebView resets a canvas is read on the Mac.

## Acceptance

1. The reading of contract 1, recorded here with its console output.
2. A browser check at a device scale factor of 2, set before the terminal opens: a ghostty terminal printed to its last column and row, the same-size reset of check 204 while the page is hidden, then the visible flip. Red at the base: the painted pixels lie in the top-left quarter of the backing store. Green: they span it as before the reset. Check 204 stays green at ratio 1.
3. A unit test on the renderer with the software canvas at ratio 2: after the context state is reset at an unchanged size, a full pass fills the last cell's background in that cell's device rectangle. Red at the base; removing the repair turns it red again.
4. A mounted test of the host-resume recovery on a ghostty terminal at ratio 2 after such a reset: columns and rows are unchanged and no size is sent.
5. The same emulated reset in chan-desktop on WebKitGTK in the desktop guest at a device scale of 2, or a record that the guest cannot run at that scale.
6. On the owner's Mac, which alone can show it: a week of daily use on a build with the repair with no terminal at half scale after a sleep; or, if the reading finds a way to provoke the reset, three provoked runs that each end at full scale with no reload.

## Reading procedure

In the affected window, open the inspector with Cmd+Opt+I and paste these in order. The third changes the page; the first two only read.

1. `JSON.stringify([...document.querySelectorAll('.terminal-host > canvas')].map(c=>{const x=c.getContext('2d'),t=x.getTransform(),r=c.getBoundingClientRect();return [c.width,c.height,c.style.width,c.style.height,r.width,r.height,devicePixelRatio,t.a,t.d]}))`. One row per ghostty terminal: backing size, CSS size, box, ratio, transform. A healthy row ends `2,2,2`. An empty list means the terminals run xterm.js.
2. `JSON.stringify([...document.querySelectorAll('.terminal-host > canvas')].map(c=>{const x=c.getContext('2d'),w=c.width>>1,h=c.height>>1,q=(X,Y)=>{const d=x.getImageData(X,Y,w,h).data;let n=0;for(let i=3;i<d.length;i+=4)if(d[i])n++;return n};return [q(0,0),q(w,0),q(0,h),q(w,h)]}))`. Painted pixels per quarter of each backing store. `[n,0,0,0]` says the drawing is at half scale; four non-zero counts say the bitmap is right.
3. `document.querySelectorAll('.terminal-host > canvas').forEach(c=>c.getContext('2d').setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0))`, then click another pane and back. Full size with the grid intact says the lost transform is the whole defect.

Then, without the console: open a new terminal in that window and note its size; read the terminal font size in Settings; and run `ps -axo lstart,command | grep '[W]ebKit.GPU'` to see whether a GPU process started at the wake.
