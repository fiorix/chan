<script lang="ts">
  import ModalShell from "../components/ModalShell.svelte";
  import PromptModal from "../components/PromptModal.svelte";
  import PathPromptModal from "../components/PathPromptModal.svelte";
  import ConfirmModal from "../components/ConfirmModal.svelte";
  import DraftCloseModal from "../components/DraftCloseModal.svelte";

  let { callers = false, onClose = (_name: string) => {}, onKeydown = (_event: KeyboardEvent) => {} } = $props<{
    callers?: boolean;
    onClose?: (name: string) => void;
    onKeydown?: (event: KeyboardEvent) => void;
  }>();
  let a = $state(false);
  let b = $state(false);
  export function show(name: "a" | "b", open = true): void {
    if (name === "a") a = open;
    else b = open;
  }
</script>

{#if callers}
  <PromptModal />
  <PathPromptModal />
  <ConfirmModal />
  <DraftCloseModal />
{/if}
{#if a}
  <ModalShell labelledby="a-title" onClose={() => onClose("a")} {onKeydown}>
    <h2 id="a-title">A</h2><button class="first">A first</button><input /><button class="last">A last</button>
  </ModalShell>
{/if}
{#if b}
  <ModalShell labelledby="b-title" onClose={() => onClose("b")} {onKeydown}>
    <h2 id="b-title">B</h2><button class="first">B first</button><input /><button class="last">B last</button>
  </ModalShell>
{/if}
