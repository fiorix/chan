<script lang="ts">
  // Screen lock for the "This workspace" settings tab. Auto-locks the
  // workspace view after inactivity with an optional local PIN (salted by the
  // workspace root, so it is per-workspace). It owns enable/timeout/theme
  // patches, the PIN set/confirm/clear dialog, a Test action, and the theme
  // preview.

  import { onMount } from "svelte";
  import {
    hashPin,
    SCREENSAVER_MAX_TIMEOUT_SECS,
    SCREENSAVER_MIN_TIMEOUT_SECS,
    type ScreensaverTheme,
  } from "../../../state/screensaver";
  import {
    loadScreensaverState,
    lockNow,
    screensaver,
  } from "../../../state/screensaver.svelte";
  import { api } from "../../../api/client";
  import { workspace } from "../../../state/store.svelte";
  import SettingField from "../SettingField.svelte";
  import PillToggle from "../PillToggle.svelte";
  import NumberField from "../NumberField.svelte";
  import MatrixRainPreview from "../../screensaver/MatrixRainPreview.svelte";
  import PlainScreensaverPreview from "../../screensaver/PlainScreensaverPreview.svelte";

  let screensaverEnabled = $state<boolean | null>(null);
  let screensaverTimeoutSecs = $state<number>(300);
  let screensaverTheme = $state<ScreensaverTheme>("plain");
  let screensaverPinSet = $state(false);
  let screensaverBusy = $state(false);
  let screensaverError = $state<string | null>(null);
  /// PIN edit buffer. `null` when not showing the dialog; otherwise carries
  /// the pin1/pin2 confirm pair.
  let pinDialog = $state<{ pin1: string; pin2: string } | null>(null);

  async function loadScreenLockState(): Promise<void> {
    try {
      const s = await api.screensaverState();
      screensaverEnabled = s.enabled;
      screensaverTimeoutSecs = s.timeout_secs;
      screensaverTheme = s.theme;
      screensaverPinSet = s.pin_set;
    } catch (err) {
      screensaverError = `screensaver: ${(err as Error).message ?? err}`;
    }
  }

  async function toggleScreensaverEnabled(): Promise<void> {
    if (screensaverEnabled === null || screensaverBusy) return;
    screensaverBusy = true;
    screensaverError = null;
    try {
      const target = !screensaverEnabled;
      const s = await api.screensaverPatch({ enabled: target });
      screensaverEnabled = s.enabled;
      screensaverTimeoutSecs = s.timeout_secs;
      screensaverTheme = s.theme;
      screensaverPinSet = s.pin_set;
      await loadScreensaverState();
    } catch (err) {
      screensaverError = `toggle failed: ${(err as Error).message ?? err}`;
    } finally {
      screensaverBusy = false;
    }
  }

  /// NumberField hands over the clamped value and which bound clamped
  /// it; a clamp onto a new value saves with the validation message
  /// kept visible, and a clamp onto the stored value shows the message
  /// without a redundant patch.
  async function commitTimeout(
    next: number | null,
    clampedTo: "min" | "max" | null,
  ): Promise<void> {
    if (screensaverBusy || next === null) return;
    screensaverError =
      clampedTo === "min"
        ? `Timeout must be at least ${SCREENSAVER_MIN_TIMEOUT_SECS}s`
        : clampedTo === "max"
          ? `Timeout must be at most ${SCREENSAVER_MAX_TIMEOUT_SECS}s`
          : null;
    // The clamp message above still stands when the entry lands on the
    // stored value; an unchanged timeout has nothing to patch.
    if (next === screensaverTimeoutSecs) return;
    screensaverBusy = true;
    const validationMessage = screensaverError;
    try {
      const s = await api.screensaverPatch({ timeout_secs: next });
      screensaverEnabled = s.enabled;
      screensaverTimeoutSecs = s.timeout_secs;
      screensaverTheme = s.theme;
      screensaverPinSet = s.pin_set;
      screensaverError = validationMessage;
      await loadScreensaverState();
    } catch (err) {
      screensaverError = `timeout save failed: ${(err as Error).message ?? err}`;
    } finally {
      screensaverBusy = false;
    }
  }

  async function commitScreensaverTheme(e: Event): Promise<void> {
    if (screensaverBusy) return;
    const theme = (e.currentTarget as HTMLSelectElement).value as ScreensaverTheme;
    screensaverBusy = true;
    screensaverError = null;
    try {
      const s = await api.screensaverPatch({ theme });
      screensaverEnabled = s.enabled;
      screensaverTimeoutSecs = s.timeout_secs;
      screensaverTheme = s.theme;
      screensaverPinSet = s.pin_set;
      await loadScreensaverState();
    } catch (err) {
      screensaverError = `theme save failed: ${(err as Error).message ?? err}`;
    } finally {
      screensaverBusy = false;
    }
  }

  function openPinDialog(): void {
    pinDialog = { pin1: "", pin2: "" };
  }

  function cancelPinDialog(): void {
    pinDialog = null;
  }

  async function commitPin(): Promise<void> {
    if (!pinDialog || screensaverBusy) return;
    const { pin1, pin2 } = pinDialog;
    if (!pin1) {
      screensaverError = "Enter a PIN";
      return;
    }
    if (pin1 !== pin2) {
      screensaverError = "PINs don't match";
      return;
    }
    screensaverBusy = true;
    screensaverError = null;
    try {
      const salt = workspace.info?.root ?? "";
      const hash = await hashPin(pin1, salt);
      const s = await api.screensaverSetPin(hash);
      screensaverEnabled = s.enabled;
      screensaverTimeoutSecs = s.timeout_secs;
      screensaverTheme = s.theme;
      screensaverPinSet = s.pin_set;
      pinDialog = null;
      await loadScreensaverState();
    } catch (err) {
      screensaverError = `PIN save failed: ${(err as Error).message ?? err}`;
    } finally {
      screensaverBusy = false;
    }
  }

  async function clearPin(): Promise<void> {
    if (screensaverBusy) return;
    screensaverBusy = true;
    screensaverError = null;
    try {
      const s = await api.screensaverClearPin();
      screensaverEnabled = s.enabled;
      screensaverTimeoutSecs = s.timeout_secs;
      screensaverTheme = s.theme;
      screensaverPinSet = s.pin_set;
      await loadScreensaverState();
    } catch (err) {
      screensaverError = `PIN clear failed: ${(err as Error).message ?? err}`;
    } finally {
      screensaverBusy = false;
    }
  }

  async function testScreenLock(): Promise<void> {
    if (screensaverBusy) return;
    screensaverError = null;
    await loadScreensaverState();
    if (!screensaver.loaded) {
      screensaverError = "screen lock state unavailable";
      return;
    }
    lockNow();
  }

  onMount(() => {
    void loadScreenLockState();
  });
