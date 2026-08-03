import { describe, expect, test } from "vitest";
import app from "../App.svelte?raw";
import client from "../api/client.ts?raw";
import shortcuts from "../state/shortcuts.ts?raw";
import tabs from "../state/tabs.svelte.ts?raw";

// SPA Cmd+N creates a draft via /api/drafts/new and opens it in the
// active pane.

describe("api.createDraft helper", () => {
  test("createDraft posts to /api/drafts/new + returns { path, name }", () => {
    // The optional kind rides the JSON body ({"kind":"slides"} seeds a
    // slide deck); the plain call sends no body at all, keeping the
    // original markdown-draft contract.
    expect(client).toMatch(
      /createDraft: \(kind\?: "slides"\) =>[\s\S]*?req<\{ path: string; name: string \}>\([\s\S]*?"POST",[\s\S]*?"\/api\/drafts\/new",[\s\S]*?kind \? \{ kind \} : undefined,/,
    );
  });
});

describe("app.draft.new shortcut registry", () => {
  test("app.draft.new has no built-in chord after no-defaults", () => {
    // The Mod+N default was dropped: New draft stays reachable via Hybrid Nav
    // and the launcher, and is assignable in the config UI, so no
    // app.draft.new entry remains in the SHORTCUTS registry.
    expect(shortcuts).not.toContain('id: "app.draft.new"');
  });
});

describe("New draft command wiring", () => {
  test("New draft is via the app.draft.new command, not a Cmd+N chord", () => {
    // The no-defaults round dropped the Cmd+N default; New draft is reached
    // through the launcher / chan:command -> runCommand path. No newDraftChord
    // keydown branch remains.
    expect(app).not.toMatch(/const newDraftChord =/);
    expect(app).toMatch(
      /case "app\.draft\.new":[\s\S]{1,80}void createDraftAndOpen\(\);/,
    );
  });

  test("createDraftAndOpen calls api.createDraft then opens with title selected", () => {
    expect(app).toMatch(
      /async function createDraftAndOpen\(\): Promise<void> \{[\s\S]*?const \{ path \} = await api\.createDraft\(\);[\s\S]*?await noteDraftCreated\(path\);[\s\S]*?await openInActivePane\(path, \{[\s\S]*?initialSelection: NEW_DRAFT_TITLE_SELECTION,/,
    );
  });

  test("createDraftAndOpen surfaces errors via transient status", () => {
    expect(app).toMatch(
      /async function createDraftAndOpen\(\)[\s\S]*?catch \(err\) \{[\s\S]*?console\.warn\([\s\S]*?setTransientStatus\(`New draft failed:/,
    );
  });

  test("staged draft materialization also refreshes Drafts state before opening", () => {
    expect(app).toMatch(
      /const \{ path \} =[\s\S]*?entry\.kind === "diagram"[\s\S]*?await api\.createDiagram\(\)[\s\S]*?: await api\.createDraft\(\);[\s\S]*?await noteDraftCreated\(path\);[\s\S]*?await openInPane\(destination\.paneId, path, \{[\s\S]*?side: destination\.side,[\s\S]*?initialSelection: NEW_DRAFT_TITLE_SELECTION/,
    );
  });

  test("new draft selection spans the seeded Draft heading text", () => {
    expect(app).toMatch(
      /const NEW_DRAFT_TITLE_SELECTION = \{[\s\S]*?from: "# "\.length,[\s\S]*?to: "# Draft"\.length,/,
    );
  });

  test("openInPane applies optional initial selection to new tabs", () => {
    expect(tabs).toMatch(
      /type OpenFileOptions = \{[\s\S]*?initialSelection\?: EditorSelection;/,
    );
    expect(tabs).toMatch(
      /if \(opts\.initialSelection\) newTab\.caret = \{ \.\.\.opts\.initialSelection \};/,
    );
  });

  test("api imported from api/client", () => {
    // Tolerates co-imports on the same line (e.g. openLocalColorWatch); the
    // intent is just that `api` is sourced from ./api/client.
    expect(app).toMatch(/import \{[^}]*\bapi\b[^}]*\} from "\.\/api\/client";/);
  });
});
