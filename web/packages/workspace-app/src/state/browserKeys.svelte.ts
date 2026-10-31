const STORAGE_KEY = "chan:file-browser:vim";

function storedVim(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === "true"; }
  catch { return false; }
}

export const browserKeys = $state({ vim: storedVim() });

export function setBrowserVim(vim: boolean): void {
  browserKeys.vim = vim;
  try { localStorage.setItem(STORAGE_KEY, String(vim)); }
  catch { /* The current window can still use the selected map. */ }
}
