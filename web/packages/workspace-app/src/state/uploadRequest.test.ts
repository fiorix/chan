// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { activeTransferCount, transfers } from "./transfers.svelte";
import { cancelUploadRequest, chooseUploadRequest, dismissOlderUploads, dismissReplacedUpload, disposeUploadRequests, RECENT_UPLOAD_REPLACEMENTS, requestUpload, uploadDestination, uploadRequestCount, uploadRequestState } from "./uploadRequest.svelte";

const upload = vi.fn();
let inputs: HTMLInputElement[] = [];

function activation(active: boolean | undefined): void {
  vi.stubGlobal("navigator", Object.create(navigator, { userActivation: { value: active === undefined ? undefined : { isActive: active } } }));
}

function select(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change"));
}

beforeEach(() => {
  disposeUploadRequests();
  inputs = [];
  upload.mockReset();
  activation(false);
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) { inputs.push(this); });
});

afterEach(() => {
  disposeUploadRequests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each([false, undefined])("inactive or absent activation (%s) records a local request without a picker or transfer", (active) => {
  activation(active);
  const history = JSON.stringify(transfers.items);
  const persisted = sessionStorage.getItem("chan.transfers");
  const count = activeTransferCount();
  requestUpload("notes", "workspace", upload);
  expect(uploadRequestState.pending).toMatchObject({ path: "notes", root: "workspace", error: null });
  expect(uploadRequestCount()).toBe(1);
  expect(inputs).toEqual([]);
  expect(upload).not.toHaveBeenCalled();
  expect(activeTransferCount()).toBe(count);
  expect(JSON.stringify(transfers.items)).toBe(history);
  expect(sessionStorage.getItem("chan.transfers")).toBe(persisted);
});

test("a live activation opens synchronously, and selection uses the captured destination once", () => {
  activation(true);
  requestUpload("/outside", "filesystem", upload);
  expect(inputs).toHaveLength(1);
  expect(uploadRequestState.pending).toBeNull();
  const file = new File(["one"], "one.txt");
  select(inputs[0]!, [file]);
  select(inputs[0]!, [file]);
  expect(upload).toHaveBeenCalledExactlyOnceWith("/outside", [file], "filesystem");
  expect(inputs[0]!.isConnected).toBe(false);
});

test("Choose files retains its destination and duplicate confirmation cannot open twice", () => {
  requestUpload("notes", "workspace", upload);
  const id = uploadRequestState.pending!.id;
  chooseUploadRequest(id);
  chooseUploadRequest(id);
  expect(inputs).toHaveLength(1);
  const file = new File(["two"], "two.txt");
  select(inputs[0]!, [file]);
  expect(upload).toHaveBeenCalledExactlyOnceWith("notes", [file], "workspace");
});

test("a newer waiting command records the replacement and rejects stale actions", () => {
  requestUpload("old", "workspace", upload);
  const old = uploadRequestState.pending!.id;
  requestUpload("/new", "filesystem", upload);
  expect(uploadRequestState.pending).toMatchObject({ path: "/new", replaced: "workspace: old" });
  expect(uploadRequestState.replaced).toEqual([{ id: old, destination: "workspace: old", replacement: "filesystem: /new" }]);
  chooseUploadRequest(old);
  cancelUploadRequest(old);
  expect(inputs).toHaveLength(0);
  const id = uploadRequestState.pending!.id;
  chooseUploadRequest(id);
  select(inputs[0]!, [new File(["new"], "new.txt")]);
  expect(upload.mock.calls[0]![0]).toBe("/new");
  expect(uploadRequestCount()).toBe(1);
  dismissReplacedUpload(old);
  expect(uploadRequestCount()).toBe(0);
});

test("replacement is retained when the new command has activation and opens immediately", () => {
  requestUpload("old", "workspace", upload);
  activation(true);
  requestUpload("new", "workspace", upload);
  expect(inputs).toHaveLength(1);
  expect(uploadRequestState.pending).toBeNull();
  expect(uploadRequestState.replaced[0]).toMatchObject({ destination: "workspace: old", replacement: "workspace: new" });
});

test("an open chooser keeps its destination while newer commands replace only the waiting request", () => {
  activation(true);
  requestUpload("open", "workspace", upload);
  requestUpload("waiting", "workspace", upload);
  requestUpload("latest", "workspace", upload);
  expect(inputs).toHaveLength(1);
  const latest = uploadRequestState.pending!.id;
  select(inputs[0]!, [new File(["a"], "a.txt")]);
  expect(upload.mock.calls[0]![0]).toBe("open");
  expect(uploadRequestState.pending?.id).toBe(latest);
  expect(uploadRequestState.replaced[0]?.destination).toBe("workspace: waiting");
  chooseUploadRequest(latest);
  select(inputs[1]!, [new File(["b"], "b.txt")]);
  expect(upload.mock.calls.map((call) => call[0])).toEqual(["open", "latest"]);
});

test("a user can choose for a newer request after an immediate attempt never emits an end event", () => {
  activation(true);
  requestUpload("never-opened", "workspace", upload);
  const abandoned = inputs[0]!;
  requestUpload("attended", "workspace", upload);
  chooseUploadRequest(uploadRequestState.pending!.id);
  expect(inputs).toHaveLength(2);
  expect(abandoned.isConnected).toBe(false);
  select(abandoned, [new File(["wrong"], "wrong.txt")]);
  const selected = new File(["right"], "right.txt");
  select(inputs[1]!, [selected]);
  expect(upload).toHaveBeenCalledExactlyOnceWith("attended", [selected], "workspace");
});

test("only recent replacements retain individual records; older ones have one dismissible count", () => {
  for (let i = 0; i < 12; i++) requestUpload(`destination-${i}`, "workspace", upload);
  expect(uploadRequestState.replaced).toHaveLength(RECENT_UPLOAD_REPLACEMENTS);
  expect(uploadRequestState.replaced.map((request) => request.destination)).toEqual([6, 7, 8, 9, 10].map((i) => `workspace: destination-${i}`));
  expect(uploadRequestState.olderReplacements).toBe(6);
  expect(uploadRequestCount()).toBe(7);
  dismissOlderUploads();
  expect(uploadRequestState.olderReplacements).toBe(0);
  expect(uploadRequestState.replaced).toHaveLength(5);
});

test.each(["empty", "cancel"])("a chooser's %s ending permits the next immediate request", (ending) => {
  activation(true);
  requestUpload("first", "workspace", upload);
  if (ending === "empty") select(inputs[0]!, []);
  else inputs[0]!.dispatchEvent(new Event("cancel"));
  requestUpload("second", "workspace", upload);
  expect(inputs).toHaveLength(2);
  expect(inputs[0]!.isConnected).toBe(false);
  expect(upload).not.toHaveBeenCalled();
});

test("a synchronous click exception leaves a retryable request and cleans its input", () => {
  activation(true);
  vi.mocked(HTMLInputElement.prototype.click).mockImplementationOnce(() => { throw new Error("picker unavailable"); });
  requestUpload("retry", "workspace", upload);
  expect(document.querySelector('input[type="file"]')).toBeNull();
  expect(uploadRequestState.pending?.error).toContain("picker unavailable");
  chooseUploadRequest(uploadRequestState.pending!.id);
  expect(inputs).toHaveLength(1);
  expect(uploadRequestState.pending).toBeNull();
});

test("cancelling a waiting request and teardown do not create byte transfers or revive stale input callbacks", () => {
  requestUpload("cancel", "workspace", upload);
  cancelUploadRequest(uploadRequestState.pending!.id);
  expect(uploadRequestCount()).toBe(0);
  activation(true);
  requestUpload("open", "workspace", upload);
  requestUpload("waiting", "workspace", upload);
  requestUpload("new", "workspace", upload);
  disposeUploadRequests();
  expect(uploadRequestCount()).toBe(0);
  expect(inputs[0]!.isConnected).toBe(false);
  select(inputs[0]!, [new File(["late"], "late.txt")]);
  expect(upload).not.toHaveBeenCalled();
});

test("destination labels distinguish roots, including their empty path", () => {
  expect(uploadDestination({ path: "", root: "workspace" })).toBe("workspace: .");
  expect(uploadDestination({ path: "", root: "filesystem" })).toBe("filesystem: /");
});
