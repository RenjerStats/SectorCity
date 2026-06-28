<script lang="ts">
  /**
   * Верхняя полоса оболочки: бренд · поиск (центр) · действия.
   * Header «для навигации и функций» (docs/SectorCity-vision.md §I.11).
   *
   * Презентационный shell: кнопки лишь шлют команды в стор (`dispatchCommand`) —
   * исполняет владелец сцены (Scene). Поиск — отдельный компонент, пишет в свой
   * стор. Выбор темы добавится сюда позже (структура регионов готова).
   */
  import {
    appMode,
    markedCount,
    markedBytes,
    breadcrumbs,
    hiddenPaths,
  } from "../store/mode";
  import {
    dispatchCommand,
    filtersOpen,
    toggleFilters,
    setCleanupConfirm,
  } from "../store/ui";
  import { formatSize } from "../format";
  import SearchBox from "./SearchBox.svelte";

  let busy = $derived($appMode.kind === "scanning");
  let cleanup = $derived($appMode.kind === "cleanup");
  let filters = $derived($filtersOpen);
  let marked = $derived($markedCount);
  let markedSize = $derived($markedBytes);
  let canReroot = $derived(
    $breadcrumbs.length > 1 &&
      !$breadcrumbs[$breadcrumbs.length - 1]?.path.endsWith("::<other>"),
  );
  let hiddenCount = $derived($hiddenPaths.length);
</script>

<header class="header">
  <div class="region brand">
    <span class="brand-dot" aria-hidden="true"></span>
    <span class="brand-name">SECTORCITY</span>
    {#if cleanup}
      <span class="chip-cleanup">СКАНЕР МУСОРА</span>
    {/if}
  </div>

  <div class="region center">
    <SearchBox />
  </div>

  <div class="region actions">
    {#if busy}
      <button class="btn" onclick={() => dispatchCommand({ kind: "cancel" })}>
        Отменить
      </button>
    {:else if cleanup}
      <!-- В режиме очистки шапка фокусируется на сносе/выходе (vision §I.11). -->
      <button
        class="btn btn-primary"
        disabled={marked === 0}
        onclick={() => setCleanupConfirm(true)}
      >
        Снести{marked > 0 ? ` (${marked} · ${formatSize(markedSize)})` : ""}
      </button>
      <button
        class="btn"
        onclick={() => dispatchCommand({ kind: "exitCleanup" })}
      >
        Выйти
      </button>
    {:else}
      <button
        class="btn btn-primary"
        onclick={() => dispatchCommand({ kind: "scan" })}
      >
        Сканировать
      </button>
      <button
        class="btn"
        onclick={() => dispatchCommand({ kind: "enterCleanup" })}
      >
        Сканер мусора
      </button>
      <button
        class="btn"
        class:on={filters}
        aria-pressed={filters}
        onclick={toggleFilters}
      >
        Фильтры
      </button>
      {#if hiddenCount > 0}
        <button
          class="btn"
          onclick={() => dispatchCommand({ kind: "toggleHidden" })}
        >
          Показать скрытое ({hiddenCount})
        </button>
      {/if}
      <button
        class="btn"
        disabled={!canReroot}
        onclick={() => dispatchCommand({ kind: "reroot" })}
      >
        Сделать корнем
      </button>
      <button class="btn" onclick={() => dispatchCommand({ kind: "reset" })}>
        Сбросить вид
      </button>
    {/if}
  </div>
</header>

<style>
  .header {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    height: var(--header-h);
    padding: 0 var(--sp-4);
    background: var(--surface);
    border-bottom: 1px solid var(--hairline);
    user-select: none;
  }
  .region {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .center {
    flex: 1 1 auto;
    min-width: 0;
    justify-content: center;
  }
  .actions {
    gap: var(--sp-2);
    flex-shrink: 0;
  }

  /* Бренд — dot-matrix, с фирменной красной точкой-акцентом. */
  .brand-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 10px var(--accent-soft);
  }
  .brand-name {
    font-family: var(--font-display);
    font-size: 1.2rem; /* крупнее — dot-matrix глифы Ndot77 читаются точками */
    letter-spacing: var(--track-caps);
    color: var(--text);
    white-space: nowrap;
  }

  /* Кнопки оболочки — матовый «премиум-пластик», скруглённые. */
  .btn {
    font: inherit;
    font-size: 0.8rem;
    letter-spacing: 0.02em;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    padding: 0.35rem 0.85rem;
    cursor: pointer;
    white-space: nowrap;
    transition:
      background var(--motion-micro) var(--ease-out),
      border-color var(--motion-micro) var(--ease-out),
      color var(--motion-micro) var(--ease-out);
  }
  .btn:hover {
    background: #232327;
    border-color: rgba(255, 255, 255, 0.2);
  }
  .btn:active {
    transform: translateY(0.5px);
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .btn:disabled:hover {
    background: var(--surface-2);
    border-color: var(--border);
  }
  .btn-primary:disabled:hover {
    background: var(--accent);
    border-color: transparent;
  }

  /* Чип активного режима очистки — единственный красный акцент (vision §I.11). */
  .chip-cleanup {
    font-family: var(--font-label, var(--font-display));
    font-size: 0.62rem;
    letter-spacing: var(--track-caps);
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    border-radius: var(--r-pill);
    padding: 0.15rem 0.55rem;
    white-space: nowrap;
  }
  /* Активный тумблер (Фильтры открыты) — подсветка единственным акцентом. */
  .btn.on {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .btn-primary {
    color: #fff;
    background: var(--accent);
    border-color: transparent;
  }
  .btn-primary:hover {
    background: var(--accent-hover);
  }
  .btn-primary:active {
    background: var(--accent-press);
  }
</style>
