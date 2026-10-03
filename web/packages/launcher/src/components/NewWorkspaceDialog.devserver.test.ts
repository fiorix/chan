import { afterEach, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";

// A devserver's launcher has no desktop to pick a folder: its route answers
// the picker with a refusal. The capability table is what the dialog reads.
vi.mock("../state/capabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/capabilities")>()),
  surface: "devserver",
  hasDesktopBridge: false,
  selfManagedWindows: true,
}));
vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

import NewWorkspaceDialog from "./NewWorkspaceDialog.svelte";
import { closeDialog, openNewDialog } from "../state/dialog.svelte";

let app: Record<string, unknown> | null = null;

afterEach(() => {
  if (app) unmount(app);
  app = null;
  document.body.replaceChildren();
  closeDialog();
});

it("offers a folder path but no Browse… where no desktop can pick one", () => {
  openNewDialog("local");
  const target = document.body.appendChild(document.createElement("div"));
  app = mount(NewWorkspaceDialog, { target });

  expect(target.textContent, "the folder path field").toContain("Folder path");
  const buttons = [...target.querySelectorAll("button")].map((b) => b.textContent?.trim());
  expect(buttons, "the dialog's buttons").not.toContain("Browse…");
});
