<script lang="ts">
  // Композиция оболочки: Header · Breadcrumbs (sub-header) · 3D-viewport · Footer.
  // Все три мира общаются ТОЛЬКО через стор (docs/SectorCity-tech.md §1):
  //   - Header/Breadcrumbs шлют команды в стор (`uiCommand`), исполняет Scene;
  //   - Footer читает режим/прогресс/сводку из стора и сам выбирает контент.
  // Scene — единственный владелец canvas; рендерер сам подгоняется под размер
  // viewport (ResizeObserver на canvas), поэтому полосы можно ужимать свободно.
  import Header from "./lib/components/Header.svelte";
  import Breadcrumbs from "./lib/components/Breadcrumbs.svelte";
  import Footer from "./lib/components/Footer.svelte";
  import Scene from "./lib/components/Scene.svelte";
</script>

<div class="app">
  <Header />
  <Breadcrumbs />
  <main class="viewport">
    <Scene />
  </main>
  <Footer />
</div>

<style>
  .app {
    display: grid;
    /* header · sub-header · viewport · footer. minmax(0,1fr) на viewport —
       критично: позволяет центральной ячейке ужиматься, иначе canvas распирал
       бы грид и полосы уезжали бы за экран. Sub-header схлопывается сам. */
    grid-template-rows: auto auto minmax(0, 1fr) auto;
    height: 100%;
  }
  .viewport {
    position: relative; /* контейнер для абсолютных оверлеев сцены */
    overflow: hidden;
    min-height: 0;
  }
</style>
