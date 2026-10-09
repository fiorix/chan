import type { TerminalTab } from "../state/tabs.svelte";

export function terminalStatusProps(tab: TerminalTab) {
  const props = $state({ tab, paneId: "terminal-test-pane", side: "a" as const, active: false, focused: false });
  return props;
}
