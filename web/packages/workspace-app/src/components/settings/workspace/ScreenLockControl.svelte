<script lang="ts">
  // Screen lock for the "This workspace" settings tab. Auto-locks the
  // workspace view after inactivity with an optional local PIN (salted by the
  // workspace root, so it is per-workspace). It owns enable/timeout/theme
  // patches, the PIN set/confirm/clear dialog, a Test action, and the theme
  // preview. What it shows is the running lock's own state, which every
  // write here reloads and which the settings index reads and writes too.

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
  import { optionsOf, settingEntry } from "../settingsIndex";
  import { patchScreenLock } from "./workspaceState.svelte";
  import MatrixRainPreview from "../../screensaver/MatrixRainPreview.svelte";
  import PlainScreensaverPreview from "../../screensaver/PlainScreensaverPreview.svelte";

  const LOCK = settingEntry("workspace.screenLock");
  const TIMEOUT = settingEntry("workspace.screenLock.timeout");
  const PIN = settingEntry("workspace.screenLock.pin");
  const THEME = settingEntry("workspace.screenLock.theme");

  /// Null until the lock's state has loaded.
  const screensaverEnabled = $derived(screensaver.loaded ? screensaver.enabled : null);
  let screensaverBusy = $state(false);
  let screensaverError = $state<string | null>(null);
  /// PIN edit buffer. `null` when not showing the dialog; otherwise carries
  /// the pin1/pin2 confirm pair.
  let pinDialog = $state<{ pin1: string; pin2: string } | null>(null);

  async function toggleScreensaverEnabled(): Promise<void> {
    if (screensaverEnabled === null || screensaverBusy) return;
    screensaverBusy = true;
    screensaverError = null;
    try {
      await patchScreenLock({ enabled: !screensaverEnabled });
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
    if (next === screensaver.timeout_secs) return;
    screensaverBusy = true;
    const validationMessage = screensaverError;
    try {
      await patchScreenLock({ timeout_secs: next });
      screensaverError = validationMessage;
    } catch (err) {
      screensaverError = `timeout save failed: ${(err as Error).message ?? err}`;
    } finally {
      screensaverBusy = false;
    }
  }

  async function commitScreensaverTheme(theme: ScreensaverTheme): Promise<void> {
    if (screensaverBusy) return;
    screensaverBusy = true;
    screensaverError = null;
    try {
      await patchScreenLock({ theme });
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
      await api.screensaverSetPin(hash);
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
      await api.screensaverClearPin();
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

  // The lock's state was loaded when the window booted, and another window
  // may have changed the settings since. A read that fails is reported here
  // and leaves the running lock as it was; one that differs from the lock's
  // state is loaded into it.
  onMount(async () => {
    try {
      const served = await api.screensaverState();
      const differs =
        !screensaver.loaded ||
        screensaver.enabled !== served.enabled ||
        screensaver.timeout_secs !== served.timeout_secs ||
        screensaver.theme !== served.theme ||
        screensaver.pin_set !== served.pin_set;
      if (differs) await loadScreensaverState();
    } catch (err) {
      screensaverError = `screensaver: ${(err as Error).message ?? err}`;
    }
  });
</script>

<SettingField
  setting={LOCK}
  hint="Auto-lock this window after inactivity; Mod+L locks now. The lock blocks input to this window only; other windows and clients with the bearer token can still reach this workspace's sessions."
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
        <label class="screensaver-timeout" data-setting={TIMEOUT.id}>
          <span>{TIMEOUT.caption}</span>
          <NumberField
            value={screensaver.timeout_secs}
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
            <span class="screensaver-pin" data-setting={PIN.id}>
              <button type="button" onclick={openPinDialog} disabled={screensaverBusy}>
                {PIN.caption}
              </button>
              {#if screensaver.pin_set}
                <button type="button" onclick={clearPin} disabled={screensaverBusy}>
                  Clear PIN
                </button>
              {:else}
                <span class="muted">No PIN set; lockout informational only.</span>
              {/if}
            </span>
          {:else}
            <span class="screensaver-pin" data-setting={PIN.id}>
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
            </span>
          {/if}
        </div>
        <label class="screensaver-theme" data-setting={THEME.id}>
          <span>{THEME.caption}</span>
          <select
            value={screensaver.theme}
            onchange={(e) => void commitScreensaverTheme(e.currentTarget.value as ScreensaverTheme)}
            disabled={screensaverBusy}
          >
            {#each optionsOf(THEME) as theme (theme.value)}
              <option value={theme.value}>{theme.label}</option>
            {/each}
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
          {#if screensaver.theme === "matrix"}
            <MatrixRainPreview width={320} height={180} />
          {:else}
            <PlainScreensaverPreview width={320} height={180} />
          {/if}
        </div>
        <p class="hint">
          Preview of the {screensaver.theme === "matrix" ? "Matrix" : "Default"} lock
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
  .screensaver-pin-controls,
  .screensaver-pin {
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
