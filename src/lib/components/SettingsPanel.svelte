<script lang="ts">
  /**
   * Окно настроек (§II.11) — всплывает по кнопке-шестерёнке в шапке справа.
   * Поповер, заякоренный под правым краем header; закрытие по scrim/✕/Esc.
   *
   * Разбито на вкладки по типу настроек:
   *   - Визуальные   — тема (палитра всего UI + 3D-акцент);
   *   - Отображение  — как строится город (порог свёртки в «Прочее»);
   *   - Сохранение   — восстановление снимка при запуске;
   *   - Прочее       — сброс к умолчаниям, о программе.
   *
   * Все значения живут в сторах (settings/mode) — панель лишь читает/пишет их;
   * применение (перекраска DOM, пересборка города) делают подписчики.
   */
  import {
    theme,
    setTheme,
    settingsOpen,
    setSettingsOpen,
    THEME_ORDER,
    accentHex,
    bgHex,
    restoreLastScan,
    setRestoreLastScan,
    resetSettings,
    AGG_FRACTION_MIN,
    AGG_FRACTION_MAX,
    graphicsLevel,
    setGraphicsLevel,
    GRAPHICS_ORDER,
  } from "../store/settings";
  import {
    aggSettings,
    categoryFilter,
    categoryFilterActive,
    toggleCategory,
    resetCategories,
    showAggregate,
    ALL_CATEGORIES,
  } from "../store/mode";
  import { CATEGORY_COLOR, CATEGORY_LABEL } from "../three/palette";

  type Tab = "visual" | "display" | "save" | "other";
  const TABS: { id: Tab; label: string }[] = [
    { id: "visual", label: "Визуальные" },
    { id: "display", label: "Отображение" },
    { id: "save", label: "Сохранение" },
    { id: "other", label: "Прочее" },
  ];

  let tab = $state<Tab>("visual");

  let open = $derived($settingsOpen);
  let current = $derived($theme);
  let graphics = $derived($graphicsLevel);
  // Порог свёртки как проценты (ползунок 1–20%) — SoT хранит долю (0.01–0.20).
  let aggPercent = $derived(Math.round($aggSettings.fraction * 100));
  let restore = $derived($restoreLastScan);

  function close() {
    setSettingsOpen(false);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
  function onAggInput(e: Event) {
    const pct = Number((e.currentTarget as HTMLInputElement).value);
    aggSettings.set({ fraction: pct / 100 });
  }
  /** Число 0xRRGGBB → CSS-hex (для точек-легенды категорий). */
  function catHex(value: number): string {
    return "#" + value.toString(16).padStart(6, "0");
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <!-- Клик мимо панели закрывает (button — доступно с клавиатуры). -->
  <button class="scrim" aria-label="Закрыть настройки" onclick={close}></button>

  <div class="panel" role="dialog" aria-modal="true" aria-label="Настройки">
    <div class="head">
      <span class="title">Настройки</span>
      <button class="x" onclick={close} aria-label="Закрыть">✕</button>
    </div>

    <!-- Вкладки -->
    <div class="tabs" role="tablist">
      {#each TABS as t (t.id)}
        <button
          class="tab"
          class:active={tab === t.id}
          role="tab"
          aria-selected={tab === t.id}
          onclick={() => (tab = t.id)}
        >
          {t.label}
        </button>
      {/each}
    </div>

    <div class="body">
      {#if tab === "visual"}
        <section class="section">
          <h3 class="section-title">Тема</h3>
          <div class="themes">
            {#each THEME_ORDER as t (t.name)}
              <button
                class="theme"
                class:active={current === t.name}
                aria-pressed={current === t.name}
                onclick={() => setTheme(t.name)}
              >
                <span
                  class="swatch"
                  style="--sw-bg: {bgHex(t.name)}; --sw-accent: {accentHex(
                    t.name,
                  )};"
                  aria-hidden="true"
                ></span>
                <span class="theme-label">{t.label}</span>
                {#if current === t.name}
                  <span class="check" aria-hidden="true">✓</span>
                {/if}
              </button>
            {/each}
          </div>
          <p class="note">
            Цвет категорий зданий одинаков во всех темах — так задумано для
            читаемости. Меняются акценты и поверхности интерфейса.
          </p>
        </section>

        <section class="section">
          <h3 class="section-title">Качество графики</h3>
          <div class="themes">
            {#each GRAPHICS_ORDER as g (g.level)}
              <button
                class="theme graphics"
                class:active={graphics === g.level}
                aria-pressed={graphics === g.level}
                onclick={() => setGraphicsLevel(g.level)}
              >
                <span class="theme-text">
                  <span class="theme-label">{g.label}</span>
                  <span class="theme-sub">{g.sub}</span>
                </span>
                {#if graphics === g.level}
                  <span class="check" aria-hidden="true">✓</span>
                {/if}
              </button>
            {/each}
          </div>
          <p class="note">
            Минимальный отключает матовое стекло и металл — заметно легче для
            слабых видеокарт. Меняется мгновенно, город пересобирается.
          </p>
        </section>
      {:else if tab === "display"}
        <section class="section">
          <div class="row-head">
            <h3 class="section-title">Категории</h3>
            {#if $categoryFilterActive}
              <button class="reset-cats" onclick={resetCategories}>
                Сбросить
              </button>
            {/if}
          </div>
          <div class="cats">
            {#each ALL_CATEGORIES as cat (cat)}
              <button
                class="cat-chip"
                class:off={!$categoryFilter.has(cat)}
                aria-pressed={$categoryFilter.has(cat)}
                title={CATEGORY_LABEL[cat]}
                onclick={() => toggleCategory(cat)}
              >
                <span
                  class="dot"
                  style="background:{$categoryFilter.has(cat)
                    ? catHex(CATEGORY_COLOR[cat])
                    : 'var(--text-muted)'}"
                ></span>
                <span class="cat-lbl">{CATEGORY_LABEL[cat]}</span>
              </button>
            {/each}
          </div>
          <p class="note">
            Снятые категории убираются из города — площадь перетекает к
            оставшимся. Папка скрыта, если внутри нет ни одной выбранной
            категории.
          </p>
        </section>

        <section class="section">
          <h3 class="section-title">Блок «Прочее»</h3>
          <label class="toggle">
            <span class="toggle-text">
              <span class="toggle-label">Показывать «Прочее»</span>
              <span class="toggle-sub">
                Свёрнутый блок мелких файлов и папок. Выкл — мелочь не
                отображается, площадь перетекает к крупным.
              </span>
            </span>
            <input
              type="checkbox"
              checked={$showAggregate}
              onchange={(e) => showAggregate.set(e.currentTarget.checked)}
            />
            <span class="switch" aria-hidden="true"></span>
          </label>

          <div class="row-head">
            <span class="sub-label">Порог свёртки</span>
            <span class="value">{aggPercent}%</span>
          </div>
          <input
            class="range"
            type="range"
            min={Math.round(AGG_FRACTION_MIN * 100)}
            max={Math.round(AGG_FRACTION_MAX * 100)}
            step="1"
            value={aggPercent}
            oninput={onAggInput}
            aria-label="Порог свёртки в «Прочее», процент объёма папки"
          />
          <p class="note">
            Здания мельче этой доли объёма папки сворачиваются в «Прочее».
            Больше значение — крупнее и чище город; меньше — видно больше
            отдельных файлов. Город пересобирается сразу.
          </p>
        </section>
      {:else if tab === "save"}
        <section class="section">
          <label class="toggle">
            <span class="toggle-text">
              <span class="toggle-label">Восстанавливать последний скан</span>
              <span class="toggle-sub">
                При запуске открывать снимок прошлого скана без повторного
                сканирования.
              </span>
            </span>
            <input
              type="checkbox"
              checked={restore}
              onchange={(e) => setRestoreLastScan(e.currentTarget.checked)}
            />
            <span class="switch" aria-hidden="true"></span>
          </label>
          <p class="note">
            Тема и настройки сохраняются автоматически и переживают перезапуск.
          </p>
        </section>
      {:else}
        <section class="section">
          <div class="about">
            <span class="brand">SECTORCITY</span>
            <span class="about-sub">Визуализатор занятого места на диске.</span>
          </div>
          <button class="btn-reset" onclick={resetSettings}>
            Сбросить настройки к умолчаниям
          </button>
          <p class="note">
            Вернёт тему, порог свёртки и восстановление скана к значениям по
            умолчанию.
          </p>
        </section>
      {/if}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    z-index: 60;
    cursor: default;
  }
  .panel {
    position: fixed;
    top: calc(var(--header-h) + var(--sp-2));
    /* Шестерёнка в правом кластере действий → окно якорим у правого края. */
    right: var(--sp-4);
    width: min(24rem, calc(100vw - 2rem));
    max-height: calc(100vh - var(--header-h) - var(--sp-6));
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--elev-2);
    padding: var(--sp-4);
    z-index: 61;
    color: var(--text);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .title {
    font-family: var(--font-label, inherit);
    font-size: 0.95rem;
    letter-spacing: var(--track-caps);
    text-transform: uppercase;
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

  /* Вкладки — сегменты по низу с подчёркиванием активного. */
  .tabs {
    display: flex;
    gap: var(--sp-1);
    border-bottom: 1px solid var(--hairline);
  }
  .tab {
    flex: 1 1 0;
    font: inherit;
    font-size: 0.72rem;
    letter-spacing: 0.01em;
    color: var(--text-muted);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 0.4rem 0.2rem 0.5rem;
    cursor: pointer;
    white-space: nowrap;
    transition:
      color var(--motion-micro) var(--ease-out),
      border-color var(--motion-micro) var(--ease-out);
  }
  .tab:hover {
    color: var(--text-2);
  }
  .tab.active {
    color: var(--text);
    border-bottom-color: var(--accent);
  }

  .body {
    min-height: 9rem;
  }
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .section-title {
    margin: 0;
    font-size: 0.7rem;
    letter-spacing: var(--track-caps);
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 600;
  }

  /* --- Визуальные: темы --- */
  .themes {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .theme {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    font: inherit;
    font-size: 0.85rem;
    color: var(--text);
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 0.5rem 0.7rem;
    cursor: pointer;
    transition:
      border-color var(--motion-micro) var(--ease-out),
      background var(--motion-micro) var(--ease-out);
  }
  .theme:hover {
    border-color: rgba(255, 255, 255, 0.2);
  }
  .theme.active {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .theme-label {
    flex: 1 1 auto;
  }
  /* Строка уровня графики: заголовок + пояснение в столбик (как тумблеры). */
  .graphics .theme-text {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    flex: 1 1 auto;
  }
  .graphics .theme-sub {
    font-size: 0.72rem;
    color: var(--text-muted);
    line-height: 1.35;
  }
  .check {
    color: var(--accent);
    font-weight: 700;
  }
  .swatch {
    position: relative;
    width: 2.4rem;
    height: 1.7rem;
    flex-shrink: 0;
    border-radius: var(--r-sm);
    background: var(--sw-bg);
    border: 1px solid var(--border);
  }
  .swatch::after {
    content: "";
    position: absolute;
    left: 0.3rem;
    right: 0.3rem;
    bottom: 0.3rem;
    height: 0.35rem;
    border-radius: var(--r-pill);
    background: var(--sw-accent);
  }

  /* --- Отображение: категории (фильтр) --- */
  .cats {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
  }
  .cat-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 0.25rem 0.55rem;
    cursor: pointer;
    border-radius: var(--r-pill);
    transition:
      background var(--motion-micro) var(--ease-out),
      border-color var(--motion-micro) var(--ease-out),
      opacity var(--motion-micro) var(--ease-out);
  }
  .cat-chip:hover {
    border-color: rgba(255, 255, 255, 0.2);
  }
  .cat-chip.off {
    opacity: 0.5;
  }
  .cat-chip.off .cat-lbl {
    color: var(--text-muted);
  }
  .cat-chip .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .cat-chip .cat-lbl {
    font-size: 0.75rem;
    color: var(--text);
  }
  .reset-cats {
    font-family: var(--font-label, inherit);
    font-size: 0.62rem;
    letter-spacing: var(--track-caps);
    text-transform: uppercase;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    border-radius: var(--r-pill);
    padding: 0.2rem 0.6rem;
    cursor: pointer;
    white-space: nowrap;
    transition: background var(--motion-micro) var(--ease-out);
  }
  .reset-cats:hover {
    background: var(--accent-soft-hover);
  }

  /* --- Отображение: ползунок порога --- */
  .row-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .sub-label {
    font-size: 0.82rem;
    color: var(--text);
  }
  .value {
    font-family: var(--font-mono);
    font-size: 0.85rem;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }
  .range {
    width: 100%;
    accent-color: var(--accent);
    cursor: pointer;
  }

  /* --- Сохранение: тумблер-переключатель --- */
  .toggle {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    cursor: pointer;
  }
  .toggle-text {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    flex: 1 1 auto;
  }
  .toggle-label {
    font-size: 0.85rem;
    color: var(--text);
  }
  .toggle-sub {
    font-size: 0.72rem;
    color: var(--text-muted);
    line-height: 1.35;
  }
  .toggle input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .switch {
    position: relative;
    flex-shrink: 0;
    width: 2.4rem;
    height: 1.35rem;
    border-radius: var(--r-pill);
    background: var(--surface);
    border: 1px solid var(--border);
    transition:
      background var(--motion-base) var(--ease-out),
      border-color var(--motion-base) var(--ease-out);
  }
  .switch::after {
    content: "";
    position: absolute;
    top: 50%;
    left: 0.2rem;
    width: 0.9rem;
    height: 0.9rem;
    border-radius: 50%;
    background: var(--text-2);
    transform: translateY(-50%);
    transition:
      transform var(--motion-base) var(--ease-out),
      background var(--motion-base) var(--ease-out);
  }
  .toggle input:checked ~ .switch {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  .toggle input:checked ~ .switch::after {
    transform: translate(1.05rem, -50%);
    background: var(--accent);
  }
  .toggle input:focus-visible ~ .switch {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* --- Прочее: about + сброс --- */
  .about {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    margin-bottom: var(--sp-1);
  }
  .brand {
    font-family: var(--font-display);
    font-size: 1.15rem;
    letter-spacing: var(--track-caps);
    color: var(--text);
  }
  .about-sub {
    font-size: 0.74rem;
    color: var(--text-muted);
  }
  .btn-reset {
    font: inherit;
    font-size: 0.82rem;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    padding: 0.45rem 0.9rem;
    cursor: pointer;
    align-self: flex-start;
    transition: border-color var(--motion-micro) var(--ease-out);
  }
  .btn-reset:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .note {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.72rem;
    line-height: 1.4;
  }
</style>
