<script lang="ts">
  /**
   * Единое окно над зданием: компактный вид по наведению (имя · категория ·
   * размер) разворачивается по клику в полную карточку (даты · путь · действия)
   * с анимацией. Один источник формы/стиля для hover и select (раньше были два
   * отдельных оверлея — тултип и карточка — с дублирующейся информацией).
   *
   * Презентационный компонент: КОНТЕНТ и режим (`expanded`) приходят пропсами,
   * ПОЗИЦИЮ ставит владелец (Scene) императивно покадрово (docs §4). Действия
   * проксируются наружу колбэками; своей логики IPC нет.
   */
  import { slide } from "svelte/transition";
  import {
    CATEGORY_LABEL,
    CATEGORY_COLOR,
    AGGREGATE_COLOR,
  } from "../three/palette";
  import { formatSize, formatDate } from "../format";
  import { REASON_META, CONFIDENCE_META } from "../cleanup";
  import CategoryGlyph from "./CategoryGlyph.svelte";
  import type { Category, ScanNode } from "../ipc/contract";

  interface Props {
    /** Узел для показа (наведённый или выбранный). */
    node: ScanNode;
    /** true — полная карточка (выбор); false — компактный hover-вид. */
    expanded: boolean;
    /** «Показать в проводнике» (безопасно). Владелец заворачивает IPC + ошибки. */
    onReveal: (path: string) => void;
    /** Закрыть карточку (снять выбор). */
    onClose: () => void;
    /** Скрыть узел из визуализации. */
    onHide?: (path: string) => void;
    /** Копировать путь узла в буфер (vision §I.9). */
    onCopyPath?: (path: string) => void;
    /** Показывать ли пометки «кандидат на очистку» (причина/уверенность/объяснение).
     *  Включается ТОЛЬКО в режиме сканера мусора: в обычном Обзоре подсказки
     *  «этот файл — возможный мусор» сбивают с толку. */
    showCleanup?: boolean;
  }
  let {
    node,
    expanded,
    onReveal,
    onClose,
    onHide,
    onCopyPath,
    showCleanup = false,
  }: Props = $props();

  // Синтетический блок «Прочее»: не файл и не папка — объединённая мелочь.
  let isAgg = $derived(node.flags.includes("aggregated"));
  let aggColorHex = "#" + AGGREGATE_COLOR.toString(16).padStart(6, "0");
  let aggBg = (() => {
    const r = (AGGREGATE_COLOR >> 16) & 255;
    const g = (AGGREGATE_COLOR >> 8) & 255;
    const b = AGGREGATE_COLOR & 255;
    return (alpha: number) => `rgba(${r}, ${g}, ${b}, ${alpha})`;
  })();

  function getCategoryColor(cat: Category): string {
    const num = CATEGORY_COLOR[cat] ?? 0x8a8f98;
    return "#" + num.toString(16).padStart(6, "0");
  }
  function getCategoryBg(cat: Category, alpha = 0.15): string {
    const num = CATEGORY_COLOR[cat] ?? 0x8a8f98;
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
</script>

<div class="card-wrap">
  <div class="card" class:expanded role="dialog" aria-label="Карточка узла">
    <!-- Заголовок: иконка (папка/файл) + имя + кнопка закрытия (только в развёрнутом) -->
    <div class="header">
      <div class="title-group">
        {#if isAgg}
          <!-- Иконка-стопка: «много мелких файлов в одном блоке». -->
          <svg
            class="node-icon"
            style="color: {aggColorHex}"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
            <polyline points="2 17 12 22 22 17"></polyline>
            <polyline points="2 12 12 17 22 12"></polyline>
          </svg>
        {:else if node.isDir}
          <svg
            class="node-icon dir"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path
              d="M19.5 21a3 3 0 0 0 3-3v-4.5a3 3 0 0 0-3-3h-1.5V9a3 3 0 0 0-3-3H9.414l-1.707-1.707A1 1 0 0 0 7 4H4.5a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h15Z"
            />
          </svg>
        {:else}
          <svg
            class="node-icon file"
            style="color: {getCategoryColor(node.category)}"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path
              fill-rule="evenodd"
              d="M5.625 1.5H9a3.75 3.75 0 0 1 3.75 3.75v1.875c0 1.036.84 1.875 1.875 1.875H16.5a3.75 3.75 0 0 1 3.75 3.75v7.875c0 1.035-.84 1.875-1.875 1.875H5.625a1.875 1.875 0 0 1-1.875-1.875V3.375c0-1.036.84-1.875 1.875-1.875Zm10.125 0v3.75c0 .345.28.625.625.625h3.75a3.75 3.75 0 0 0-3.75-4.375Z"
              clip-rule="evenodd"
            />
          </svg>
        {/if}
        <span class="name" title={node.name}>{node.name}</span>
      </div>
      {#if expanded}
        <button class="close" onclick={onClose} aria-label="Закрыть">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      {/if}
    </div>

    <!-- Важное (всегда видно): размер крупно (dot-matrix KPI) + бэдж категории -->
    <div class="row info-row">
      <span class="size">{formatSize(node.size)}</span>
      {#if isAgg}
        <span
          class="cat-badge"
          style="background: {aggBg(
            0.12,
          )}; color: {aggColorHex}; border-color: {aggBg(0.3)}"
        >
          {node.childCount.toLocaleString("ru")} мелких файлов
        </span>
      {:else}
        <span
          class="cat-badge"
          style="background: {getCategoryBg(
            node.category,
            0.12,
          )}; color: {getCategoryColor(
            node.category,
          )}; border-color: {getCategoryBg(node.category, 0.3)}"
        >
          <!-- Dot-глиф категории (тикет 003) — избыточный к цвету канал. -->
          <CategoryGlyph category={node.category} size={12} />
          {CATEGORY_LABEL[node.category]}
        </span>
      {/if}
    </div>

    <!-- Причина кандидатуры на очистку — видна УЖЕ в компактном hover-виде
         (полное объяснение — в развёрнутой карточке ниже). Только в режиме
         сканера мусора (showCleanup): в Обзоре пометки сбивают с толку. -->
    {#if showCleanup && node.cleanup}
      <div class="row reason-row">
        <span
          class="conf-dot"
          style:background={CONFIDENCE_META[node.cleanup.confidence].cssVar}
          aria-hidden="true"
        ></span>
        <span class="reason-text">
          {REASON_META[node.cleanup.reason].label}
          · {CONFIDENCE_META[node.cleanup.confidence].label}
        </span>
      </div>
    {/if}

    <!-- Подробности (только в развёрнутом виде). `in:slide|global` — анимация
         РАЗВОРОТА проигрывается при монтировании окна (в т.ч. при выборе нового
         файла через {#key} в Scene). global — потому что блок истинен с создания
         родителя, а локальный transition в таком случае Svelte подавляет. Только
         on-enter: на закрытии/смене файла outro нет (иначе «схлопывание» старого
         окна на месте нового). -->
    {#if expanded}
      <div class="expand" in:slide|global={{ duration: 220 }}>
        <div class="divider"></div>

        <div class="details-section">
          <div class="detail-item">
            <svg
              class="detail-icon"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="10"></circle>
              <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
            <span class="detail-text"
              >Изменён: <span class="highlight">{formatDate(node.mtime)}</span
              ></span
            >
          </div>
          {#if node.isDir}
            <div class="detail-item">
              <svg
                class="detail-icon"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                <circle cx="9" cy="7" r="4"></circle>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
              </svg>
              <span class="detail-text"
                >Содержит: <span class="highlight"
                  >{node.childCount.toLocaleString("ru")} эл.</span
                ></span
              >
            </div>
          {/if}
        </div>

        {#if node.flags.includes("locked")}
          <div class="locked-warning">
            <svg
              class="warning-icon"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path
                fill-rule="evenodd"
                d="M12 1.5a5.25 5.25 0 0 0-5.25 5.25v3a3 3 0 0 0-3 3v6.75a3 3 0 0 0 3 3h10.5a3 3 0 0 0 3-3v-6.75a3 3 0 0 0-3-3v-3c0-2.9-2.35-5.25-5.25-5.25Zm-3.75 8.25v-3a3.75 3.75 0 1 1 7.5 0v3H8.25Z"
                clip-rule="evenodd"
              />
            </svg>
            <span>Системный файл — удаление заблокировано</span>
          </div>
        {/if}

        {#if showCleanup && node.cleanup && !node.flags.includes("locked")}
          <div class="cleanup-warning">
            <svg
              class="warning-icon"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path
                fill-rule="evenodd"
                d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003ZM12 8.25a.75.75 0 0 1 .75.75v3.75a.75.75 0 0 1-1.5 0V9a.75.75 0 0 1 .75-.75Zm0 8.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"
                clip-rule="evenodd"
              />
            </svg>
            <div class="cleanup-info">
              <span class="cleanup-title">
                {REASON_META[node.cleanup.reason].label}
                <span
                  class="cleanup-conf"
                  style:color={CONFIDENCE_META[node.cleanup.confidence].cssVar}
                  title={CONFIDENCE_META[node.cleanup.confidence].hint}
                >
                  · {CONFIDENCE_META[node.cleanup.confidence].label}
                </span>
              </span>
              <span class="cleanup-explain">
                {REASON_META[node.cleanup.reason].explain}
              </span>
            </div>
          </div>
        {/if}

        <div class="path-container" title={node.path}>
          <div class="path-head">
            <span class="path-label">Путь</span>
            {#if onCopyPath && !isAgg}
              <button
                class="copy-btn"
                onclick={() => onCopyPath(node.path)}
                title="Копировать путь"
                aria-label="Копировать путь"
              >
                <svg
                  class="btn-icon"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path
                    d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                  ></path>
                </svg>
                <span>Копировать</span>
              </button>
            {/if}
          </div>
          <div class="path-text">{node.path}</div>
        </div>

        <div class="actions">
          <button class="reveal-btn" onclick={() => onReveal(node.path)}>
            <svg
              class="btn-icon"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"
              ></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
            <span>Показать в проводнике</span>
          </button>
          {#if onHide}
            <button class="exclude-btn" onclick={() => onHide(node.path)}>
              <svg
                class="btn-icon"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path
                  d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
                ></path>
                <line x1="1" y1="1" x2="23" y2="23"></line>
              </svg>
              <span>Исключить</span>
            </button>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  <!-- Хвостик-указатель к зданию: тот же материал, что и корпус (цвет/прозрач-
       ность из --overlay + бордюр), остриё лишь чуть скруглено. Вынесён ИЗ
       .card — иначе вложенный backdrop-filter не размывает сцену и выглядит
       плоско-тёмным поверх яркого здания. -->
  <div class="arrow"></div>
</div>

<style>
  /* Обёртка: позиционный контекст для стрелки-сестры (вне .card, чтобы её
     backdrop-filter не был вложен в blur корпуса). Размер — по корпусу. */
  .card-wrap {
    position: relative;
    display: inline-block;
  }

  /* Матовая «премиум-пластик» карточка (Nothing), скруглённая, акцент — красный.
     pointer-events включаются только в развёрнутом виде: компактный hover-вид
     пассивен (не перехватывает курсор/клик по зданию под ним). */
  .card {
    pointer-events: none;
    position: relative;
    min-width: 15rem;
    max-width: 24rem;
    box-sizing: border-box;
    padding: 0.9rem 1.05rem;
    background: var(--overlay);
    backdrop-filter: blur(var(--blur));
    -webkit-backdrop-filter: blur(var(--blur));
    border: 1px solid var(--border);
    border-radius: var(--r-card);
    box-shadow: var(--elev-2);
    font-family: inherit;
    font-size: 0.85rem;
    line-height: 1.4;
    color: var(--text);
    transition:
      box-shadow var(--motion-base) var(--ease-out),
      border-color var(--motion-base) var(--ease-out);
  }
  .card.expanded {
    pointer-events: auto;
  }
  .card.expanded:hover {
    border-color: rgba(255, 255, 255, 0.2);
  }

  /* Хвостик-указатель к зданию: тот же материал, что корпус (--overlay + бордюр,
     та же прозрачность), повёрнутый квадрат — остриё лишь чуть скруглено. */
  .arrow {
    position: absolute;
    bottom: -6px;
    left: 50%;
    transform: translateX(-50%) rotate(45deg);
    width: 12px;
    height: 12px;
    background: var(--overlay);
    backdrop-filter: blur(var(--blur));
    -webkit-backdrop-filter: blur(var(--blur));
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    border-bottom-right-radius: 3px;
    z-index: -1;
    pointer-events: none;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1.25rem;
  }
  .title-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    flex: 1;
  }
  .node-icon {
    width: 1.1rem;
    height: 1.1rem;
    flex-shrink: 0;
  }
  .node-icon.dir {
    color: var(--text-2);
  }
  .name {
    font-weight: 600;
    font-size: 0.92rem;
    color: var(--text);
    overflow-wrap: break-word;
    word-break: break-word;
    min-width: 0;
  }

  .close {
    background: none;
    border: none;
    color: var(--text-muted);
    padding: 0.2rem;
    border-radius: var(--r-sm);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition:
      background var(--motion-micro) var(--ease-out),
      color var(--motion-micro) var(--ease-out),
      transform var(--motion-base) var(--ease-out);
  }
  .close svg {
    width: 1.1rem;
    height: 1.1rem;
  }
  .close:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--text);
    transform: rotate(90deg);
  }

  .divider {
    height: 1px;
    background: var(--hairline);
    margin: 0.6rem 0;
  }

  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }
  .info-row {
    margin-top: 0.55rem;
  }
  /* Размер — крупно, dot-matrix (фирменный KPI, виден и в компактном виде). */
  .size {
    font-family: var(--font-display);
    font-size: 1.5rem;
    letter-spacing: 0.02em;
    color: var(--text);
  }

  /* Бэдж категории — цвет канала категории (инлайн-стили). */
  .cat-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.15rem 0.45rem;
    border-radius: var(--r-sm);
    border: 1px solid;
    letter-spacing: 0.01em;
    white-space: nowrap;
  }

  /* Блок подробностей — появляется/скрывается slide-анимацией. */
  .expand {
    overflow: hidden;
  }

  .details-section {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 0.65rem;
  }
  .detail-item {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--text-muted);
    font-size: 0.76rem;
  }
  .detail-icon {
    width: 0.8rem;
    height: 0.8rem;
    flex-shrink: 0;
  }
  .detail-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .highlight {
    color: var(--text-2);
    font-weight: 500;
  }

  /* Заблокировано бэкендом (системные локи) — красный акцент. */
  .locked-warning {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    color: var(--accent);
    padding: 0.35rem 0.55rem;
    border-radius: var(--r-sm);
    font-size: 0.76rem;
    font-weight: 600;
    margin-bottom: 0.65rem;
  }

  /* Компактная строка причины (видна в hover-виде): глиф уверенности + подпись. */
  .reason-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.3rem;
    font-size: 0.72rem;
    color: var(--text-2);
  }
  .conf-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .reason-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Кандидат на очистку — семантический амбер (--stale), не акцент.
     v2: причина + уверенность + объяснение словами (план §2.3). */
  .cleanup-warning {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    background: rgba(224, 163, 62, 0.1);
    border: 1px solid rgba(224, 163, 62, 0.3);
    color: var(--stale);
    padding: 0.35rem 0.55rem;
    border-radius: var(--r-sm);
    font-size: 0.76rem;
    font-weight: 600;
    margin-bottom: 0.65rem;
  }
  .cleanup-info {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }
  .cleanup-title {
    font-weight: 600;
  }
  .cleanup-conf {
    font-weight: 500;
  }
  .cleanup-explain {
    color: var(--text-2);
    font-weight: 400;
    font-size: 0.72rem;
    line-height: 1.35;
  }
  .warning-icon {
    width: 0.85rem;
    height: 0.85rem;
    flex-shrink: 0;
  }

  .path-container {
    background: rgba(0, 0, 0, 0.22);
    border: 1px solid var(--hairline);
    border-radius: var(--r-sm);
    padding: 0.35rem 0.5rem;
    font-size: 0.72rem;
    font-family: var(--font-mono);
    color: var(--text-muted);
    margin-bottom: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    max-height: 4.2rem;
    overflow: hidden;
  }
  .path-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
  }
  .path-label {
    font-size: 0.62rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }
  .copy-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.15rem 0.4rem;
    border: 1px solid var(--hairline);
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text-2);
    font: inherit;
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: pointer;
  }
  .copy-btn:hover {
    border-color: var(--border);
    background: var(--accent-soft);
    color: var(--text);
  }
  .copy-btn .btn-icon {
    width: 0.8rem;
    height: 0.8rem;
  }
  .path-text {
    word-break: break-all;
    overflow-y: auto;
    line-height: 1.35;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.1) transparent;
  }
  .path-text::-webkit-scrollbar {
    width: 3px;
    height: 3px;
  }
  .path-text::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
  }

  /* Главное действие — красная заливка (CTA). */
  .actions {
    display: flex;
    width: 100%;
    gap: 0.5rem;
  }
  .reveal-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 0.5rem;
    font-family: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--accent-fg);
    background: var(--accent);
    border: none;
    border-radius: var(--r-md);
    cursor: pointer;
    transition:
      background var(--motion-micro) var(--ease-out),
      transform var(--motion-micro) var(--ease-out);
  }
  .reveal-btn:hover {
    background: var(--accent-hover);
  }
  .reveal-btn:active {
    background: var(--accent-press);
    transform: translateY(0.5px);
  }
  .exclude-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 0.5rem;
    font-family: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    cursor: pointer;
    transition:
      background var(--motion-micro) var(--ease-out),
      border-color var(--motion-micro) var(--ease-out),
      transform var(--motion-micro) var(--ease-out);
  }
  .exclude-btn:hover {
    background: #232327;
    border-color: rgba(255, 255, 255, 0.2);
  }
  .exclude-btn:active {
    transform: translateY(0.5px);
  }
  .btn-icon {
    width: 0.8rem;
    height: 0.8rem;
    flex-shrink: 0;
  }
</style>
