<script lang="ts">
  /**
   * Панель фильтра-подсветки кандидатов (фаза 2, DoD). Переехала в footer
   * (открывается тумблером «Фильтры» в header) — горизонтальная компактная форма.
   * Пишет в стор `candidateFilter`; рендер сам гасит несовпадающие узлы (Scene
   * подписан и зовёт `navigator.applyHighlight`). Логика прежняя, изменён облик.
   */
  import { candidateFilter, filterActive } from "../store/mode";

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

  function toggleCandidates() {
    candidateFilter.set({ ...f, onlyCandidates: !f.onlyCandidates });
  }
  function setMinSize(v: number) {
    candidateFilter.set({ ...f, minSize: v });
  }
  function setOlder(v: number) {
    candidateFilter.set({ ...f, olderThanDays: v });
  }
  function reset() {
    candidateFilter.set({
      onlyCandidates: false,
      minSize: 0,
      olderThanDays: 0,
    });
  }
</script>

<div class="filters">
  <span class="cap">ФИЛЬТР</span>

  <label class="check">
    <input
      type="checkbox"
      checked={f.onlyCandidates}
      onchange={toggleCandidates}
    />
    <span class="box" aria-hidden="true"></span>
    <span>Кандидаты на очистку</span>
  </label>

  <label class="field">
    <span class="lbl">Размер</span>
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
    <span class="lbl">Давность</span>
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
    <button class="reset" onclick={reset}>Сбросить</button>
  {/if}
</div>

<style>
  .filters {
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

  /* Кастомный чекбокс — матовый, акцент при отметке. */
  .check {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
    color: var(--text);
  }
  .check input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .box {
    position: relative;
    width: 1rem;
    height: 1rem;
    border-radius: var(--r-sm);
    background: var(--surface-2);
    border: 1px solid var(--border);
    transition:
      background var(--motion-micro) var(--ease-out),
      border-color var(--motion-micro) var(--ease-out);
  }
  .check input:checked ~ .box {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  .box::after {
    content: "";
    position: absolute;
    left: 5px;
    top: 2px;
    width: 3px;
    height: 6px;
    border: solid var(--accent);
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
    opacity: 0;
    transition: opacity var(--motion-micro) var(--ease-out);
  }
  .check input:checked ~ .box::after {
    opacity: 1;
  }

  .field {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    white-space: nowrap;
  }
  .lbl {
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

  .reset {
    font: inherit;
    font-size: 0.76rem;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    border-radius: var(--r-pill);
    padding: 0.25rem 0.7rem;
    cursor: pointer;
    white-space: nowrap;
    transition: background var(--motion-micro) var(--ease-out);
  }
  .reset:hover {
    background: rgba(215, 25, 33, 0.22);
  }
</style>
