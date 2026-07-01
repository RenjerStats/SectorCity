<script lang="ts">
  /**
   * Всплывающая плашка-подтверждение (vision-принцип «любое действие видно в UI»).
   * Появляется снизу по центру над footer, сама гаснет через `LIFETIME_MS`.
   * Источник — стор `toast`; показывается для действий без иного видимого следа
   * (сейчас — «Скопировано в буфер обмена»).
   */
  import { toast } from "../store/ui";

  /** Сколько плашка висит до авто-скрытия. */
  const LIFETIME_MS = 1800;

  let current = $state<{ id: number; text: string } | null>(null);
  let visible = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Новый тост из стора → показать и (пере)запустить таймер скрытия. Сравнение по
  // id: одинаковый текст подряд всё равно рестартует таймаут (id уникален).
  $effect(() => {
    const t = $toast;
    if (!t) return;
    current = t;
    visible = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      visible = false; // запускаем fade-out; контент оставляем до анимации
    }, LIFETIME_MS);
    return () => {
      if (timer) clearTimeout(timer);
    };
  });
</script>

{#if current}
  <div class="toast" class:show={visible} role="status" aria-live="polite">
    <svg
      class="check"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
    <span>{current.text}</span>
  </div>
{/if}

<style>
  .toast {
    position: fixed;
    left: 50%;
    bottom: calc(var(--footer-h, 2.5rem) + var(--sp-4));
    transform: translate(-50%, 0.5rem);
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 0.45rem 0.85rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    box-shadow: var(--elev-2);
    color: var(--text);
    font-size: 0.8rem;
    white-space: nowrap;
    z-index: 60;
    opacity: 0;
    pointer-events: none;
    transition:
      opacity var(--motion-base) var(--ease-out),
      transform var(--motion-base) var(--ease-out);
  }
  .toast.show {
    opacity: 1;
    transform: translate(-50%, 0);
  }
  .check {
    color: var(--safe);
    flex-shrink: 0;
  }
</style>
