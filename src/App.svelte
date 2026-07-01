<script lang="ts">
  // Композиция оболочки: Header · 3D-viewport · Footer.
  // Все три мира общаются ТОЛЬКО через стор (docs/SectorCity-tech.md §1):
  //   - Header/крошки шлют команды в стор (`uiCommand`), исполняет Scene;
  //   - Footer читает режим/прогресс/сводку из стора и сам выбирает контент
  //     (по умолчанию — полоса размера уровня + крошки-путь + кнопка легенды).
  // Scene — единственный владелец canvas; рендерер сам подгоняется под размер
  // viewport (ResizeObserver на canvas), поэтому полосы можно ужимать свободно.
  import Header from "./lib/components/Header.svelte";
  import Footer from "./lib/components/Footer.svelte";
  import Scene from "./lib/components/Scene.svelte";
  import CleanupConfirm from "./lib/components/CleanupConfirm.svelte";
  import SettingsPanel from "./lib/components/SettingsPanel.svelte";
  import LegendPanel from "./lib/components/LegendPanel.svelte";
  import HotkeysHelp from "./lib/components/HotkeysHelp.svelte";
  import Hotkeys from "./lib/components/Hotkeys.svelte";
  import Toast from "./lib/components/Toast.svelte";
</script>

<!-- Центральный обработчик горячих клавиш (единственный владелец keydown). -->
<Hotkeys />

<div class="app">
  <Header />
  <main class="viewport">
    <Scene />
  </main>
  <Footer />
</div>

<!-- Всплывающее окно настроек (поповер слева под шапкой). -->
<SettingsPanel />

<!-- Всплывающее окно легенды (поповер справа над footer). -->
<LegendPanel />

<!-- Общепрограммный модал (по центру, поверх всего): подтверждение сноса. -->
<CleanupConfirm />

<!-- Общепрограммное окно-шпаргалка горячих клавиш (F1 / «?»). -->
<HotkeysHelp />

<!-- Всплывающие плашки-подтверждения (напр. «скопировано»). -->
<Toast />

<style>
  .app {
    display: grid;
    /* header · viewport · footer. minmax(0,1fr) на viewport — критично:
       позволяет центральной ячейке ужиматься, иначе canvas распирал бы грид и
       полосы уезжали бы за экран. Крошки переехали в footer. */
    grid-template-rows: auto minmax(0, 1fr) auto;
    height: 100%;
  }
  .viewport {
    position: relative; /* контейнер для абсолютных оверлеев сцены */
    overflow: hidden;
    min-height: 0;
  }
</style>
