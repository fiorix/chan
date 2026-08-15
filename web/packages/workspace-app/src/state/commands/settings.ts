// The settings command opens the configuration surface. It calls its action
// directly from the launcher; the default and assigned chords route through
// App.svelte so host dispatch and keyboard dispatch share the same command id.
// Machine-global config stays available in every window, including standalone
// terminals. See state/commands.ts for the Command shape and helpers.

import { registerCommands } from "../commands";
import { openSettings } from "../store.svelte";

registerCommands([
  {
    id: "app.settings.open",
    title: "Settings",
    category: "Global",
    requirement: "any",
    keywords: ["preferences", "configuration", "config", "options"],
    icon: "settings",
    available: () => true,
    run: () => openSettings(),
  },
]);
