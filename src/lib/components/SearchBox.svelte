<script lang="ts">
  /**
   * Поле поиска-подсветки (фаза 2). Пишет запрос в стор `searchQuery`; рендер
   * гасит несовпадающие по имени узлы (Scene объединяет поиск с фильтром и зовёт
   * `navigator.applyHighlight`). Презентационный компонент: своей 3D/IPC-логики
   * нет, только правка строки запроса в сторе.
   */
  import { searchQuery } from "../store/mode";

  let q = $derived($searchQuery);
  let isFocused = $state(false);

  function onInput(e: Event) {
    searchQuery.set((e.currentTarget as HTMLInputElement).value);
  }
  function clear() {
    searchQuery.set("");
  }
</script>

<div
  class="search-container"
  class:focused={isFocused}
  class:active={q.trim().length > 0}
>
  <!-- Иконка лупы -->
  <svg
    class="search-icon"
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <circle cx="11" cy="11" r="8"></circle>
    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
  </svg>

  <input
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
  .search-container {
    /* Absolute anchoring at top center */
    position: absolute;
    top: 1rem;
    left: 50%;
    transform: translateX(-50%);

    /* Layout */
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.7rem;

    /* Width limits and transition */
    width: 15rem;
    box-sizing: border-box;

    /* Styling: Premium Dark Glassmorphism */
    background: rgba(20, 22, 27, 0.92);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    box-shadow:
      0 8px 24px rgba(0, 0, 0, 0.45),
      0 0 0 1px rgba(255, 255, 255, 0.03);

    z-index: 2;
    transition:
      width 0.25s cubic-bezier(0.4, 0, 0.2, 1),
      border-color 0.2s cubic-bezier(0.4, 0, 0.2, 1),
      box-shadow 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* Expand search bar when active or focused */
  .search-container.focused,
  .search-container.active {
    width: 19rem;
    border-color: rgba(79, 157, 255, 0.45);
    box-shadow:
      0 8px 32px rgba(0, 0, 0, 0.55),
      0 0 0 1px rgba(79, 157, 255, 0.2),
      0 0 16px rgba(79, 157, 255, 0.08);
  }

  /* Search magnifying glass icon */
  .search-icon {
    width: 0.9rem;
    height: 0.9rem;
    color: var(--muted, #8b929c);
    stroke-width: 2.5;
    flex-shrink: 0;
    transition: color 0.2s ease;
  }

  .search-container.focused .search-icon,
  .search-container.active .search-icon {
    color: var(--accent, #4f9dff);
  }

  /* Input fields override */
  .search-container input {
    font-family: inherit;
    font-size: 0.85rem;
    width: 100%;
    color: var(--fg, #e6e6e6);
    background: none;
    border: none;
    outline: none;
    padding: 0;
    margin: 0;
  }

  .search-container input::placeholder {
    color: var(--muted, #8b929c);
    opacity: 0.8;
  }

  /* Clear button */
  .clear {
    background: none;
    border: none;
    color: var(--muted, #8b929c);
    padding: 2px;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition:
      background-color 0.15s,
      color 0.15s;
  }

  .clear svg {
    width: 0.8rem;
    height: 0.8rem;
    stroke-width: 2.8;
  }

  .clear:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #ffffff;
  }
</style>
