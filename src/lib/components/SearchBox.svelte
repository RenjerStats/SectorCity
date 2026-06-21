<script lang="ts">
  /**
   * Поле поиска-подсветки (фаза 2). Пишет запрос в стор `searchQuery`; рендер
   * гасит несовпадающие по имени узлы (Scene объединяет поиск с фильтром и зовёт
   * `navigator.applyHighlight`). Презентационный компонент: своей 3D/IPC-логики
   * нет, только правка строки запроса в сторе.
   */
  import { searchQuery } from "../store/mode";

  let q = $derived($searchQuery);

  function onInput(e: Event) {
    searchQuery.set((e.currentTarget as HTMLInputElement).value);
  }
  function clear() {
    searchQuery.set("");
  }
</script>

<div class="search" class:active={q.trim().length > 0}>
  <input
    type="search"
    placeholder="Поиск по имени…"
    value={q}
    oninput={onInput}
    aria-label="Поиск по имени"
  />
  {#if q.trim().length > 0}
    <button class="clear" onclick={clear} aria-label="Очистить поиск">×</button>
  {/if}
</div>

<style>
  .search {
    position: absolute;
    top: 1rem;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.4rem;
    background: rgba(30, 32, 38, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 0.4rem;
  }
  .search.active {
    border-color: rgba(79, 157, 255, 0.5);
  }
  .search input {
    font: inherit;
    font-size: 0.85rem;
    width: 14rem;
    color: var(--fg, #e6e6e6);
    background: none;
    border: none;
    outline: none;
  }
  .clear {
    background: none;
    border: none;
    color: var(--muted, #8b929c);
    font-size: 1.05rem;
    line-height: 1;
    cursor: pointer;
  }
  .clear:hover {
    color: var(--fg, #e6e6e6);
  }
</style>
