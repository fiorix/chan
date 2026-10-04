// Browser-side byte download: hand in-memory bytes to the browser's
// download manager via a temporary object-URL anchor. The web
// counterpart of the desktop `saveBytesToDownloads` IPC (which saves
// through the native Downloads pipeline and transfer indicator).

/// Trigger a browser download of `blob` as `filename`.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Let the click start before releasing the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/// Trigger a browser download of `bytes` as `filename`.
export function downloadBytes(
  bytes: Uint8Array,
  filename: string,
  mime = "application/octet-stream",
): void {
  downloadBlob(new Blob([bytes as BlobPart], { type: mime }), filename);
}
