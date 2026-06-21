<script lang="ts">
  import { onMount } from "svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { createScene, type SceneHandle } from "../three/scene";
  import { createNavigator, type CityNavigator } from "../three/navigator";
  import Legend from "./Legend.svelte";
  import StatusOverlay from "./StatusOverlay.svelte";
  import NodeCard from "./NodeCard.svelte";
  import FilterPanel from "./FilterPanel.svelte";
  import SearchBox from "./SearchBox.svelte";
  import {
    setupInteraction,
    type InteractionController,
  } from "../three/interaction";
  import { CATEGORY_LABEL } from "../three/palette";
  import { formatSize, formatDate } from "../format";
  import {
    getLevel,
    startScan,
    cancelScan,
    currentRoot,
  } from "../ipc/commands";
  import { revealInExplorer } from "../ipc/actions";
  import {
    appMode,
    scanProgress,
    hoveredNode,
    selectedNode,
    breadcrumbs,
    candidateFilter,
    searchQuery,
    type CandidateFilter,
  } from "../store/mode";
  import type { ScanNode, ScanProgress } from "../ipc/contract";

  // Этот компонент — ЕДИНСТВЕННЫЙ владелец 3D-сцены. Он монтирует canvas,
  // держит жизненный цикл сцены и наполняет её данными из IPC. Связь с
  // остальным DOM — через стор; высокочастотную позицию тултипа пишем в DOM
  // императивно (в обход реактивности), контент тултипа — реактивно из стора.
  let canvas: HTMLCanvasElement;
  let handle: SceneHandle | undefined;
  let nav: CityNavigator | undefined;
  let interaction: InteractionController | undefined;
  let tooltipEl = $state<HTMLDivElement | undefined>(undefined);
  // Обёртка карточки выбранного узла: позицию ставим императивно покадрово
  // (как у тултипа), КОНТЕНТ карточки — реактивно из стора `selectedNode`.
  let cardEl = $state<HTMLDivElement | undefined>(undefined);

  // Состояние центрального оверлея (приветствие/пусто/ошибка/отмена). Низко-
  // частотное — обычный $state; "none" = город виден, оверлей не рисуется.
  type StatusKind = "welcome" | "empty" | "error" | "cancelled" | "none";
  let statusKind = $state<StatusKind>("none");
  let statusErrors = $state(0);

  /** Топ-N зданий на уровень; хвост бэк сворачивает в «Прочее». */
  const TOP_N = 50;
  /** Длительность зума камеры при drill (docs: ~500 мс). */
  const DRILL_MS = 500;

  /** Грубое форматирование байтов в ГБ для панели прогресса. */
  function formatGB(bytes: number): string {
    return `${(bytes / 1e9).toFixed(2)} ГБ`;
  }

  /** Предикат фильтра кандидатов; `null`, если критериев нет. Конъюнкция условий. */
  function filterPredicate(
    f: CandidateFilter,
  ): ((n: ScanNode) => boolean) | null {
    const on = f.onlyCandidates || f.minSize > 0 || f.olderThanDays > 0;
    if (!on) return null;
    const now = Date.now() / 1000;
    const olderThan = f.olderThanDays * 86400; // дни → секунды (0 = выкл)
    return (n) => {
      if (f.onlyCandidates && !n.flags.includes("cleanupCandidate"))
        return false;
      if (f.minSize > 0 && n.size < f.minSize) return false;
      if (olderThan > 0 && now - n.mtime < olderThan) return false;
      return true;
    };
  }

  /** Объединённая подсветка: фильтр кандидатов И поиск по имени (конъюнкция).
   * `null`, если ни фильтр, ни поиск не активны (подсветка снимается). */
  function buildHighlight(
    f: CandidateFilter,
    q: string,
  ): ((n: ScanNode) => boolean) | null {
    const fp = filterPredicate(f);
    const needle = q.trim().toLowerCase();
    const hasSearch = needle.length > 0;
    if (!fp && !hasSearch) return null;
    return (n) => {
      if (fp && !fp(n)) return false;
      if (hasSearch && !n.name.toLowerCase().includes(needle)) return false;
      return true;
    };
  }

  /** Пересчитать подсветку из текущих сторов и отдать навигатору (он переживает
   * навигацию). Зовётся при изменении фильтра ИЛИ поискового запроса. */
  function refreshHighlight() {
    nav?.applyHighlight(
      buildHighlight(candidateFilter.get(), searchQuery.get()),
    );
  }

  /** Имя уровня из пути для крошки (последний сегмент, или сам путь). */
  function crumbName(path: string): string {
    if (!path) return "Демо";
    const seg = path.split(/[/\\]/).filter(Boolean);
    return seg.length > 0 ? seg[seg.length - 1] : path;
  }

  /** Загрузить `path` как новый корень мира (старт/после скана/прыжок по крошке
   * дальше чем на уровень). Возвращает число узлов (0 → пусто, нечего показывать). */
  async function loadRoot(path: string): Promise<number> {
    // depth=2: каждый район несёт превью своих детей → вложенный treemap + LOD.
    const nodes = await getLevel(path, TOP_N, 2);
    nav?.reset(nodes, path);
    interaction?.clearHover();
    return nodes.length;
  }

  onMount(() => {
    handle = createScene(canvas);
    nav = createNavigator(handle);

    // Взаимодействие: наведение → стор (контент тултипа), клик по району → drill.
    interaction = setupInteraction(handle, {
      onHover: (node) => hoveredNode.set(node),
      onDrill: (node) => void drill(node),
      // Клик по файлу → карточка над зданием; клик мимо/по «Прочее» → null.
      // Режим (appMode) не трогаем: карточка живёт на отдельном атоме, как hover.
      onSelect: (node) => selectedNode.set(node),
    });

    // LOD активного уровня: покадрово по позиции камеры (дёшево, переключение
    // только на смене состояния). Навигатор знает, какой уровень активен.
    const offLod = handle.onFrame(() => {
      nav?.updateLOD();
    });

    // Позицию тултипа обновляем покадрово императивно (вне реконсиляции Svelte).
    const offFrame = handle.onFrame(() => {
      if (!tooltipEl || !handle || !interaction) return;
      const anchor = interaction.hoverAnchor();
      if (!anchor) return;
      const s = handle.worldToScreen(anchor);
      tooltipEl.style.transform = `translate(-50%, -100%) translate(${s.x}px, ${s.y}px)`;
      tooltipEl.style.opacity = s.visible ? "1" : "0";
    });

    // Позицию карточки выбранного узла — тоже покадрово императивно (docs §4).
    // Контент уже отрисован реактивно (selectedNode); здесь только проекция.
    const offCard = handle.onFrame(() => {
      if (!cardEl || !handle || !interaction) return;
      const anchor = interaction.selectionAnchor();
      if (!anchor) return;
      const s = handle.worldToScreen(anchor);
      cardEl.style.transform = `translate(-50%, -100%) translate(${s.x}px, ${s.y}px)`;
      cardEl.style.opacity = s.visible ? "1" : "0";
    });

    // ESC — снять выбор (закрыть карточку). Глобально, т.к. фокус на canvas.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") interaction?.clearSelection();
    };
    window.addEventListener("keydown", onKey);

    // Подсветка: фильтр кандидатов И поиск по имени → один предикат навигатору.
    // subscribe срабатывает сразу с текущим значением — nav уже создан выше.
    const offFilter = candidateFilter.subscribe(() => refreshHighlight());
    const offSearch = searchQuery.subscribe(() => refreshHighlight());

    // Стрим прогресса скана с бэка (троттлинг там же) → низкочастотный стор.
    let unlisten: UnlistenFn | undefined;
    listen<ScanProgress>("scan://progress", (e) => {
      scanProgress.set(e.payload);
      if (!e.payload.done) {
        appMode.set({ kind: "scanning", progress: 0 });
      }
    })
      .then((un) => (unlisten = un))
      .catch(() => {
        // Вне Tauri событий нет — ожидаемо в чистом vite.
      });

    // Старт: если есть снимок прошлого скана — поднимаем его без рескана,
    // иначе показываем мок верхнего уровня (корень "" → бэк отдаёт мок).
    appMode.set({ kind: "scanning", progress: 0 });
    currentRoot()
      .then(async (root) => {
        const target = root ?? "";
        await loadRoot(target);
        breadcrumbs.set([{ path: target, name: crumbName(target) }]);
        appMode.set({ kind: "idle", path: target });
        // Нет снимка прошлого скана → за демо-городом показываем приветствие
        // с приглашением выбрать реальную папку; после скана оно скрывается.
        statusKind = root === null ? "welcome" : "none";
      })
      .catch((err) => {
        console.warn("стартовый уровень недоступен:", err);
        appMode.set({ kind: "idle", path: "" });
        statusKind = "welcome";
      });

    return () => {
      offLod();
      offFrame();
      offCard();
      offFilter();
      offSearch();
      window.removeEventListener("keydown", onKey);
      unlisten?.();
      interaction?.dispose();
      nav?.dispose();
      handle?.dispose();
      handle = undefined;
    };
  });

  /** Выбрать папку → реальный скан со стримом прогресса → верхний уровень. */
  async function scanFolder() {
    const root = await open({ directory: true, multiple: false });
    if (typeof root !== "string") return; // отмена диалога

    statusKind = "none"; // прячем оверлей на время скана
    interaction?.clearSelection();
    appMode.set({ kind: "scanning", progress: 0 });
    scanProgress.set({
      entries: 0,
      bytes: 0,
      errors: 0,
      done: false,
      cancelled: false,
    });
    try {
      const completed = await startScan(root);
      if (completed) {
        const count = await loadRoot(root);
        breadcrumbs.set([{ path: root, name: crumbName(root) }]);
        appMode.set({ kind: "idle", path: root });
        // Пустой корень (нет файлов) → оверлей «папка пуста», иначе город виден.
        statusKind = count === 0 ? "empty" : "none";
      } else {
        appMode.set({ kind: "idle", path: "" }); // отменён — прежний город остаётся
        statusKind = "cancelled";
      }
    } catch (err) {
      console.error("скан не удался:", err);
      appMode.set({ kind: "idle", path: "" });
      statusErrors = $scanProgress?.errors ?? 0;
      statusKind = "error";
    } finally {
      scanProgress.set(null);
    }
  }

  /** Клик по району: бесшовный зум (промоут превью), затем крошка. Геометрию,
   * камеру и origin shift считает навигатор — здесь только данные + крошки. */
  async function drill(node: ScanNode) {
    if ($appMode.kind === "zooming" || !nav) return;
    const from = $appMode.kind === "idle" ? $appMode.path : "";
    appMode.set({ kind: "zooming", from, to: node.path });
    hoveredNode.set(null);

    // Дети района (превью +1) — это содержимое нового активного уровня.
    const childNodes = await getLevel(node.path, TOP_N, 2);
    await nav.drill(node, childNodes, DRILL_MS);
    interaction?.clearHover();

    breadcrumbs.set([
      ...$breadcrumbs,
      { path: node.path, name: node.name || crumbName(node.path) },
    ]);
    appMode.set({ kind: "idle", path: node.path });
  }

  /** Перейти к крошке по индексу. Подъём ровно на родителя — бесшовный (промоут
   * декора); прыжок дальше — обычная пересборка уровня (origin сбрасывается). */
  async function goToCrumb(index: number) {
    if ($appMode.kind === "zooming" || !nav) return;
    const crumb = $breadcrumbs[index];
    if (!crumb || index === $breadcrumbs.length - 1) return;
    appMode.set({ kind: "zooming", from: "", to: crumb.path });
    hoveredNode.set(null);
    interaction?.clearSelection(); // выбор уровня-источника больше не валиден

    if (index === $breadcrumbs.length - 2 && nav.canUp(crumb.path)) {
      await nav.up(DRILL_MS);
    } else {
      await loadRoot(crumb.path);
    }
    interaction?.clearHover();

    breadcrumbs.set($breadcrumbs.slice(0, index + 1));
    appMode.set({ kind: "idle", path: crumb.path });
  }

  function cancel() {
    void cancelScan();
  }
  function resetView() {
    handle?.resetView();
  }

  /** «Показать в проводнике» из карточки. Ошибку (нет пути/прав) глушим в лог. */
  async function revealNode(path: string) {
    try {
      await revealInExplorer(path);
    } catch (err) {
      console.warn("показать в проводнике не удалось:", err);
    }
  }
  /** Закрыть карточку (снять выбор) — через слой взаимодействия (он чистит Hit). */
  function closeCard() {
    interaction?.clearSelection();
  }

  let busy = $derived($appMode.kind === "scanning");
  let zooming = $derived($appMode.kind === "zooming");
  let progress = $derived($scanProgress);
  let hovered = $derived($hoveredNode);
  let selected = $derived($selectedNode);
  let crumbs = $derived($breadcrumbs);
