<script lang="ts">
  import PrivateField from "./PrivateField.svelte";
</script>
<PrivateField field="test:address" label="address"><span title="https://private.example/?t=secret">https://private.example</span></PrivateField>
<PrivateField field="test:token" label="token"><input value="private-token" aria-label="token" /></PrivateField>
