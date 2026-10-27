import {
  createDeckDraft,
  loadSessionDeckDraft,
  saveSessionDeckDraft,
  SESSION_DECK_DRAFT_KEY,
  type DeckDraft,
} from "@chan/web-shared/command-deck";

// A browser/webview reload recreates the component. The agreed draft includes
// visibility, so an open inline launcher comes back open after reload.
export const commandLauncher = $state<{ draft: DeckDraft }>({
  draft: loadSessionDeckDraft(SESSION_DECK_DRAFT_KEY),
});

export function activeCommandLauncherDraft(): DeckDraft {
  return commandLauncher.draft;
}

export function persistCommandLauncherDraft(): void {
  saveSessionDeckDraft(SESSION_DECK_DRAFT_KEY, commandLauncher.draft);
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
  commandLauncher.draft = createDeckDraft();
  commandLauncher.draft.visible = visible;
  persistCommandLauncherDraft();
}

export function toggleCommandLauncher(): void {
  if (commandLauncher.draft.visible) closeCommandLauncher();
  else openCommandLauncher();
}
