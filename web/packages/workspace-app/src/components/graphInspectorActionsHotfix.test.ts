import { describe, expect, test } from "vitest";
import panel from "./GraphPanel.svelte?raw";
import canvas from "./GraphCanvas.svelte?raw";

// Graph inspector action hotfix. The reload $effect read `currentScope`
// (a $derived), which was recomputed from the pane-derived scope list and
// returned an equal-but-new object whenever a layout change occurred.
// "Open" and "Show File" both triggered that churn and re-fired the
// reload. The fix anchors the reload effect on a stable loadKey value.

describe("graph reload is anchored on scope/depth/mode, not layout churn", () => {
  test("a stable loadKey derives from scopeId + depth + mode only", () => {
    // The loadKey must not include the layout-derived currentScope object,
    // whose identity changes when an editor tab opens or a reveal happens.
    expect(panel).toMatch(
      /const loadKey = \$derived\(\s*`\$\{graphState\.scopeId\}\|\$\{graphState\.depth\}\|\$\{graphState\.mode\}`,?\s*\)/,
    );
  });

  test("the reload effect tracks visible + loadKey and runs load() untracked", () => {
    // Reading visible + loadKey up front registers exactly those two as
    // dependencies. untrack() around load() prevents load()'s internal
    // reads (currentScope, filters...) from becoming reload triggers.
    // Lazy-first + dirty gating (keep-alive) sits between the trigger
    // reads and the load() call without widening the contract: those
    // two are the only deps, and load() runs untracked.
    expect(panel).toMatch(/const show = visible;\s*const key = loadKey;/);
    expect(panel).toMatch(/untrack\(\(\) => void load\(\)\);/);
  });

  test("untrack is imported from svelte", () => {
    expect(panel).toMatch(/import \{ onDestroy, tick, untrack \} from "svelte";/);
  });
});

