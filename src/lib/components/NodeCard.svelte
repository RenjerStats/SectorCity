<script lang="ts">
  /**
   * Карточка-окно над выбранным зданием (режим `selected`). Презентационный
   * компонент: КОНТЕНТ берёт реактивно из стора `selectedNode`, ПОЗИЦИЮ не знает
   * — её ставит владелец (Scene) императивно покадрово на обёртке (docs §4).
   * Действия проксирует наружу через колбэки-пропсы; своей логики IPC не имеет.
   *
   * Презентацию (вёрстка/CSS) можно дорабатывать отдельно (тикет Gemini): контракт
   * — пропсы `onReveal`/`onClose` и чтение `selectedNode`; не трогать позиционирование.
   */
  import { selectedNode } from "../store/mode";
  import { CATEGORY_LABEL, CATEGORY_COLOR } from "../three/palette";
  import { formatSize, formatDate } from "../format";
  import type { Category } from "../ipc/contract";

  interface Props {
    /** «Показать в проводнике» (безопасно). Владелец заворачивает IPC + ошибки. */
    onReveal: (path: string) => void;
    /** Закрыть карточку (снять выбор). */
    onClose: () => void;
  }
  let { onReveal, onClose }: Props = $props();

  let node = $derived($selectedNode);

  // Преобразование числового цвета категории в строку CSS hex
  function getCategoryColor(cat: Category): string {
    const num = CATEGORY_COLOR[cat] ?? 0x8a8f98;
    return "#" + num.toString(16).padStart(6, "0");
  }

  // Получение полупрозрачного RGBA для красивых бэджей/бордеров
  function getCategoryBg(cat: Category, alpha = 0.15): string {
    const num = CATEGORY_COLOR[cat] ?? 0x8a8f98;
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
</script>

{#if node}
  <div class="card" role="dialog" aria-label="Карточка узла">
    <!-- Стрелка-хвостик внизу по центру, указывающая на здание -->
    <div class="arrow"></div>

    <!-- Заголовок: иконка (папка/файл) + имя файла + кнопка закрытия -->
    <div class="header">
      <div class="title-group">
        {#if node.isDir}
          <!-- Иконка папки -->
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
          <!-- Иконка файла с цветом категории -->
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
    </div>

    <!-- Тонкий футуристичный разделитель -->
    <div class="divider"></div>

    <!-- Важные метаданные: размер и цветной бэдж категории -->
    <div class="row info-row">
      <span class="size">{formatSize(node.size)}</span>
      <span
        class="cat-badge"
        style="background: {getCategoryBg(
          node.category,
          0.12,
        )}; color: {getCategoryColor(
          node.category,
        )}; border-color: {getCategoryBg(node.category, 0.3)}"
      >
        {CATEGORY_LABEL[node.category]}
      </span>
    </div>

    <!-- Дополнительные параметры: дата изменения и число элементов (для папок) -->
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

    <!-- Предупреждение о необходимости очистки -->
    {#if node.flags.includes("cleanupCandidate")}
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
        <span>Кандидат на очистку</span>
      </div>
    {/if}

    <!-- Полный путь к файлу в специальном блоке с прокруткой -->
    <div class="path-container" title={node.path}>
      <span class="path-label">Путь</span>
      <div class="path-text">{node.path}</div>
    </div>

    <!-- Кнопки действий -->
    <div class="actions">
      <button class="reveal-btn" onclick={() => node && onReveal(node.path)}>
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
    </div>
  </div>
{/if}

<style>
  .card {
    /* pointer-events must be auto so interactive elements are clickable */
    pointer-events: auto;

    /* Sizing limits */
    min-width: 14rem;
    max-width: 24rem;
    width: max-content;
    box-sizing: border-box;
    padding: 0.9rem 1.05rem;

    /* Styling: Premium Dark Glassmorphism */
    background: rgba(20, 22, 27, 0.95);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    box-shadow:
      0 12px 32px rgba(0, 0, 0, 0.55),
      0 0 0 1px rgba(255, 255, 255, 0.05),
      0 0 24px rgba(79, 157, 255, 0.03);

    /* Typography & Hierarchy */
    font-family: inherit;
    font-size: 0.85rem;
    line-height: 1.4;
    color: var(--fg, #e6e6e6);

    /* Relative positioning to anchor close button and bottom arrow */
    position: relative;

    /* Smooth glow transition on hover */
    transition:
      box-shadow 0.25s cubic-bezier(0.4, 0, 0.2, 1),
      border-color 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .card:hover {
    border-color: rgba(79, 157, 255, 0.25);
    box-shadow:
      0 16px 40px rgba(0, 0, 0, 0.65),
      0 0 0 1px rgba(79, 157, 255, 0.15),
      0 0 28px rgba(79, 157, 255, 0.06);
  }

  /* Triangle tail at the bottom center of the card */
  .arrow {
    position: absolute;
    bottom: -6px;
    left: 50%;
    transform: translateX(-50%) rotate(45deg);
    width: 12px;
    height: 12px;
    background: rgba(20, 22, 27, 0.95);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-right: 1px solid rgba(255, 255, 255, 0.08);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    z-index: -1;
    pointer-events: none;
    transition: border-color 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .card:hover .arrow {
    border-color: rgba(79, 157, 255, 0.25);
  }

  /* Header elements */
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
    color: var(--accent, #4f9dff);
  }

  .name {
    font-weight: 600;
    font-size: 0.92rem;
    color: #ffffff;
    overflow-wrap: break-word;
    word-wrap: break-word;
    word-break: break-word;
    min-width: 0;
  }

  /* Close button */
  .close {
    background: none;
    border: none;
    color: var(--muted, #8b929c);
    padding: 0.2rem;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition:
      background-color 0.15s,
      color 0.15s,
      transform 0.15s;
  }

  .close svg {
    width: 1.1rem;
    height: 1.1rem;
  }

  .close:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #ffffff;
    transform: rotate(90deg);
  }

  .divider {
    height: 1px;
    background: rgba(255, 255, 255, 0.07);
    margin: 0.6rem 0;
  }

  /* Core layout row (size + category) */
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }

  .info-row {
    margin-bottom: 0.65rem;
  }

  .size {
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--fg, #e6e6e6);
    letter-spacing: -0.01em;
  }

  /* Category badge */
  .cat-badge {
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.15rem 0.45rem;
    border-radius: 4px;
    border: 1px solid;
    letter-spacing: 0.01em;
    white-space: nowrap;
  }

  /* Details list */
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
    color: var(--muted, #8b929c);
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
    color: rgba(255, 255, 255, 0.8);
    font-weight: 500;
  }

  /* Warn section (cleanupCandidate) */
  .cleanup-warning {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: rgba(242, 193, 78, 0.08);
    border: 1px solid rgba(242, 193, 78, 0.25);
    color: #f2c14e;
    padding: 0.35rem 0.55rem;
    border-radius: 5px;
    font-size: 0.76rem;
    font-weight: 600;
    margin-bottom: 0.65rem;
    box-shadow: 0 2px 8px rgba(242, 193, 78, 0.04);
  }

  .warning-icon {
    width: 0.85rem;
    height: 0.85rem;
    flex-shrink: 0;
  }

  /* File path box styling */
  .path-container {
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.03);
    border-radius: 5px;
    padding: 0.35rem 0.5rem;
    font-size: 0.72rem;
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    color: var(--muted, #8b929c);
    margin-bottom: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    max-height: 4.2rem;
    overflow: hidden;
  }

  .path-label {
    font-size: 0.62rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: rgba(255, 255, 255, 0.25);
  }

  .path-text {
    word-break: break-all;
    overflow-y: auto;
    line-height: 1.35;
    /* Custom scrollbar */
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

  /* Action button wrapper & primary button styling */
  .actions {
    display: flex;
    width: 100%;
  }

  .reveal-btn {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 0.45rem;
    font-family: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    color: #ffffff;
    background: linear-gradient(
      135deg,
      var(--accent, #4f9dff) 0%,
      rgba(79, 157, 255, 0.8) 100%
    );
    border: none;
    border-radius: 5px;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(79, 157, 255, 0.18);
    transition:
      transform 0.15s,
      box-shadow 0.15s,
      background-color 0.15s;
  }

  .reveal-btn:hover {
    transform: translateY(-1px);
    background: linear-gradient(135deg, #60a7ff 0%, #4f9dff 100%);
    box-shadow:
      0 4px 12px rgba(79, 157, 255, 0.3),
      0 0 12px rgba(79, 157, 255, 0.12);
  }

  .reveal-btn:active {
    transform: translateY(0);
    box-shadow: 0 2px 4px rgba(79, 157, 255, 0.18);
  }

  .btn-icon {
    width: 0.8rem;
    height: 0.8rem;
    flex-shrink: 0;
  }
</style>
