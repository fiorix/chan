<script lang="ts">
  // Brand row + signed-in identity badge + sign-out. Used by both
  // gw.{domain} and usr.{domain} so the two surfaces share one
  // header. Tab strip stays in each app since the items differ.
  import { initial } from "../initial";

  type Who = {
    display_name: string | null;
    email: string;
    avatar_url: string | null;
  };

  let { me, onSignOut }: { me: Who; onSignOut: () => void } = $props();
</script>

<header class="topbar">
  <div class="brand">
    <span class="brand-mark" aria-hidden="true"></span>
    <span class="brand-name">chan</span>
  </div>
  <div class="who">
    {#if me.avatar_url}
      <img
        class="avatar avatar-img"
        src={me.avatar_url}
        alt=""
        referrerpolicy="no-referrer"
      />
    {:else}
      <span class="avatar" aria-hidden="true">{initial(me)}</span>
    {/if}
    <span class="muted who-email">{me.email}</span>
    <button onclick={onSignOut}>Sign out</button>
  </div>
</header>

<style>
  header.topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    padding: .5rem 1rem;
    background: var(--bg-card);
    border-bottom: 1px solid var(--border);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: .5rem;
    font-weight: 600;
  }
  /* CSS-mask paint: chan-mark.png is a black ink alpha; recolor to
     var(--brand) so the wordmark stays consistent across themes
     without shipping a second asset. Each consuming app has the
     mark at /chan-mark.png in its public/ directory. */
  .brand-mark {
    display: inline-block;
    width: 22px;
    height: 22px;
    background-color: var(--brand);
    -webkit-mask: url('/chan-mark.png') center / contain no-repeat;
            mask: url('/chan-mark.png') center / contain no-repeat;
  }
  .brand-name { color: var(--text); letter-spacing: .01em; }
  .who { display: flex; align-items: center; gap: .6rem; }
  .muted { color: var(--text-secondary); }
  .who-email {
    max-width: 22ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Initial-circle avatar; the img variant wins the same box when
     a provider picture is set. */
  .avatar {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    color: var(--text);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 600;
  }
  img.avatar-img {
    object-fit: cover;
    background: var(--bg-elev);
  }
</style>
