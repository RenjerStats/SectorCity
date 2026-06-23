<script lang="ts">
  /**
   * Панель списка скрытых элементов визуализации.
   * Показывает скрытые пути, позволяя вернуть их поштучно или вернуть все разом.
   * Монтируется в footerSlot.
   */
  import { hiddenPaths, unhideNode, clearHidden } from "../store/mode";
  import { baseName } from "../format";

  let paths = $derived($hiddenPaths);
</script>

{#if paths.length > 0}
  <div class="hidden-panel">
    <div class="header-row">
      <div class="cap-group">
        <span class="cap">СКРЫТЫЕ ЭЛЕМЕНТЫ</span>
        <span class="count">{paths.length}</span>
      </div>
      <button class="clear-all" onclick={clearHidden}>Вернуть всё</button>
    </div>

    <div class="paths-list">
      {#each paths as path (path)}
        <div class="path-item">
          <span class="name">{baseName(path)}</span>
          <span class="path" title={path}>{path}</span>
          <button class="restore-btn" onclick={() => unhideNode(path)}>
            Вернуть
          </button>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .hidden-panel {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-height: 12rem;
    padding: var(--sp-2) 0;
    gap: var(--sp-2);
    overflow: hidden;
  }

  .header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    flex-shrink: 0;
  }

  .cap-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .cap {
    font-family: var(--font-label);
    font-size: 0.62rem;
    letter-spacing: var(--track-caps);
    color: var(--text-muted);
    white-space: nowrap;
  }

  .count {
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--text-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    padding: 0.05rem 0.45rem;
    min-width: 1rem;
    text-align: center;
  }

  .clear-all {
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
    transition: background var(--motion-micro) var(--ease-out);
  }

  .clear-all:hover {
    background: rgba(215, 25, 33, 0.22);
  }

  .paths-list {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    overflow-y: auto;
    width: 100%;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.1) transparent;
  }

  .paths-list::-webkit-scrollbar {
    width: 4px;
  }

  .paths-list::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
  }

  .path-item {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: 0.25rem 0.5rem;
    background: rgba(0, 0, 0, 0.15);
    border: 1px solid var(--hairline);
    border-radius: var(--r-sm);
  }

  .name {
    font-weight: 600;
    font-size: 0.8rem;
    color: var(--text);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .path {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-grow: 1;
    min-width: 0;
    text-align: left;
  }

  .restore-btn {
    font-family: inherit;
    font-size: 0.72rem;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    padding: 0.15rem 0.5rem;
    cursor: pointer;
    white-space: nowrap;
    transition:
      background var(--motion-micro) var(--ease-out),
      border-color var(--motion-micro) var(--ease-out);
    flex-shrink: 0;
  }

  .restore-btn:hover {
    border-color: rgba(255, 255, 255, 0.2);
    background: #232327;
  }
</style>
