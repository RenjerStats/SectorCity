<script lang="ts">
  type StatusKind = "welcome" | "empty" | "error" | "cancelled" | "none";

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

{#if kind !== "none" && (kind === "welcome" || kind === "empty" || kind === "error" || kind === "cancelled")}
  <div class="overlay-container">
    <div class="status-card">
      {#if kind === "welcome"}
        <h2 class="title accent">SectorCity</h2>
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

  .status-card {
    pointer-events: auto;
    width: 100%;
    max-width: 420px;
    background: rgba(14, 15, 19, 0.85);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 0.75rem;
    padding: 2rem;
    box-shadow:
      0 10px 30px rgba(0, 0, 0, 0.5),
      inset 0 1px 0 rgba(255, 255, 255, 0.1);
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.25rem;
    animation: fadeIn 0.3s ease-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: scale(0.95);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .title {
    margin: 0;
    font-size: 1.75rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    background: linear-gradient(
      135deg,
      #ffffff 40%,
      rgba(255, 255, 255, 0.6) 100%
    );
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .title.accent {
    background: linear-gradient(
      135deg,
      #ffffff 30%,
      var(--accent, #4f9dff) 100%
    );
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .title.error {
    background: linear-gradient(135deg, #ffffff 30%, #ff6b6b 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .description {
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.5;
    color: var(--muted, #8b929c);
    max-width: 100%;
  }

  .errors-count {
    display: inline-block;
    margin-top: 0.5rem;
    font-size: 0.85rem;
    color: #ff6b6b;
    background: rgba(255, 107, 107, 0.1);
    border: 1px solid rgba(255, 107, 107, 0.2);
    padding: 0.25rem 0.6rem;
    border-radius: 0.25rem;
  }

  .action-btn {
    font-family: inherit;
    font-size: 0.95rem;
    font-weight: 500;
    color: #ffffff;
    background: var(--accent, #4f9dff);
    border: none;
    border-radius: 0.375rem;
    padding: 0.6rem 1.25rem;
    cursor: pointer;
    transition:
      background-color 0.2s,
      transform 0.1s,
      box-shadow 0.2s;
    box-shadow: 0 4px 12px rgba(79, 157, 255, 0.3);
  }

  .action-btn:hover {
    background: #3a86eb;
    box-shadow: 0 4px 16px rgba(79, 157, 255, 0.4);
  }

  .action-btn:active {
    transform: scale(0.97);
  }

  .action-btn.secondary {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: var(--fg, #e6e8eb);
    box-shadow: none;
  }

  .action-btn.secondary:hover {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.2);
  }
</style>
