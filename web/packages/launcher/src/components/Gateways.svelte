<script lang="ts">
  import PrivateField from "@chan/web-shared/PrivateField.svelte";
  import { privateText } from "@chan/web-shared/privacy";
  // The Gateways screen: one machine-styled badge per configured gateway --
  // the ArrowRightLeft glyph, the label over the URL, the status dot, the
  // rename pencil, and the connect/disconnect control with a spinning cancel
  // while connecting, sign-in narration while a browser sign-in is pending,
  // and a red lost dot + disconnect-to-recover while unreachable. A badge
  // reached through WireGuard shows each enrolled ingress's id and live
  // state under the URL. A manual file or an older desktop keeps the summary
  // line: the desktop runs a file as soon as the row is saved, so the state
  // follows a change within one refresh. A file the
  // desktop refused arrives as the row's `last_error`, which the status line
  // already narrates. A badge with a generated WireGuard key shows the
  // public key's first eight characters with a copy action and whether the
  // gateway enrolled it; a key not enrolled yet asks for a connect, whose
  // sign-in enrolls it and names the file it writes. Select mode reveals per-badge
  // checkboxes feeding the same global bulk bar as the Computers screen; the
  // screen is reachable only on the desktop surface (the TopBar toggle gates
  // on the bridge), and the controls carry the same bridge gate.
  //
  // On the desktop the badges are a carousel deck like the Computers screen's
  // (Carousel): the gateways sorted by name, then the Add gateway card, which
  // turns over to the gateway form. Other surfaces list the badges one under
  // another.
  import { ArrowRightLeft, Copy, LoaderCircle, Pencil, Plug, Unplug } from "@lucide/svelte";
  import Carousel from "./Carousel.svelte";
  import AddCard from "./AddCard.svelte";
  import GatewayForm from "./GatewayForm.svelte";
  import {
    library,
    connectGateway,
    disconnectGateway,
    reportError,
    clearError,
  } from "../state/library.svelte";
  import { checksVisible, isSelected, toggleSelected } from "../state/selection.svelte";
  import { openEditGateway } from "../state/dialog.svelte";
  import { readOnly, hasDesktopBridge } from "../state/capabilities";
  import type { GatewayEntry } from "../api/library";

  function hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  function gatewayName(gw: GatewayEntry): string {
    return gw.label || hostOf(gw.url);
  }

  // The deck: the gateways by name, then the Add gateway card.
  type DeckCard =
    | { key: string; label: string; kind: "gateway"; gw: GatewayEntry }
    | { key: string; label: string; kind: "add" };
  const deckCards = $derived.by((): DeckCard[] => {
    const cards: DeckCard[] = [...library.gateways]
      .sort((a, b) => gatewayName(a).localeCompare(gatewayName(b)))
      .map((gw) => ({ key: gw.id, label: privateText(gatewayName(gw), "Gateway"), kind: "gateway", gw }));
    cards.push({ key: "add-gateway", label: "Add gateway", kind: "add" });
    return cards;
  });

  const connected = (gw: GatewayEntry): boolean => gw.status === "connected";
  const lost = (gw: GatewayEntry): boolean => gw.status === "unreachable";
  const spinning = (gw: GatewayEntry): boolean => gw.status === "connecting";

  const heldEnter = new Set<string>();
  let repeatedEnter = false;

  function onControlKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      const code = event.code || event.key;
      repeatedEnter = event.repeat || heldEnter.has(code);
      heldEnter.add(code);
    }
  }

  function onWindowKeyup(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      heldEnter.delete(event.code || event.key);
      repeatedEnter = false;
    } else if (event.key === " ") {
      // Space activates on release, even if Enter repeated while Space was held.
      repeatedEnter = false;
    }
  }

  function clearHeldEnter(): void {
    heldEnter.clear();
    repeatedEnter = false;
  }

  async function copyPublicKey(key: string): Promise<void> {
    await navigator.clipboard.writeText(key);
  }

  // Per-badge action failures surface as notice bubbles (uniform with the
  // Library rows: the actions throw, the caller catches here).
  async function run(action: Promise<void>): Promise<void> {
    clearError();
    try {
      await action;
    } catch (e) {
      reportError(e);
    }
  }
</script>

<svelte:window onkeyup={onWindowKeyup} onblur={clearHeldEnter} />

