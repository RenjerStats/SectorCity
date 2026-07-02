<script lang="ts">
  import StarGlyph from "./StarGlyph.svelte";

  type StatusKind =
    | "loading"
    | "welcome"
    | "empty"
    | "error"
    | "cancelled"
    | "none";

  let {
    kind,
    errors = 0,
    onScan,
  }: {
    kind: StatusKind;
    /** Число пропущенных из-за ошибок входов (для kind="error"). */
    errors?: number;
    /** Вызвать, когда пользователь жмёт кнопку действия (скан/повтор). */
    onScan: () => void;
  } = $props();
</script>

{#if kind !== "none"}
  <div class="overlay-container">
    <div class="status-card">
      <!-- Бренд-глиф «полярная звезда» из точек (план §6): пульсирует, пока
           что-то грузится; в остальных состояниях — статичная марка. -->
      <StarGlyph size={40} pulse={kind === "loading"} />
      {#if kind === "loading"}
        <h2 class="title">Загружаю снимок…</h2>
        <p class="description">
          Читаю снимок прошлого сканирования — город появится без рескана.
        </p>
      {:else if kind === "welcome"}
        <h2 class="title accent">SECTORCITY</h2>
        <p class="description">
          Инструмент анализа дискового пространства.<br />Здание — файл, район —
          папка. Кодирование площади, высоты и цвета поможет быстро найти мусор.
        </p>
        <button class="action-btn" onclick={onScan}>Сканировать папку</button>
      {:else if kind === "empty"}
        <h2 class="title">Папка пуста</h2>
        <p class="description">В выбранной папке нет файлов для отображения.</p>
        <button class="action-btn secondary" onclick={onScan}>
          Выбрать другую папку
        </button>
      {:else if kind === "error"}
        <h2 class="title error">Ошибка сканирования</h2>
        <p class="description">
          Не удалось получить доступ к папке или произошел сбой.
          {#if errors > 0}
            <br />
            <span class="errors-count">
              Пропущено объектов: {errors.toLocaleString("ru")}
            </span>
          {/if}
        </p>
        <button class="action-btn" onclick={onScan}>Попробовать снова</button>
      {:else if kind === "cancelled"}
        <h2 class="title">Скан отменён</h2>
        <p class="description">
          Процесс сканирования диска был прерван пользователем.
        </p>
        <button class="action-btn" onclick={onScan}>Сканировать снова</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .overlay-container {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    padding: 2rem;
  }

  /* Матовая центральная карточка состояния (Nothing). */
  .status-card {
    pointer-events: auto;
    width: 100%;
    max-width: 420px;
    background: var(--overlay);
    backdrop-filter: blur(var(--blur));
    -webkit-backdrop-filter: blur(var(--blur));
    border: 1px solid var(--border);
    border-radius: var(--r-card);
    padding: 2rem;
    box-shadow: var(--elev-2);
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.25rem;
    animation: fadeIn var(--motion-base) var(--ease-out);
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(6px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  .title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 2rem; /* крупнее — dot-matrix Ndot77 читается точками */
    letter-spacing: var(--track-caps);
    color: var(--text);
  }
  .title.accent {
    color: var(--text);
  }
  .title.error {
    color: var(--accent);
  }

  .description {
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.5;
    color: var(--text-2);
    max-width: 100%;
  }

  .errors-count {
    display: inline-block;
    margin-top: 0.5rem;
    font-size: 0.85rem;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid rgba(215, 25, 33, 0.3);
    padding: 0.25rem 0.6rem;
    border-radius: var(--r-sm);
  }

  /* Главное действие — красная заливка (CTA). */
  .action-btn {
    font-family: inherit;
    font-size: 0.9rem;
    font-weight: 600;
    color: #fff;
    background: var(--accent);
    border: none;
    border-radius: var(--r-pill);
    padding: 0.55rem 1.25rem;
    cursor: pointer;
    transition:
      background var(--motion-micro) var(--ease-out),
      transform var(--motion-micro) var(--ease-out);
  }
  .action-btn:hover {
    background: var(--accent-hover);
  }
  .action-btn:active {
    transform: scale(0.98);
  }

  .action-btn.secondary {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
  }
  .action-btn.secondary:hover {
    background: #232327;
    border-color: rgba(255, 255, 255, 0.2);
  }
</style>
