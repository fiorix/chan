# Desktop Webview Rendering

End-to-end expectations for what the desktop app's own webview actually paints, as opposed to what a Chromium-based check sees. Owner-run: see [`../README.md`](../README.md) for the model and the rules that apply to every run.

Each scenario states behavior that must hold today. Where an executable check or test already proves it, that check is named under **Backing**; where none exists, the scenario says so and stays manual.

## What this covers

- the Linux desktop app renders on WebKitGTK, not on Blink, so a CSS feature Chrome honors is not thereby available to the shipped app;
- every card that hides a face hides it by a property the shipping engine actually implements, so no window opens onto a covered surface;
- a flip hands its faces over as the card crosses 90deg, not at half its duration;
- reduced motion drops the turn without stranding a face on screen;
- the engine capabilities these decisions rest on are re-measured when the host GUI stack moves.

Chromium coverage cannot substitute for any of this. `browser-smoke/` drives headless Chrome, which honors `backface-visibility`; a card whose hidden face is hidden only by that property passes every smoke check and covers the whole window in the shipped app.

## When to re-run

Look up the area you changed and run the scenarios listed against it.

- **Any 3D transform, `transform-style`, or `backface-visibility` in a component**: WV-01, WV-02, WV-03, WV-05
- **`Pane.svelte` card structure or its side flip**: WV-02, WV-03, WV-04
- **`ScreenFlip.svelte` or the launcher's screen swap**: WV-01, WV-03, WV-04
- **A WebKitGTK bump on the host, or a change to the AppImage GUI-stack preference in `linux_gui_stack.rs`**: WV-05, then everything it reports as changed
- **Animation timing or easing on either flip**: WV-03

## Scenarios

| ID | Scenario | Kind |
| --- | --- | --- |
| WV-01 | The Computers screen paints its content at rest | automated |
| WV-02 | A terminal pane paints its content at rest | automated |
| WV-03 | A flip hands over at the 90deg crossing | automated |
| WV-04 | Reduced motion leaves no face painted | mixed |
| WV-05 | Engine capabilities are what the CSS assumes | automated |

The automated coverage runs from two places. The source pins run under the normal frontend test command from `web/packages/launcher` and `web/packages/workspace-app`; the engine cases run through the webview harness:

```sh
python3 scripts/e2e/webview-flip-render.py
```

That harness needs python-gobject with the WebKit2 4.1 typelib and a display. Under a headless runner, wrap it: `xvfb-run -a python3 scripts/e2e/webview-flip-render.py`. It exits 2 when the GUI stack is missing, which is a skip and not a pass.

---

### WV-01 - the Computers screen paints its content at rest

**Expectation.** With no flip running, the launcher's main area shows the machine tree. The `ScreenFlip` back face carrying the incoming screen's name is not painted at all: not behind the content, not over it, and not mirrored across it. This holds on the engine the desktop app actually ships with, not merely on one that implements every property the stylesheet names.

**Why this is load-bearing.** The back face is opaque, fills the area, and sits above the content. Nothing degrades gracefully here: when it paints at rest the launcher is not a degraded window, it is an unusable one, and the app opens onto it every single launch.

**Run.** `python3 scripts/e2e/webview-flip-render.py`, case `launcher ScreenFlip [rest]`. In the real app, open the desktop app and read the Computers window.

**Backing.** That harness case. The CSS contract behind it is pinned by `the back face never paints at rest` in `web/packages/launcher/src/lib/flip.test.ts`.

**Evidence.** `target/e2e/webview-flip/screen-flip-rest.png` and the reported share of the center patch the content face covers.

### WV-02 - a terminal pane paints its content at rest

**Expectation.** With no flip running, a pane shows its tab strip and its terminal or editor body. The `pane-card-inner` back face carrying the side letter is not painted. This holds for every pane in every desktop window, including panes in windows opened after the first.

**Why this is load-bearing.** Same shape as WV-01 and the same absence of a graceful degradation: a covered pane is a terminal the user cannot see or read, and a window full of panes is a window full of nothing.

**Run.** `python3 scripts/e2e/webview-flip-render.py`, case `workspace-app Pane [rest]`. In the real app, open a workspace with a terminal and read the pane.

