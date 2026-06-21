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
  <!-- Заголовок панели с иконкой и индикатором активности -->
  <div class="panel-header">
    <div class="title-group">
      <svg
        class="panel-icon"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        stroke-width="2.2"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 01-.659 1.591l-5.432 5.432a2.25 2.25 0 00-.659 1.591v2.927a2.25 2.25 0 01-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 00-.659-1.591L3.659 7.409A2.25 2.25 0 013 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0112 3z"
        />
      </svg>
      <span class="title-text">Фильтр узлов</span>
    </div>
    {#if $filterActive}
      <span class="status-indicator" title="Фильтр активен"></span>
    {/if}
  </div>

  <div class="divider"></div>

  <!-- Кастомный чекбокс кандидатов на очистку -->
  <label class="checkbox-container">
    <input
      type="checkbox"
      checked={f.onlyCandidates}
      onchange={toggleCandidates}
    />
    <span class="checkmark"></span>
    <span class="label-text">Кандидаты на очистку</span>
  </label>

  <!-- Выпадающий список размера -->
  <div class="field">
    <span class="field-label">Размер</span>
    <select
      value={f.minSize}
      onchange={(e) => setMinSize(Number(e.currentTarget.value))}
    >
      {#each SIZE_PRESETS as p (p.value)}
        <option value={p.value}>{p.label}</option>
      {/each}
    </select>
  </div>

  <!-- Выпадающий список давности -->
  <div class="field">
    <span class="field-label">Давность</span>
    <select
      value={f.olderThanDays}
      onchange={(e) => setOlder(Number(e.currentTarget.value))}
    >
      {#each AGE_PRESETS as p (p.value)}
        <option value={p.value}>{p.label}</option>
      {/each}
    </select>
  </div>

  <!-- Кнопка сброса при активном фильтре -->
  {#if $filterActive}
    <button class="reset-btn" onclick={reset}>
      <svg
        class="reset-icon"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M23 4v6h-6"></path>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
      </svg>
      <span>Сбросить фильтр</span>
    </button>
  {/if}
</div>

<style>
  .panel {
    /* Фиксированное позиционирование слева внизу */
    position: absolute;
    bottom: 1rem;
    left: 1rem;

    /* Разметка */
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    padding: 0.85rem 1rem;
    width: 14.5rem;
    box-sizing: border-box;

    /* Оформление: Premium Dark Glassmorphism */
    background: rgba(20, 22, 27, 0.93);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    box-shadow:
      0 12px 32px rgba(0, 0, 0, 0.5),
      0 0 0 1px rgba(255, 255, 255, 0.05),
      0 0 24px rgba(79, 157, 255, 0.02);

    /* Типографика */
    font-family: inherit;
    font-size: 0.82rem;
    color: var(--fg, #e6e6e6);

    /* Анимации свечения */
    transition:
      border-color 0.25s cubic-bezier(0.4, 0, 0.2, 1),
      box-shadow 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* Подсветка панели при активном состоянии */
  .panel.active {
    border-color: rgba(242, 193, 78, 0.35);
    box-shadow:
      0 12px 36px rgba(0, 0, 0, 0.55),
      0 0 0 1px rgba(242, 193, 78, 0.15),
      0 0 20px rgba(242, 193, 78, 0.06);
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .title-group {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }

  .panel-icon {
    width: 0.9rem;
    height: 0.9rem;
    color: var(--muted, #8b929c);
    transition: color 0.25s ease;
  }

  .panel.active .panel-icon {
    color: #f2c14e;
  }

  .title-text {
    font-weight: 600;
    color: #ffffff;
    font-size: 0.85rem;
    letter-spacing: -0.01em;
  }

  /* Пульсирующий желтый индикатор активности */
  .status-indicator {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background-color: #f2c14e;
    box-shadow: 0 0 8px #f2c14e;
    animation: pulse 2s infinite;
  }

  @keyframes pulse {
    0% {
      opacity: 0.4;
      box-shadow: 0 0 2px #f2c14e;
    }
    50% {
      opacity: 1;
      box-shadow: 0 0 8px #f2c14e;
    }
    100% {
      opacity: 0.4;
      box-shadow: 0 0 2px #f2c14e;
    }
  }

  .divider {
    height: 1px;
    background: rgba(255, 255, 255, 0.07);
    margin: 0.1rem 0;
  }

  /* Дизайн кастомного чекбокса */
  .checkbox-container {
    display: flex;
    align-items: center;
    position: relative;
    padding-left: 1.55rem;
    cursor: pointer;
    user-select: none;
    font-size: 0.8rem;
    color: var(--fg, #e6e6e6);
    line-height: 1.15rem;
  }

  /* Скрываем нативный input */
  .checkbox-container input {
    position: absolute;
    opacity: 0;
    cursor: pointer;
    height: 0;
    width: 0;
  }

  /* Кастомная рамка чекбокса */
  .checkmark {
    position: absolute;
    top: 0.05rem;
    left: 0;
    height: 1.05rem;
    width: 1.05rem;
    background-color: rgba(0, 0, 0, 0.22);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 4px;
    transition: all 0.2s ease;
  }

  .checkbox-container:hover input ~ .checkmark {
    border-color: rgba(255, 255, 255, 0.25);
    background-color: rgba(255, 255, 255, 0.03);
  }

  /* Активное состояние чекбокса */
  .checkbox-container input:checked ~ .checkmark {
    background-color: rgba(242, 193, 78, 0.15);
    border-color: #f2c14e;
    box-shadow: 0 0 6px rgba(242, 193, 78, 0.1);
  }

  /* Символ галочки */
  .checkmark::after {
    content: "";
    position: absolute;
    display: none;
    left: 5px;
    top: 2px;
    width: 3px;
    height: 6px;
    border: solid #f2c14e;
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }

  /* Показываем галочку при отметке */
  .checkbox-container input:checked ~ .checkmark::after {
    display: block;
  }

  .label-text {
    font-weight: 500;
  }

  /* Блок полей ввода с селектом */
  .field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.65rem;
  }

  .field-label {
    color: var(--muted, #8b929c);
    font-size: 0.78rem;
    font-weight: 500;
  }

  .field select {
    font: inherit;
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--fg, #e6e6e6);
    background: rgba(0, 0, 0, 0.22);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    padding: 0.25rem 1.4rem 0.25rem 0.45rem;
    outline: none;
    cursor: pointer;
    min-width: 6.8rem;
    box-sizing: border-box;

    /* Скрываем нативную стрелку */
    appearance: none;
    -webkit-appearance: none;

    /* Наша кастомная векторная стрелочка-chevron */
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%238b929c' stroke-width='2.5'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' d='M19.5 8.25l-7.5 7.5-7.5-7.5'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.4rem center;
    background-size: 0.7rem;

    transition: all 0.2s ease;
  }

  .field select:hover {
    border-color: rgba(255, 255, 255, 0.25);
    background-color: rgba(255, 255, 255, 0.02);
  }

  .field select:focus {
    border-color: rgba(242, 193, 78, 0.35);
    box-shadow: 0 0 6px rgba(242, 193, 78, 0.1);
  }

  .panel.active .field select:focus {
    border-color: #f2c14e;
  }

  /* Кнопка сброса фильтра */
  .reset-btn {
    margin-top: 0.25rem;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    padding: 0.4rem;
    font-family: inherit;
    font-size: 0.75rem;
    font-weight: 600;
    color: #f2c14e;
    background: rgba(242, 193, 78, 0.08);
    border: 1px solid rgba(242, 193, 78, 0.25);
    border-radius: 6px;
    cursor: pointer;
    transition:
      background-color 0.15s,
      border-color 0.15s,
      transform 0.1s;
  }

  .reset-btn:hover {
    background: rgba(242, 193, 78, 0.13);
    border-color: rgba(242, 193, 78, 0.4);
  }

  .reset-btn:active {
    transform: scale(0.98);
  }

  .reset-icon {
    width: 0.75rem;
    height: 0.75rem;
    flex-shrink: 0;
  }
</style>
