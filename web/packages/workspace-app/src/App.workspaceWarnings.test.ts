import { describe, expect, test } from "vitest";
import types from "../api/types.ts?raw";
import app from "../App.svelte?raw";
import statusBar from "../components/AppStatusBar.svelte?raw";
import modal from "../components/WorkspaceWarningsModal.svelte?raw";
import store from "./store.svelte.ts?raw";

describe("workspace boot warnings", () => {
  test("WorkspaceInfo carries non-fatal warning records", () => {
    expect(types).toMatch(/warnings: WorkspaceWarning\[\];/);
    expect(types).toMatch(/export type WorkspaceWarning = \{[\s\S]{1,160}kind: string;/);
  });

  test("bootstrap surfaces workspace warnings as typed status actions", () => {
    expect(store).toMatch(
      /export const workspaceWarningsDialog = \$state<[\s\S]{1,600}warnings: \[\],[\s\S]{1,220}notice: null,/,
    );
    expect(store).toMatch(
      /function surfaceWorkspaceWarnings\(info: WorkspaceInfo\): void \{[\s\S]{1,500}workspaceWarningsDialog\.warnings = warnings;[\s\S]{1,700}ui\.statusAction = \{ kind: "workspace-warnings", label \};/,
    );
    expect(store).toMatch(
      /const info = await api\.workspace\(\);[\s\S]{1,160}workspace\.info = info;[\s\S]{1,160}surfaceWorkspaceWarnings\(info\);/,
    );
    expect(store).toMatch(
      /export async function refreshWorkspace\(\): Promise<void> \{[\s\S]{1,200}surfaceWorkspaceWarnings\(info\);/,
    );
  });

  test("status bar opens warning dialog only for matching typed actions", () => {
    expect(statusBar).toMatch(
      /ui\.statusAction\?\.kind === "workspace-warnings"[\s\S]{1,120}ui\.statusAction\.label === ui\.status/,
    );
    expect(statusBar).toMatch(
      /<button[\s\S]{1,220}class="section status-msg status-action"[\s\S]{1,180}onclick=\{activateStatus\}/,
    );
    expect(statusBar).toMatch(/openWorkspaceWarningsDialog/);
  });

  test("warning dialog can copy, dismiss, and discard through draft API", () => {
    expect(app).toMatch(/import WorkspaceWarningsModal from "\.\/components\/WorkspaceWarningsModal\.svelte";/);
    expect(app).toMatch(/<WorkspaceWarningsModal \/>/);
    expect(modal).toMatch(/role="dialog"/);
    expect(modal).toMatch(/Copy path/);
    expect(modal).toMatch(/Dismiss/);
    expect(modal).toMatch(/Discard metadata/);
    expect(store).toMatch(
      /export async function discardWorkspaceWarning\(warning: WorkspaceWarning\): Promise<void> \{[\s\S]{1,500}await api\.discardDraft\(warning\.path\);[\s\S]{1,240}surfaceWorkspaceWarnings\(info\);/,
    );
  });
});
