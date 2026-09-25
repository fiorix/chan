import { describe, expect, test } from "vitest";
import tabs from "../state/tabs.svelte.ts?raw";
import graph from "./GraphPanel.svelte?raw";

// Team Work entrypoint check:
//
// 1. Cmd+P instantiates a fresh Team Work Lead Terminal (a new
//    terminal with the embedded editor armed open) and returns it
//    so the dialog flow can delete it on Cancel. It no longer
//    toggles a prompt on the current terminal.
//
// 2. Depth slider shallow-scope cue: when depthCap <= 1, render
//    a `[max]` suffix so the user sees the slider is already at
//    max without needing to drag.

describe("Cmd+P Team Work lead terminal", () => {
  test("createTeamWorkLeadTerminal spawns a fresh (normal) terminal in the active pane and returns it", () => {
    // The Team Work bubble is gone: the lead is a normal terminal (the
    // orchestrator delivers its identity prompt via the queue), so this just
    // spawns + returns - no openActiveTeamWork. It also flags the spawned tab
    // `teamWorkPending` with the dialog's initial config so a reload reopens
    // the dialog over it (#4 reload-survival).
    expect(tabs).toMatch(
      /export function createTeamWorkLeadTerminal\([\s\S]*?opts: OpenTerminalOptions = \{\},[\s\S]*?\): TerminalTab \| null \{[\s\S]*?const p = activePane\(\);[\s\S]*?openTerminalInPane\(p\.id, opts\);[\s\S]*?teamWorkPending = defaultTeamConfig\(\);[\s\S]*?return tab;/,
    );
    expect(tabs).not.toMatch(/openActiveTeamWork/);
  });

  test("no active-terminal toggle branch (fresh terminal each time)", () => {
    expect(tabs).not.toMatch(/activeTab\.teamWork\?\.open/);
    expect(tabs).not.toMatch(/teamWork\.open = false/);
  });
});

describe("depth-slider shallow-scope cue", () => {
  test("derived depthShallow gate: only for non-language non-disabled scopes where depthCap <= 1", () => {
    // Hoisted as a top-level `$derived.by` so it can workspace both
    // the `disabled` attribute on the slider AND the markup
    // cue without invoking `{@const}` outside an allowed
    // parent block.
    expect(graph).toMatch(
      /const depthShallow = \$derived\.by\(\(\) => \{[\s\S]*?if \(languageMode\) return false;[\s\S]*?return depthCap <= 1;/,
    );
  });

  test("slider input is disabled when shallow (no point dragging)", () => {
    expect(graph).toMatch(/disabled=\{depthDisabled \|\| depthShallow\}/);
  });

  test("depth-row gets a .shallow class + tooltip when shallow", () => {
    expect(graph).toMatch(/class:shallow=\{depthShallow\}/);
    expect(graph).toMatch(
      /title=\{depthShallow[\s\S]*?Scope is shallow[\s\S]*?depth 1 already reveals/,
    );
  });

  test("depth value renders `[max]` cue when shallow", () => {
    expect(graph).toMatch(
      /\{:else if depthShallow\}[\s\S]*?\{graphState\.depth\} <span class="depth-cue">\[max\]<\/span>/,
    );
  });

  test("CSS rule for .depth-cue exists (dimmer + smaller than the numeric value)", () => {
    expect(graph).toMatch(/\.tab-menu-bubble \.depth-cue \{[\s\S]*?opacity: 0\.7;/);
  });
});
