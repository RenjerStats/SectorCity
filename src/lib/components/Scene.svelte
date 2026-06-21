<script lang="ts">
  import { onMount } from "svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { createScene, type SceneHandle } from "../three/scene";
  import { createNavigator, type CityNavigator } from "../three/navigator";
  import StatusOverlay from "./StatusOverlay.svelte";
  import NodeCard from "./NodeCard.svelte";
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
  import { uiCommand, levelSummary } from "../store/ui";
  import type { Category, ScanNode, ScanProgress } from "../ipc/contract";

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

  /** Сводка уровня для footer (полоса заполнения по категориям): композиция
   * прямых детей. Низкочастотно — пишем в стор на каждой смене уровня. */
  function setSummary(nodes: ScanNode[], path: string) {
    let totalBytes = 0;
    let fileCount = 0;
    const byCategory: Partial<Record<Category, number>> = {};
    for (const n of nodes) {
      totalBytes += n.size;
      if (!n.isDir) fileCount += 1;
      byCategory[n.category] = (byCategory[n.category] ?? 0) + n.size;
    }
    levelSummary.set({ path, totalBytes, fileCount, byCategory });
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
    setSummary(nodes, path);
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

    // Команды из header (Scan/Cancel/Reset) — единственный канал «шапка → сцена»
    // (docs §1: миры общаются только через стор). Снимаем команду ДО исполнения,
    // чтобы вложенный subscribe(null) был холостым (гард на `!c`).
    const offCmd = uiCommand.subscribe((c) => {
      if (!c) return;
      uiCommand.set(null);
      switch (c.kind) {
        case "scan":
          void scanFolder();
          break;
        case "cancel":
          cancel();
          break;
        case "reset":
          resetView();
          break;
        case "goToCrumb":
          void goToCrumb(c.index);
          break;
      }
    });

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
      offCmd();
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
    setSummary(childNodes, node.path);

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

  let hovered = $derived($hoveredNode);
  let selected = $derived($selectedNode);
</script>

<div class="scene">
  <canvas bind:this={canvas}></canvas>

  <!-- Крошки переехали в sub-header (Breadcrumbs), легенда/фильтр/поиск — в
       header/footer (docs Приложение B). В сцене остаются только заякоренные к
       3D оверлеи: статус, тултип, карточка. -->

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
    background: var(--overlay);
    backdrop-filter: blur(var(--blur));
    -webkit-backdrop-filter: blur(var(--blur));
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    font-size: 0.85rem;
    line-height: 1.35;
    color: var(--text);
    box-shadow: var(--elev-2);
    transition: opacity var(--motion-micro) var(--ease-out);
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
    color: var(--text-muted);
  }
  .tooltip .cleanup {
    margin-top: 0.15rem;
    color: var(--stale);
    font-size: 0.8rem;
  }
  .tooltip .muted {
    color: var(--text-muted);
  }
  .tooltip .path {
    margin-top: 0.25rem;
    color: var(--text-muted);
    font-size: 0.75rem;
    font-family: var(--font-mono);
    word-break: break-all;
  }
</style>
