<script lang="ts">
  /**
   * Верхняя полоса оболочки: бренд · поиск (центр) · действия.
   * Header «для навигации и функций» (docs/SectorCity-vision.md §I.11).
   *
   * Презентационный shell: кнопки лишь шлют команды в стор (`dispatchCommand`) —
   * исполняет владелец сцены (Scene). Поиск — отдельный компонент, пишет в свой
   * стор. Слева — кнопка-шестерёнка: всплывающее окно настроек (тема и пр.).
   */
  import {
    appMode,
    markedCount,
    markedBytes,
    breadcrumbs,
    hiddenPaths,
  } from "../store/mode";
  import { dispatchCommand, setCleanupConfirm } from "../store/ui";
  import { settingsOpen, toggleSettings } from "../store/settings";
  import { formatSize } from "../format";
  import SearchBox from "./SearchBox.svelte";

  let busy = $derived($appMode.kind === "scanning");
  let cleanup = $derived($appMode.kind === "cleanup");
  let marked = $derived($markedCount);
  let markedSize = $derived($markedBytes);
  let canReroot = $derived(
    $breadcrumbs.length > 1 &&
      !$breadcrumbs[$breadcrumbs.length - 1]?.path.endsWith("::<other>"),
  );
  let hiddenCount = $derived($hiddenPaths.length);
  let settings = $derived($settingsOpen);
</script>

<header class="header">
  <div class="region brand">
    <button
      class="settings-btn"
      class:on={settings}
      aria-pressed={settings}
      aria-label="Настройки"
      onclick={toggleSettings}
    >
      <svg
        class="gear"
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="3.2" />
        <path
          d="M12 2.2v2.6M12 19.2v2.6M2.2 12h2.6M19.2 12h2.6M4.9 4.9l1.9 1.9M17.2 17.2l1.9 1.9M19.1 4.9l-1.9 1.9M6.8 17.2l-1.9 1.9"
        />
      </svg>
      <span class="settings-label">Настройки</span>
    </button>
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

  /* Кнопка-шестерёнка (слева) — вход в окно настроек вместо wordmark. */
  .settings-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    font: inherit;
    font-size: 0.8rem;
    letter-spacing: 0.02em;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    padding: 0.35rem 0.85rem 0.35rem 0.6rem;
    cursor: pointer;
    white-space: nowrap;
    transition:
      background var(--motion-micro) var(--ease-out),
      border-color var(--motion-micro) var(--ease-out),
      color var(--motion-micro) var(--ease-out);
  }
  .settings-btn:hover {
    background: #232327;
    border-color: rgba(255, 255, 255, 0.2);
  }
  .settings-btn:active {
    transform: translateY(0.5px);
  }
  .settings-btn.on {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .gear {
    display: block;
    transition: transform var(--motion-base) var(--ease-out);
  }
  .settings-btn:hover .gear {
    transform: rotate(35deg);
  }
  .settings-label {
    font-family: var(--font-label, inherit);
    letter-spacing: var(--track-caps);
    text-transform: uppercase;
    font-size: 0.72rem;
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