</script>

<div class="scene">
  <canvas bind:this={canvas}></canvas>

  <div class="controls">
    {#if busy}
      <button onclick={cancel}>Отменить скан</button>
    {:else}
      <button onclick={scanFolder}>Сканировать папку</button>
    {/if}
    <button onclick={resetView}>Сбросить вид</button>
  </div>

  {#if crumbs.length > 0 && !busy}
    <nav class="crumbs" aria-label="Навигация по уровням">
      {#each crumbs as crumb, i (crumb.path)}
        {#if i > 0}<span class="sep">›</span>{/if}
        <button
          class="crumb"
          class:current={i === crumbs.length - 1}
          disabled={i === crumbs.length - 1 || zooming}
          onclick={() => goToCrumb(i)}
        >
          {crumb.name}
        </button>
      {/each}
    </nav>
  {/if}

  {#if busy && progress && !progress.done}
    <div class="progress">
      Сканирую: {progress.entries.toLocaleString("ru")} объектов · {formatGB(
        progress.bytes,
      )}
      {#if progress.errors > 0}· пропущено {progress.errors}{/if}
    </div>
  {/if}

  <!-- Легенда кодирования (высота=устаревание, цвет=категория). DOM-оверлей,
       читает только палитру; во время скана прячем, чтобы не мешать прогрессу. -->
  {#if !busy}
    <Legend />
    <!-- Фильтр-подсветка кандидатов (DoD): пишет в стор, рендер гасит остальное. -->
    <FilterPanel />
    <!-- Поиск-подсветка по имени: тот же механизм дима (конъюнкция с фильтром). -->
    <SearchBox />
  {/if}

  <!-- Центральный оверлей состояний (приветствие/пусто/ошибка/отмена). Сам
       рисует пустоту при "none"; кнопка запускает тот же scanFolder. -->
  <StatusOverlay kind={statusKind} errors={statusErrors} onScan={scanFolder} />

  {#if hovered}
    <div class="tooltip" bind:this={tooltipEl}>
      <strong class="name">{hovered.name}</strong>
      <div class="row">
        <span class="size">{formatSize(hovered.size)}</span>
        <span class="cat">{CATEGORY_LABEL[hovered.category]}</span>
      </div>
      <div class="muted">изменён {formatDate(hovered.mtime)}</div>
      {#if hovered.isDir}
        <div class="muted">
          {hovered.childCount.toLocaleString("ru")} элементов
        </div>
      {/if}
      {#if hovered.flags.includes("cleanupCandidate")}
        <div class="cleanup">⚑ кандидат на очистку</div>
      {/if}
      <div class="path">{hovered.path}</div>
    </div>
  {/if}

  <!-- Карточка выбранного узла (режим SELECT). Обёртку позиционируем
       императивно покадрово (см. onFrame выше); контент — реактивно из стора. -->
  {#if selected}
    <div class="card-anchor" bind:this={cardEl}>
      <NodeCard onReveal={revealNode} onClose={closeCard} />
    </div>
  {/if}
</div>

<style>
  .scene {
    position: absolute;
    inset: 0;
    z-index: 0;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  .controls {
    position: absolute;
    top: 1rem;
    right: 1rem;
    display: flex;
    gap: 0.5rem;
  }
  .controls button {
    padding: 0.4rem 0.8rem;
    font: inherit;
    color: var(--fg, #e6e6e6);
    background: rgba(30, 32, 38, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 0.4rem;
    cursor: pointer;
  }
  .controls button:hover:not(:disabled) {
    background: rgba(45, 48, 56, 0.95);
  }
  .controls button:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .crumbs {
    position: absolute;
    top: 1rem;
    left: 1rem;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    max-width: 70vw;
    flex-wrap: wrap;
    padding: 0.35rem 0.6rem;
    background: rgba(30, 32, 38, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 0.4rem;
  }
  .crumb {
    font: inherit;
    font-size: 0.85rem;
    color: var(--accent, #4f9dff);
    background: none;
    border: none;
    padding: 0.1rem 0.2rem;
    cursor: pointer;
  }
  .crumb.current {
    color: var(--fg, #e6e6e6);
    cursor: default;
  }
  .crumb:disabled {
    cursor: default;
  }
  .crumb:not(:disabled):hover {
    text-decoration: underline;
  }
  .sep {
    color: var(--muted, #8b929c);
    font-size: 0.85rem;
  }

  .progress {
    position: absolute;
    left: 50%;
    bottom: 1.5rem;
    transform: translateX(-50%);
    padding: 0.5rem 1rem;
    font-size: 0.9rem;
    color: var(--fg, #e6e6e6);
    background: rgba(30, 32, 38, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 0.4rem;
    white-space: nowrap;
  }

  .card-anchor {
    position: absolute;
    top: 0;
    left: 0;
    /* Позиция/видимость — императивно покадрово (см. onFrame); до первого кадра
       прячем. pointer-events на самой карточке (она внутри) включены. */
    opacity: 0;
    pointer-events: none;
    z-index: 2;
  }

  .tooltip {
    position: absolute;
    top: 0;
    left: 0;
    /* Позиция и видимость ставятся императивно (см. onFrame); до первого
       кадра прячем, чтобы не мигнуть в углу. */
    opacity: 0;
    pointer-events: none;
    min-width: 12rem;
    max-width: 22rem;
    padding: 0.5rem 0.7rem;
    background: rgba(20, 22, 27, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 0.4rem;
    font-size: 0.85rem;
    line-height: 1.35;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
    transition: opacity 0.1s;
  }
  .tooltip .name {
    display: block;
    word-break: break-all;
  }
  .tooltip .row {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    margin-top: 0.15rem;
  }
  .tooltip .cat {
    color: var(--muted, #8b929c);
  }
  .tooltip .cleanup {
    margin-top: 0.15rem;
    color: #f2c14e;
    font-size: 0.8rem;
  }
  .tooltip .muted {
    color: var(--muted, #8b929c);
  }
  .tooltip .path {
    margin-top: 0.25rem;
    color: var(--muted, #8b929c);
    font-size: 0.75rem;
    word-break: break-all;
  }
</style>
