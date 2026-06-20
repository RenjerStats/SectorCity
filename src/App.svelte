<script lang="ts">
  import Scene from "./lib/components/Scene.svelte";

  // 3D-слой (Three.js) и DOM-обвязка общаются ТОЛЬКО через стор —
  // прямых вызовов между ними нет (см. docs/SectorCity-tech.md §1).
  // Заголовок/состояния вынесены в оверлеи (StatusOverlay, Legend);
  // полноценный тулбар/панель — отдельный UI-кусочек фазы 2.
</script>

<Scene />
