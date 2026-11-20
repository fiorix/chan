import { beforeEach, describe, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  caps: { workspace: true, files: true, drafts: true, terminal: true },
  open: vi.fn(),
  list: vi.fn(),
  openFile: vi.fn(async () => {}),
  openBrowser: vi.fn(),
  context: { current: null as null | { rootDisplay: string; rootWire: string; homeWire: string; identity: string } },
}));

vi.mock("../state/windowCaps", () => ({ windowCaps: fake.caps }));
vi.mock("../api/client", () => ({
  api: { open: fake.open, list: fake.list, metricsIdentity: vi.fn() },
  sessionWindowId: () => "w-1",
}));
vi.mock("../state/fileContext.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/fileContext.svelte")>()),
  filesContext: fake.context,
}));
vi.mock("../state/tabs.svelte", () => ({
  openInActivePane: fake.openFile,
  openBrowserInActivePane: fake.openBrowser,
}));
vi.mock("../state/store.svelte", () => ({ setTransientStatus: vi.fn() }));

import { ApiError } from "../api/errors";
import { openTerminalFileInEditor } from "./linkActions";

const entry = (path: string, is_dir = false) => ({ path, is_dir, mtime: null, size: 0 });

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(fake.caps, { workspace: true, files: true });
  fake.context.current = null;
});

describe("a workspace window", () => {
  test("opens through POST /api/open in its must-exist mode", async () => {
    fake.open.mockResolvedValue({ message: "open request queued for notes.md" });
    expect(await openTerminalFileInEditor("/srv/ws/notes.md")).toBeNull();
    expect(fake.open).toHaveBeenCalledExactlyOnceWith({ window_id: "w-1", target: "/srv/ws/notes.md", must_exist: true });
  });

  test("reads the route's 404 as not found and shows any other refusal", async () => {
    fake.open.mockRejectedValueOnce(new ApiError(404, "not found: /srv/ws/gone.md"));
    expect(await openTerminalFileInEditor("/srv/ws/gone.md")).toBe("not found");
    fake.open.mockRejectedValueOnce(new ApiError(400, "path escapes workspace root"));
    expect(await openTerminalFileInEditor("/etc/hosts")).toBe("path escapes workspace root");
  });
});

describe("a standalone window with files", () => {
  beforeEach(() => {
    Object.assign(fake.caps, { workspace: false, files: true });
    fake.context.current = { rootDisplay: "/", rootWire: "", homeWire: "home/me", identity: "lib:x|files" };
  });

  test("lists the parent and opens a file it holds", async () => {
    fake.list.mockResolvedValue([entry("home/me/notes.md"), entry("home/me/docs", true)]);
    expect(await openTerminalFileInEditor("/home/me/notes.md")).toBeNull();
    expect(fake.list).toHaveBeenCalledWith("home/me");
    expect(fake.openFile).toHaveBeenCalledWith("home/me/notes.md");
    expect(fake.open).not.toHaveBeenCalled();
  });

  test("refuses a name the parent does not hold", async () => {
    fake.list.mockResolvedValue([entry("home/me/notes.md")]);
    expect(await openTerminalFileInEditor("/home/me/gone.md")).toBe("not found");
    expect(fake.openFile).not.toHaveBeenCalled();
  });

  test("takes ~/ from its file context's home", async () => {
    fake.list.mockResolvedValue([entry("home/me/docs", true)]);
    expect(await openTerminalFileInEditor("~/docs/")).toBeNull();
    expect(fake.list).toHaveBeenCalledWith("home/me");
    expect(fake.openBrowser).toHaveBeenCalledWith({ select: "home/me/docs" });
  });
});

test("a window with no files refuses before any call", async () => {
  Object.assign(fake.caps, { workspace: false, files: false });
  expect(await openTerminalFileInEditor("/srv/notes.md")).toBe("this window opens no files");
  expect(fake.open).not.toHaveBeenCalled();
  expect(fake.list).not.toHaveBeenCalled();
});
