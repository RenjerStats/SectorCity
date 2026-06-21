<script lang="ts">
  /**
   * Панель фильтра-подсветки кандидатов на очистку (фаза 2, DoD). Пишет в стор
   * `candidateFilter`; рендер сам гасит несовпадающие узлы (Scene подписан на
   * стор и зовёт `navigator.applyHighlight`). Презентационный компонент: своей
   * 3D/IPC-логики нет, только правка критериев фильтра в сторе.
   *
   * Внешний вид можно дорабатывать отдельно (тикет Gemini): контракт — чтение/
   * запись `candidateFilter` и поля `onlyCandidates`/`minSize`/`olderThanDays`.
   */
  import { candidateFilter, filterActive } from "../store/mode";

  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  /** Пресеты порога размера (байты) и давности (дни) — простые select'ы. */
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

<div class="panel" class:active={$filterActive}>
  <div class="title">Фильтр кандидатов</div>

  <label class="check">
    <input
      type="checkbox"
      checked={f.onlyCandidates}
      onchange={toggleCandidates}
    />
    Только кандидаты на очистку
  </label>

  <label class="field">
    Размер
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
    Давность
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
    <button class="reset" onclick={reset}>Сбросить фильтр</button>
  {/if}
</div>

<style>
  .panel {
    position: absolute;
    bottom: 1rem;
    left: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.6rem 0.8rem;
    background: rgba(30, 32, 38, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 0.5rem;
    font-size: 0.82rem;
    color: var(--fg, #e6e6e6);
  }
  .panel.active {
    border-color: rgba(242, 193, 78, 0.5);
  }
  .title {
    font-weight: 600;
    margin-bottom: 0.1rem;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
  }
  .field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    color: var(--muted, #8b929c);
  }
  .field select {
    font: inherit;
    font-size: 0.8rem;
    color: var(--fg, #e6e6e6);
    background: rgba(20, 22, 27, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 0.3rem;
    padding: 0.15rem 0.3rem;
  }
  .reset {
    margin-top: 0.2rem;
    font: inherit;
    font-size: 0.78rem;
    color: var(--accent, #4f9dff);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
  }
  .reset:hover {
    text-decoration: underline;
  }
</style>
