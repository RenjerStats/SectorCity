<script lang="ts">
  /**
   * Нижняя полоса оболочки — универсальное контекст-зависимое поле
   * (docs/SectorCity-vision.md §I.11). Контент выбирается по приоритету:
   *
   *   1) занятый слот (`footerSlot`) — сниппет компонента (аварийный люк, задел
   *      под сканер мусора / результаты поиска);
   *   2) scanning      → полоса первичной разметки диска (DiskMapProgress);
   *   3) иначе         → полоса заполнения по категориям + легенда кодирования.
   *
   * Фильтры (категории / «Прочее») переехали в окно настроек (SettingsPanel).
   *
   * Здесь не только текст: это полноценные виджеты. Новый режим подключается
   * добавлением ветки сюда ИЛИ временным захватом слота из своего компонента.
   */
  import { appMode, scanProgress, searchQuery } from "../store/mode";
  import {
    footerSlot,
    levelSummary,
    hiddenOpen,
    legendOpen,
    toggleLegend,
  } from "../store/ui";
  import DiskMapProgress from "./footer/DiskMapProgress.svelte";
  import DiskFillBar from "./footer/DiskFillBar.svelte";
  import SearchResults from "./footer/SearchResults.svelte";
  import Breadcrumbs from "./Breadcrumbs.svelte";
  import CleanupPanel from "./CleanupPanel.svelte";
  import HiddenPanel from "./HiddenPanel.svelte";

  let override = $derived($footerSlot);
  let mode = $derived($appMode);
  let hidden = $derived($hiddenOpen);
  let legend = $derived($legendOpen);
  // Активный поиск занимает footer списком результатов (vision §I.3) — приоритет
  // выше фильтров/легенды, но ниже скана.
  let searching = $derived($searchQuery.trim().length > 0);
</script>

<footer class="footer">
  {#if override}
    {@render override()}
  {:else if mode.kind === "scanning"}
    <DiskMapProgress progress={$scanProgress} />
  {:else if searching}
    <SearchResults />
  {:else if mode.kind === "cleanup"}
    <CleanupPanel />
  {:else if hidden}
    <HiddenPanel />
  {:else}
    <!-- Компоновка (план §4): крошки слева (от начала чтения), справа —
         KPI+полоса заполнения одним блоком (число привязано к полосе);
         «Легенда» — краем. -->
    <div class="browse">
      <div class="path"><Breadcrumbs /></div>
      <div class="size"><DiskFillBar summary={$levelSummary} /></div>
      <button
        class="legend-btn"
        class:on={legend}
        aria-pressed={legend}
        onclick={toggleLegend}
      >
        Легенда
      </button>
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
    gap: var(--sp-4);
    width: 100%;
    min-width: 0;
  }
  /* Слева — интерактивный путь (крошки) от начала чтения; тянется. */
  .path {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    justify-content: flex-start;
    overflow: hidden;
  }
  /* Правее — KPI + полоса размера уровня по категориям (одним блоком). */
  .size {
    flex: 1 1 44%;
    min-width: 10rem;
    max-width: 48%;
  }
  /* Кнопка легенды — прижата к правому краю. */
  .legend-btn {
    flex-shrink: 0;
    display: inline-flex;
    justify-content: center;
    align-items: center;
    font-family: var(--font-mono);
    font-size: 0.68rem;
    font-weight: 500;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--text-2);
    background: transparent;
    border: none;
    padding: 0.4rem 0.9rem;
    position: relative;
    cursor: pointer;
    white-space: nowrap;
    transition: color var(--motion-micro) var(--ease-out);
  }
  /* Боковые скобки */
  .legend-btn::before,
  .legend-btn::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    width: 6px;
    border: 1px solid var(--border);
    transition:
      border-color var(--motion-micro) var(--ease-out),
      transform var(--motion-micro) var(--ease-out);
  }
  .legend-btn::before {
    left: 0;
    border-right: none;
  }
  .legend-btn::after {
    right: 0;
    border-left: none;
  }
  /* Анимация скобок при наведении */
  .legend-btn:hover::before {
    transform: translateX(-3px);
    border-color: var(--text);
  }
  .legend-btn:hover::after {
    transform: translateX(3px);
    border-color: var(--text);
  }
  .legend-btn.on {
    color: var(--text);
  }
  .legend-btn.on::before,
  .legend-btn.on::after {
    border-color: var(--accent);
  }
</style>
