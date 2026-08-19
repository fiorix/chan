import { beforeEach, describe, expect, test } from "vitest";
import richPromptSrc from "./RichPrompt.svelte?raw";
import app from "../App.svelte?raw";
import tabs from "../state/tabs.svelte.ts?raw";
import {
  hideRichPromptForTab,
  isRichPromptVisible,
  richPrompt,
  showRichPromptForTab,
  toggleRichPromptForTab,
} from "../state/richPrompt.svelte";

// Rich Prompt - the Drafts-backed bubble + its toggle + the sender. The
// terminal wiring (mount / menu / sink registration / close-discard) is covered
// in richPromptTerminalWiring.test.ts. Component markup is asserted as source
// shape (it is a Svelte component, not pure); the real interaction (paste ->
// Drafts, submit carries the ref, close deletes the folder) is browser-smoked.

describe("richPrompt state module", () => {
  beforeEach(() => {
    richPrompt.byTab = {};
  });

  test("per-terminal toggle / show / hide keyed by tab id (text lives in the draft)", () => {
    expect(isRichPromptVisible("t1")).toBe(false);
    toggleRichPromptForTab("t1");
    expect(isRichPromptVisible("t1")).toBe(true);
    // Independent per terminal: opening t1 does not affect t2.
    expect(isRichPromptVisible("t2")).toBe(false);
    toggleRichPromptForTab("t1");
    expect(isRichPromptVisible("t1")).toBe(false);
    showRichPromptForTab("t2");
    expect(isRichPromptVisible("t2")).toBe(true);
    hideRichPromptForTab("t2");
    expect(isRichPromptVisible("t2")).toBe(false);
  });
});

