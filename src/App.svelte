<script lang="ts">
  import Scene from "./lib/components/Scene.svelte";
  import { appMode } from "./lib/store/mode";

  // Фаза 0: 3D-слой (Three.js) и DOM-обвязка общаются ТОЛЬКО через стор —
  // прямых вызовов между ними нет (см. docs/SectorCity-tech.md §1).
  let mode = $derived($appMode);
</script>

<Scene />

<main>
  <h1>SectorCity</h1>
  <p class="muted">Визуализатор занятого места на диске — «город в городе».</p>
  <p class="muted">
    Каркас проекта инициализирован. Текущий режим:
    <code>{mode.kind}</code>
  </p>
</main>

<style>
  main {
    position: relative;
    z-index: 1;
    padding: 2rem;
    max-width: 40rem;
    /* Информационная панель не должна перехватывать управление камерой. */
    pointer-events: none;
  }
  h1 {
    margin: 0 0 0.5rem;
    font-weight: 600;
  }
  .muted {
    color: var(--muted);
  }
  code {
    color: var(--accent);
  }
</style>
