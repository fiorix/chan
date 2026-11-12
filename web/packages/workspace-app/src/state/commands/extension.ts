// The commands every extension tab has: Reload extension and Present
// extension, the rows of the tab's own menu. Each acts on the focused
// extension tab through the function its menu row calls, in
// state/extensions.svelte.ts, where the frame registry and the presentation
// state live. The commands an extension declares are registered there from
// the catalog. See state/commands.ts for the Command shape and helpers.

import {
  commandContext,
  onSurface,
  registerCommands,
  type CommandContext,
} from "../commands";
import {
  extensionFor,
  extensionHasCapability,
  extensionPresenting,
  reloadExtensionTab,
  toggleExtensionPresentation,
} from "../extensions.svelte";
import { closeCommandLauncher } from "../store.svelte";

/// Whether the focused tab is an extension tab whose extension the catalog
/// holds, optionally one that declares `capability`.
function onLiveExtension(ctx: CommandContext, capability?: "presentation"): boolean {
  if (!onSurface(ctx, "extension") || ctx.activeExtensionId === null) return false;
  const extension = extensionFor(ctx.activeExtensionId);
  return extension !== undefined && (!capability || extensionHasCapability(extension, capability));
}

function extensionGone(ctx: CommandContext): string | null {
  return ctx.activeExtensionId !== null && extensionFor(ctx.activeExtensionId) === undefined
    ? "The extension is unavailable"
    : null;
}

registerCommands([
  {
    id: "app.extension.reload",
    title: "Reload extension",
    category: "Apps",
    scope: "app",
    surface: "extension",
    order: 0,
    requirement: "workspace",
    keywords: ["refresh", "restart", "frame"],
    available: (ctx) => onLiveExtension(ctx),
    unavailableReason: extensionGone,
    run: () => {
      const { activeTabId } = commandContext();
      if (activeTabId) void reloadExtensionTab(activeTabId);
    },
  },
  {
    id: "app.extension.present",
    title: "Present extension",
    category: "Apps",
    scope: "app",
    surface: "extension",
    order: 1,
    kind: "toggle",
    requirement: "workspace",
    keywords: ["Restore extension", "presentation", "fullscreen", "maximize"],
    available: (ctx) => onLiveExtension(ctx, "presentation"),
    unavailableReason: (ctx) => extensionGone(ctx) ?? "The extension does not present",
    state: (ctx) => extensionPresenting(ctx.activeTabId),
    run: () => {
      const { activeTabId, activeExtensionId } = commandContext();
      if (!activeTabId || !activeExtensionId) return;
      toggleExtensionPresentation(activeTabId, activeExtensionId);
      // A presented frame takes the browser's top layer, above the launcher,
      // so the launcher leaves instead of staying open underneath it.
      if (extensionPresenting(activeTabId)) closeCommandLauncher();
    },
  },
]);
