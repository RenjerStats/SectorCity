<script lang="ts">
  /**
   * Хлебные крошки навигации (интерактивный путь). Переехали из sub-header под
   * header в footer (правее полосы размера уровня): читают стек `breadcrumbs` из
   * стора, клик шлёт команду `goToCrumb` (исполняет Scene).
   *
   * Inline-форма без собственного хрома (фон/границу даёт полоса footer). Нет
   * крошек / идёт скан — не рендерится (footer в этих состояниях занят другим).
   */
  import { appMode, breadcrumbs } from "../store/mode";
  import { dispatchCommand } from "../store/ui";

  let crumbs = $derived($breadcrumbs);
  let zooming = $derived($appMode.kind === "zooming");
  let busy = $derived($appMode.kind === "scanning");
  let shown = $derived(crumbs.length > 0 && !busy);
</script>

{#if shown}
  <nav class="crumbs" aria-label="Навигация по уровням">
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
  </nav>
{/if}

<style>
  /* Inline-крошки в footer: одна строка, при переполнении прячем НАЧАЛО (root),
     хвост с текущей папкой прижат вправо и остаётся виден. */
  .crumbs {
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    justify-content: flex-end;
    gap: 0.15rem;
    min-width: 0;
    overflow: hidden;
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
    white-space: nowrap;
    flex-shrink: 0;
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
    flex-shrink: 0;
  }
</style>
