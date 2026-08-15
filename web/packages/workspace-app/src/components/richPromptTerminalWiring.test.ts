import { describe, expect, test } from "vitest";
import app from "../App.svelte?raw";
import terminalCommands from "../state/commands/terminal.ts?raw";
import terminal from "./TerminalTab.svelte?raw";
import pane from "./Pane.svelte?raw";

function frameArm(type: string, nextType: string): string {
  const startMarker = `frame.type === "${type}") {`;
  const endMarker = `} else if (frame.type === "${nextType}")`;
  const start = terminal.indexOf(startMarker);
  const end = terminal.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`missing ${type} frame arm before ${nextType}`);
  }
  return terminal.slice(start, end);
}

function expectInOrder(source: string, ...snippets: string[]): void {
  let cursor = -1;
  for (const snippet of snippets) {
    const next = source.indexOf(snippet, cursor + 1);
    expect(next, `missing or out of order: ${snippet}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

// Rich Prompt - the terminal wiring: TerminalTab registers the prompt
// sink (WS `prompt` frame, NOT raw input), mounts the bubble over the active
// terminal, and exposes the right-click "Show/Hide Rich Prompt" entry. The
// bubble component + toggle + sender are covered in
// richPromptComponent.test.ts. Real interaction is browser-smoked.

describe("TerminalTab Rich Prompt wiring", () => {
  test("registers a prompt sink that sends the `prompt` frame (not raw input)", () => {
    expect(terminal).toMatch(/registerTerminalPromptSink\(tab\.id, sendPrompt\)/);
    expect(terminal).toMatch(
      /function sendPrompt\(data: string, agent\?: string, id\?: string\): boolean \{[\s\S]{1,260}return send\(\{ type: "prompt", data, \.\.\.\(agent \? \{ agent \} : \{\}\), \.\.\.\(id \? \{ id \} : \{\}\) \}\)/,
    );
  });

  test("queue-visibility frames: queue / prompt-ack / prompt-delivered drive tab state", () => {
    // `queue` is the absolute LOGICAL MESSAGE depth on every change, so a
    // drained batch of N notifications arrives as one N -> 0 step. The handler
    // must assign it, never adjust the badge relative to its previous value.
    expect(terminal).toMatch(
      /frame\.type === "queue"\) \{\s*setTerminalQueueDepth\(tab, frame\.depth\);/,
    );
    expect(terminal).not.toMatch(/setTerminalQueueDepth\(tab, \(tab\.queueDepth/);
    // prompt-ack resolves queued-or-rejected by id (stale/foreign ids no-op
    // in the store); prompt-delivered resolves delivered. Both carry depth.
    expect(terminal).toMatch(
      /frame\.type === "prompt-ack"\) \{[\s\S]{1,400}resolvePendingPrompt\(tab, frame\.id, frame\.queued \? "queued" : "rejected", frame\.depth\);/,
    );
    expect(terminal).toMatch(
      /frame\.type === "prompt-delivered"\) \{[\s\S]{1,260}resolvePendingPrompt\(tab, frame\.id, "delivered", frame\.depth\);/,
    );
  });

  test("session frame re-syncs queue depth on every (re)attach", () => {
    expect(terminal).toMatch(/queue_depth\?: number;/);
    expect(terminal).toMatch(/setTerminalQueueDepth\(tab, frame\.queue_depth \?\? 0\);/);
  });

  test("session frame replaces the transient server-reported submit identity", () => {
    expect(terminal).toMatch(/submit_agent\?: SubmitAgent;/);
    expectInOrder(
      frameArm("session", "renamed"),
      "setTerminalSession(tab, frame.id);",
      "setTerminalSubmitAgent(tab, frame.submit_agent);",
    );
  });

  test("Pane tab strip shows the queue-depth pill for terminal tabs", () => {
    // Same affordance family as the activity dot: only for terminal
    // tabs, only when something is queued (0 collapses to undefined in
    // the store, so truthiness alone would also work -- the explicit
    // guard documents the intent).
    expect(pane).toMatch(
      /\{#if t\.kind === "terminal" && \(t\.queueDepth \?\? 0\) > 0\}[\s\S]{1,220}title="queued terminal messages"[\s\S]{1,120}\{t\.queueDepth\}/,
    );
    // A/B sides use the same strip orientation, so there is no flipped mirror
    // selector that would need a queue-pill exception.
    expect(pane).not.toContain(".tabs.flipped");
  });

  test("socket loss and session end fail the pending prompt and zero the badge", () => {
    expect(terminal).toMatch(
      /ws\.onclose = \(\) => \{[\s\S]{1,800}failPendingPrompt\(tab\);\s*setTerminalQueueDepth\(tab, 0\);/,
    );
    // closed/exit arms: depth 0 + fail BEFORE clearTerminalSession (the
    // scrollback-snapshot clear, keyed by the now-dead session id, sits between
    // the fail and the session clear -- still before clearTerminalSession).
    expectInOrder(
      frameArm("closed", "exit"),
      "setTerminalQueueDepth(tab, 0);",
      "failPendingPrompt(tab);",
      "clearTerminalSession(tab);",
    );
    expectInOrder(
      frameArm("exit", "error"),
      "setTerminalQueueDepth(tab, 0);",
      "failPendingPrompt(tab);",
      "clearTerminalSession(tab);",
    );
  });

  test("unregisters the prompt sink on teardown", () => {
    expect(terminal).toMatch(
      /const unregisterPrompt = registerTerminalPromptSink[\s\S]{1,400}unregisterPrompt\(\)/,
    );
  });

  test("keeps <RichPrompt> mounted across tab switches, passing tab + focused", () => {
    expect(terminal).toMatch(/import RichPrompt from "\.\/RichPrompt\.svelte"/);
    // The tab is passed so the bubble binds to THIS terminal's per-terminal
    // Drafts-backed draft; visibility is per-terminal (keyed by tab id), not a
    // window-global flag. The mount guard is NOT gated on `active`: the bubble
    // stays mounted like the terminal body (hidden by the root's visibility
    // flip) so its editor keeps caret/selection/undo across a tab switch, and
    // `focused` gates autofocus so a hidden bubble never steals the keyboard.
    expect(terminal).toMatch(
      /\{#if isRichPromptVisible\(tab\.id\)\}[\s\S]{1,120}<RichPrompt \{tab\} \{focused\} \/>/,
    );
    expect(terminal).not.toMatch(/\{#if active && isRichPromptVisible\(tab\.id\)\}/);
  });

  test("discards the per-terminal Rich Prompt draft folder on terminal close", () => {
    // Draft lifecycle: the draft (draft.md + pasted media) is tied to the
    // terminal; closing the terminal deletes the whole folder so nothing leaks.
    expect(terminal).toMatch(
      /function closeTerminalForTab\(\): boolean \{[\s\S]{1,900}if \(tab\.richPromptDraftPath\) \{[\s\S]{1,120}api\.discardDraft\(tab\.richPromptDraftPath\)/,
    );
  });

  test("right-click menu has a Show/Hide Rich Prompt entry with the chord", () => {
    expect(terminal).toMatch(
      /onclick=\{toggleRichPromptFromMenu\}[\s\S]{1,260}isRichPromptVisible\(tab\.id\) \? "Hide Rich Prompt" : "Show Rich Prompt"[\s\S]{1,120}\{richPromptChord\}/,
    );
    expect(terminal).toMatch(
      /const richPromptChord = chordFor\("terminal\.richPrompt"\) \?\? ""/,
    );
  });

  test("the menu entry needs a workspace, like every other door to Rich Prompt", () => {
    // The draft lands in the workspace drafts dir, so the chord
    // (App.svelte), the catalog entry (requirement: "workspace") and this menu
    // row must agree. The row calls toggleRichPromptForTab directly, past both
    // command gates, so its own guard is the only thing standing between a
    // standalone window and a createDraft against a tenant with no drafts
    // route.
    expect(terminal).toMatch(
      /\{#if windowCaps\.workspace\}[\s\S]{1,120}onclick=\{toggleRichPromptFromMenu\}/,
    );
    expect(terminal).toMatch(
      /import \{ windowCaps \} from "\.\.\/state\/windowCaps"/,
    );
  });

  test("command launcher exposes the same Rich Prompt toggle", () => {
    expect(terminalCommands).toMatch(
      /id: "terminal\.richPrompt",[\s\S]{1,220}title: "Show\/Hide Rich Prompt",[\s\S]{1,120}category: "Terminal",[\s\S]{1,160}available: onWorkspaceTerminal,[\s\S]{1,120}dispatchChanCommand\("terminal\.richPrompt"\)/,
    );
    expect(app).toMatch(
      /case "terminal\.richPrompt": \{[\s\S]{1,160}const term = activeTerminalTab\(\);[\s\S]{1,120}if \(term\) toggleRichPromptForTab\(term\.id\);/,
    );
  });
});
