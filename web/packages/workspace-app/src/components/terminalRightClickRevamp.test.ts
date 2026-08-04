import { describe, expect, test } from "vitest";
import terminal from "./TerminalTab.svelte?raw";

// TerminalTab right-click menu shape. Tests pin the structure;
// behavioral coverage (Mod+L equivalents, the broadcast checkbox
// flow) belongs in TerminalTab.test.ts. The tab menu has:
//
// * Status row "connected: <detail>" (colon, not em dash).
// * Name, Group, status, and broadcast controls.
// * Close after a separator.
//
// The body menu starts with the live terminal engine and per-tab secret
// masking control, then carries Find / Copy / Paste / Copy Scrollback,
// while command-discovery rows live in the command launcher.
// * No Reload Window / Open Inspector entries.
// * MCP info-button opens a modal dialog.

describe("status row colon", () => {
  test("status row uses colon-separator (no em dash)", () => {
    expect(terminal).toMatch(/statusDetail \? `: \$\{statusDetail\}`/);
    expect(terminal).not.toMatch(/statusDetail \? ` - \$\{statusDetail\}`/);
  });

  test("Name then Group rows precede the status row", () => {
    // Name row, then the Group row (broadcast group, restart-gated), then
    // the status row. The Group row's restart prompt is conditional, so
    // allow it (or its absence) before the status comment.
    expect(terminal).toMatch(
      /<label class="rename-row">[\s\S]{1,800}<span>Name<\/span>[\s\S]{1,800}<\/label>\s*<label class="rename-row">[\s\S]{1,400}<span>Group<\/span>[\s\S]{1,1000}<\/label>[\s\S]{1,800}<!-- Status reads "connected: <detail>"[\s\S]{1,200}<div class="terminal-status-row">/,
    );
  });
});

describe("removed tab-menu command-discovery rows", () => {
  test("From-$CWD spawn band is gone", () => {
    expect(terminal).not.toMatch(/class="from-cwd-label">From \$CWD/);
    expect(terminal).not.toMatch(/function openNewTerminal\(\): void \{/);
    expect(terminal).not.toMatch(/function openNewFileBrowser\(\): void \{/);
    expect(terminal).not.toMatch(/function openNewGraph\(\): void \{/);
    expect(terminal).not.toMatch(/<span class="mbtn-label">New File<\/span>/);
    expect(terminal).not.toMatch(/<span class="mbtn-label">New Terminal<\/span>/);
    expect(terminal).not.toMatch(/<span class="mbtn-label">New File Browser<\/span>/);
    expect(terminal).not.toMatch(/<span class="mbtn-label">New Graph<\/span>/);
  });

  test("Restart and Copy path to $CWD tab-menu rows are gone", () => {
    expect(terminal).not.toMatch(/<span class="mbtn-label">Restart<\/span>/);
    expect(terminal).not.toMatch(/<span class="mbtn-label">Start New Session<\/span>/);
    expect(terminal).not.toMatch(/<span class="mbtn-label">Copy path to \$CWD<\/span>/);
  });

  test("no per-terminal MCP env toggle remains in the menu", () => {
    expect(terminal).not.toContain("mcp-env-row");
    expect(terminal).not.toContain("Set MCP env vars");
  });
});

describe("terminal body-context vs tab-context split", () => {
  test("body right-click opens the body source", () => {
    expect(terminal).toMatch(
      /function onTerminalContextMenu[\s\S]{1,200}openTabMenu\([\s\S]{1,300}"body",/,
    );
  });

  test("body menu carries masking plus the tight Find / Copy / Paste / Copy Scrollback set", () => {
    // The body branch renders the ephemeral masking control and these four;
    // the tab branch no longer carries them. Pin their order and presence.
    expect(terminal).toContain('{#if tabMenu.source === "body"}');
    expect(terminal).toMatch(
      /tabMenu\.source === "body"[\s\S]{1,1200}onclick=\{toggleSecretMasking\}[\s\S]{1,800}onclick=\{openFind\}[\s\S]{1,400}onclick=\{copySelectionOrScrollback\}[\s\S]{1,400}onclick=\{pasteClipboard\}[\s\S]{1,400}onclick=\{copyScrollback\}/,
    );
  });

  test("body menu starts with the live post-fallback backend", () => {
    expect(terminal).toMatch(
      /tabMenu\.source === "body"[\s\S]{1,500}class="terminal-backend-label" data-terminal-backend=\{backend\}[\s\S]{1,200}\{backend\}[\s\S]{1,1000}onclick=\{toggleSecretMasking\}[\s\S]{1,1000}<div class="msep" role="separator"><\/div>/,
    );
  });

  test("new xterm tabs seed from the persisted boolean with omitted default off", () => {
    expect(terminal).toMatch(/let secretMaskingEnabled = \$state\(false\)/);
    expect(terminal).toMatch(
      /async function start\(\): Promise<void> \{[\s\S]{1,1200}secretMaskingEnabled = terminalPrefs\?\.secret_masking \?\? false/,
    );
    expect(terminal).toMatch(
      /new TerminalSecretMasker\([\s\S]{1,300}secretMaskingEnabled/,
    );
  });

  test("component recreation runs start and reseeds masking from configuration", () => {
    expect(terminal).toMatch(
      /\$effect\(\(\) => \{\s*if \(!host \|\| term\) return;\s*void tick\(\)\.then\(start\);\s*return teardown;\s*\}\)/,
    );
  });

  test("the menu and command masking toggle stays ephemeral and xterm-only", () => {
    const toggle = terminal.match(
      /function toggleSecretMasking\(\): void \{([\s\S]*?)\n  \}/,
    )?.[1];
    expect(toggle).toBeDefined();
    expect(toggle).toMatch(/backend !== "xterm"/);
    expect(toggle).toContain("Secret masking unavailable on ghostty backend");
    expect(toggle).toMatch(/secretMasker\?\.setEnabled\(secretMaskingEnabled\)/);
    expect(toggle).not.toMatch(/api\.|localStorage|sessionStorage/);
    expect(terminal).toMatch(
      /name === "app\.terminal\.secretMasking\.toggle"\) toggleSecretMasking\(\)/,
    );
  });
});

describe("Close anchors the foot", () => {
  test("Close menu entry wired to closeFromMenu", () => {
    expect(terminal).toMatch(
      /onclick=\{closeFromMenu\}[\s\S]{1,400}<span class="mbtn-label">Close<\/span>/,
    );
  });

  test("closeFromMenu invokes closeTab with paneId + tab.id", () => {
    expect(terminal).toMatch(
      /function closeFromMenu\(\): void \{[\s\S]{1,200}closeTabMenu\(\);[\s\S]{1,200}void closeTab\(paneId, tab\.id\);/,
    );
  });

  test("broadcast section is followed by separator + Close", () => {
    expect(terminal).toMatch(
      /\{#if crossWindowMembers\.length > 0\}[\s\S]{1,2000}\{\/if\}\s*<div class="msep" role="separator"><\/div>\s*<button class="mbtn" onclick=\{closeFromMenu\}>/,
    );
  });

  test("Settings and Reopen rows are gone", () => {
    expect(terminal).not.toMatch(/onclick=\{flipToSettings\}/);
    expect(terminal).not.toMatch(/<span class="mbtn-label">Settings<\/span>/);
    expect(terminal).not.toMatch(/onclick=\{doReopenClosedTab\}/);
    expect(terminal).not.toMatch(/<span class="mbtn-label">Reopen Closed Tab<\/span>/);
  });
});
