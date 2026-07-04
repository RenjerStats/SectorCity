<script lang="ts">
  import { onMount } from "svelte";
  import type { Vector3 } from "three";
  import { open } from "@tauri-apps/plugin-dialog";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { createScene, type SceneHandle } from "../three/scene";
  import { createSceneWebGPU } from "../three/scene.webgpu";
  import { QUALITY, type GraphicsLevel } from "../three/quality";
  import { createNavigator, type CityNavigator } from "../three/navigator";
  import StatusOverlay from "./StatusOverlay.svelte";
  import StarGlyph from "./StarGlyph.svelte";
  import CategoryEmpty from "./CategoryEmpty.svelte";
  import NodeCard from "./NodeCard.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import {
    setupInteraction,
    type InteractionController,
  } from "../three/interaction";
  import {
    getLevel,
    startScan,
    cancelScan,
    currentRoot,
    search,
    listCleanup,
  } from "../ipc/commands";
  import { revealInExplorer, copyPath } from "../ipc/actions";
  import { baseName } from "../format";
  import {
    appMode,
    scanProgress,
    hoveredNode,
    selectedNode,
    breadcrumbs,
    candidateFilter,
    searchQuery,
    searchResults,
    searchPending,
    SEARCH_MIN_CHARS,
    aggSettings,
    markedForCleanup,
    toggleMark,
    clearMarks,
    cleanupCandidatesHere,
    cleanupGroups,
    categoryFilter,
    categoryFilterActive,
    categoryFilterEmpty,
    categoryMaskOf,
    showAggregate,
    hiddenPaths,
    hideNode,
    clearHidden,
    type CandidateFilter,
  } from "../store/mode";
  import {
    uiCommand,
    levelSummary,
    setCleanupConfirm,
    setContextMenuOpen,
    hiddenOpen,
    toggleHidden,
    showToast,
    type NodeAction,
  } from "../store/ui";
  import {
    restoreLastScan,
    graphicsLevel,
    setGraphicsLevel,
  } from "../store/settings";
  import type {
    AggSpec,
    Category,
    ScanNode,
    ScanProgress,
  } from "../ipc/contract";

  /** Дебаунс глобального поиска (мс): не дёргаем бэк на каждый символ. */
  const SEARCH_DEBOUNCE_MS = 200;

  // Этот компонент — ЕДИНСТВЕННЫЙ владелец 3D-сцены. Он монтирует canvas,
  // держит жизненный цикл сцены и наполняет её данными из IPC. Связь с
  // остальным DOM — через стор; высокочастотную позицию окна над зданием пишем
  // в DOM императивно (в обход реактивности), контент окна — реактивно из стора.
  let canvas: HTMLCanvasElement;
  let handle: SceneHandle | undefined;
  let nav: CityNavigator | undefined;
  let interaction: InteractionController | undefined;
  // Два независимых оверлея-окна одного стиля: cardEl — полное на ВЫБРАННОМ
  // (с разворотом), hoverEl — мини на НАВЕДЁННОМ (компактное, без анимации).
  // Позицию ставим императивно покадрово; контент — реактивно из сторов.
  let cardEl = $state<HTMLDivElement | undefined>(undefined);
  let hoverEl = $state<HTMLDivElement | undefined>(undefined);
  // Компас-«полярная звезда» (план §6): вращающаяся часть. Угол пишется
  // ИМПЕРАТИВНО покадрово (высокочастотное из камеры — в обход стора, docs §1).
  let compassRotEl = $state<HTMLSpanElement | undefined>(undefined);
  // Контекстное меню ПКМ (vision §I.10): узел под курсором + позиция, либо null.
  // Низкочастотно (по клику) — обычный $state, как selectedNode; рендерится в DOM.
  let contextMenu = $state<{
    node: ScanNode;
    drillTarget: ScanNode;
    x: number;
    y: number;
  } | null>(null);

  /** Задать/снять контекстное меню и зеркалить его открытость в стор (для Esc-стека
   *  центрального обработчика хоткеев, см. ui.ts `contextMenuOpen`). */
  function setMenu(m: typeof contextMenu): void {
    contextMenu = m;
    setContextMenuOpen(m !== null);
  }

  // Состояние центрального оверлея (приветствие/пусто/ошибка/отмена). Низко-
  // частотное — обычный $state; "none" = город виден, оверлей не рисуется.
  type StatusKind =
    | "loading"
    | "welcome"
    | "empty"
    | "error"
    | "cancelled"
    | "none";
  let statusKind = $state<StatusKind>("none");
  let statusErrors = $state(0);
  let currentUnfilteredNodes = $state<ScanNode[]>([]);

  /** Потолок числа зданий-файлов на уровень (страховка перфо). Основной контрол
   *  агрегации — порог в `aggSettings`; этот лишь не даёт уровню распухнуть. */
  const TOP_N_CAP = 150;
  /** Длительность зума камеры при drill (docs: ~500 мс). */
  const DRILL_MS = 500;
  /** Дебаунс пересборки города при движении ползунка порога (≈ось «на лету»). */
  const AGG_DEBOUNCE_MS = 150;
  /** Глубина превью с бэка: реальная застройка до +2, заглушки-«теплицы» — на +3
   *  (см. `PREVIEW_MAX_DEPTH` в city.ts). */
  const PREVIEW_DEPTH = 3;

  /** Текущие параметры агрегации из стора → контракт `AggSpec` для `getLevel`.
   *  Относительный режим — прямая доля объёма папки (детерминированно, без зависимости
   *  от ракурса камеры): бэк сворачивает узлы мельче `fraction`·суммы уровня. */
  function aggSpec(): AggSpec {
    const a = aggSettings.get();
    return {
      fraction: a.fraction,
      topNCap: TOP_N_CAP,
    };
  }

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
    // Кандидаты на очистку этого уровня — для панели сканера (счётчик/сумма/«всё»).
    cleanupCandidatesHere.set(
      nodes.filter((n) => n.flags.includes("cleanupCandidate")),
    );
  }

  /**
   * Структурный фильтр (vision §I.4а / тикет 009): из РАСКЛАДКИ убираются узлы
   * невыбранных категорий и (если выключено «Показывать мелочь») блоки «Мелочь»;
   * площадь перетекает к оставшимся.
   *
   * - файл — по собственной категории;
   * - папка и блок «Мелочь» — по `categoryMask` (объединение категорий ФАЙЛОВ во
   *   всём поддереве, считает бэк): прячем тот район, ВНУТРИ которого нет ни одной
   *   выбранной категории, — чтобы не водить пользователя по заведомо пустым папкам.
   *
   * Фильтруем РЕКУРСИВНО, включая вложенное превью района: тогда LOD-превью (когда
   * камера подходит к папке и та раскрывается во вложенные здания) показывает ровно
   * то же, что и заход внутрь, — без «лишних» зданий вне фильтра. Footprint папки
   * при этом честно реагирует на фильтр (площадь = сумма видимого содержимого).
   * Когда ни фильтр категорий, ни скрытие мелочи не активны — не режем НИЧЕГО
   * (канонический детерминированный город).
   */
  function getFilteredNodes(nodes: ScanNode[]): ScanNode[] {
    const catActive = categoryFilterActive.get();
    const hideAgg = !showAggregate.get();
    const hidden = hiddenPaths.get();
    const hiddenSet = hidden.length > 0 ? new Set(hidden) : null;
    if (!catActive && !hideAgg && !hiddenSet) return nodes;
    const mask = catActive ? categoryMaskOf(categoryFilter.get()) : null;
    return filterNodesRec(nodes, mask, hideAgg, hiddenSet);
  }

  /** Рекурсивно отфильтровать узлы уровня и их превью. `mask = null` — фильтр
   *  категорий выключен (режем только мелочь по `hideAgg`); `hiddenSet = null` —
   *  скрытых узлов нет. Скрытие по `path` — структурная операция (узел убран из
   *  раскладки, соседи перетекают), действует рекурсивно, включая превью. */
  function filterNodesRec(
    nodes: ScanNode[],
    mask: number | null,
    hideAgg: boolean,
    hiddenSet: Set<string> | null,
  ): ScanNode[] {
    const out: ScanNode[] = [];
    for (const n of nodes) {
      if (hiddenSet && hiddenSet.has(n.path)) continue;
      if (hideAgg && n.flags.includes("aggregated")) continue;
      // Маска: у файла = бит категории, у папки/«Мелочи» = объединение поддерева,
      // поэтому единый предикат «есть пересечение с выбранными» покрывает всё.
      if (mask !== null && (n.categoryMask & mask) === 0) continue;
      const hasKids = n.children && n.children.length > 0;
      if (hasKids && (n.isDir || n.flags.includes("aggregated"))) {
        out.push({
          ...n,
          children: filterNodesRec(n.children!, mask, hideAgg, hiddenSet),
        });
      } else {
        out.push(n);
      }
    }
    return out;
  }

  /**
   * Признак пустоты для плашки `CategoryEmpty`: показываем её ТОЛЬКО когда после
   * фильтра на уровне не осталось НИ ОДНОГО дома (ни папок, ни «Мелочи», ни файлов
   * выбранных категорий). Если на месте остался хотя бы квартал «Мелочь» или
   * папка — пустоты нет, плашку не рисуем. Пустой уровень без фильтра — забота
   * StatusOverlay, не наша.
   */
  function updateFilterEmpty(unfilteredNodes: ScanNode[]) {
    if (!categoryFilterActive.get() || unfilteredNodes.length === 0) {
      categoryFilterEmpty.set(false);
      return;
    }
    categoryFilterEmpty.set(getFilteredNodes(unfilteredNodes).length === 0);
  }

  /** Предикат «помечен на снос» для облика сцены (читает актуальную карту). */
  const isMarkedFn = (n: ScanNode) => markedForCleanup.get().has(n.path);

  /** Предикат «кандидат на очистку» с учётом выбранных фильтров размера и возраста. */
  const isCandidateFn = (n: ScanNode) => {
    if (!n.flags.includes("cleanupCandidate")) return false;
    const f = candidateFilter.get();
    if (f.minSize > 0 && n.size < f.minSize) return false;
    if (f.olderThanDays > 0) {
      const olderThan = f.olderThanDays * 86400; // дни -> секунды
      if (Date.now() / 1000 - n.mtime < olderThan) return false;
    }
    return true;
  };

  /** Обновить группы причин очистки по поддереву уровня `path` (панель v2).
   *  Гонку навигаций гасим сверкой актуальности пути на приходе ответа. */
  async function refreshCleanupGroups(path: string) {
    try {
      const groups = await listCleanup(path);
      const m = appMode.get();
      if (m.kind === "cleanup" && m.path === path) cleanupGroups.set(groups);
    } catch (err) {
      console.warn("list_cleanup не удался:", err);
    }
  }

  /** Войти в режим сканера мусора: переключить семантику клика и облик сцены. */
  function enterCleanup() {
    const crumbs = $breadcrumbs;
    const path = crumbs.length > 0 ? crumbs[crumbs.length - 1].path : "";
    interaction?.clearSelection();
    hoveredNode.set(null);
    appMode.set({ kind: "cleanup", path });
    nav?.setCleanup({ isMarked: isMarkedFn, isCandidate: isCandidateFn });
    // Группы причин подтянет подписчик appMode (см. offCleanupGroups в onMount).
  }

  /** Выйти из режима: снять облик/пометки и вернуться в обычный Обзор. */
  function exitCleanup() {
    const path = $appMode.kind === "cleanup" ? $appMode.path : "";
    nav?.setCleanup(null);
    cleanupGroups.set([]);
    clearMarks();
    // Сбросить фильтры кандидатов при выходе из режима очистки
    candidateFilter.set({
      onlyCandidates: false,
      minSize: 0,
      olderThanDays: 0,
    });
    setCleanupConfirm(false);
    appMode.set({ kind: "idle", path });
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

  /** Дебаунс-таймер пересборки города при смене порога агрегатора. */
  let aggTimer: ReturnType<typeof setTimeout> | undefined;

  /** Перезапросить текущий уровень с новым порогом и пересобрать город НА МЕСТЕ
   *  (камера не дёргается). Структурная операция: меняется, что свёрнуто в «Прочее».
   *  Гард: не лезем во время зума/скана; путь берём из последней крошки. */
  async function reaggregate() {
    if (!nav) return;
    const mode = appMode.get();
    if (mode.kind === "zooming" || mode.kind === "scanning") return;
    const crumbs = breadcrumbs.get();
    if (crumbs.length === 0) return;
    const path = crumbs[crumbs.length - 1].path;
    const nodes = await getLevel(path, aggSpec(), PREVIEW_DEPTH);
    currentUnfilteredNodes = nodes;
    const filtered = getFilteredNodes(nodes);
    nav.rebuildActive(filtered);
    interaction?.clearHover();
    setSummary(nodes, path);
    updateFilterEmpty(nodes);
    // После сноса/пересборки в режиме очистки панель причин должна отражать
    // новое дерево (удалённые кандидаты исчезают из групп).
    if (appMode.get().kind === "cleanup") void refreshCleanupGroups(path);
  }

  /** Запланировать пересборку с дебаунсом — «на лету», но без холостых пересчётов
   *  на каждом пикселе ползунка. */
  function scheduleReaggregate() {
    if (aggTimer) clearTimeout(aggTimer);
    aggTimer = setTimeout(() => void reaggregate(), AGG_DEBOUNCE_MS);
  }

  /** Пересобрать активный уровень из текущих структурных фильтров (категории /
   *  скрытие мелочи) БЕЗ перезапроса бэка — данные уровня уже в
   *  `currentUnfilteredNodes`. Зовётся при изменении любого структурного фильтра. */
  function rebuildFromFilters() {
    if (!nav) return;
    nav.rebuildActive(getFilteredNodes(currentUnfilteredNodes));
    updateFilterEmpty(currentUnfilteredNodes);
    interaction?.clearHover();
  }

  /** Имя уровня из пути для крошки (последний сегмент, или сам путь). */
  function crumbName(path: string): string {
    return path ? baseName(path) : "Демо";
  }

  /** Загрузить `path` как новый корень мира (старт/после скана/прыжок по крошке
   * дальше чем на уровень). Возвращает число узлов (0 → пусто, нечего показывать). */
  async function loadRoot(path: string): Promise<number> {
    // depth=2: каждый район несёт превью своих детей → вложенный treemap + LOD.
    const nodes = await getLevel(path, aggSpec(), PREVIEW_DEPTH);
    currentUnfilteredNodes = nodes;
    const filtered = getFilteredNodes(nodes);
    nav?.reset(filtered, path);
    interaction?.clearHover();
    setSummary(nodes, path);
    updateFilterEmpty(nodes);
    return nodes.length;
  }

  onMount(() => {
    // Бэкенд текущего стека и отписки его покадровых оверлеев. Смена уровня графики
    // ЧЕРЕЗ границу WebGL↔WebGPU пересоздаёт весь стек (бэкенд нельзя переключить на
    // живом canvas), поэтому держим их отдельно и умеем срывать/поднимать заново.
    let currentBackend: "webgl" | "webgpu" = "webgl";
    let frameOffs: (() => void)[] = [];
    let remounting = false;
    let disposed = false;
    let snapUnlisten: UnlistenFn | undefined;

    // Один <canvas> НАВСЕГДА привязан к первому полученному типу контекста: после
    // WebGPU на нём нельзя создать WebGL-контекст (и наоборот) — иначе
    // «Canvas has an existing context of a different type». Поэтому перед КАЖДЫМ
    // повторным подъёмом стека (в т.ч. в fallback-ветке, где WebGPU уже мог
    // занять контекст) подменяем DOM-элемент на свежий. `className` копируем —
    // scoped-CSS Svelte селектит `canvas` по классу с хэшем, без него холст
    // потеряет `width/height: 100%`.
    let canvasClaimed = false;
    function swapCanvas() {
      const fresh = document.createElement("canvas");
      fresh.className = canvas.className;
      canvas.replaceWith(fresh);
      canvas = fresh;
      canvas.style.cursor = graphicsLevel.get() === "experimental" ? "none" : "";
    }

    /** Зарегистрировать покадровые оверлеи (LOD, окна над зданием, компас) на
     *  ТЕКУЩЕМ handle; отписки складываем в `frameOffs` (снимаются при ремоунте). */
    function wireOverlays() {
      if (!handle) return;
      // LOD активного уровня: покадрово по позиции камеры (дёшево).
      let lastFrameT = performance.now();
      const offLod = handle.onFrame(() => {
        const now = performance.now();
        const dt = now - lastFrameT;
        lastFrameT = now;
        nav?.updateLOD();
        nav?.updateFade(dt); // кросс-фейд градиента затемнения декора (план §7.1)
      });
      // Позицию окон над зданием ставим покадрово императивно (вне реконсиляции
      // Svelte, docs §4): полное — по якорю выбранного, мини — по наведённому.
      const place = (
        el: HTMLDivElement | undefined,
        anchor: Vector3 | null,
      ) => {
        if (!el || !handle) return;
        if (!anchor) {
          el.style.opacity = "0";
          return;
        }
        const s = handle.worldToScreen(anchor);
        el.style.transform = `translate(-50%, -100%) translate(${s.x}px, ${s.y}px)`;
        el.style.opacity = s.visible ? "1" : "0";
      };
      const offCard = handle.onFrame(() => {
        if (!interaction) return;
        place(cardEl, interaction.selectionAnchor());
        place(hoverEl, interaction.hoverAnchor());
      });
      // Компас: угол = азимут камеры вокруг цели (0 — взгляд на север, −Z).
      const offCompass = handle.onFrame(() => {
        if (!compassRotEl || !handle) return;
        const t = handle.cameraTarget();
        const dx = handle.camera.position.x - t.x;
        const dz = handle.camera.position.z - t.z;
        const deg = (Math.atan2(dx, dz) * 180) / Math.PI;
        compassRotEl.style.transform = `rotate(${deg}deg)`;
      });
      frameOffs.push(offLod, offCard, offCompass);
    }

    /** Поднять рендер-стек под уровень `level`: рендерер по бэкенду (WebGPU —
     *  асинхронно), навигатор, взаимодействие, оверлеи. Бросает при провале WebGPU. */
    async function buildStack(level: GraphicsLevel) {
      // Свежий холст, если прежний уже получал контекст (смена бэкенда/повторный
      // подъём). Первый подъём берёт готовый <canvas> из разметки как есть.
      if (canvasClaimed) swapCanvas();
      canvasClaimed = true;
      canvas.style.cursor = level === "experimental" ? "none" : "";
      handle =
        QUALITY[level].backend === "webgpu"
          ? await createSceneWebGPU(canvas)
          : createScene(canvas);
      currentBackend = QUALITY[level].backend;
      nav = createNavigator(handle);
      // Взаимодействие: наведение → стор, клик → drill, ПКМ → меню, Ctrl+ЛКМ → снос.
      interaction = setupInteraction(handle, {
        onHover: (node) => hoveredNode.set(node),
        onDrill: (node) => void drill(node),
        onSelect: (node) => selectedNode.set(node),
        // Системные (locked) и синтетическую «Мелочь» (aggregated) не помечаем.
        isCleanup: () => appMode.get().kind === "cleanup",
        onMark: (node) => {
          if (
            node.flags.includes("locked") ||
            node.flags.includes("aggregated")
          )
            return;
          toggleMark(node.path, node.size);
        },
        onContext: (info, x, y) => {
          setMenu(
            info
              ? { node: info.node, drillTarget: info.drillTarget, x, y }
              : null,
          );
        },
      });
      wireOverlays();
    }

    /** Сорвать текущий стек: снять оверлеи, освободить взаимодействие/навигатор/сцену. */
    function teardownStack() {
      for (const off of frameOffs) off();
      frameOffs = [];
      interaction?.dispose();
      interaction = undefined;
      nav?.dispose();
      nav = undefined;
      handle?.dispose();
      handle = undefined;
    }

    /** Пересоздать стек под новый бэкенд (WebGL↔WebGPU) и перестроить текущий
     *  уровень. При провале WebGPU — откат на «Максимальный» (WebGL). */
    async function remount(level: GraphicsLevel) {
      remounting = true;
      const crumbs = breadcrumbs.get();
      const path = crumbs.length ? crumbs[crumbs.length - 1].path : "";
      statusKind = "loading";
      teardownStack();
      try {
        await buildStack(level);
      } catch (err) {
        console.warn(
          "WebGPU-сцена не поднялась — откат на «Максимальный»:",
          err,
        );
        showToast("WebGPU недоступен — откат на «Максимальный»");
        setGraphicsLevel("maximal"); // подписчик проигнорит (remounting=true)
        try {
          await buildStack("maximal");
        } catch (err2) {
          console.error("не удалось поднять WebGL-сцену:", err2);
          remounting = false;
          return;
        }
      }
      try {
        await loadRoot(path); // перестроить уровень в свежем nav
        await handle?.compile();
      } catch (err) {
        console.warn("пересборка уровня после ремоунта не удалась:", err);
      }
      statusKind = "none";
      remounting = false;
    }

    // Первичный подъём стека (для WebGPU — асинхронный), затем стартовый поток.
    void (async () => {
      try {
        await buildStack(graphicsLevel.get());
      } catch (err) {
        console.warn(
          "стартовая WebGPU-сцена не поднялась — откат на WebGL:",
          err,
        );
        showToast("WebGPU недоступен — откат на «Максимальный»");
        setGraphicsLevel("maximal");
        await buildStack("maximal");
      }
      if (disposed) {
        teardownStack();
        return;
      }
      await runStartFlow();
    })();

    // Клавиатура (Esc-стек, drill/свойства, действия над узлом) централизована в
    // hotkeys.ts (единственный владелец keydown). Сцена лишь исполняет команды
    // `uiCommand` (см. offCmd ниже) — прямого слушателя клавиш здесь больше нет.

    // Подсветка: фильтр кандидатов И поиск по имени → один предикат навигатору.
    // subscribe срабатывает сразу с текущим значением — nav уже создан выше.
    const offFilter = candidateFilter.subscribe(() => {
      refreshHighlight();
      if (appMode.get().kind === "cleanup") {
        nav?.setCleanup({ isMarked: isMarkedFn, isCandidate: isCandidateFn });
      }
    });
    const offSearch = searchQuery.subscribe(() => refreshHighlight());

    // Глобальный поиск (vision §I.3): дебаунс-запрос к снимку → список в footer.
    // Отдельно от подсветки `refreshHighlight` (та гасит несовпадения на активном
    // уровне; это — выдача по ВСЕМУ дереву). Гонку гасим сверкой актуальности needle.
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    const offSearchIpc = searchQuery.subscribe((q) => {
      const needle = q.trim();
      if (searchTimer) clearTimeout(searchTimer);
      if (needle.length < SEARCH_MIN_CHARS) {
        searchResults.set([]);
        searchPending.set(false);
        return;
      }
      searchPending.set(true);
      searchTimer = setTimeout(() => {
        void search(needle)
          .then((res) => {
            if (searchQuery.get().trim() === needle) searchResults.set(res);
          })
          .catch((err) => {
            console.warn("поиск не удался:", err);
            if (searchQuery.get().trim() === needle) searchResults.set([]);
          })
          .finally(() => {
            if (searchQuery.get().trim() === needle) searchPending.set(false);
          });
      }, SEARCH_DEBOUNCE_MS);
    });

    // Структурные фильтры (категории, скрытие мелочи) → пересобираем город и
    // обновляем статус пустоты. Первый синхронный вызов subscribe пропускаем
    // (стартовый уровень грузится отдельно ниже).
    let categoryFilterFirst = true;
    const offCategoryFilter = categoryFilter.subscribe(() => {
      if (categoryFilterFirst) {
        categoryFilterFirst = false;
        return;
      }
      rebuildFromFilters();
    });
    let showAggFirst = true;
    const offShowAgg = showAggregate.subscribe(() => {
      if (showAggFirst) {
        showAggFirst = false;
        return;
      }
      rebuildFromFilters();
    });

    // Скрытые узлы (тикет 008) — структурный фильтр: пересобираем город при
    // изменении набора. Когда возвращать больше нечего, закрываем панель скрытого
    // (её кнопка в header тоже исчезает при N=0). Первый синхронный вызов
    // пропускаем — стартовый уровень грузится отдельно ниже.
    let hiddenFirst = true;
    const offHidden = hiddenPaths.subscribe((paths) => {
      if (hiddenFirst) {
        hiddenFirst = false;
        return;
      }
      if (paths.length === 0) hiddenOpen.set(false);
      rebuildFromFilters();
    });

    // Смена порога агрегатора → структурная пересборка текущего уровня (с дебаунсом).
    // Первый вызов subscribe — синхронный с текущим значением; стартовый уровень
    // грузится ниже отдельно, поэтому пропускаем его (гард `aggFirst`).
    let aggFirst = true;
    const offAgg = aggSettings.subscribe(() => {
      if (aggFirst) {
        aggFirst = false;
        return;
      }
      scheduleReaggregate();
    });

    // Смена уровня графики (настройки). Внутри одного бэкенда — живьём применяем
    // рендер-параметры (pixelRatio/тени/пост) + пересобираем уровень (материалы
    // стекло/металл/PBR). ЧЕРЕЗ границу WebGL↔WebGPU (напр. →«экспериментальный») —
    // рендерер нельзя переключить на живом canvas, поэтому ПЕРЕСОЗДаём весь стек
    // (`remount`). `quality.active` уже обновлён сеттером в сторе. Первый синхронный
    // вызов пропускаем (стартовый уровень грузится отдельным потоком выше); во время
    // самого ремоунта повторные вызовы игнорируем (гард `remounting`).
    let graphicsFirst = true;
    const offGraphics = graphicsLevel.subscribe((level) => {
      if (graphicsFirst) {
        graphicsFirst = false;
        return;
      }
      if (remounting) return;
      if (QUALITY[level].backend !== currentBackend) {
        void remount(level);
      } else {
        handle?.applyQuality();
        void reaggregate();
      }
    });

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
        case "enterCleanup":
          enterCleanup();
          break;
        case "exitCleanup":
          exitCleanup();
          break;
        case "refresh":
          void reaggregate();
          break;
        case "reroot":
          void reroot();
          break;
        case "toggleHidden":
          toggleHidden();
          break;
        case "navigateTo":
          void navigateToResult(c.path);
          break;
        case "up":
          void goUp();
          break;
        case "deselect":
          interaction?.clearSelection();
          break;
        case "nodeAction":
          handleNodeAction(c.action);
          break;
      }
    });

    // Режим очистки: смена уровня В режиме (drill/крошки/поиск) обновляет группы
    // причин по новому поддереву. Вход в режим ловится этим же подписчиком.
    let lastCleanupPath: string | null = null;
    const offCleanupGroups = appMode.subscribe((m) => {
      if (m.kind === "cleanup") {
        if (m.path !== lastCleanupPath) {
          lastCleanupPath = m.path;
          void refreshCleanupGroups(m.path);
        }
      } else if (m.kind !== "zooming") {
        lastCleanupPath = null; // выход из режима (zooming — транзит, не сброс)
      }
    });

    // Пометка на снос изменилась → перекрасить облик очистки на лету (красный/дим).
    // Зовём navigator только в режиме cleanup; вне его — это no-op облика.
    const offMarks = markedForCleanup.subscribe(() => {
      if (appMode.get().kind === "cleanup") {
        nav?.setCleanup({ isMarked: isMarkedFn, isCandidate: isCandidateFn });
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

    // Старт: если включено восстановление и есть снимок прошлого скана — поднимаем
    // его без рескана, иначе показываем мок верхнего уровня (корень "" → бэк отдаёт
    // мок) с приветствием. Восстановление отключается в настройках (вкладка
    // «Сохранение»); тогда даже при наличии снимка стартуем на демо-городе.
    //
    // Снимок бэк читает В ФОНЕ (план §1.1): `currentRoot` может ответить
    // `loading: true` — тогда показываем «загружаю снимок…» и ждём события
    // `snapshot://ready` (его слушатель ставим ДО запроса, чтобы событие не
    // проскочило в щель между ответом и подпиской). `started` гасит двойной
    // вход (ответ с готовым корнем + догнавшее событие).
    //
    // Вынесено в функцию: стартовый поток запускается ПОСЛЕ подъёма стека
    // (`buildStack` асинхронна для WebGPU), см. async-IIFE в начале onMount.
    async function runStartFlow() {
      appMode.set({ kind: "scanning", progress: 0 });
      let started = false;
      /** Однократная стартовая инициализация: построить уровень по корню (`null` —
       *  демо + приветствие), прекомпилировать шейдеры (§1.2) и снять оверлей. */
      async function startWith(root: string | null): Promise<void> {
        if (started) return;
        started = true;
        try {
          const target = root ?? "";
          // Замер §1.2: первый buildCity + compileAsync + первый кадр города —
          // смотреть в devtools Performance (marks) или в консоли.
          performance.mark("sc:first-build:start");
          await loadRoot(target);
          performance.mark("sc:first-build:end");
          performance.measure(
            "sc:first-build",
            "sc:first-build:start",
            "sc:first-build:end",
          );
          // Прекомпиляция шейдеров (transmission-купола + PMREM) ДО снятия оверлея:
          // иначе их синхронная сборка на первом кадре города даёт jank (§1.2).
          await handle?.compile();
          performance.mark("sc:first-compile:end");
          performance.measure(
            "sc:first-compile",
            "sc:first-build:end",
            "sc:first-compile:end",
          );
          const offFirstFrame = handle?.onFrame(() => {
            offFirstFrame?.();
            performance.mark("sc:first-frame");
            performance.measure(
              "sc:first-frame-after-build",
              "sc:first-compile:end",
              "sc:first-frame",
            );
            const ms = (name: string) =>
              performance.getEntriesByName(name)[0]?.duration.toFixed(0) ?? "?";
            console.info(
              `[perf] первый уровень: build ${ms("sc:first-build")}мс, ` +
                `compile ${ms("sc:first-compile")}мс, ` +
                `кадр ${ms("sc:first-frame-after-build")}мс`,
            );
          });
          breadcrumbs.set([{ path: target, name: crumbName(target) }]);
          appMode.set({ kind: "idle", path: target });
          // Нет снимка прошлого скана → за демо-городом показываем приветствие
          // с приглашением выбрать реальную папку; после скана оно скрывается.
          statusKind = root === null ? "welcome" : "none";
        } catch (err) {
          console.warn("стартовый уровень недоступен:", err);
          appMode.set({ kind: "idle", path: "" });
          statusKind = "welcome";
        }
      }
      if (!restoreLastScan.get()) {
        void startWith(null);
      } else {
        listen<string | null>("snapshot://ready", (e) => {
          void startWith(e.payload);
        })
          .then((un) => {
            snapUnlisten = un;
            return currentRoot();
          })
          .then((cur) => {
            if (cur.loading) {
              statusKind = "loading"; // корень появится с событием snapshot://ready
              return;
            }
            void startWith(cur.root);
          })
          .catch((err) => {
            // Вне Tauri (чистый vite) ни событий, ни IPC — стартуем на демо.
            console.warn("стартовый корень недоступен:", err);
            void startWith(null);
          });
      }
    }

    return () => {
      disposed = true;
      snapUnlisten?.();
      offFilter();
      offSearch();
      offSearchIpc();
      if (searchTimer) clearTimeout(searchTimer);
      offCategoryFilter();
      offShowAgg();
      offHidden();
      offAgg();
      offGraphics();
      offCleanupGroups();
      offMarks();
      if (aggTimer) clearTimeout(aggTimer);
      offCmd();
      unlisten?.();
      teardownStack();
    };
  });

  /** Выбрать папку → реальный скан со стримом прогресса → верхний уровень. */
  async function scanFolder() {
    const root = await open({ directory: true, multiple: false });
    if (typeof root !== "string") return; // отмена диалога

    statusKind = "none"; // прячем оверлей на время скана
    interaction?.clearSelection();
    // Новый скан сбрасывает сессионный режим очистки, пометки и набор скрытого
    // (vision §I.6/§I.7 / тикет 008).
    nav?.setCleanup(null);
    clearMarks();
    clearHidden();
    setCleanupConfirm(false);
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
        // Свежепостроенный город = свежие материалы: прекомпилировать шейдеры до
        // снятия прогресс-панели, чтобы первый кадр не собирал их синхронно (§1.2).
        await handle?.compile();
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
    // Режим сканера мусора переживает навигацию по дереву (нужно искать мусор).
    const wasCleanup = $appMode.kind === "cleanup";
    const from =
      $appMode.kind === "idle" || $appMode.kind === "cleanup"
        ? $appMode.path
        : "";
    appMode.set({ kind: "zooming", from, to: node.path });
    hoveredNode.set(null);

    // Дети района (превью +1) — это содержимое нового активного уровня.
    const childNodes = await getLevel(node.path, aggSpec(), PREVIEW_DEPTH);
    currentUnfilteredNodes = childNodes;
    const filtered = getFilteredNodes(childNodes);
    await nav.drill(node, filtered, DRILL_MS);
    interaction?.clearHover();
    setSummary(childNodes, node.path);
    updateFilterEmpty(childNodes);

    breadcrumbs.set([
      ...$breadcrumbs,
      { path: node.path, name: node.name || crumbName(node.path) },
    ]);
    appMode.set(
      wasCleanup
        ? { kind: "cleanup", path: node.path }
        : { kind: "idle", path: node.path },
    );
  }

  /** §6: после бесшовного `up` дочитать ОДИН дальний декор-слой, если буфер контекста
   * просел ниже лимита (глубокий drill срезал дальние предки). Источник данных —
   * цепочка крошек: родитель самого дальнего удерживаемого уровня. Асинхронно и
   * fire-and-forget — твин камеры не блокируем (план §6). */
  async function replenishFarDecor() {
    if (!nav) return;
    const ref = nav.farthestHeldPath();
    if (!ref) return; // буфер полон
    const crumbs = breadcrumbs.get();
    const i = crumbs.findIndex((c) => c.path === ref);
    if (i <= 0) return; // дальше корня предков нет
    const parentPath = crumbs[i - 1].path;
    const nodes = await getLevel(parentPath, aggSpec(), PREVIEW_DEPTH);
    nav.appendFarAncestor(parentPath, getFilteredNodes(nodes));
  }

  /** Перейти к крошке по индексу. Подъём ровно на родителя — бесшовный (промоут
   * декора); прыжок дальше — обычная пересборка уровня (origin сбрасывается). */
  async function goToCrumb(index: number) {
    if ($appMode.kind === "zooming" || !nav) return;
    const crumb = $breadcrumbs[index];
    if (!crumb || index === $breadcrumbs.length - 1) return;
    const wasCleanup = $appMode.kind === "cleanup";
    appMode.set({ kind: "zooming", from: "", to: crumb.path });
    hoveredNode.set(null);
    interaction?.clearSelection(); // выбор уровня-источника больше не валиден

    const parentNodesPromise = getLevel(crumb.path, aggSpec(), PREVIEW_DEPTH);

    let didSeamlessUp = false;
    if (index === $breadcrumbs.length - 2 && nav.canUp(crumb.path)) {
      const parentNodes = await parentNodesPromise;
      currentUnfilteredNodes = parentNodes;
      await nav.up(DRILL_MS);
      didSeamlessUp = true;
      setSummary(parentNodes, crumb.path);
      updateFilterEmpty(parentNodes);
    } else {
      const parentNodes = await parentNodesPromise;
      currentUnfilteredNodes = parentNodes;
      const filtered = getFilteredNodes(parentNodes);
      await nav.reset(filtered, crumb.path);
      setSummary(parentNodes, crumb.path);
      updateFilterEmpty(parentNodes);
    }
    interaction?.clearHover();

    breadcrumbs.set($breadcrumbs.slice(0, index + 1));
    appMode.set(
      wasCleanup
        ? { kind: "cleanup", path: crumb.path }
        : { kind: "idle", path: crumb.path },
    );
    // Бесшовный подъём мог оголить дальний контекст — дочитать его (§6), не блокируя.
    if (didSeamlessUp) void replenishFarDecor();
  }

  function cancel() {
    void cancelScan();
  }
  /** Длительность плавного возврата камеры к обзорному ракурсу (компас). */
  const RESET_VIEW_MS = 600;

  /** «Сбросить вид» (клик по компасу / команда / хоткей): плавный твин к
   *  исходному обзорному ракурсу (север сверху). Во время зума — no-op. */
  function resetView() {
    if ($appMode.kind === "zooming") return;
    handle?.resetView(RESET_VIEW_MS);
  }

  /** На уровень вверх (хоткей Backspace / Alt+←): прыжок на предпоследнюю крошку.
   *  No-op на корне (одна крошка) — как дизейбл кнопки «назад». */
  function goUp() {
    const crumbs = $breadcrumbs;
    if (crumbs.length >= 2) void goToCrumb(crumbs.length - 2);
  }

  /** Узел для действия с клавиатуры: выбранный (карточка) в приоритете, иначе
   *  наведённый — «правда под курсором/в фокусе» (vision §I.9). */
  function actionNode(): ScanNode | null {
    return selectedNode.get() ?? hoveredNode.get();
  }

  /** Диспетчер действий над узлом с клавиатуры (vision §I.9/§I.10). `drill`,
   *  `properties` и `mark` работают строго по НАВЕДЁННОМУ (это «объект под
   *  курсором»); reveal/hide/copy — по активному (выбранный ∥ наведённый).
   *  Синтетический блок «Мелочь» (`aggregated`) реального пути не имеет —
   *  reveal/hide/copy/mark по нему пропускаем; системные (`locked`) не помечаем. */
  function handleNodeAction(action: NodeAction) {
    switch (action) {
      case "drill": {
        const n = hoveredNode.get();
        if (n && (n.isDir || n.flags.includes("aggregated"))) void drill(n);
        break;
      }
      case "properties":
        interaction?.selectHovered();
        break;
      case "reveal": {
        const n = actionNode();
        if (n && !n.flags.includes("aggregated")) void revealNode(n.path);
        break;
      }
      case "copyPath": {
        const n = actionNode();
        if (n && !n.flags.includes("aggregated")) void copyPathAction(n.path);
        break;
      }
      case "hide": {
        const n = actionNode();
        if (n && !n.flags.includes("aggregated")) hideSelected(n.path);
        break;
      }
      case "mark": {
        if (appMode.get().kind !== "cleanup") break;
        const n = hoveredNode.get();
        if (n && !n.flags.includes("locked") && !n.flags.includes("aggregated"))
          toggleMark(n.path, n.size);
        break;
      }
    }
  }

  /**
   * «Сделать эту папку корнем» (тикет 007): жёсткое переоткрытие текущего уровня
   * как нового корня — стек крошек сбрасывается до него, город перестраивается с
   * нуля (без бесшовного зума). Гарды дублируют дизейбл кнопки в Header: не на
   * верхнем уровне и не на синтетическом блоке «Прочее». Смена корня сбрасывает
   * сессионный набор скрытого (vision §I.6 / тикет 008). */
  async function reroot() {
    if ($appMode.kind === "zooming" || !nav) return;
    const crumbs = $breadcrumbs;
    if (crumbs.length <= 1) return;
    const current = crumbs[crumbs.length - 1];
    if (current.path.endsWith("::<other>")) return;
    interaction?.clearSelection();
    clearHidden();
    const count = await loadRoot(current.path);
    breadcrumbs.set([{ path: current.path, name: crumbName(current.path) }]);
    appMode.set({ kind: "idle", path: current.path });
    statusKind = count === 0 ? "empty" : "none";
  }

  /** Скрыть узел из визуализации (кнопка «Исключить» в карточке, тикет 008):
   *  добавить путь в сессионный набор и снять выбор. Пересборку города запускает
   *  подписчик `hiddenPaths` в onMount. */
  function hideSelected(path: string) {
    hideNode(path);
    interaction?.clearSelection();
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

  /** «Копировать путь» (карточка / ПКМ / хоткей Ctrl+C). Успех подтверждаем
   *  плашкой-тостом (vision: действие обязано отражаться в UI — у копирования нет
   *  иного видимого следа). Ошибку (нет доступа к буферу) — в лог + тост. */
  async function copyPathAction(path: string) {
    try {
      await copyPath(path);
      showToast("Скопировано в буфер обмена");
    } catch (err) {
      console.warn("копирование пути не удалось:", err);
      showToast("Не удалось скопировать путь");
    }
  }

  /** Цепочка крошек от корня `root` до `leaf` (включительно) по ПРЕФИКСАМ реального
   *  пути: каждый предок — префикс `leaf`, обрезанный по разделителю, поэтому строки
   *  точно совпадают с путями снимка (важно для последующих прыжков по крошкам;
   *  устойчиво к разделителю `\`/`/` и корню-диску `C:\`). */
  function chainTo(
    root: string,
    leaf: string,
  ): { path: string; name: string }[] {
    const chain = [{ path: root, name: crumbName(root) }];
    if (leaf === root || !leaf.startsWith(root)) return chain;
    const isSep = (c: string) => c === "\\" || c === "/";
    let pos = root.length;
    while (pos < leaf.length) {
      while (pos < leaf.length && isSep(leaf[pos])) pos++;
      let next = pos;
      while (next < leaf.length && !isSep(leaf[next])) next++;
      if (next === pos) break;
      chain.push({ path: leaf.slice(0, next), name: leaf.slice(pos, next) });
      pos = next;
    }
    return chain;
  }

  /** Навигация к узлу по пути (vision §I.3: клик по результату поиска → «дойти»).
   *  Перестраиваем мир на уровне-РОДИТЕЛЕ узла (здание видно среди соседей) и
   *  восстанавливаем крошки от корня; поиск остаётся активным, поэтому совпадение
   *  светится среди притушенных. Жёсткая пересборка (origin сбрасывается, как прыжок
   *  по неблизкой крошке) — простая и надёжная, без бесшовного зума через всё дерево. */
  async function navigateToResult(target: string) {
    if ($appMode.kind === "zooming" || !nav) return;
    const crumbsNow = $breadcrumbs;
    const root = crumbsNow.length > 0 ? crumbsNow[0].path : "";
    if (!root) return;
    const full = chainTo(root, target);
    // Уровень-владелец = родитель target (крошки без последнего звена).
    const levelChain = full.slice(0, Math.max(1, full.length - 1));
    const parentPath = levelChain[levelChain.length - 1].path;

    const wasCleanup = $appMode.kind === "cleanup";
    interaction?.clearSelection();
    hoveredNode.set(null);
    appMode.set({ kind: "zooming", from: "", to: parentPath });

    const nodes = await getLevel(parentPath, aggSpec(), PREVIEW_DEPTH);
    currentUnfilteredNodes = nodes;
    nav.reset(getFilteredNodes(nodes), parentPath);
    interaction?.clearHover();
    setSummary(nodes, parentPath);
    updateFilterEmpty(nodes);
    breadcrumbs.set(levelChain);
    appMode.set(
      wasCleanup
        ? { kind: "cleanup", path: parentPath }
        : { kind: "idle", path: parentPath },
    );
    statusKind = "none";
  }

  // Два НЕЗАВИСИМЫХ окна: полное на выбранном и мини на наведённом. Никакого
  // общего состояния — иначе hover дёргает разворот выбранного (см. NodeCard).
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

  <!-- Плашка пустоты категорийного фильтра -->
  <CategoryEmpty />

  <!-- Компас-«полярная звезда» (план §6): показывает север карты, вращается с
       орбитой камеры (императивно, onFrame); клик — плавный «Сбросить вид»
       (заменил одноимённую кнопку в шапке). -->
  <button
    class="compass"
    title="Сбросить вид — камера плавно вернётся к обзору (север сверху)"
    aria-label="Сбросить вид"
    onclick={resetView}
  >
    <span class="compass-rot" bind:this={compassRotEl}>
      <StarGlyph size={30} />
    </span>
  </button>

  <!-- Единое окно над зданием: компактный hover-вид разворачивается по клику в
       полную карточку (docs §I.9). Узел — выбранный, иначе наведённый; режим
       `expanded` = есть выбор. Обёртку позиционируем императивно покадрово (см.
       onFrame), контент/анимацию — реактивно из стора. -->
  <!-- Полное окно ВЫБРАННОГО узла. `{#key}` по пути — выбор нового файла
       пересоздаёт окно, поэтому `in:slide|global` проигрывает разворот заново
       (а не «перескок»). Наведение на другие здания его НЕ трогает. -->
  {#if selected}
    <div class="card-anchor" bind:this={cardEl}>
      {#key selected.path}
        <NodeCard
          node={selected}
          expanded={true}
          onReveal={revealNode}
          onClose={closeCard}
          onHide={hideSelected}
          onCopyPath={copyPathAction}
        />
      {/key}
    </div>
  {/if}

  <!-- Мини-окно НАВЕДЁННОГО узла (компактное, не дублируется на выбранном).
       Показывается и при открытом полном окне. `expanded=false` → блока разворота
       нет → не анимируется, просто следует за курсором. Пассивно (pointer-events
       на компактном — none): клик уходит зданию под ним. -->
  {#if hovered && hovered.path !== selected?.path}
    <div class="card-anchor" bind:this={hoverEl}>
      <NodeCard
        node={hovered}
        expanded={false}
        onReveal={revealNode}
        onClose={closeCard}
      />
    </div>
  {/if}

  <!-- Контекстное меню ПКМ (vision §I.10): рендерится Scene (владелец 3D), данные
       и действия — локально, как у карточки. fixed-позиция (координаты курсора). -->
  {#if contextMenu}
    <ContextMenu
      menu={contextMenu}
      cleanup={$appMode.kind === "cleanup"}
      marked={$markedForCleanup.has(contextMenu.node.path)}
      onOpen={(node) => {
        setMenu(null);
        void drill(node);
      }}
      onReveal={revealNode}
      onCopyPath={copyPathAction}
      onHide={hideSelected}
      onProperties={() => interaction?.selectContext()}
      onMark={(node) => {
        if (node.flags.includes("locked")) return;
        toggleMark(node.path, node.size);
      }}
      onClose={() => setMenu(null)}
    />
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
  /* Компас в углу сцены: круглая матовая кнопка, вращается только внутренний
     глиф (не трогаем layout-трансформ кнопки). */
  .compass {
    position: absolute;
    right: 14px;
    bottom: 14px;
    z-index: 3;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 46px;
    height: 46px;
    padding: 0;
    background: var(--overlay);
    backdrop-filter: blur(var(--blur));
    -webkit-backdrop-filter: blur(var(--blur));
    border: 1px solid var(--border);
    border-radius: 50%;
    cursor: pointer;
    transition: border-color var(--motion-micro) var(--ease-out);
  }
  .compass:hover {
    border-color: var(--accent);
  }
  .compass-rot {
    display: block;
    line-height: 0;
    will-change: transform;
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
</style>
