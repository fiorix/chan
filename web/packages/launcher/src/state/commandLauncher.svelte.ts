import {
  createDeckDraft,
  loadSessionDeckDraft,
  saveSessionDeckDraft,
  type DeckDraft,
} from "@chan/web-shared/command-deck";

const STORAGE_KEY = "chan.command-launcher.v1:computers";

function load(): DeckDraft {
  return loadSessionDeckDraft(STORAGE_KEY, "computers");
}

export const commandLauncher = $state<{ draft: DeckDraft }>({ draft: load() });

export function persistCommandLauncherDraft(): void {
  saveSessionDeckDraft(STORAGE_KEY, commandLauncher.draft);
}

export function openCommandLauncher(): void {
  commandLauncher.draft.visible = true;
  persistCommandLauncherDraft();
}

export function closeCommandLauncher(): void {
  commandLauncher.draft.visible = false;
  persistCommandLauncherDraft();
}

export function clearCommandLauncherDraft(): void {
  const visible = commandLauncher.draft.visible;
  commandLauncher.draft = createDeckDraft("computers");
  commandLauncher.draft.visible = visible;
  persistCommandLauncherDraft();
}

export function toggleCommandLauncher(): void {
  if (commandLauncher.draft.visible) closeCommandLauncher();
  else openCommandLauncher();
}
