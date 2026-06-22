<script lang="ts">
  /**
   * Легенда кодирования (высота=устаревание, цвет=категория). Переехала в footer
   * (docs/SectorCity-vision.md, Приложение B) — горизонтальная компактная форма.
   * Умеет фильтровать категории по клику (вкл/выкл) и двойному клику (solo).
   */
  import { CATEGORY_COLOR, CATEGORY_LABEL } from "../three/palette";
  import type { Category } from "../ipc/contract";
  import {
    categoryFilter,
    categoryFilterActive,
    toggleCategory,
    soloCategory,
    resetCategories,
  } from "../store/mode";

  const ORDER: Category[] = [
    "code",
    "document",
    "image",
    "video",
    "audio",
    "archive",
    "binary",
    "other",
  ];

  let filter = $derived($categoryFilter);
  let active = $derived($categoryFilterActive);

  function hex(value: number): string {
    return "#" + value.toString(16).padStart(6, "0");
  }
</script>

<div class="legend">
  <div class="grp">
    <span class="cap">ВЫСОТА</span>
    <div class="hscale" aria-hidden="true">
      <span style="height:4px"></span>
      <span style="height:7px"></span>
      <span style="height:10px"></span>
      <span style="height:13px"></span>
      <span style="height:16px"></span>
    </div>
    <span class="hint">устаревание</span>
  </div>

  <span class="vsep"></span>

  <div class="grp cats">
    <span class="cap">КАТЕГОРИИ</span>
    {#each ORDER as cat (cat)}
      <button
        class="cat"
        class:off={!filter.has(cat)}
        title={`${CATEGORY_LABEL[cat]} (Клик: вкл/выкл, Двойной клик: только эта)`}
        onclick={() => toggleCategory(cat)}
        ondblclick={(e) => {
          e.stopPropagation();
          soloCategory(cat);
        }}
      >
        <span class="dot" style="background:{filter.has(cat) ? hex(CATEGORY_COLOR[cat]) : 'var(--text-muted)'}"></span>
        <span class="name">{CATEGORY_LABEL[cat]}</span>
      </button>
    {/each}

    {#if active}
      <button class="reset" onclick={resetCategories} title="Сбросить фильтр категорий">
        Сбросить
      </button>
    {/if}
  </div>
</div>

<style>
  .legend {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-width: 0;
    overflow: hidden;
    flex: 0 1 auto;
  }
  .grp {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }
  .cats {
    overflow: hidden;
  }
  .cap {
    font-family: var(--font-label);
    font-size: 0.62rem;
    letter-spacing: var(--track-caps);
    color: var(--text-muted);
    white-space: nowrap;
  }
  /* «устаревание» — тем же шрифтом, что .cap «ВЫСОТА» (единый читаемый стиль). */
  .hint {
    font-family: var(--font-label);
    font-size: 0.68rem;
    color: var(--text-muted);
    white-space: nowrap;
  }
  /* Мини-шкала высоты: монохромные «дома» по нарастающей (высота = устаревание). */
  .hscale {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 16px;
  }
  .hscale span {
    width: 4px;
    border-radius: 1px 1px 0 0;
    background: linear-gradient(to top, var(--text-muted), var(--text-2));
  }
  .vsep {
    width: 1px;
    height: 16px;
    background: var(--hairline);
    flex-shrink: 0;
  }
  .cat {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
    background: none;
    border: none;
    padding: 0.15rem 0.35rem;
    margin: 0;
    cursor: pointer;
    border-radius: var(--r-sm);
    transition: background var(--motion-micro) var(--ease-out);
  }
  .cat:hover {
    background: rgba(255, 255, 255, 0.05);
  }
  .cat.off .dot {
    background: #444448 !important;
    box-shadow: none;
  }
  .cat.off .name {
    color: var(--text-muted);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .name {
    font-size: 0.68rem;
    color: var(--text-2);
  }
  .reset {
    font-family: var(--font-label);
    font-size: 0.62rem;
    letter-spacing: var(--track-caps);
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    border-radius: var(--r-pill);
    padding: 0.1rem 0.4rem;
    cursor: pointer;
    margin-left: 0.4rem;
    white-space: nowrap;
    transition: background var(--motion-micro) var(--ease-out);
  }
  .reset:hover {
    background: rgba(215, 25, 33, 0.22);
  }
</style>
