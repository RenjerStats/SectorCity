<script lang="ts">
  /**
   * Поле поиска-подсветки (фаза 2). Переехало в центр header. Пишет запрос в стор
   * `searchQuery`; рендер гасит несовпадающие по имени узлы (Scene объединяет
   * поиск с фильтром и зовёт `navigator.applyHighlight`). Презентационный.
   */
  import { searchQuery } from "../store/mode";
  import { searchFocusRequest } from "../store/ui";

  let q = $derived($searchQuery);
  let isFocused = $state(false);
  let inputEl = $state<HTMLInputElement | undefined>(undefined);

  function onInput(e: Event) {
    searchQuery.set((e.currentTarget as HTMLInputElement).value);
  }
  function clear() {
    searchQuery.set("");
  }

  // Фокус по запросу с клавиатуры («/» или Ctrl+F, hotkeys.ts). Нонс растёт —
  // фокусируем и выделяем текст. Стартовое значение 0 при первом прогоне effect
  // фокус не даёт (условие `> 0`), поэтому поле не крадёт фокус при монтировании.
  $effect(() => {
    if ($searchFocusRequest > 0 && inputEl) {
      inputEl.focus();
      inputEl.select();
    }
  });
</script>

<div
  class="search"
  class:focused={isFocused}
  class:active={q.trim().length > 0}
>
  <svg
    class="icon"
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="8"></circle>
    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
  </svg>

  <input
    bind:this={inputEl}
    type="text"
    placeholder="Поиск по имени…"
    value={q}
    oninput={onInput}
    onfocus={() => (isFocused = true)}
    onblur={() => (isFocused = false)}
    aria-label="Поиск по имени"
  />

  {#if q.trim().length > 0}
    <button class="clear" onclick={clear} aria-label="Очистить поиск">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
  {/if}
</div>

<style>
  .search {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    max-width: 24rem;
    box-sizing: border-box;
    padding: 0.32rem 0.7rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    transition:
      border-color var(--motion-micro) var(--ease-out),
      box-shadow var(--motion-micro) var(--ease-out);
  }
  .search.focused,
  .search.active {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .icon {
    width: 0.9rem;
    height: 0.9rem;
    color: var(--text-muted);
    flex-shrink: 0;
    transition: color var(--motion-micro) var(--ease-out);
  }
  .search.focused .icon,
  .search.active .icon {
    color: var(--accent);
  }
  input {
    font-family: inherit;
    font-size: 0.85rem;
    width: 100%;
    color: var(--text);
    background: none;
    border: none;
    outline: none;
    padding: 0;
    margin: 0;
  }
  input::placeholder {
    color: var(--text-muted);
  }
  .clear {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    background: none;
    border: none;
    color: var(--text-muted);
    padding: 2px;
    border-radius: var(--r-sm);
    cursor: pointer;
    transition:
      background var(--motion-micro) var(--ease-out),
      color var(--motion-micro) var(--ease-out);
  }
  .clear svg {
    width: 0.8rem;
    height: 0.8rem;
  }
  .clear:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--text);
  }
</style>