describe("Open routes a file to the editor and a directory to a File Browser tab, not a graph reload", () => {
  test("the nav contract: graphFromHere spawns a NEW graph tab (no in-place re-root)", () => {
    // The old contract re-rooted in place (mutating graphState +
    // selectedId). The new contract spawns a fresh semantic graph tab
    // seeded at the clicked node via openGraphInActivePane, leaving the
    // current graph untouched.
    expect(panel).toMatch(
      /function graphFromHere\(path: string, isDir: boolean\): void \{[\s\S]*?openGraphInActivePane\(\{\s*mode: "semantic",\s*scopeId,\s*depth: 1,\s*pendingSelectId: path,\s*\}\)/,
    );
    // openGraphInActivePane is the tab-spawn primitive, imported from
    // the tabs state module (replacing the old in-place mutation).
    expect(panel).toMatch(/openGraphInActivePane/);
    expect(panel).toMatch(/from "\.\.\/state\/tabs\.svelte"/);
    // The deleted in-place re-root no longer mutates the current tab.
    expect(panel).not.toMatch(
      /function graphFromHere[\s\S]*?graphState\.scopeId = scopeId;[\s\S]*?selectedId = path;/,
    );
  });

  test("the semantic-node inspector binds onOpen to the editor for file selections", () => {
    // "Open" on a file routes through openFileOrReveal, which opens the
    // editor pane (openInActivePane) for an editable text file, matching
    // the File Browser's open-selection, and falls back to a File Browser
    // tab for a binary. This replaced the File-Browser-tab-only
    // revealPathInBrowserTab bind of the prior contract.
    expect(panel).toMatch(
      /onOpen=\{\s*inspectorSelection\?\.kind === "file"\s*\?\s*\(\) => openFileOrReveal\(inspectorSelection\.path\)/,
    );
    // The deleted editor-open helper name is gone everywhere.
    expect(panel).not.toMatch(/openSelectedFile/);
  });

  test("the fs-mode inspector binds onOpen to the editor for file nodes", () => {
    // A file node "Open" routes through openFileOrReveal: an editable
    // text file opens in the editor pane. The fs layer's file-kind nodes
    // carry no text/binary split, so the editable verdict comes from the
    // tree entry's server kind; a binary falls back to a File Browser
    // tab. Directories use onReveal.
    expect(panel).toMatch(
      /onOpen=\{fsKind === "file" \? \(\) => openFileOrReveal\(fsPath\) : undefined\}/,
    );
    // openFileOrReveal routes editable text to the editor pane, binary to
    // a File Browser tab, mirroring the File Browser predicate.
    expect(panel).toMatch(
      /function openFileOrReveal\(path: string\): void \{[\s\S]*?isOpenableTextKind\(kind\)[\s\S]*?void openInActivePane\(path\);[\s\S]*?revealPathInBrowserTab\(path, false\);/,
    );
  });
});

describe("Open / Reveal spawn a File Browser tab via revealPathInBrowserTab, not a graph reload", () => {
  test("the surviving reveal primitive routes through revealPathInBrowserTab (browser tab)", () => {
    // Reveal opens a File Browser TAB via openBrowserInActivePane, not
    // the overlay-era revealPathInBrowser + close(). The dedicated
    // revealSelectedFile / revealSelectedFsEntry helpers were deleted;
    // revealPathInBrowserTab(path, isDir) is the single reveal-into-a-
    // new-FB-tab primitive the inspector binds directly.
    expect(panel).toMatch(
      /function revealPathInBrowserTab\(path: string, isDir: boolean\): void \{[\s\S]*?openBrowserInActivePane\(isRoot \? \{\} : \{ select: path \}\)/,
    );
    expect(panel).not.toMatch(/function revealSelectedFile\(/);
    expect(panel).not.toMatch(/function revealSelectedFsEntry\(/);
  });

  test("the fs-mode inspector binds onReveal to revealPathInBrowserTab for directories", () => {
    // Directories pass isDir=true so the browser expands the dir itself;
    // files expand ancestors. Detailed branch pins are in
    // graphDirInspectorHotfix.test.ts.
    expect(panel).toMatch(
      /onReveal=\{fsIsDir \? \(\) => revealPathInBrowserTab\(fsPath, true\) : undefined\}/,
    );
  });

  test("the semantic inspector binds onReveal to revealPathInBrowserTab for directories", () => {
    // A directory selection's "Open" routes through FileInfoBody's
    // openDirInBrowser → onReveal, spawning a File Browser tab AT the
    // directory (isDir=true). Non-directory selections leave onReveal
    // undefined (file uses onOpen above).
    expect(panel).toMatch(
      /onReveal=\{\s*inspectorSelection\?\.kind === "directory"[\s\S]*?\(\) => revealPathInBrowserTab\(inspectorSelection\.path, true\)/,
    );
  });
});

describe("directory nodes are slightly bigger than leaf nodes", () => {
  test("RADIUS_DIR sits between the leaf base and the doc/workspace hub size", () => {
    expect(canvas).toMatch(/const RADIUS_BASE = 5;/);
    expect(canvas).toMatch(/const RADIUS_DIR = 6;/);
    expect(canvas).toMatch(/const RADIUS_DOC = 7;/);
  });

  test("renderRadius gives folder nodes the RADIUS_DIR base and workspace its own 1.5x size", () => {
    // Workspace root is sized 1.5x the worst-case hub-scaled dir
    // (RADIUS_DIR * RADIUS_HUB_SCALE * 1.5) so the gap holds even
    // when top-level dirs are hub-scaled. Workspace skips the backlink
    // ramp so its size is exactly RADIUS_WORKSPACE.
    expect(canvas).toMatch(
      /const RADIUS_WORKSPACE = RADIUS_DIR \* RADIUS_HUB_SCALE \* 1\.5;/,
    );
    expect(canvas).toMatch(
      /kind === "workspace"\s*\?\s*RADIUS_WORKSPACE\s*:\s*kind === "doc"\s*\?\s*RADIUS_DOC\s*:\s*kind === "folder"\s*\?\s*RADIUS_DIR\s*:\s*RADIUS_BASE/,
    );
    expect(canvas).toMatch(
      /if \(kind === "workspace"\) return base;[\s\S]{1,400}if \(maxBacklinks <= 0\) return base;/,
    );
  });
});
