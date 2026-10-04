<script module lang="ts">
  export function hasOsIcon(os: string): boolean {
    return os.trim() !== "";
  }
</script>

<script lang="ts">
  // The machine OS as a small row mark, one per family, with the human OS string
  // as the tooltip. The marks are simple currentColor SVGs, kept in this one
  // file so re-skinning the set is a single-file change. An unknown/empty family
  // renders nothing rather than a misleading icon.
  interface Props {
    /** OS family from the self-report: macos | windows | linux | other. */
    os: string;
    /** Best-effort human OS string for the tooltip; falls back to the family name. */
    prettyName?: string | null;
    /** Pixel size of the square mark. */
    size?: number;
  }
  let { os, prettyName = null, size = 15 }: Props = $props();

  const LABEL: Record<string, string> = {
    macos: "macOS",
    windows: "Windows",
    linux: "Linux",
    other: "Unknown OS",
  };

  // Collapse any non-empty value the family enum may grow to onto `other`; an
  // empty `os` (before the first connect, or when the devserver does not report it) shows no
  // mark.
  const normalized = $derived(os.trim());
  const family = $derived(
    normalized === "macos" || normalized === "windows" || normalized === "linux"
      ? normalized
      : normalized
        ? "other"
        : "",
  );
  const label = $derived(prettyName ?? (family ? LABEL[family] : ""));
</script>

{#if family}
  <span class="os-icon" title={label} role="img" aria-label={label}>
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {#if family === "macos"}
        <path
          d="M17.6 13.1c0-2.36 1.93-3.5 2.02-3.55-1.1-1.6-2.82-1.83-3.43-1.85-1.46-.15-2.85.86-3.59.86-.74 0-1.88-.84-3.1-.82-1.6.02-3.07.93-3.89 2.36-1.66 2.87-.42 7.12 1.19 9.46.79 1.14 1.73 2.42 2.97 2.38 1.19-.05 1.64-.77 3.08-.77 1.43 0 1.84.77 3.1.74 1.28-.02 2.09-1.16 2.87-2.31.9-1.32 1.27-2.61 1.29-2.68-.03-.01-2.47-.95-2.5-3.75z" />
        <path
          d="M15.13 6.06c.66-.8 1.1-1.9.98-3.01-.95.04-2.1.63-2.78 1.43-.61.71-1.14 1.83-1 2.91 1.06.08 2.14-.53 2.8-1.33z" />
      {:else if family === "windows"}
        <rect x="3.2" y="3.2" width="7.3" height="7.3" rx="1" />
        <rect x="13.5" y="3.2" width="7.3" height="7.3" rx="1" />
        <rect x="3.2" y="13.5" width="7.3" height="7.3" rx="1" />
        <rect x="13.5" y="13.5" width="7.3" height="7.3" rx="1" />
      {:else if family === "linux"}
        <path
          d="M12 2.5c-1.85 0-3.2 1.5-3.2 3.6 0 .53.05 1.02.08 1.45.05.72-.18 1.2-.74 2.02-.62.9-1.55 2-2.24 3.42-.69 1.42-1.02 2.9-.6 3.68.27.5.83.45 1.12.2.16-.13.28-.32.38-.5-.05.5-.15 1.18-.3 1.72-.17.6.3 1.06.92 1.06h8.96c.62 0 1.09-.46.92-1.06-.15-.54-.25-1.22-.3-1.72.1.18.22.37.38.5.29.25.85.3 1.12-.2.42-.78.09-2.26-.6-3.68-.69-1.42-1.62-2.52-2.24-3.42-.56-.82-.79-1.3-.74-2.02.03-.43.08-.92.08-1.45 0-2.1-1.35-3.6-3.2-3.6z" />
      {:else}
        <rect x="2.5" y="4" width="19" height="12.5" rx="1.6" />
        <rect x="9.2" y="17" width="5.6" height="2" rx="0.5" />
        <rect x="6.5" y="19.7" width="11" height="1.6" rx="0.8" />
      {/if}
    </svg>
  </span>
{/if}

<style>
  .os-icon {
    display: inline-flex;
    align-items: center;
    /* Sit on the text baseline run without nudging the row's vertical rhythm. */
    vertical-align: -0.2em;
  }
</style>
