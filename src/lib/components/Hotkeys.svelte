<script lang="ts">
  /**
   * Монтирует центральный обработчик горячих клавиш (hotkeys.ts) на всё время
   * жизни приложения. Разметки нет — только жизненный цикл слушателя.
   */
  import { onMount } from "svelte";
  import { installHotkeys } from "../hotkeys";

  onMount(() => installHotkeys());
</script>
