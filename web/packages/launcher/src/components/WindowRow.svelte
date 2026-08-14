<script lang="ts">
  // One window/terminal row in the machine tree (control terminals, standalone
  // terminals, and the windows nested in a workspace card). The row adapts to the
  // surface's capabilities:
  //   - desktop bridge: [FOCUS] (focus a live window / un-hide a buried one) and
  //     [SHOW/HIDE] (Eye when visible, EyeOff when hidden, keyed on the
  //     server-persisted `hidden`). A control terminal whose devserver is not
  //     responding slow-flashes its eye yellow for attention; acting on the window
  //     clears it.
  //   - self-managed (devserver/PWA): no bridge, so [OPEN] opens the window as an
  //     in-app browser window. A connected browser window with no live handle
  //     here flashes for a re-open click.
  //   - readonly (gateway): static, connection dot only, no actions.
  //
  // `icon` adds a leading kind glyph (accent for the control terminal); the
  // machine tree passes it for every row. The textual "connection lost" cue is
  // the devserver identity row's machine icon turned red (Library.svelte), not a
  // pill on this row.
  import { tick } from "svelte";
  import { AppWindow, ExternalLink, Eye, EyeOff, Focus, Folder, SquareTerminal } from "lucide-svelte";
  import {
    focusWindow,
    toggleWindow,
    saveWindowLabel,
    reportError,
    clearError,
  } from "../state/library.svelte";
  import { rowLabel, windowRowLabel } from "../lib/windowLabel";
  import { hasControlAttention, clearControlAttention } from "../state/controlAttention.svelte";
  import { hasWindowAttention } from "../state/windowAttention.svelte";
  import { hasDesktopBridge, readOnly, selfManagedWindows } from "../state/capabilities";
  import { openWindowRecord, toggleWindowVisibility } from "../state/windowManager.svelte";
  import { actingFor, canActOnTenant } from "../state/leadership.svelte";
  import { MAX_WINDOW_LABEL_CHARS, type WindowRecord } from "../api/library";

  interface Props {
    w: WindowRecord;
    icon?: boolean;
  }
  let { w, icon = false }: Props = $props();
  let editingLabel = $state(false);
  let labelDraft = $state("");
  let labelInput: HTMLInputElement | undefined = $state();

  async function beginLabelEdit(): Promise<void> {
    labelDraft = w.label ?? "";
    editingLabel = true;
    await tick();
    labelInput?.focus();
    labelInput?.select();
  }

  function cancelLabelEdit(): void {
    editingLabel = false;
    labelDraft = w.label ?? "";
  }

  function canEditWindowLabel(rec: WindowRecord): boolean {
    return (
      !readOnly &&
      !rec.control &&
      (!selfManagedWindows || canActOnTenant(rec.prefix))
    );
  }

  async function commitLabelEdit(): Promise<void> {
    if (!editingLabel) return;
    editingLabel = false;
    const label = labelDraft.trim();
    if (label === (w.label ?? "").trim()) return;
    clearError();
    try {
      await saveWindowLabel(w, label, actingFor(w.prefix));
    } catch (e) {
      reportError(e);
    }
  }

  // A control terminal whose devserver needs attention slow-flashes its eye
  // yellow until the user acts on the window or the desktop reports recovery.
  // The desktop emits `devserver-control-attention` for both a connected
  // devserver that stopped responding AND a disconnected one whose control
  // script died (kept open at "process exited"), so the flash is event-driven.
  function needsAttention(rec: WindowRecord): boolean {
    return rec.control && hasControlAttention(rec.library_id);
  }

  // The user acting on the window (focus or show/hide) acknowledges the
  // attention -- clear the flash.
  function acknowledge(rec: WindowRecord): void {
    if (rec.control) clearControlAttention(rec.library_id);
  }

  // The FOCUS / SHOW-HIDE bridge ops reject on a surface with no desktop and on a
  // stale/reaped window. Catch here and surface the failure in the banner instead
  // of letting a floating promise reject into the console.
  async function run(rec: WindowRecord, action: Promise<void>): Promise<void> {
    clearError();
    try {
      await action;
      acknowledge(rec);
    } catch (e) {
      reportError(e);
    }
  }
</script>

{#snippet windowName()}
  <div class="row-main">
    {#if editingLabel}
      <span class="label-editor">
        <span>{rowLabel(w.kind, w.ordinal, w.app)} [</span>
        <input
          bind:this={labelInput}
          bind:value={labelDraft}
          maxlength={MAX_WINDOW_LABEL_CHARS}
          aria-label={`Text for ${rowLabel(w.kind, w.ordinal, w.app)}`}
          placeholder="label"
          onblur={() => void commitLabelEdit()}
          onkeydown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitLabelEdit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelLabelEdit();
            }
          }} />
        <span>]</span>
      </span>
    {:else if canEditWindowLabel(w)}
      <button
        class="row-name editable-label"
        type="button"
        title="Add or edit window text"
        onclick={() => void beginLabelEdit()}>{windowRowLabel(w)}</button>
    {:else}
      <span class="row-name">{windowRowLabel(w)}</span>
    {/if}
  </div>
{/snippet}

