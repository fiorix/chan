<script lang="ts">
  // The workspace's drafts, above the file tree. A draft is kept outside
  // the workspace, so no row of the tree is one: this group lists them from
  // the server's drafts list.

  let { rightDock = false }: { rightDock?: boolean } = $props();
  void rightDock;
</script>
