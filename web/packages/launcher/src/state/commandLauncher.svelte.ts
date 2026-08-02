import {
  createDeckDraft,
  loadSessionDeckDraft,
  saveSessionDeckDraft,
  type DeckDraft,
  type DeckEntryMode,
} from "@chan/web-shared/command-deck";

const STORAGE_PREFIX = "chan.command-launcher.v1";

function storageKey(mode: DeckEntryMode): string {
  return `${STORAGE_PREFIX}:${mode}`;
}

function load(mode: DeckEntryMode): DeckDraft {
  const draft = loadSessionDeckDraft(storageKey(mode), mode);
  // A browser/webview reload recreates the component. The agreed draft includes
  // visibility, so an open inline launcher comes back open after reload.
  return draft;
}

export const commandLauncher = $state<{
  entryMode: DeckEntryMode;
  drafts: Record<DeckEntryMode, DeckDraft>;
}>({
  entryMode: "contextual",
  drafts: {
    contextual: load("contextual"),
    computers: load("computers"),
  },
});

export function activeCommandLauncherDraft(): DeckDraft {
  return commandLauncher.drafts[commandLauncher.entryMode];
}

export function persistCommandLauncherDraft(mode = commandLauncher.entryMode): void {
  saveSessionDeckDraft(storageKey(mode), commandLauncher.drafts[mode]);
}

export function openCommandLauncher(mode: DeckEntryMode = "contextual"): void {
  commandLauncher.entryMode = mode;
  const draft = commandLauncher.drafts[mode];
  draft.visible = true;
  persistCommandLauncherDraft(mode);
}

export function closeCommandLauncher(): void {
  const draft = activeCommandLauncherDraft();
  draft.visible = false;
  persistCommandLauncherDraft();
}

export function clearCommandLauncherDraft(mode = commandLauncher.entryMode): void {
  const visible = commandLauncher.drafts[mode].visible;
  commandLauncher.drafts[mode] = createDeckDraft(mode);
  commandLauncher.drafts[mode].visible = visible;
  persistCommandLauncherDraft(mode);
}

export function toggleCommandLauncher(mode: DeckEntryMode = "contextual"): void {
  if (commandLauncher.entryMode === mode && commandLauncher.drafts[mode].visible) {
    closeCommandLauncher();
  } else {
    openCommandLauncher(mode);
  }
}
