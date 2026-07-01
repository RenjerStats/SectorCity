<script lang="ts">
  /**
   * Окно-шпаргалка горячих клавиш (F1 / «?») — общепрограммный модал по центру
   * (overlay + blur), как CleanupConfirm/Settings. Раскладка утверждена
   * пользователем; источник смысла — hotkeys.ts. Свой Esc (owns своё закрытие).
   */
  import { helpOpen, setHelpOpen } from "../store/ui";

  let open = $derived($helpOpen);

  function close() {
    setHelpOpen(false);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  /** Группы хоткеев для показа: заголовок + пары [клавиша, действие]. */
  const groups: { title: string; rows: [string, string][] }[] = [
    {
      title: "Навигация",
      rows: [
        ["Enter", "Войти в наведённую папку"],
        ["Backspace / Alt+←", "На уровень вверх"],
        ["R / Home", "Сбросить вид"],
        ["W A S D", "Панорама камеры"],
        ["Колесо · + −", "Зум камеры"],
      ],
    },
    {
      title: "Узел",
      rows: [
        ["Space", "Свойства (карточка)"],
        ["Ctrl+C", "Копировать путь"],
        ["E", "Показать в проводнике"],
        ["H", "Скрыть узел"],
        ["Shift+H", "Панель скрытого"],
      ],
    },
    {
      title: "Поиск и фильтры",
      rows: [
        ["/ · Ctrl+F", "Поиск по имени"],
        ["L", "Легенда"],
        ["1 – 8", "Категории (по легенде)"],
        ["0", "Показывать «Мелочь»"],
      ],
    },
    {
      title: "Сканер мусора",
      rows: [
        ["Ctrl+G", "Вход / выход"],
        ["X", "Пометить / снять на снос"],
        ["Ctrl+Enter", "Подтвердить снос"],
      ],
    },
    {
      title: "Программа",
      rows: [
        ["Ctrl+O", "Сканировать папку"],
        ["Ctrl+,", "Настройки"],
        ["F1 / ?", "Эта шпаргалка"],
        ["Esc", "Назад / закрыть / отмена"],
      ],
    },
  ];
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <button class="scrim" aria-label="Закрыть" onclick={close}></button>

  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-label="Горячие клавиши"
  >
    <div class="head">
      <span class="title">Горячие клавиши</span>
      <button class="x" onclick={close} aria-label="Закрыть">✕</button>
    </div>

    <div class="grid">
      {#each groups as g (g.title)}
        <section class="group">
          <h3>{g.title}</h3>
          <dl>
            {#each g.rows as [keys, label] (keys)}
              <div class="row">
                <dt>
                  {#each keys.split(" ") as tok (tok)}
                    {#if tok === "·" || tok === "/"}
                      <span class="op">{tok}</span>
                    {:else}
                      <kbd>{tok}</kbd>
                    {/if}
                  {/each}
                </dt>
                <dd>{label}</dd>
              </div>
            {/each}
          </dl>
        </section>
      {/each}
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
    width: min(46rem, calc(100vw - 2rem));
    max-height: 84vh;
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
    margin-bottom: var(--sp-3);
  }
  .title {
    font-family: var(--font-label, inherit);
    letter-spacing: var(--track-caps);
    text-transform: uppercase;
    font-size: 0.85rem;
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

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
    gap: var(--sp-4);
    overflow-y: auto;
  }
  .group h3 {
    margin: 0 0 var(--sp-2);
    font-size: 0.68rem;
    letter-spacing: var(--track-caps);
    text-transform: uppercase;
    color: var(--accent);
  }
  dl {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--sp-2);
  }
  dt {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }
  dd {
    margin: 0;
    color: var(--text-2);
    font-size: 0.78rem;
    text-align: right;
  }
  kbd {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    line-height: 1;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 0.18rem 0.4rem;
    white-space: nowrap;
  }
  .op {
    color: var(--text-muted);
    font-size: 0.72rem;
  }
</style>
