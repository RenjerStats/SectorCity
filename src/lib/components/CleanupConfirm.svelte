<script lang="ts">
  /**
   * Модал подтверждения сноса (vision §I.7, шаг 6) — общепрограммное окно по
   * центру (overlay + blur). Перемещает помеченные файлы в Корзину, обновляет
   * дерево и перезапрашивает уровень для визуальной перестройки.
   */
  import {
    cleanupConfirmOpen,
    setCleanupConfirm,
    dispatchCommand,
  } from "../store/ui";
  import {
    markedForCleanup,
    markedCount,
    markedBytes,
    clearMarks,
  } from "../store/mode";
  import { formatSize } from "../format";
  import { deleteToTrash } from "../ipc/commands";

  let open = $derived($cleanupConfirmOpen);
  // [путь, размер] помеченного — для списка (крупнейшие сверху).
  let items = $derived(
    [...$markedForCleanup.entries()].sort((a, b) => b[1] - a[1]),
  );

  let deleting = $state(false);
  let errorMsg = $state("");

  function close() {
    if (deleting) return;
    setCleanupConfirm(false);
    errorMsg = "";
  }
  function basename(path: string): string {
    const seg = path.split(/[/\\]/).filter(Boolean);
    return seg.length > 0 ? seg[seg.length - 1] : path;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  async function handleConfirm() {
    if (deleting || items.length === 0) return;
    deleting = true;
    errorMsg = "";
    try {
      const paths = items.map(([path]) => path);
      const res = await deleteToTrash(paths);

      // При подтверждённом сносе очищаем пометки
      clearMarks();

      if (res.failed.length > 0) {
        errorMsg = `Не удалось удалить ${res.failed.length} объектов. Они могут быть заблокированы процессом.`;
        deleting = false;
        // Перерисовываем сцену, чтобы отобразить то, что удалилось
        dispatchCommand({ kind: "refresh" });
      } else {
        deleting = false;
        close();
        dispatchCommand({ kind: "refresh" });
      }
    } catch (err) {
      errorMsg = String(err);
      deleting = false;
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <!-- Затемнение-scrim: клик мимо панели закрывает (button — доступно с клавиатуры). -->
  <button class="scrim" aria-label="Закрыть" disabled={deleting} onclick={close}
  ></button>

  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-label="Подтверждение сноса"
  >
    <div class="head">
      <span class="title">Снести отмеченные</span>
      <button class="x" disabled={deleting} onclick={close} aria-label="Закрыть"
        >✕</button
      >
    </div>

    <div class="kpi">
      <span class="num">{$markedCount}</span>
      <span class="lbl">объектов · освободится {formatSize($markedBytes)}</span>
    </div>

    <ul class="list">
      {#each items as [path, size] (path)}
        <li>
          <span class="name" title={path}>{basename(path)}</span>
          <span class="size">{formatSize(size)}</span>
        </li>
      {/each}
    </ul>

    {#if errorMsg}
      <p class="note error">{errorMsg}</p>
    {:else}
      <p class="note">
        Выбранные элементы будут перемещены в Корзину. Вы сможете восстановить
        их оттуда средствами операционной системы.
      </p>
    {/if}

    <div class="actions">
      <button class="btn ghost" disabled={deleting} onclick={close}
        >Отмена</button
      >
      <button
        class="btn primary"
        disabled={deleting || items.length === 0}
        onclick={handleConfirm}
      >
        {deleting ? "Удаление..." : "Переместить в Корзину"}
      </button>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    backdrop-filter: blur(var(--blur));
    -webkit-backdrop-filter: blur(var(--blur));
    z-index: 50;
    border: none;
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(28rem, calc(100vw - 2rem));
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--elev-2);
    padding: var(--sp-4);
    z-index: 51;
    color: var(--text);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .title {
    font-size: 0.95rem;
    font-weight: 600;
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

  .kpi {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin: var(--sp-3) 0;
  }
  .num {
    font-family: var(--font-display);
    font-size: 2rem;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }
  .lbl {
    color: var(--text-2);
    font-size: 0.82rem;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    border: 1px solid var(--hairline);
    border-radius: var(--r-sm);
    max-height: 16rem;
  }
  .list li {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.35rem 0.6rem;
    font-size: 0.78rem;
    border-bottom: 1px solid var(--hairline);
  }
  .list li:last-child {
    border-bottom: none;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  .size {
    color: var(--text-muted);
    font-family: var(--font-mono);
    flex-shrink: 0;
  }

  .note {
    color: var(--text-muted);
    font-size: 0.74rem;
    line-height: 1.4;
    margin: var(--sp-3) 0;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
  }
  .btn {
    font: inherit;
    font-size: 0.82rem;
    border-radius: var(--r-pill);
    padding: 0.4rem 0.9rem;
    cursor: pointer;
    border: 1px solid var(--border);
  }
  .ghost {
    color: var(--text);
    background: var(--surface);
  }
  .ghost:hover {
    border-color: rgba(255, 255, 255, 0.2);
  }
  .primary {
    color: #fff;
    background: var(--accent);
    border-color: transparent;
    font-weight: 600;
  }
  .primary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
