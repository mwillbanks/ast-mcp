<script lang="ts">
import { tick } from "svelte";
export class SvelteService extends Base {
  async run() {
    await tick();
    return update();
  }
}
</script>
<h1>{title}</h1>
