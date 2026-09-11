<template><button @click="run">{{ label }}</button></template>
<script lang="ts">
import { Base } from "./base";
export class VueService extends Base implements Runnable {
  run() {
    return render("🙂");
  }
}
</script>
