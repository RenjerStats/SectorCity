<script lang="ts">
  /**
   * Окно легенды кодирования — всплывает по кнопке «Легенда» справа в footer.
   * Поповер снизу-справа (над footer); закрытие по scrim/✕/Esc.
   *
   * Легенда объясняет два канала: ВЫСОТА = устаревание, ЦВЕТ = категория.
   * Точки категорий интерактивны (как раньше в полосе footer): клик — вкл/выкл,
   * двойной — только эта; фильтр живёт в сторе (та же логика, что в настройках).
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
  import { legendOpen, toggleLegend } from "../store/ui";

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

  let open = $derived($legendOpen);
  let filter = $derived($categoryFilter);
  let active = $derived($categoryFilterActive);

  function hex(value: number): string {
    return "#" + value.toString(16).padStart(6, "0");
  }
  function close() {
    toggleLegend();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && open) close();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <button class="scrim" aria-label="Закрыть легенду" onclick={close}></button>

  <div class="panel" role="dialog" aria-modal="true" aria-label="Легенда">
    <div class="head">
      <span class="title">Легенда</span>
      <button class="x" onclick={close} aria-label="Закрыть">✕</button>
    </div>

    <section class="section">
      <div class="row-head">
        <h3 class="section-title">Высота</h3>
        <span class="hint">устаревание</span>
      </div>
      <div class="hscale" aria-hidden="true">
        <span style="height:5px"></span>
        <span style="height:9px"></span>
        <span style="height:13px"></span>
        <span style="height:17px"></span>
        <span style="height:21px"></span>
      </div>
      <p class="note">
        Чем выше здание — тем дольше файл/папка не менялись (база — дата
        изменения).
      </p>
    </section>

    <section class="section">
      <div class="row-head">
        <h3 class="section-title">Категории</h3>
        {#if active}
          <button
            class="reset"
            onclick={resetCategories}
            title="Сбросить фильтр категорий"
          >
            Сбросить
          </button>
        {/if}
      </div>
      <div class="cats">
        {#each ORDER as cat (cat)}
          <button
            class="cat"
            class:off={!filter.has(cat)}
            aria-pressed={filter.has(cat)}
            title={`${CATEGORY_LABEL[cat]} (клик — вкл/выкл, двойной — только эта)`}
            onclick={() => toggleCategory(cat)}
            ondblclick={(e) => {
              e.stopPropagation();
              soloCategory(cat);
            }}
          >
            <span
              class="dot"
              style="background:{filter.has(cat)
                ? hex(CATEGORY_COLOR[cat])
                : 'var(--text-muted)'}"
            ></span>
            <span class="name">{CATEGORY_LABEL[cat]}</span>
          </button>
        {/each}
      </div>
      <p class="note">
        Цвет здания — категория содержимого. Клик по категории фильтрует город.
      </p>
    </section>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    z-index: 60;
    cursor: default;
  }
  .panel {
    position: fixed;
    right: var(--sp-4);
    bottom: calc(var(--footer-h) + var(--sp-2));
    width: min(20rem, calc(100vw - 2rem));
    max-height: calc(100vh - var(--footer-h) - var(--sp-6));
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--elev-2);
    padding: var(--sp-4);
    z-index: 61;
    color: var(--text);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .title {
    font-family: var(--font-label, inherit);
    font-size: 0.95rem;
    letter-spacing: var(--track-caps);
    text-transform: uppercase;
  }
  .x {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 0.9rem;
    cursor: pointer;
    padding: 0.2rem;
    border-radius: var(--r-sm);
  }
  .x:hover {
    color: var(--text);
    background: rgba(255, 255, 255, 0.08);
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .row-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .section-title {
    margin: 0;
    font-size: 0.7rem;
    letter-spacing: var(--track-caps);
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 600;
  }
  .hint {
    font-family: var(--font-label, inherit);
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  /* Мини-шкала высоты: монохромные «дома» по нарастающей (высота = устаревание). */
  .hscale {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 22px;
  }
  .hscale span {
    width: 6px;
    border-radius: 1px 1px 0 0;
    background: linear-gradient(to top, var(--text-muted), var(--text-2));
  }

  .cats {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
  }
  .cat {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 0.25rem 0.55rem;
    cursor: pointer;
    border-radius: var(--r-pill);
    transition:
      background var(--motion-micro) var(--ease-out),
      border-color var(--motion-micro) var(--ease-out),
      opacity var(--motion-micro) var(--ease-out);
  }
  .cat:hover {
    border-color: rgba(255, 255, 255, 0.2);
  }
  .cat.off {
    opacity: 0.5;
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
    font-size: 0.74rem;
    color: var(--text);
  }
  .reset {
    font-family: var(--font-label, inherit);
    font-size: 0.62rem;
    letter-spacing: var(--track-caps);
    text-transform: uppercase;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    border-radius: var(--r-pill);
    padding: 0.15rem 0.55rem;
    cursor: pointer;
    white-space: nowrap;
    transition: background var(--motion-micro) var(--ease-out);
  }
  .reset:hover {
    background: rgba(215, 25, 33, 0.22);
  }

  .note {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.72rem;
    line-height: 1.4;
  }
</style>
