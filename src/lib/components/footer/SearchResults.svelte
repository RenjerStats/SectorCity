<script lang="ts">
  /**
   * Список результатов глобального поиска в footer (vision §I.3): «нашёл — дойди».
   * Совпадения по имени со ВСЕГО снимка (крупнейшие первыми, считает бэк `search`),
   * показываем имя · путь · размер; клик — навигация к зданию (drill-цепочка).
   * Само поле поиска живёт в header (`SearchBox`); тут только выдача и счётчик.
   *
   * Связь с владельцем сцены — только через стор (docs §1): клик кладёт команду
   * `navigateTo`, Scene её исполняет. Раскладку/подсветку (дим несовпадений на
   * активном уровне) ведёт прежний механизм `searchQuery` — он не отменён.
   */
  import {
    searchQuery,
    searchResults,
    searchPending,
    SEARCH_MIN_CHARS,
  } from "../../store/mode";
  import { dispatchCommand } from "../../store/ui";
  import { formatSize, baseName } from "../../format";

  let q = $derived($searchQuery.trim());
  let results = $derived($searchResults);
  let pending = $derived($searchPending);
  let tooShort = $derived(q.length > 0 && q.length < SEARCH_MIN_CHARS);

  function go(path: string) {
    dispatchCommand({ kind: "navigateTo", path });
  }
  /** Папка-владелец узла (для подписи «… / parent») — последний сегмент пути выше. */
  function parentName(path: string): string {
    const m = path.match(/^(.*)[\\/][^\\/]+$/);
    return m ? baseName(m[1]) : "";
  }
</script>

<div class="search-results">
  <div class="head">
    <span class="label">Поиск</span>
    {#if tooShort}
      <span class="count">введите ещё {SEARCH_MIN_CHARS - q.length}…</span>
    {:else if pending}
      <span class="count">ищу…</span>
    {:else}
      <span class="count">{results.length} совпадений</span>
    {/if}
  </div>

  {#if !tooShort && !pending && results.length === 0}
    <div class="empty">Ничего не найдено</div>
  {:else}
    <ul class="list">
      {#each results as r (r.path)}
        <li>
          <button class="row" onclick={() => go(r.path)} title={r.path}>
            <span class="name" class:dir={r.isDir}>{r.name}</span>
            <span class="parent">{parentName(r.path)}</span>
            <span class="size">{formatSize(r.size)}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .search-results {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    width: 100%;
    min-width: 0;
  }
  .head {
    display: flex;
    flex-direction: column;
    flex: 0 0 auto;
    line-height: 1.2;
  }
  .label {
    font-size: 0.7rem;
    letter-spacing: var(--track-caps);
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .count {
    font-size: 0.8rem;
    color: var(--text-2);
  }
  .empty {
    color: var(--text-muted);
    font-size: 0.8rem;
  }
  .list {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0;
    padding: 0;
    list-style: none;
    overflow-x: auto;
    min-width: 0;
    flex: 1 1 auto;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-2);
    border: 1px solid var(--hairline);
    border-radius: var(--r-pill);
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
    font-size: 0.8rem;
    white-space: nowrap;
    cursor: pointer;
  }
  .row:hover {
    border-color: var(--border);
    background: var(--accent-soft);
  }
  .name {
    max-width: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name.dir {
    color: var(--text);
    font-weight: 600;
  }
  .parent {
    color: var(--text-muted);
    font-size: 0.72rem;
  }
  .size {
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }
</style>
