import type { TransferRoot } from "../api/client";
import { errorText } from "../api/errors";
import { createCardFocus } from "../components/cardFocus";

interface UploadRequest {
  id: string;
  path: string;
  root?: TransferRoot;
  replaced: string | null;
  error: string | null;
}

interface ReplacedRequest {
  id: string;
  destination: string;
  replacement: string;
}

type Upload = (path: string, files: File[], root?: TransferRoot) => void;

export const RECENT_UPLOAD_REPLACEMENTS = 5;
export const uploadRequestState = $state<{
  pending: UploadRequest | null;
  replaced: ReplacedRequest[];
  olderReplacements: number;
}>({ pending: null, replaced: [], olderReplacements: 0 });

let nextId = 0;
let pendingUpload: Upload | null = null;
let picker: { request: UploadRequest; dispose: () => void } | null = null;

export function uploadDestination(request: Pick<UploadRequest, "path" | "root">): string {
  return request.root === "filesystem"
    ? `filesystem: ${request.path || "/"}`
    : `workspace: ${request.path || "."}`;
}

export function uploadRequestCount(): number {
  return Number(uploadRequestState.pending !== null) + uploadRequestState.replaced.length + Number(uploadRequestState.olderReplacements > 0);
}

function recordReplacement(old: UploadRequest, replacement: UploadRequest): void {
  uploadRequestState.replaced.push({ id: old.id, destination: uploadDestination(old), replacement: uploadDestination(replacement) });
  if (uploadRequestState.replaced.length > RECENT_UPLOAD_REPLACEMENTS) {
    uploadRequestState.replaced.shift();
    uploadRequestState.olderReplacements++;
  }
}

export function dismissReplacedUpload(id: string): void {
  uploadRequestState.replaced = uploadRequestState.replaced.filter((request) => request.id !== id);
}

export function dismissOlderUploads(): void {
  uploadRequestState.olderReplacements = 0;
}

/// The activation read and picker click stay in this task; a browser cannot report a silent refusal after the click.
export function requestUpload(path: string, root: TransferRoot | undefined, upload: Upload): void {
  const old = uploadRequestState.pending;
  const request: UploadRequest = { id: `upload-${++nextId}`, path, root, replaced: old ? uploadDestination(old) : null, error: null };
  if (old) recordReplacement(old, request);
  uploadRequestState.pending = request;
  pendingUpload = upload;
  if (!picker && navigator.userActivation?.isActive === true) openPicker(request, upload);
}

function openPicker(request: UploadRequest, upload: Upload): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.hidden = true;
  function dispose(): void {
    input.removeEventListener("change", change);
    input.removeEventListener("cancel", cancel);
    input.remove();
  }
  function finish(files: File[]): void {
    if (picker?.request.id !== request.id) return;
    dispose();
    picker = null;
    releaseUploadFocus(request.id);
    if (files.length) upload(request.path, files, request.root);
  }
  function change(): void { finish(Array.from(input.files ?? [])); }
  function cancel(): void { finish([]); }
  picker = { request, dispose };
  uploadRequestState.pending = null;
  pendingUpload = null;
  input.addEventListener("change", change);
  input.addEventListener("cancel", cancel);
  document.body.appendChild(input);
  try {
    input.click();
  } catch (error) {
    if (picker?.request.id !== request.id) return;
    dispose();
    picker = null;
    request.error = `Could not open the file chooser: ${errorText(error)}`;
    uploadRequestState.pending = request;
    pendingUpload = upload;
  }
}

/// Receiving this gesture proves a modal chooser is not up. Retire a stale believed-open input rather than blocking later commands forever.
export function chooseUploadRequest(id: string): void {
  const request = uploadRequestState.pending;
  const upload = pendingUpload;
  if (request?.id !== id || !upload) return;
  if (picker) {
    releaseUploadFocus(picker.request.id);
    picker.dispose();
    picker = null;
  }
  openPicker(request, upload);
}

export function cancelUploadRequest(id: string): void {
  if (uploadRequestState.pending?.id !== id) return;
  uploadRequestState.pending = null;
  pendingUpload = null;
  releaseUploadFocus(id);
}

export function uploadRequestKeydown(event: KeyboardEvent, id: string): void {
  if (event.key !== "Enter" && event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Enter") chooseUploadRequest(id);
  else cancelUploadRequest(id);
}

// One lifetime spans the request's card, panel row and native chooser. DOM replacement does not overwrite its remembered predecessor.
const focus = createCardFocus();
let focusId: string | null = null;
let surface: HTMLElement | null = null;
let ownsFocus = false;

function releaseUploadFocus(id: string): void {
  if (focusId !== id) return;
  focus.release();
  focusId = null;
  ownsFocus = false;
}

export function uploadRequestFocus(container: HTMLElement, id: string): { update: (id: string) => void; destroy: () => void } {
  const node = container.querySelector<HTMLElement>(".rc-card") ?? container;
  function take(requestId: string): void {
    const appeared = focusId !== requestId;
    if (appeared) {
      focus.release();
      focusId = requestId;
    }
    surface = node;
    if (appeared || ownsFocus) focus.take(node);
  }
  function track(): void { ownsFocus = !!surface?.contains(document.activeElement); }
  document.addEventListener("focusin", track);
  take(id);
  return {
    update: take,
    destroy() {
      if (surface === node) {
        ownsFocus = node.contains(document.activeElement) || (document.activeElement === document.body && ownsFocus);
        surface = null;
      }
      document.removeEventListener("focusin", track);
    },
  };
}

export function disposeUploadRequests(): void {
  picker?.dispose();
  picker = null;
  pendingUpload = null;
  uploadRequestState.pending = null;
  uploadRequestState.replaced = [];
  uploadRequestState.olderReplacements = 0;
  if (focusId) releaseUploadFocus(focusId);
  surface = null;
}
