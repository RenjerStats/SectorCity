<script lang="ts">
  import { appMode } from "./lib/store/mode";

  // Заглушка фазы 0: показываем текущий режим из единого стора.
  // 3D-слой (Three.js) и DOM-обвязка будут общаться ТОЛЬКО через стор —
  // прямых вызовов между ними нет (см. docs/SectorCity-tech.md §1).
  let mode = $derived($appMode);
</script>

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
