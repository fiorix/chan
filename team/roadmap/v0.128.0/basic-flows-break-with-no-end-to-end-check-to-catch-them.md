# Basic flows break with no end-to-end check to catch them

Status: raised by the owner on 2026-11-11 and accepted for v0.128.0 the same day; not started. His words: "we will also need to run the browser smoke tests and end-to-end tests; perhaps we may even need new ones because we've recently broke very basic functionality such as pasting images into the rich prompt and into the editor".

## What is there now

- The breakage: v0.127.0 fixed an image paste into the editor and the Rich Prompt that was lost on chan-desktop (`898474c75`, fix(editor): recover empty WebKit image pastes natively). WKWebView advertised Files in the clipboard event but exposed no items and no files, so the paste did nothing, while Chrome exposed the image and pasted it. The fix reads the image through the desktop IPC and uploads it as PNG; its tests are mounted vitest cases (`web/packages/workspace-app/src/editor/bubbles/image_drop.clipboard.test.ts`, `components/RichPrompt.svelte.test.ts`). A release earlier the ghostty image paste ([done](../done/ghostty-drops-an-image-paste-and-swallows-control-v.md)) had the same shape: a basic flow broken on one backend, found by the owner on his Mac.
- The browser suite (`scripts/e2e/browser-smoke/`, 119 checks at `8e41a9264`) drives Chrome through puppeteer-core against a debug `chan serve`; it is outside the gate and runs by judgment in an isolated guest (`.agents/skills/gate/SKILL.md`, "The browser smokes are outside the gate, deliberately"). Which basic flows it covers, and which it covers in Chrome alone, has not been listed; the WebKit breakage above passes every Chrome check.
- The desktop guest (`dev/hn-tmux-rig/chan-e2e-desktop.sdme`, `guest-desktop.sh`) builds chan-desktop on WebKitGTK and was written for the WireGuard arms (`scripts/e2e/desktop-wireguard.sh`); as far as read, nothing drives a paste, a drop or typing into its webview today. The audit below confirms or corrects that reading.

## Desired contract

1. An audit lists the basic flows and what checks each end to end today, with the engine each check runs on: pasting and dropping an image into the Rich Prompt and into the editor, typing and saving in the editor, a terminal's input, output and paste on both backends, opening a file, the search, the panes. The audit's list is this item's scope and is recorded in this item.
2. Each flow the audit finds without an end-to-end check gets one that goes red on the broken code and green on the fix, in two arms: a browser arm under `scripts/e2e/browser-smoke/checks/` in Chrome, and a WebKit arm on chan-desktop (WebKitGTK) in the desktop guest. Each check names the engine it runs on in its header and in its output.
3. The image paste into the Rich Prompt and into the editor is covered in both arms. The WebKit arm's check is red at `898474c75^` and green at `898474c75`, or the item records why WebKitGTK does not reproduce WKWebView's clipboard shape and the check then drives the fix's path with the clipboard shape that failed.
4. The whole browser suite and the end-to-end suites run on `v0128/int` at each milestone of this release, not only the new checks, with the results on the bus and in the release record.

## Boundaries

- Checks and the guest runner. A product defect a new check finds gets its own row and is not fixed here.
- The browser suite stays outside the gate; its README's graduation rule stands.
- WebKitGTK stands in for WKWebView. What only WKWebView shows stays an owner check on macOS, batched per milestone.

## Acceptance

1. The audit's table in this item: flow, unit or mounted tests, browser check and engine, WebKit check, gap.
2. For each gap, the new check green at the integration tip and shown red once on a deliberate break (the fix reverted or a mutation), with the red's output kept with the round's evidence; `make e2e-check` and `make browser-smoke-lib-test` green.
3. The whole browser suite green in an isolated guest at the integration tip, and the WebKit arm green in the desktop guest, each with its results file on the bus.
4. `scripts/e2e/README.md` and the browser suite's README list the new checks and the WebKit arm's run recipe.
