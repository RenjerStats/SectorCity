<script lang="ts">
  /**
   * Панель режима «Сканер мусора» в footer: список ПРИЧИН по всему поддереву
   * текущего уровня (чекбокс-чип · глиф
   * уверенности · счётчик · объём), отсортированный по объёму (сортирует бэк).
   * Клик по чипу — массовая пометка/снятие всей причины (полный список путей
   * приходит лениво через `cleanup_paths`). Пресеты размера/давности остаются
   * фильтрами: применяются к пометке Review-причин и к подсветке сцены.
   */
  import {
    cleanupGroups,
    markedForCleanup,
    markMany,
    unmarkMany,
    candidateFilter,
    filterActive,
    currentLevel,
  } from "../store/mode";
  import { cleanupPaths } from "../ipc/commands";
  import { REASON_META, CONFIDENCE_META } from "../cleanup";
  import { formatSize } from "../format";
  import type { CleanupGroup, CleanupItemRef } from "../ipc/contract";

  const GB = 1024 ** 3;
  const MB = 1024 ** 2;

  const SIZE_PRESETS = [
    { label: "любой", value: 0 },
    { label: "≥ 100 МБ", value: 100 * MB },
    { label: "≥ 1 ГБ", value: GB },
  ];
  const AGE_PRESETS = [
    { label: "любая", value: 0 },
    { label: "> 6 мес.", value: 180 },
    { label: "> 1 года", value: 365 },
  ];

  let f = $derived($candidateFilter);
  let marks = $derived($markedForCleanup);
  let groups = $derived($cleanupGroups);

  // Какие причины помечены целиком (кликом по чипу) — для облика чипа. Локальное
  // приближение: точная сверка потребовала бы полного списка путей на клиенте.
  // Чип «подсвечен», если все его топ-элементы в пометке (дёшево и наглядно).
  function isReasonMarked(g: CleanupGroup): boolean {
    return g.topItems.length > 0 && g.topItems.every((n) => marks.has(n.path));
  }

  /** Фильтр пресетов размера/давности — применяется к пометке Review-причин
   *  (Safe/Likely помечаются целиком: правило уже даёт уверенность). */
  function passesPresets(item: CleanupItemRef): boolean {
    if (f.minSize > 0 && item.size < f.minSize) return false;
    if (f.olderThanDays > 0) {
      const olderThan = f.olderThanDays * 86400;
      if (Date.now() / 1000 - item.mtime < olderThan) return false;
    }
    return true;
  }

  let busyReason = $state<string | null>(null);

  /** Клик по чипу причины: пометить всю причину (или снять, если помечена). */
  async function toggleReason(g: CleanupGroup) {
    const scope = $currentLevel;
    if (!scope || busyReason) return;
    busyReason = g.reason;
    try {
      let items = await cleanupPaths(scope, g.reason);
      if (g.confidence === "review") items = items.filter(passesPresets);
      if (isReasonMarked(g)) {
        unmarkMany(items.map((i) => i.path));
      } else {
        markMany(items);
      }
    } catch (err) {
      console.warn("cleanup_paths не удался:", err);
    } finally {
      busyReason = null;
    }
  }

  function chipTitle(g: CleanupGroup): string {
    const conf = CONFIDENCE_META[g.confidence];
    return `${REASON_META[g.reason].explain}\n\nУверенность: ${conf.label} — ${conf.hint}`;
  }

  function setMinSize(v: number) {
    candidateFilter.set({ ...f, minSize: v });
  }
  function setOlder(v: number) {
    candidateFilter.set({ ...f, olderThanDays: v });
  }
  function resetFilters() {
    candidateFilter.set({ ...f, minSize: 0, olderThanDays: 0 });
  }
</script>

