<script lang="ts">
  /**
   * Панель режима «Сканер мусора» в footer (vision §I.7, шаг 2/4). Показывает
   * причину(ы) очистки со счётчиком/объёмом и массовую пометку, плюс настройки
   * размера и давности для фильтрации кандидатов.
   */
  import {
    cleanupCandidatesHere,
    markedForCleanup,
    markMany,
    unmarkMany,
    candidateFilter,
    filterActive,
  } from "../store/mode";
  import { formatSize } from "../format";

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

  // Кандидаты, отфильтрованные по размеру и давности
  let candidates = $derived(
    $cleanupCandidatesHere.filter((n) => {
      if (f.minSize > 0 && n.size < f.minSize) return false;
      if (f.olderThanDays > 0) {
        const olderThan = f.olderThanDays * 86400;
        if (Date.now() / 1000 - n.mtime < olderThan) return false;
      }
      return true;
    })
  );

  // Суммарный объём кандидатов этого уровня (для строки причины).
  let candBytes = $derived(candidates.reduce((s, n) => s + n.size, 0));
  // Все ли кандидаты уровня уже помечены (тогда кнопка снимает, а не ставит).
  let allMarked = $derived(
    candidates.length > 0 && candidates.every((n) => marks.has(n.path)),
  );

  function toggleAll() {
    if (allMarked) unmarkMany(candidates.map((n) => n.path));
    else markMany(candidates);
  }

  function setMinSize(v: number) {
    candidateFilter.set({ ...f, minSize: v });
  }
  function setOlder(v: number) {
    candidateFilter.set({ ...f, olderThanDays: v });
  }
  function resetFilters() {
    candidateFilter.set({
      ...f,
      minSize: 0,
      olderThanDays: 0,
    });
  }
</script>

<div class="cleanup">
  <span class="cap">ПРИЧИНА</span>

  <div class="reason">
    <span class="dot" aria-hidden="true"></span>
    <span class="reason-label">Кандидаты на очистку</span>
    <span class="reason-hint">кэш · корзина · крупные старые</span>
    <span class="reason-count">
      {candidates.length}
      {#if candidates.length > 0}· {formatSize(candBytes)}{/if}
    </span>
    <button
      class="mark-all"
      disabled={candidates.length === 0}
      onclick={toggleAll}
    >
      {allMarked ? "Снять все" : "Отметить все"}
    </button>
  </div>

  <span class="hint">Клик по зданию — пометить на снос</span>

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
    <button class="reset-filter" onclick={resetFilters} title="Сбросить фильтры кандидатов">
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

  .reason {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    white-space: nowrap;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent-soft);
    flex-shrink: 0;
  }
  .reason-label {
    color: var(--text);
    font-size: 0.8rem;
    font-weight: 600;
  }
  .reason-hint {
    color: var(--text-muted);
    font-size: 0.72rem;
  }
  .reason-count {
    color: var(--text-2);
    font-size: 0.76rem;
    font-variant-numeric: tabular-nums;
  }
  .mark-all {
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
  .mark-all:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-soft);
  }
  .mark-all:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .hint {
    font-size: 0.72rem;
    color: var(--text-muted);
    white-space: nowrap;
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
    background: rgba(215, 25, 33, 0.22);
  }
</style>
