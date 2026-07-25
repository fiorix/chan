// Kept as the state-layer import point because store.svelte.ts and
// editorTools.svelte.ts already share it without forming an import cycle.
export { updateGlobalConfigSerial } from "../api/preferenceWrite";
export type { PreferencesMutation } from "../api/preferenceWrite";