</script>

<SettingField
  label="Screen lock"
  hint="Auto-lock the workspace view after inactivity. Local-only PIN protection (Mod+L locks now)."
>
  <div class="stack">
    <PillToggle
      label={screensaverEnabled === null
        ? "loading..."
        : screensaverBusy
          ? "flipping..."
          : screensaverEnabled
            ? "On"
            : "Off"}
      checked={screensaverEnabled === true}
      disabled={screensaverEnabled === null || screensaverBusy}
      ontoggle={() => void toggleScreensaverEnabled()}
    />
    {#if screensaverError}
      <p class="hint err" role="alert">{screensaverError}</p>
    {/if}
    {#if screensaverEnabled === true}
      <div class="screensaver-config">
        <label class="screensaver-timeout">
          <span>Inactivity timeout (seconds):</span>
          <NumberField
            value={screensaverTimeoutSecs}
            min={SCREENSAVER_MIN_TIMEOUT_SECS}
            max={SCREENSAVER_MAX_TIMEOUT_SECS}
            step={30}
            disabled={screensaverBusy}
            ariaLabel="Inactivity timeout in seconds"
            oncommit={(next, clampedTo) => void commitTimeout(next, clampedTo)}
          />
        </label>
        <div class="screensaver-pin-controls">
          {#if pinDialog === null}
            <button type="button" onclick={testScreenLock} disabled={screensaverBusy}>
              Test
            </button>
            {#if screensaverPinSet}
              <button type="button" onclick={openPinDialog} disabled={screensaverBusy}>
                Change PIN
              </button>
              <button type="button" onclick={clearPin} disabled={screensaverBusy}>
                Clear PIN
              </button>
            {:else}
              <button type="button" onclick={openPinDialog} disabled={screensaverBusy}>
                Set PIN
              </button>
              <span class="muted">No PIN set; lockout informational only.</span>
            {/if}
          {:else}
            <input
              type="password"
              bind:value={pinDialog.pin1}
              placeholder="PIN"
              autocomplete="off"
              disabled={screensaverBusy}
            />
            <input
              type="password"
              bind:value={pinDialog.pin2}
              placeholder="Confirm"
              autocomplete="off"
              disabled={screensaverBusy}
            />
            <button type="button" onclick={commitPin} disabled={screensaverBusy}>
              Save
            </button>
            <button type="button" onclick={cancelPinDialog} disabled={screensaverBusy}>
              Cancel
            </button>
          {/if}
        </div>
        <label class="screensaver-theme">
          <span>Theme:</span>
          <select
            bind:value={screensaverTheme}
            onchange={commitScreensaverTheme}
            disabled={screensaverBusy}
          >
            <option value="plain">Default</option>
            <option value="matrix">Matrix</option>
          </select>
        </label>
        <p class="hint">
          Theme rendered behind the lock cover when the workspace view
          auto-locks.
        </p>
      </div>
      <div class="screensaver-preview">
        <div class="preview-title">Screensaver preview</div>
        <div class="preview-box">
          {#if screensaverTheme === "matrix"}
            <MatrixRainPreview width={320} height={180} />
          {:else}
            <PlainScreensaverPreview width={320} height={180} />
          {/if}
        </div>
        <p class="hint">
          Preview of the {screensaverTheme === "matrix" ? "Matrix" : "Default"} lock
          theme.
        </p>
      </div>
    {/if}
  </div>
</SettingField>

<style>
  .screensaver-config {
    display: grid;
    gap: 0.5rem;
    width: 100%;
  }
  .screensaver-theme,
  .screensaver-timeout {
    display: grid;
    grid-template-columns: minmax(9rem, auto) minmax(8rem, 1fr);
    align-items: center;
    gap: 0.5rem;
    max-width: 28rem;
    font-size: 13px;
  }
  .screensaver-theme select,
  .screensaver-timeout :global(input),
  .screensaver-pin-controls input {
    min-width: 0;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 5px 7px;
    font: inherit;
  }
  .screensaver-pin-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .screensaver-pin-controls button {
    background: var(--btn-bg);
    color: var(--text);
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    padding: 5px 9px;
    font: inherit;
    cursor: pointer;
  }
  .screensaver-pin-controls button:hover:not(:disabled) {
    border-color: var(--btn-hover);
  }
  .screensaver-pin-controls button:disabled {
    opacity: 0.6;
    cursor: wait;
  }
  .muted {
    color: var(--text-secondary);
    font-style: italic;
  }
  .screensaver-preview {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-top: 0.75rem;
  }
  .preview-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }
  .preview-box {
    width: 320px;
    height: 180px;
    max-width: 100%;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
</style>