<div class="cleanup">
  <span class="cap">ПРИЧИНЫ</span>

  {#if groups.length === 0}
    <span class="hint">Кандидатов в этом поддереве не найдено</span>
  {:else}
    <div class="chips" role="list">
      {#each groups as g (g.reason)}
        <button
          class="chip"
          class:on={isReasonMarked(g)}
          disabled={busyReason !== null}
          title={chipTitle(g)}
          onclick={() => void toggleReason(g)}
        >
          <span
            class="dot"
            style:background={CONFIDENCE_META[g.confidence].cssVar}
            aria-hidden="true"
          ></span>
          <span class="chip-label">{REASON_META[g.reason].label}</span>
          <span class="chip-count">
            {g.count.toLocaleString("ru")} · {formatSize(g.bytes)}
          </span>
        </button>
      {/each}
    </div>
  {/if}

  <span class="hint gesture">Ctrl+клик по зданию — пометить на снос</span>

  <span class="spacer"></span>

  <span class="sep" aria-hidden="true"></span>

  <label class="field">
    <span class="field-lbl">Размер</span>
    <select
      value={f.minSize}
      onchange={(e) => setMinSize(Number(e.currentTarget.value))}
    >
      {#each SIZE_PRESETS as p (p.value)}
        <option value={p.value}>{p.label}</option>
      {/each}
    </select>
  </label>

  <label class="field">
    <span class="field-lbl">Давность</span>
    <select
      value={f.olderThanDays}
      onchange={(e) => setOlder(Number(e.currentTarget.value))}
    >
      {#each AGE_PRESETS as p (p.value)}
        <option value={p.value}>{p.label}</option>
      {/each}
    </select>
  </label>

  {#if $filterActive}
    <button
      class="reset-filter"
      onclick={resetFilters}
      title="Сбросить фильтры кандидатов"
    >
      Сбросить
    </button>
  {/if}
</div>

<style>
  .cleanup {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    width: 100%;
    min-width: 0;
    overflow: hidden;
  }
  .cap {
    font-family: var(--font-label);
    font-size: 0.62rem;
    letter-spacing: var(--track-caps);
    color: var(--text-muted);
    white-space: nowrap;
  }

  /* Лента чипов-причин: горизонтальный скролл при переполнении (footer — одна
     строка фиксированной высоты, вертикали нет). */
  .chips {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: thin;
    padding: 2px 0;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
    font: inherit;
    font-size: 0.74rem;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    padding: 0.2rem 0.6rem;
    cursor: pointer;
    transition:
      background var(--motion-micro) var(--ease-out),
      border-color var(--motion-micro) var(--ease-out);
  }
  .chip:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .chip.on {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .chip:disabled {
    opacity: 0.6;
    cursor: wait;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .chip-label {
    font-weight: 600;
    white-space: nowrap;
  }
  .chip-count {
    color: var(--text-2);
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .hint {
    font-size: 0.72rem;
    color: var(--text-muted);
    white-space: nowrap;
  }
  /* Подсказка жеста прячется первой, когда чипам тесно. */
  .hint.gesture {
    flex-shrink: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .spacer {
    flex: 1 1 auto;
  }

  .sep {
    width: 1px;
    align-self: stretch;
    background: var(--hairline);
    margin: 0 0.2rem;
  }

  .field {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    white-space: nowrap;
  }

  .field-lbl {
    color: var(--text-muted);
    font-size: 0.76rem;
  }

  select {
    font: inherit;
    font-size: 0.76rem;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 0.2rem 1.4rem 0.2rem 0.45rem;
    outline: none;
    cursor: pointer;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%236e6e73' stroke-width='2.5'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' d='M19.5 8.25l-7.5 7.5-7.5-7.5'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.4rem center;
    background-size: 0.7rem;
    transition: border-color var(--motion-micro) var(--ease-out);
  }

  select:hover,
  select:focus {
    border-color: var(--accent);
  }

  .reset-filter {
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

  .reset-filter:hover {
    background: var(--accent-soft-hover);
  }
</style>