describe("RichPrompt.svelte component", () => {
  test("uses Wysiwyg as the editor implementation", () => {
    expect(richPromptSrc).toMatch(/import Wysiwyg from "\.\.\/editor\/Wysiwyg\.svelte"/);
    expect(richPromptSrc).toMatch(/<Wysiwyg[\s\S]{1,500}bind:value=\{content\}/);
    expect(richPromptSrc).toMatch(/currentPath=\{draftPath\}/);
    // Rich Prompt delegates markdown parsing, image paste/drop, and image
    // widgets to Wysiwyg; the bubble only supplies terminal-specific behavior.
    expect(richPromptSrc).not.toMatch(/@codemirror\/lang-markdown/);
    expect(richPromptSrc).not.toMatch(/from "\.\.\/editor\/bubbles\/image_drop"/);
  });

  test("main-editor editing: Wysiwyg owns Enter/lists; Rich Prompt adds Mod+Enter submit", () => {
    expect(richPromptSrc).toMatch(
      /extraExtensions=\{editorExtensions\}/,
    );
    // stopPropagation: the submit chord must not bubble to the image
    // widget's document-level View chord (paste image + Mod-Enter used to
    // submit AND open the fullscreen zoom in one press).
    expect(richPromptSrc).toMatch(
      /\{ key: "Mod-Enter", run: submitFromView, stopPropagation: true \}/,
    );
    expect(richPromptSrc).not.toMatch(/key: "Enter"[\s\S]{1,80}submit/);
  });

  test("Drafts-backed: per-terminal draft.md is edited as a markdown file", () => {
    // Bound to the terminal's draft (a prop), created lazily, content loaded
    // from + written back to draft.md. Wysiwyg receives currentPath=draftPath,
    // so pasted images upload into the draft folder as markdown embeds and
    // render in-place.
    expect(richPromptSrc).toMatch(
      /let \{ tab, focused = false \}: \{ tab: TerminalTab; focused\?: boolean \} =\s*\$props\(\)/,
    );
    expect(richPromptSrc).toMatch(/currentPath=\{draftPath\}/);
    expect(richPromptSrc).not.toMatch(/getTerminalCwdRel/);
    expect(richPromptSrc).toMatch(/await api\.createDraft\(\)/);
    expect(richPromptSrc).toMatch(/tab\.richPromptDraftPath = path/);
    expect(richPromptSrc).toMatch(/await api\.read\(path\)/);
    expect(richPromptSrc).toMatch(/await api\.write\(draftPath, content\)/);
  });

  test("submit routes to THIS terminal, then KEEPS the text as the greyed read-only card", () => {
    // Routes to the bubble's OWN tab with the chord THIS terminal reads
    // (submitAgent()) + a client message id, only beginning a pending when the
    // frame actually went out (the data-loss guard).
    expect(richPromptSrc).toMatch(/const id = crypto\.randomUUID\(\);/);
    expect(richPromptSrc).toMatch(
      /import \{ rewriteImagePathsForDelivery \} from "\.\.\/editor\/deliver_images"/,
    );
    // The editor backing markdown stays draft-relative for preview, while the
    // prompt frame payload is rewritten to bare absolute on-disk image paths.
    expect(richPromptSrc).toMatch(
      /const delivered = rewriteImagePathsForDelivery\(\s*text,\s*draftPath,[\s\S]{1,400}workspace\.info\?\.root \?\? filesContext\.current\?\.rootDisplay \?\? null,/,
    );
    expect(richPromptSrc).toMatch(
      /if \(!sendPromptToTerminal\(tab\.id, delivered, submitAgent\(\), id\)\) return true;/,
    );
    expect(richPromptSrc).toMatch(/beginPendingPrompt\(tab, id\);/);
    const submitBody = richPromptSrc.match(/function submitFromView\(view: EditorView\): boolean \{[\s\S]*?\n  \}/)?.[0];
    expect(submitBody).toBeTruthy();
    // Submit KEEPS the text (the greyed card), so it does NOT clear the
    // composer; it guards re-submit while the card is up (no double-deliver),
    // persists the text (reload-restores the card), and remembers it for recall.
    expect(submitBody).not.toContain('insert: ""');
    expect(submitBody).toContain("if (isPending) return true;");
    expect(submitBody).toContain("lastQueued = { id, text };");
    expect(submitBody).toContain("void flushWrite();");
    expect(richPromptSrc).not.toMatch(/type: "input"/);
    expect(richPromptSrc).not.toMatch(/discardDraft/);
  });

  test("delivered CLEARS the greyed card; rejected/failed un-grey + keep the text + warn", () => {
    const consumeBody = richPromptSrc.match(/function consumeTerminalPhase\([\s\S]*?\n  \}/)?.[0];
    expect(consumeBody).toBeTruthy();
    // Delivered: the agent consumed the message, so the card clears (text +
    // draft) back to an empty editable composer and refocuses the Wysiwyg editor.
    const deliveredBranch = consumeBody?.match(
      /if \(phase === "delivered"\)[\s\S]*?\n    \} else \{/,
    )?.[0];
    expect(deliveredBranch).toBeTruthy();
    expect(deliveredBranch).toContain('content = ""');
    expect(deliveredBranch).toContain("queueMicrotask(() => editor?.focusAt(0))");
    // Rejected/failed: clearing pending below un-greys; the text stays for a
    // retry; warn honestly.
    expect(richPromptSrc).toMatch(/queue full, try again/);
    expect(richPromptSrc).toMatch(/connection lost, message may still be queued/);
  });

  test("the greyed read-only card: readOnly lock + caret hidden, reconciled by type-to-move-on", () => {
    // The read-only/greyed/caret-hidden card is applied via a lock
    // compartment, but reconciles back-to-back by exiting on the first keystroke
    // (beforeinput move-on) rather than dropping the lock -- so it never STICKS.
    expect(richPromptSrc).toMatch(/lockCompartment/);
    expect(richPromptSrc).toMatch(/EditorState\.readOnly\.of\(locked\)/);
    expect(richPromptSrc).toMatch(/caret-color: transparent/);
    // Type to move on: a user text input while pending clears the card + seeds a
    // fresh composer with what was typed.
    expect(richPromptSrc).toMatch(
      /beforeinput: \(event, view\) => \{[\s\S]{1,400}if \(!isPending\) return false;[\s\S]{1,400}enterLocalEdit\(\);/,
    );
    expect(richPromptSrc).toMatch(/insert: seed/);
  });

  test("↑ edits the queued message (from the card or an empty composer); Esc drops it", () => {
    expect(richPromptSrc).toMatch(/\{ key: "ArrowUp", run: recallFromView \}/);
    // From the greyed card, recall un-greys (the text is already shown); from an
    // empty composer it restores the buffer. Both best-effort cancel.
    expect(richPromptSrc).toMatch(/if \(isPending\) \{[\s\S]{1,200}enterLocalEdit\(\);/);
    // The card-up recall MUST fold the readOnly->editable reconfigure into its
    // own dispatch and DEFER focus to a microtask -- same WKWebView flip the
    // delivered path folds. Leaning on the out-of-band lock $effect + a
    // synchronous focus leaves the card un-typeable until a remount (the
    // ArrowUp-stuck-read-only regression).
    const recallPending = richPromptSrc.match(
      /if \(isPending\) \{[\s\S]*?return true;\n    \}/,
    )?.[0];
    expect(recallPending).toBeTruthy();
    expect(recallPending).toContain("lockCompartment.reconfigure(lockExtensions(false))");
    expect(recallPending).toContain("queueMicrotask(() => view.focus())");
    expect(richPromptSrc).toMatch(/content\.length > 0 \|\| !lastQueued\) return false/);
    expect(richPromptSrc).toMatch(/const \{ id, text \} = lastQueued;/);
    expect(richPromptSrc).toMatch(/sendCancelToTerminal\(tab\.id, id\)/);
    // Stopping a send is ONE action whichever route runs it, so Esc delegates
    // to the recall path rather than carrying its own cancel-and-clear: the
    // message leaves the queue and its text stays in the composer. Esc only
    // abandons the draft when there is nothing queued to stop.
    const dropBody = richPromptSrc.match(
      /function dropOrAbandonFromView\(view: EditorView\): boolean \{[\s\S]*?\n  \}/,
    )?.[0];
    expect(dropBody).toContain("if (isPending) return recallFromView(view);");
    expect(dropBody).toContain("abandonDraft();");
    expect(richPromptSrc).toMatch(/function abandonDraft\(\): void/);
    expect(richPromptSrc).toMatch(/hideRichPromptForTab\(tab\.id\)/);
    // The strip's stop runs the same recall path. It must never reach the
    // abandon fallthrough, which hides the whole bubble.
    const primaryClickBody = richPromptSrc.match(
      /function onPrimaryClick\(\): void \{[\s\S]*?\n  \}/,
    )?.[0];
    expect(primaryClickBody).toContain("if (isPending) recallFromView(promptView);");
    expect(primaryClickBody).not.toContain("abandonDraft");
    expect(primaryClickBody).not.toContain("dropOrAbandonFromView");
  });

  test("fast-path grace + ack timeout constants gate the chip and the dead-socket fail", () => {
    // 300ms: an idle agent drains within ~1 tick -- no chip flash on routine
    // submits. 5s: no ack means the socket is effectively dead.
    expect(richPromptSrc).toMatch(/PENDING_CHIP_GRACE_MS = 300/);
    expect(richPromptSrc).toMatch(/PROMPT_ACK_TIMEOUT_MS = 5000/);
    expect(richPromptSrc).toMatch(/failPendingPrompt\(tab\);/);
  });

  test("strip surfaces the queue depth (server + the local just-submitted) beside its controls", () => {
    // queuedCount = max(server queueDepth, the local just-submitted message
    // after the grace window) -- so a teammate `cs terminal write` and the
    // user's own queued messages both show.
    expect(richPromptSrc).toMatch(
      /Math\.max\(tab\.queueDepth \?\? 0, isPending && pendingChipVisible \? 1 : 0\)/,
    );
    // The count and a transient note share one advisory text slot; a note
    // takes the slot without disturbing either control.
    expect(richPromptSrc).toMatch(
      /transientNote \?\? \(queuedCount > 0 \? `\$\{queuedCount\} queued` : null\)/,
    );
    // The affordances are controls, not label text. The primary carries the
    // pending state: submit becomes stop and back again. Recall is a control
    // only when nothing is pending, because stopping a send already returns
    // the text to the composer and a second control would repeat it.
    expect(richPromptSrc).toMatch(
      /if \(isPending\) return null;[\s\S]{1,120}\{ label: "↑ recall", disabled: content\.length > 0 \}/,
    );
    expect(richPromptSrc).toMatch(
      /\{ label: "esc cancel", disabled: false \}/,
    );
    expect(richPromptSrc).toMatch(
      /\{ label: submitLabel, disabled: content\.trim\(\)\.length === 0 \}/,
    );
    expect(richPromptSrc).not.toMatch(/label: "↑ edit"/);
  });

  test("submitAgent prefers server identity and delegates protocol fallback", () => {
    // The session frame's spawn-derived identity is authoritative. The shared
    // helper retains negotiated-protocol inference for old servers and agents
    // launched manually from a shell.
    expect(richPromptSrc).toMatch(/function submitAgent\(\): SubmitAgent/);
    expect(richPromptSrc).toMatch(
      /return submitAgentForTerminal\(tab\.submitAgent, tab\.keyboardProtocol\);/,
    );
  });

  test("adds only a never-escape composer Tab; Wysiwyg owns the rest of the keymap", () => {
    // Tab in the composer indents and must never escape to the browser's focus
    // nav, so RichPrompt binds it with an indentMore fallback. It does NOT
    // reimplement Enter continuation or markdown backspace (Wysiwyg owns those).
    expect(richPromptSrc).toMatch(/indentListItem\(v\) \|\| indentMore\(v\)/);
    expect(richPromptSrc).not.toMatch(/insertNewlineContinueMarkup/);
    expect(richPromptSrc).not.toMatch(/deleteMarkupBackward/);
  });

  test("floating bubble with the submit-with-cmd+enter label", () => {
    expect(richPromptSrc).toMatch(/class="rich-prompt"/);
    expect(richPromptSrc).toMatch(/submit with cmd\+enter/);
    expect(richPromptSrc).toMatch(/position: absolute/);
  });
});

describe("App.svelte Rich Prompt toggle", () => {
  test("imports + binds the per-terminal toggle on a KeyP chord", () => {
    expect(app).toMatch(
      /import \{ toggleRichPromptForTab \} from "\.\/state\/richPrompt\.svelte"/,
    );
    // Cmd+Shift+P on macOS; off mac the Win/Super key is ruled out, so both
    // the desktop webview and the browser take Ctrl+Shift+P. Resolved into a
    // `richPromptChord` boolean gated on currentOS().
    expect(app).toMatch(/const richPromptChord =[\s\S]{1,40}currentOS\(\) === "mac"/);
    // mac path keeps metaKey; off mac it is ctrlKey (both surfaces).
    expect(app).toMatch(/e\.metaKey && !e\.ctrlKey && !e\.altKey && e\.shiftKey/);
    expect(app).toMatch(/e\.ctrlKey && !e\.metaKey && !e\.altKey && e\.shiftKey/);
    // Toggles ONLY the focused terminal; no-op when it isn't a terminal.
    expect(app).toMatch(
      /if \(richPromptChord\)[\s\S]{1,200}activeTerminalTab\(\)[\s\S]{1,80}toggleRichPromptForTab\(term\.id\)/,
    );
  });
});

describe("prompt-sink sender (tabs.svelte.ts)", () => {
  test("registry + per-terminal sender exist, distinct from the input sink", () => {
    expect(tabs).toMatch(/export function registerTerminalPromptSink\(/);
    // The trailing id is optional: the team orchestrator's lead-identity
    // call sites pass none and stay legacy fire-and-forget.
    expect(tabs).toMatch(
      /export function sendPromptToTerminal\(\s*tabId: string,\s*data: string,\s*agent\?: string,\s*id\?: string,\s*\): boolean/,
    );
    expect(tabs).toMatch(/const terminalPromptSinks = new Map/);
  });

  test("per-terminal draft path is a tab field + persisted (rpd) for leak-free cleanup", () => {
    expect(tabs).toMatch(/richPromptDraftPath\?: string;/);
    expect(tabs).toMatch(/rpd\?: string;/);
    expect(tabs).toMatch(/rpd: t\.richPromptDraftPath/);
  });
});
