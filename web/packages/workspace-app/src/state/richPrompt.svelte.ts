// Rich Prompt: PER-TERMINAL visibility for the floating markdown bubble that
// overlays a terminal's bottom. Keyed by terminal tab id: Cmd+Shift+P toggles
// the bubble on the FOCUSED pane's active terminal (App.svelte resolves it via
// activeTerminalTab; a no-op when the focused tab is not a terminal), and the
// per-terminal right-click "Show/Hide Rich Prompt" entry toggles that one
// terminal. So two terminals can each independently show their own bubble, and
// submit routes to the bubble's OWN terminal (RichPrompt.submit ->
// sendPromptToTerminal(tab.id, ...)).
//
// The prompt TEXT is not held here: each terminal's bubble is backed by a
// per-terminal chan-workspace DRAFT (`tab.richPromptDraftPath` -> a real
// `<draftsDir>/<name>/draft.md`), so the text + any pasted images live on disk and
// any MCP/disk agent can read the media as files. RichPrompt.svelte owns that
// draft binding; this module owns only which terminals currently show the
// bubble. The entry is dropped when the terminal closes
// (TerminalTab.closeTerminalForTab -> hideRichPromptForTab).
//
// Submit routes through the terminal WS `prompt` frame into the per-session
// write queue (see tabs.svelte.ts sendPromptToTerminal).

export const richPrompt = $state<{ byTab: Record<string, boolean> }>({
  byTab: {},
});

export function isRichPromptVisible(tabId: string): boolean {
  return richPrompt.byTab[tabId] === true;
}

export function showRichPromptForTab(tabId: string): void {
  richPrompt.byTab[tabId] = true;
}

export function hideRichPromptForTab(tabId: string): void {
  richPrompt.byTab[tabId] = false;
}

export function toggleRichPromptForTab(tabId: string): void {
  if (isRichPromptVisible(tabId)) hideRichPromptForTab(tabId);
  else showRichPromptForTab(tabId);
}
