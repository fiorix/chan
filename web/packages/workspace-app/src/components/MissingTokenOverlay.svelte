<script lang="ts">
  // Full-page surface shown when bootstrap detects 401 + no token in
  // the URL or sessionStorage. Standard flow is that `chan serve`
  // prints a launch URL with a `?t=...` token; pasting just the
  // host:port into a fresh tab strips the token and every /api call
  // 401s. Users would otherwise see a blank UI with no obvious
  // cause, so this surface names the problem in plain language and
  // tells them where the real URL came from.
  //
  // Visual matches the gateway's `workspace unavailable` page (see
  // gateway/crates/devserver-proxy/src/proxy.rs::NOT_FOUND_HTML) so
  // the "something is wrong here" UX is consistent across the two
  // surfaces a user can land on with an unusable URL.

  import { ui } from "../state/store.svelte";
</script>

{#if ui.authMissing}
  <main
    class="page"
    aria-live="assertive"
    aria-label="access token missing"
  >
    <h1>access token missing</h1>
    <p>
      this URL is missing the access token <code>chan serve</code> printed
      on launch. open the original URL from the terminal where the
      server was started.
    </p>
  </main>
{/if}

<style>
  /* Matches chan-gateway's workspace-unavailable page: full viewport,
     vertically + horizontally centered, no card chrome, no backdrop
     blur. Sits above every other surface so it can't be hidden
     behind a stray overlay during a failed bootstrap. */
  .page {
    position: fixed;
    inset: 0;
    z-index: 40000;
    background: var(--bg);
    color: var(--text);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    text-align: center;
    padding: 2rem;
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }
  p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 14px;
    max-width: 44ch;
    line-height: 1.5;
  }
  code {
    background: var(--code-bg);
    border-radius: 3px;
    padding: 1px 5px;
    font-size: 12.5px;
  }
</style>
