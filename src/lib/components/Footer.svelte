<script lang="ts">
  /**
   * Нижняя полоса оболочки — универсальное контекст-зависимое поле
   * (docs/SectorCity-vision.md §I.11). Контент выбирается по приоритету:
   *
   *   1) занятый слот (`footerSlot`) — сниппет компонента (аварийный люк, задел
   *      под сканер мусора / результаты поиска);
   *   2) scanning      → полоса первичной разметки диска (DiskMapProgress);
   *   3) filtersOpen   → панель фильтров (FilterPanel);
   *   4) иначе         → полоса заполнения по категориям + легенда кодирования.
   *
   * Здесь не только текст: это полноценные виджеты. Новый режим подключается
   * добавлением ветки сюда ИЛИ временным захватом слота из своего компонента.
   */
  import { appMode, scanProgress } from "../store/mode";
  import {
    footerSlot,
    levelSummary,
    filtersOpen,
    hiddenOpen,
  } from "../store/ui";
  import DiskMapProgress from "./footer/DiskMapProgress.svelte";
  import DiskFillBar from "./footer/DiskFillBar.svelte";
  import Legend from "./Legend.svelte";
  import FilterPanel from "./FilterPanel.svelte";
  import CleanupPanel from "./CleanupPanel.svelte";
  import HiddenPanel from "./HiddenPanel.svelte";

  let override = $derived($footerSlot);
  let mode = $derived($appMode);
  let filters = $derived($filtersOpen);
  let hidden = $derived($hiddenOpen);
</script>

<footer class="footer">
  {#if override}
    {@render override()}
  {:else if mode.kind === "scanning"}
    <DiskMapProgress progress={$scanProgress} />
  {:else if mode.kind === "cleanup"}
    <CleanupPanel />
  {:else if hidden}
    <HiddenPanel />
  {:else if filters}
    <FilterPanel />
  {:else}
    <div class="browse">
      <div class="grow"><DiskFillBar summary={$levelSummary} /></div>
      <Legend />
    </div>
  {/if}
</footer>

<style>
  .footer {
    display: flex;
    align-items: center;
    min-height: var(--footer-h);
    padding: 0 var(--sp-4);
    background: var(--surface);
    border-top: 1px solid var(--hairline);
    font-size: 0.8rem;
    color: var(--text-2);
    overflow: hidden;
  }
  .browse {
    display: flex;
    align-items: center;
    gap: var(--sp-6);
    width: 100%;
    min-width: 0;
  }
  .grow {
    flex: 1 1 auto;
    min-width: 0;
  }
</style>
