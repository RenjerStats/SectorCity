<script lang="ts">
  /**
   * Панель фильтров: переключатели категорий файлов (структурный фильтр) и
   * порог агрегации мелочи в блок «Мелочь» (доля объёма папки).
   */
  import {
    aggSettings,
    categoryFilter,
    categoryFilterActive,
    toggleCategory,
    resetCategories,
    showAggregate,
    ALL_CATEGORIES,
  } from "../store/mode";
  import {
    AGGREGATE_COLOR,
    CATEGORY_COLOR,
    CATEGORY_LABEL,
  } from "../three/palette";

  let a = $derived($aggSettings);

  // Ползунок доли: мин. доля объёма папки (в %), мельче которой тайл сворачивается
  // в «Мелочь» (больше % → агрессивнее). Хранится долей 0..1; в UI — проценты.
  function setFraction(percent: number) {
    aggSettings.set({ ...a, fraction: percent / 100 });
  }

  function hex(value: number): string {
    return "#" + value.toString(16).padStart(6, "0");
  }
</script>

<div class="filters">
  <span class="cap">КАТЕГОРИИ</span>

  <div class="cats-group">
    {#each ALL_CATEGORIES as cat (cat)}
      <button
        class="cat-chip"
        class:off={!$categoryFilter.has(cat)}
        title={CATEGORY_LABEL[cat]}
        onclick={() => toggleCategory(cat)}
      >
        <span
          class="dot"
          style="background:{$categoryFilter.has(cat)
            ? hex(CATEGORY_COLOR[cat])
            : 'var(--text-muted)'}"
        ></span>
        <span class="lbl">{CATEGORY_LABEL[cat]}</span>
      </button>
    {/each}

    {#if $categoryFilterActive}
      <button class="reset-cats" onclick={resetCategories}>Сбросить</button>
    {/if}
  </div>

  <span class="sep" aria-hidden="true"></span>
  <span class="cap">АГРЕГАТ</span>

  <!-- Показывать ли блок «Мелочь» вообще. Выкл — мелочь не отображается, площадь
       перетекает к крупным (структурно, как фильтр категорий). -->
  <button
    class="cat-chip agg-toggle"
    class:off={!$showAggregate}
    title={"Показывать блок «Мелочь» (агрегат мелких файлов/папок)"}
    onclick={() => showAggregate.set(!$showAggregate)}
  >
    <span
      class="dot"
      style="background:{$showAggregate
        ? hex(AGGREGATE_COLOR)
        : 'var(--text-muted)'}"
    ></span>
    <span class="lbl">Мелочь</span>
  </button>

  <!-- Порог агрегатора: доля объёма папки (рекурсивно, одинаково на каждом уровне).
       Мельче порога сворачиваются И файлы, И папки в навигируемый блок «Мелочь». -->
  <label class="field slider">
    <span class="lbl">мин. доля</span>
    <input
      type="range"
      min="1"
      max="20"
      step="1"
      value={Math.round(a.fraction * 100)}
      oninput={(e) => setFraction(Number(e.currentTarget.value))}
    />
    <span class="val">{Math.round(a.fraction * 100)}%</span>
  </label>
</div>

<style>
  .filters {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    width: 100%;
    min-width: 0;
    overflow: hidden;
  }
  .cap {
    font-family: var(--font-label);
    font-size: 0.62rem;
    letter-spacing: var(--track-caps);
    color: var(--text-muted);
    white-space: nowrap;
  }

  .cats-group {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    overflow: hidden;
  }
  .cat-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
    background: var(--surface-2);
    border: 1px solid var(--border);
    padding: 0.2rem 0.5rem;
    margin: 0;
    cursor: pointer;
    border-radius: var(--r-pill);
    transition:
      background var(--motion-micro) var(--ease-out),
      border-color var(--motion-micro) var(--ease-out);
  }
  .cat-chip:hover {
    border-color: rgba(255, 255, 255, 0.2);
    background: #232327;
  }
  .cat-chip.off {
    opacity: 0.55;
  }
  .cat-chip.off .dot {
    background: #444448 !important;
  }
  .cat-chip.off .lbl {
    color: var(--text-muted);
  }
  .cat-chip .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .cat-chip .lbl {
    font-size: 0.72rem;
    color: var(--text);
  }
  .reset-cats {
    font-family: var(--font-label);
    font-size: 0.62rem;
    letter-spacing: var(--track-caps);
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    border-radius: var(--r-pill);
    padding: 0.25rem 0.65rem;
    cursor: pointer;
    white-space: nowrap;
    margin-left: 0.3rem;
    transition: background var(--motion-micro) var(--ease-out);
  }
  .reset-cats:hover {
    background: rgba(215, 25, 33, 0.22);
  }

  .field {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    white-space: nowrap;
  }
  .lbl {
    color: var(--text-muted);
    font-size: 0.76rem;
  }

  .sep {
    width: 1px;
    align-self: stretch;
    background: var(--hairline);
    margin: 0 0.2rem;
  }

  .slider input[type="range"] {
    width: 7rem;
    height: 2px;
    appearance: none;
    -webkit-appearance: none;
    background: var(--border);
    border-radius: var(--r-pill);
    outline: none;
    cursor: pointer;
  }
  .slider input[type="range"]::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    border-radius: var(--r-pill);
    background: var(--accent);
    cursor: pointer;
  }
  .slider input[type="range"]::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border: none;
    border-radius: var(--r-pill);
    background: var(--accent);
    cursor: pointer;
  }
  .slider .val {
    min-width: 2.4rem;
    font-size: 0.76rem;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
</style>
