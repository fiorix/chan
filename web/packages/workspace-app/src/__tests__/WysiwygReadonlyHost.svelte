<script lang="ts">
  import Wysiwyg from "../editor/Wysiwyg.svelte";

  let value = $state("tail\n");
  let readonly = $state(false);

  export function setReadonly(next: boolean): void {
    readonly = next;
  }
</script>

<Wysiwyg bind:value {readonly} currentPath="notes/a.md" autoFocus={false} />