{#snippet gatewayCard(gw: GatewayEntry)}
  <section class="card gateway-card">
    <div class="card-header gateway-header" data-deck-row tabindex="-1">
      {#if !readOnly && checksVisible()}
        <input
          class="row-check"
          type="checkbox"
          checked={isSelected("gateway", gw.id)}
          aria-label={`Select ${privateText(gatewayName(gw), "gateway")}`}
          onchange={() => toggleSelected("gateway", gw.id)} />
      {/if}
      <div class="gw-id">
        <span class="gw-name-row">
          <span class="gw-glyph"><ArrowRightLeft size={16} /></span>
          <PrivateField field={`gateway:${gw.id}:name`} label="gateway name"><span class="gw-name">{gatewayName(gw)}</span></PrivateField>
          {#if lost(gw)}<span class="status-dot lost" title="Connection lost"></span>
          {:else if connected(gw)}<span class="status-dot live" title="Connected"></span>{/if}
          {#if connected(gw)}
            <span class="chip">
              {gw.devserver_count} devserver{gw.devserver_count === 1 ? "" : "s"}
            </span>
          {/if}
        </span>
        <span class="gw-addr-row">
          <span class="gw-glyph"></span>
          <PrivateField field={`gateway:${gw.id}:url`} label="gateway address"><span class="gw-url" title={gw.url}>{gw.url}</span></PrivateField>
        </span>
        {#if gw.wireguard_public_key}
          <span class="gw-addr-row gw-wg-key">
            <span class="gw-glyph"></span>
            <span class="chip">WireGuard key</span>
            <PrivateField field={`gateway:${gw.id}:key`} label="WireGuard public key"><span class="gw-url gw-wg-key-prefix" title={gw.wireguard_public_key}
              >{gw.wireguard_public_key.slice(0, 8)}</span></PrivateField>
            <button
              class="icon-btn gw-wg-copy"
              type="button"
              title="Copy the WireGuard public key"
              aria-label={`Copy the WireGuard public key of ${privateText(gatewayName(gw), "gateway")}`}
              onclick={() => run(copyPublicKey(gw.wireguard_public_key!))}>
              <Copy size={12} />
            </button>
            <span class="gw-url gw-wg-enrolled">
              {gw.wireguard_enrolled ? "enrolled" : "not enrolled: connect to sign in"}
            </span>
          </span>
        {/if}
        {#if gw.wireguard_ingresses?.length}
          {#each gw.wireguard_ingresses as ingress (ingress.id)}
            <span class="gw-addr-row gw-wireguard gw-wg-ingress">
              <span class="gw-glyph"></span>
              <span class="chip">WireGuard</span>
              <span class="gw-wg-fixed">
                <PrivateField field={`gateway:${gw.id}:ingress:${ingress.id}:id`} label="WireGuard ingress"><span class="gw-url gw-wg-id" title={ingress.id}>{ingress.id}</span></PrivateField>
              </span>
              <span class="gw-wg-detail">
                <PrivateField field={`gateway:${gw.id}:ingress:${ingress.id}:status`} label="connection details"><span class="gw-url gw-wg-status" title={ingress.status}>{ingress.status}</span></PrivateField>
              </span>
            </span>
          {/each}
        {:else if gw.wireguard || gw.wireguard_status || gw.wireguard_enrolled}
          <span class="gw-addr-row gw-wireguard">
            <span class="gw-glyph"></span>
            <span class="chip">WireGuard</span>
            {#if gw.wireguard_status}
              <span class="gw-wg-summary">
                <PrivateField field={`gateway:${gw.id}:status`} label="connection details"><span class="gw-url gw-wg-status" title={gw.wireguard_status}>{gw.wireguard_status}</span></PrivateField>
              </span>
            {/if}
            {#if gw.wireguard}
              <span class="gw-wg-detail">
                <PrivateField field={`gateway:${gw.id}:path`} label="WireGuard path"><span class="gw-url gw-wg-file" title={gw.wireguard}>{gw.wireguard}</span></PrivateField>
              </span>
            {/if}
          </span>
        {/if}
      </div>
      <div class="card-actions gateway-actions">
        {#if !readOnly}
          <!-- Rename is a registry write (label only; the URL is identity),
               so it gates on the mutable surface, not the desktop bridge. -->
          <button
            class="icon-btn"
            type="button"
            title="Rename"
            aria-label={`Rename gateway ${privateText(gatewayName(gw), "gateway")}`}
            onclick={() => openEditGateway(gw)}>
            <Pencil size={16} />
          </button>
        {/if}
        {#if hasDesktopBridge}
          <!-- One control keeps keyboard focus through Connect and Cancel.
               Unreachable gateways still own a retrying connection, so they
               disconnect before another Connect can recover them. -->
          <button
            class="icon-btn"
            class:on={connected(gw)}
            class:lost={lost(gw)}
            type="button"
            title={spinning(gw)
              ? "Cancel connection (o)"
              : lost(gw)
                ? "Disconnect lost connection (o)"
                : connected(gw) ? "Disconnect (o)" : "Connect (o)"}
            data-deck-key="o"
            aria-label={spinning(gw)
              ? `Cancel connection to ${privateText(gatewayName(gw), "gateway")}`
              : connected(gw) || lost(gw)
                ? `Disconnect gateway ${privateText(gatewayName(gw), "gateway")}`
                : `Connect gateway ${privateText(gatewayName(gw), "gateway")}`}
            onkeydown={onControlKeydown}
            onblur={clearHeldEnter}
            onclick={(event) => {
              // A multi-click sequence is one activation even if the row changes between clicks.
              if (event.detail > 1) return;
              // Keep the guard here: engines may still click after a prevented keydown.
              if (event.detail === 0 && repeatedEnter) return;
              return run(
                spinning(gw) || connected(gw) || lost(gw) ? disconnectGateway(gw.id) : connectGateway(gw.id),
              );
            }}>
            {#if spinning(gw)}
              <LoaderCircle class="spin" size={16} />
            {:else if connected(gw) || lost(gw)}
              <Unplug size={16} />
            {:else}
              <Plug size={16} />
            {/if}
          </button>
        {/if}
      </div>
    </div>
    {#if gw.pending_signin}
      <!-- The connect handed off to a browser sign-in: narrate the wait. The
           desktop clears the state on the deep-link callback, its timeout,
           or teardown. -->
      <p class="card-prompt gateway-prompt waiting">
        <LoaderCircle class="spin" size={14} aria-hidden="true" />
        Waiting for sign-in in your browser...
      </p>
    {:else if spinning(gw)}
      <p class="card-prompt gateway-prompt">Connecting…</p>
    {:else if lost(gw)}
      <p class="card-prompt gateway-prompt">
        Connection lost{#if gw.last_error}: <PrivateField field={`gateway:${gw.id}:error`} label="error details">{gw.last_error}</PrivateField>{:else}.{/if} Retrying; the last-known
        devservers stay listed.
      </p>
    {:else if connected(gw)}
      <p class="card-prompt gateway-prompt">
        {gw.devserver_count === 0
          ? "No devservers on this gateway yet."
          : `${gw.devserver_count} devserver${gw.devserver_count === 1 ? "" : "s"} listed under Computers.`}
      </p>
    {:else}
      <p class="card-prompt gateway-prompt">
        Not connected{#if gw.last_error}{" ("}<PrivateField field={`gateway:${gw.id}:error`} label="error details">{gw.last_error}</PrivateField>){:else}.{/if}
      </p>
    {/if}
  </section>
{/snippet}

<div class="gateways-screen">
  {#if hasDesktopBridge}
    <Carousel deck="gateways" items={deckCards} label="Gateways">
      {#snippet card(item: DeckCard)}
        {#if item.kind === "gateway"}
          {@render gatewayCard(item.gw)}
        {:else}
          <AddCard
            deck="gateways"
            kind="gateway"
            label="Add gateway"
            hint={library.gateways.length === 0
              ? "No gateways yet. Add one to reach your devservers and devservers shared with you."
              : "Reach your devservers, and devservers shared with you, through another gateway."}>
            {#snippet form(onsaved: (id: string) => void, ondismiss: () => void)}
              <GatewayForm {onsaved} {ondismiss} cancellable />
            {/snippet}
          </AddCard>
        {/if}
      {/snippet}
    </Carousel>
  {:else}
    {#each library.gateways as gw (gw.id)}
      {@render gatewayCard(gw)}
    {/each}
    {#if library.gateways.length === 0}
      <p class="empty-hint">
        No gateways yet. Add one to reach your devservers and devservers shared with you.
      </p>
    {/if}
  {/if}
</div>

<style>
  /* Each gateway is a global `.card`, the machine-badge idiom: identity
     header over a one-line status narration. */
  .gateway-header {
    gap: 0.5rem;
    padding: 0.4rem 0.25rem 0.35rem;
  }

  .gw-id {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    flex: 1;
    min-width: 0;
  }

  .gw-name-row,
  .gw-addr-row {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
  }

  .gw-glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1rem;
    flex-shrink: 0;
    color: var(--text-secondary);
  }

  .gw-name {
    font-weight: 600;
    font-size: 0.92rem;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .gw-url {
    font-size: 0.78rem;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Size the privacy wrapper too, so revealing a long status cannot steal the id's width. */
  .gw-wg-fixed {
    display: inline-flex;
    flex-shrink: 0;
  }

  .gw-wg-summary,
  .gw-wg-detail {
    display: inline-flex;
    min-width: 0;
    overflow: hidden;
  }

  .gw-wg-detail {
    flex: 1;
  }

  /* The file is a path the user typed, so it reads as literal text. */
  .gw-wg-file {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .status-dot {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 50%;
    background: var(--text-secondary);
    opacity: 0.4;
    flex-shrink: 0;
  }

  .status-dot.live {
    background: var(--accent);
    opacity: 1;
    box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 70%, transparent);
  }

  /* Same dot, connection lost: the roster poll keeps failing. Steady red. */
  .status-dot.lost {
    background: var(--danger);
    opacity: 1;
    box-shadow: 0 0 6px color-mix(in srgb, var(--danger) 70%, transparent);
  }
</style>
