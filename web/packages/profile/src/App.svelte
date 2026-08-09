<script lang="ts">
  import { onMount } from "svelte";
  import Topbar from "@chan/web-shared/Topbar.svelte";
  import Login from "./views/Login.svelte";
  import Profile from "./views/Profile.svelte";
  import Tokens from "./views/Tokens.svelte";
  import Devservers from "./views/Devservers.svelte";
  import { meStore } from "./state/me.svelte";
  import { takeDesktopAuthorized } from "./lib/desktopAuthorized";

  type Tab = "profile" | "tokens" | "workspaces";
  let tab = $state<Tab>(tabFromHash());

  function tabFromHash(): Tab {
    const h = typeof location !== "undefined" ? location.hash : "";
    if (h === "#tokens") return "tokens";
    if (h === "#workspaces") return "workspaces";
    return "profile";
  }

  function setTab(next: Tab) {
    tab = next;
    // replaceState so changing tabs doesn't push browser history.
    const target =
      next === "tokens" ? "#tokens" :
      next === "workspaces" ? "#workspaces" : "#profile";
    if (location.hash !== target) {
      history.replaceState(null, "", target);
    }
  }

  // Hide the Devservers tab when the share_workspaces feature flag is off
  // for this user. If they bookmarked #workspaces or pasted a URL into the bar,
  // fall back to Profile so the dashboard always lands on a tab the
  // user can actually see.
  function visibleTab(t: Tab, sharesOn: boolean): Tab {
    return t === "workspaces" && !sharesOn ? "profile" : t;
  }

  // Raised when chan-desktop's loopback listener bounced the browser back
  // here after a successful authorization.
  let desktopAuthorized = $state(false);

  onMount(() => {
    const marker = takeDesktopAuthorized(location.href);
    if (marker.authorized) {
      desktopAuthorized = true;
      // Strip before the first setTab: its replaceState preserves the
      // query, so the marker would otherwise outlive this page load.
      history.replaceState(null, "", marker.href);
    }
    void meStore.load();
  });
</script>

<svelte:window onhashchange={() => (tab = tabFromHash())} />

<main class="shell">
  {#if meStore.status === "idle" || meStore.status === "loading"}
    <div class="centered muted">Loading...</div>
  {:else if meStore.status === "error"}
    <div class="centered error">
      <p>Could not load your profile.</p>
      <p class="muted small">{meStore.error}</p>
      <button onclick={() => meStore.load()}>Retry</button>
    </div>
  {:else if meStore.status === "anon"}
    <Login />
  {:else if meStore.status === "loaded" && meStore.me}
    {@const sharesOn = !!meStore.me.flags?.share_workspaces}
    {@const activeTab = visibleTab(tab, sharesOn)}
    <Topbar me={meStore.me.user} onSignOut={() => meStore.logout()} />
    {#if desktopAuthorized}
      <div class="notice" role="status">
        <span>Signed in. You can return to chan-desktop.</span>
        <button class="dismiss" onclick={() => (desktopAuthorized = false)}>
          Dismiss
        </button>
      </div>
    {/if}
    <nav class="tabs">
      <button
        class:active={activeTab === "profile"}
        onclick={() => setTab("profile")}
      >
        Profile
      </button>
      <button
        class:active={activeTab === "tokens"}
        onclick={() => setTab("tokens")}
      >
        Tokens
      </button>
      {#if sharesOn}
        <button
          class:active={activeTab === "workspaces"}
          onclick={() => setTab("workspaces")}
        >
          Devservers
        </button>
      {/if}
    </nav>
    {#if activeTab === "profile"}
      <Profile me={meStore.me} />
    {:else if activeTab === "tokens"}
      <Tokens />
    {:else}
      <Devservers devservers={meStore.me.devservers} />
    {/if}
  {/if}
</main>

<style>
  .shell {
    min-height: 100vh;
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  }
  .centered {
    flex: 1;
    display: grid;
    place-items: center;
    text-align: center;
    gap: .75rem;
    padding: 2rem;
  }
  .muted { color: var(--text-secondary); }
  .small { font-size: 13px; }
  .error { color: var(--warn-text); }
  .notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    max-width: 720px;
    width: 100%;
    margin: .75rem auto 0;
    padding: .6rem .9rem;
    box-sizing: border-box;
    border: 1px solid var(--accent);
    border-radius: 8px;
    color: var(--text);
    font-size: 14px;
  }
  .notice .dismiss {
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font: inherit;
    padding: 0;
    cursor: pointer;
  }
  .notice .dismiss:hover { color: var(--text); }
  nav.tabs {
    display: flex;
    gap: .25rem;
    max-width: 720px;
    width: 100%;
    margin: 0 auto;
    padding: .5rem 1rem 0;
    box-sizing: border-box;
  }
  nav.tabs button {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    color: var(--text-secondary);
    padding: .5rem .75rem;
    font: inherit;
    cursor: pointer;
  }
  nav.tabs button.active {
    color: var(--text);
    border-bottom-color: var(--link);
  }
</style>
