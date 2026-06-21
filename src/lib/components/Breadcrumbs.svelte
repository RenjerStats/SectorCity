<script lang="ts">
  /**
   * Sub-header: хлебные крошки навигации (docs/SectorCity-vision.md §I.11 —
   * «крошки отдельной тонкой полосой под header»). Презентационный: читает стек
   * `breadcrumbs` из стора, клик шлёт команду `goToCrumb` (исполняет Scene).
   *
   * Всегда рендерит контейнер (грид-ячейку): пустой/во время скана — схлопывается
   * в 0 высоты, чтобы не ломать раскладку грида оболочки.
   */
  import { appMode, breadcrumbs } from "../store/mode";
  import { dispatchCommand } from "../store/ui";

  let crumbs = $derived($breadcrumbs);
  let zooming = $derived($appMode.kind === "zooming");
  let busy = $derived($appMode.kind === "scanning");
  let shown = $derived(crumbs.length > 0 && !busy);
</script>

<nav class="subheader" class:empty={!shown} aria-label="Навигация по уровням">
  {#if shown}
    {#each crumbs as crumb, i (crumb.path)}
      {#if i > 0}<span class="sep">›</span>{/if}
      <button
        class="crumb"
        class:current={i === crumbs.length - 1}
        disabled={i === crumbs.length - 1 || zooming}
        onclick={() => dispatchCommand({ kind: "goToCrumb", index: i })}
      >
        {crumb.name}
      </button>
    {/each}
  {/if}
</nav>

<style>
  .subheader {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.15rem;
    height: 2rem;
    padding: 0 var(--sp-4);
    background: var(--surface);
    border-bottom: 1px solid var(--hairline);
    overflow: hidden;
  }
  /* Нет крошек / идёт скан — полоса схлопнута, но грид-ячейка сохранена. */
  .subheader.empty {
    height: 0;
    padding: 0;
    border-bottom: none;
  }
  .crumb {
    font: inherit;
    font-size: 0.8rem;
    color: var(--accent);
    background: none;
    border: none;
    padding: 0.1rem 0.25rem;
    border-radius: var(--r-sm);
    cursor: pointer;
    transition: background var(--motion-micro) var(--ease-out);
  }
  .crumb.current {
    color: var(--text);
    cursor: default;
  }
  .crumb:disabled {
    cursor: default;
  }
  .crumb:not(:disabled):hover {
    background: var(--accent-soft);
  }
  .sep {
    color: var(--text-muted);
    font-size: 0.8rem;
  }
</style>
