import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import fileInfo from "./FileInfoBody.svelte?raw";
import workspaceInfo from "./WorkspaceInfoBody.svelte?raw";

// Read through `fs` rather than `?raw`: Vite denies an import that escapes the
// web root, and this assertion deliberately reaches across into the server.
// Same package-relative form as `terminal/protocol.test.ts`.
const serverRouter = readFileSync(
  "../../../crates/chan-server/src/lib.rs",
  "utf8",
);

// The inspector is shown on two surfaces that BOTH exist without a workspace:
// the file browser and the editor's details panel. Its two data sources do
// not: `/api/report/*` and `/api/inspector` are mounted on the workspace
// router only, so on a files window every request 404s.
//
// The directory branch turned that into two doomed requests per selection: a
// 404 from `reportDir` is the documented signal to fall back to the walking
// `reportPrefix`, so the fallback fired on the tenant that has neither. The
// visible result was "report unavailable: ..." in a panel whose Code section
// should simply be absent.
describe("inspector workspace-only loads", () => {
  test("both bodies gate their loads on the workspace capability", () => {
    for (const [name, source] of [
      ["FileInfoBody", fileInfo],
      ["WorkspaceInfoBody", workspaceInfo],
    ] as const) {
      expect(source, `${name} imports the capability`).toContain(
        'import { windowCaps } from "../state/windowCaps";',
      );
      // One guard for the inspector effect, one for the report effect.
      const guards = source.match(/if \(!windowCaps\.workspace\)/g);
      expect(guards?.length, `${name} guards both effects`).toBe(2);
    }
  });

  test("the report guard clears the loading flag rather than stranding it", () => {
    // Returning with `reportLoading` still true would render "loading
    // report..." forever instead of no section at all.
    for (const source of [fileInfo, workspaceInfo]) {
      expect(source).toMatch(
        /if \(!windowCaps\.workspace\) \{\s*reportLoading = false;\s*return;\s*\}/,
      );
    }
  });

  test("the routes these bodies call are still workspace-router only", () => {
    // The guards above are correct only while this holds. If `/api/inspector`
    // or `/api/report/*` are ever mounted on the terminal tenant, the gate
    // becomes a needless restriction and should be revisited rather than
    // silently kept.
    const terminalRouter = serverRouter.slice(
      serverRouter.indexOf("fn terminal_router("),
      serverRouter.indexOf("fn router_with_extensions("),
    );
    expect(terminalRouter.length).toBeGreaterThan(0);
    expect(terminalRouter).not.toContain("/api/inspector");
    expect(terminalRouter).not.toContain("/api/report/");
  });
});