**Backing.** That harness case. The CSS contract behind it is pinned by `the back face never paints at rest` in `web/packages/workspace-app/src/components/Pane.test.ts`.

**Evidence.** `target/e2e/webview-flip/pane-rest.png` and the reported share of the center patch the content face covers.

### WV-03 - a flip hands over at the 90deg crossing

**Expectation.** During a turn the back face owns the card until the card passes edge-on, and the content face owns it afterwards. The handover is placed against the easing's half-progress point rather than half the duration, so neither face is ever shown to the viewer mirrored. Both flips share the same easing and the same handover point, because the launcher's screen flip is a deliberate copy of the pane's side flip.

**Why this is load-bearing.** On an engine without `backface-visibility` the handover is the only thing that swaps the faces. Placing it on duration rather than on the curve leaves the label facing the viewer backwards for roughly a third of the turn, which reads as a rendering fault rather than as an animation.

**Run.** `python3 scripts/e2e/webview-flip-render.py`, cases `pre-handover-60ms` and `post-handover-100ms` for both specimens. In the real app, swap between Computers and Gateways, and flip a pane's side.

**Backing.** Those four harness cases pin which face owns the center either side of the crossing. The 14.43% literal itself is pinned in both source-pin tests. No check measures the crossing against a changed easing curve: changing the timing function requires recomputing the literal by hand.

**Evidence.** The four `*-handover-*.png` renders.

### WV-04 - reduced motion leaves no face painted

**Expectation.** Under `prefers-reduced-motion: reduce` both flips drop the turn, and dropping it also drops the face handover. The screen or side change is instant and the content face is what shows, with no back face left painted and no label flashed.

**Why this is load-bearing.** The handover is an animation. Cancelling the card's turn while leaving the handover running would play a label over static content; cancelling the handover while leaving the rest state ungated would strand the back face permanently for exactly the users who asked for less motion.

**Run.** Set `gsettings set org.gnome.desktop.interface enable-animations false` or the equivalent for the host toolkit, then swap screens in the launcher and flip a pane's side.

**Backing.** Both source-pin tests assert the reduced-motion block names the back face alongside the card. No engine check runs under a reduced-motion preference.

**Evidence.** Screenshots of both surfaces immediately after the swap.

### WV-05 - engine capabilities are what the CSS assumes

**Expectation.** The rendering decisions above rest on measurements of the shipping engine, and those measurements are re-taken when the host GUI stack moves. `backface-visibility: hidden` is inert on WebKitGTK: it is ignored on real elements and on pseudo-elements alike, with and without `perspective` on the 3D-context root, with and without `transform-style: preserve-3d`, on both rotation axes, and regardless of `WEBKIT_DISABLE_DMABUF_RENDERER`. Verified on webkit2gtk-4.1 2.52.5. Nothing in the SPA may depend on it alone for a face that must not be seen.

**Why this is load-bearing.** The AppImage prefers the host GUI stack over its bundle, so the engine under the shipped app is whatever the user's distro provides and it moves without a chan release. A capability measured once and assumed forever is how a working build turns into a blank window on somebody else's machine.

**Run.** `python3 scripts/e2e/webview-flip-render.py`. Its `pre-handover` cases fail if a future engine starts honoring `backface-visibility`, because the back face would then be hidden at the point the check expects it to own the card. That failure is the signal to re-measure, not a defect.

**Backing.** That harness. The macOS and Windows webviews are not measured by it: WKWebView and WebView2 are untested for this property and no scenario claims a result for them.

**Evidence.** The harness output for all six cases, plus the engine version the run was taken on.

## Standing decisions

- **The shipping engine decides what a stylesheet may rely on, not the spec and not Chrome.** A property Chrome implements is a property the smoke suite proves nothing about. Any face, overlay, or layer that must not be seen is hidden by something measured on WebKitGTK.
- **`backface-visibility` stays in the source as a hint, never as the mechanism.** It costs nothing on engines that ignore it and it is correct on engines that do not, but the `visibility` gate is what actually keeps a back face off the screen. Removing the gate because the property is "already there" reintroduces the covered window.
- **A rest state is never left to an animation-only guarantee.** The turn is the exception and the resting card is the rule, so the resting card is what the base rule must render correctly on its own.