{#if hasDesktopBridge}
  <div class="row">
    {#if icon}
      <span class="row-glyph" class:control={w.control} aria-hidden="true">
        {#if w.kind === "workspace"}<AppWindow size={15} />{:else if w.app === "files"}<Folder size={15} />{:else}<SquareTerminal size={15} />{/if}
      </span>
    {/if}
    {@render windowName()}
    <div class="row-actions">
      <button
        class="icon-btn"
        type="button"
        title="Focus window"
        aria-label="Focus window"
        onclick={() => {
          run(w, focusWindow(w));
        }}>
        <Focus size={16} />
      </button>
      <button
        class="icon-btn"
        class:on={!w.hidden}
        class:attention={needsAttention(w)}
        type="button"
        title={needsAttention(w)
          ? "Control terminal needs attention"
          : w.hidden
            ? "Show window"
            : "Hide window"}
        aria-label={needsAttention(w)
          ? `${w.hidden ? "Show window" : "Hide window"} (needs attention)`
          : w.hidden
            ? "Show window"
            : "Hide window"}
        onclick={() => {
          run(w, toggleWindow(w));
        }}>
        {#if w.hidden}<EyeOff size={16} />{:else}<Eye size={16} />{/if}
      </button>
    </div>
  </div>
{:else if selfManagedWindows}
  <!-- Self-managed (devserver/PWA): no desktop bridge, so [OPEN] opens the
       window in-app as a browser window. A connected browser window with no
       live handle here flashes for a re-open click. -->
  <div class="row">
    {#if icon}
      <span class="row-glyph" class:control={w.control} aria-hidden="true">
        {#if w.kind === "workspace"}<AppWindow size={15} />{:else if w.app === "files"}<Folder size={15} />{:else}<SquareTerminal size={15} />{/if}
      </span>
    {/if}
    {@render windowName()}
    <div class="row-actions">
      <!-- Bridgeless SHOW/HIDE: flips the shared, server-persisted visibility
           (the `/visibility` web op), leader-gated like the create controls, so a
           follower tab sees it disabled. Separate from OPEN, which owns this
           launcher's local browser handle. -->
      <button
        class="icon-btn"
        class:on={!w.hidden}
        type="button"
        disabled={!canActOnTenant(w.prefix)}
        title={!canActOnTenant(w.prefix)
          ? "Only the tenant leader can show or hide this window"
          : w.hidden
            ? "Show window"
            : "Hide window"}
        aria-label={w.hidden ? "Show window" : "Hide window"}
        onclick={() => {
          run(w, toggleWindowVisibility(w, actingFor(w.prefix)));
        }}>
        {#if w.hidden}<EyeOff size={16} />{:else}<Eye size={16} />{/if}
      </button>
      <button
        class="icon-btn"
        class:attention={hasWindowAttention(w.window_id)}
        type="button"
        title="Open window"
        aria-label={hasWindowAttention(w.window_id) ? "Open window (not open here)" : "Open window"}
        onclick={() => openWindowRecord(w)}>
        <ExternalLink size={16} />
      </button>
    </div>
  </div>
{:else}
  <!-- Readonly surface (gateway): the dot shows the connection state but can't
       drive a native window. -->
  <div class="row">
    {#if icon}
      <span class="row-glyph" class:control={w.control} aria-hidden="true">
        {#if w.kind === "workspace"}<AppWindow size={15} />{:else if w.app === "files"}<Folder size={15} />{:else}<SquareTerminal size={15} />{/if}
      </span>
    {/if}
    {@render windowName()}
    <!-- Readonly can't drive a window, but it mirrors the EYE state: a hidden
         window shows a static EyeOff beside the connection dot. -->
    {#if w.hidden}
      <span class="hidden-ind" title="Hidden" aria-label="Hidden"><EyeOff size={14} /></span>
    {/if}
    <span class="dot" class:live={w.connected} title={w.connected ? "Connected" : "Detached"}></span>
  </div>
{/if}

<style>
  .editable-label {
    display: inline;
    padding: 0;
    border: 0;
    background: transparent;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: text;
  }

  .editable-label:hover {
    color: var(--brand);
  }

  .label-editor {
    display: inline-flex;
    align-items: baseline;
    min-width: 0;
    color: var(--text);
    font-size: 0.88rem;
    font-weight: 500;
    white-space: nowrap;
  }

  .label-editor input {
    width: min(14rem, 35vw);
    min-width: 4rem;
    margin: 0 0.18rem;
    padding: 0.08rem 0.25rem;
    border: 1px solid var(--brand);
    border-radius: 4px;
    outline: none;
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }

  /* The leading kind glyph (nested tree); the control terminal reads accent. */
  .row-glyph {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--text-secondary);
  }

  .row-glyph.control {
    color: var(--accent);
  }

  /* Readonly hidden indicator: a muted, static EyeOff (no action) mirroring the
     server-persisted hidden state beside the connection dot. */
  .hidden-ind {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--text-secondary);
    opacity: 0.75;
  }

  /* A control terminal whose devserver is not responding: its eye slow-flashes
     yellow to request attention. The pulse overrides the .on accent tint while it
     runs; user action or a restored event clears it. */
  .icon-btn.attention {
    animation: control-attention 1.6s ease-in-out infinite;
  }

  @keyframes control-attention {
    0%,
    100% {
      border-color: var(--btn-border);
      color: var(--text-secondary);
      background: var(--btn-bg);
    }
    50% {
      border-color: #e3b341;
      color: #e3b341;
      background: color-mix(in srgb, #e3b341 18%, transparent);
    }
  }

  /* Respect reduced-motion: hold a steady yellow instead of pulsing. */
  @media (prefers-reduced-motion: reduce) {
    .icon-btn.attention {
      animation: none;
      border-color: #e3b341;
      color: #e3b341;
      background: color-mix(in srgb, #e3b341 18%, transparent);
    }
  }
</style>
