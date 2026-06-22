<script lang="ts">
  import { onMount } from "svelte";
  import type { Vector3 } from "three";
  import { open } from "@tauri-apps/plugin-dialog";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { createScene, type SceneHandle } from "../three/scene";
  import { createNavigator, type CityNavigator } from "../three/navigator";
  import StatusOverlay from "./StatusOverlay.svelte";
  import CategoryEmpty from "./CategoryEmpty.svelte";
  import NodeCard from "./NodeCard.svelte";
  import {
    setupInteraction,
    type InteractionController,
  } from "../three/interaction";
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
    aggSettings,
    markedForCleanup,
    toggleMark,
    clearMarks,
    cleanupCandidatesHere,
    categoryFilter,
    categoryFilterActive,
    categoryFilterEmpty,
    categoryMaskOf,
    showAggregate,
    type CandidateFilter,
  } from "../store/mode";
  import { uiCommand, levelSummary, setCleanupConfirm } from "../store/ui";
  import type {
    AggSpec,
    Category,
    ScanNode,
    ScanProgress,
  } from "../ipc/contract";

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

  // Состояние центрального оверлея (приветствие/пусто/ошибка/отмена). Низко-
  // частотное — обычный $state; "none" = город виден, оверлей не рисуется.
  type StatusKind = "welcome" | "empty" | "error" | "cancelled" | "none";
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

  /** Текущие параметры агрегации из стора → контракт `AggSpec` для `getLevel`.
   *  Относительный режим — прямая доля объёма папки (детерминированно, без зависимости
   *  от ракурса камеры): бэк сворачивает узлы мельче `fraction`·суммы уровня. */
  function aggSpec(): AggSpec {
    const a = aggSettings.get();
    return {
      mode: a.mode,
      fraction: a.fraction,
      minBytes: a.minBytes,
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
    if (!catActive && !hideAgg) return nodes;
    const mask = catActive ? categoryMaskOf(categoryFilter.get()) : null;
    return filterNodesRec(nodes, mask, hideAgg);
  }

  /** Рекурсивно отфильтровать узлы уровня и их превью. `mask = null` — фильтр
   *  категорий выключен (режем только мелочь по `hideAgg`). */
  function filterNodesRec(
    nodes: ScanNode[],
    mask: number | null,
    hideAgg: boolean,
  ): ScanNode[] {
    const out: ScanNode[] = [];
    for (const n of nodes) {
      if (hideAgg && n.flags.includes("aggregated")) continue;
      // Маска: у файла = бит категории, у папки/«Мелочи» = объединение поддерева,
      // поэтому единый предикат «есть пересечение с выбранными» покрывает всё.
      if (mask !== null && (n.categoryMask & mask) === 0) continue;
      const hasKids = n.children && n.children.length > 0;
      if (hasKids && (n.isDir || n.flags.includes("aggregated"))) {
        out.push({
          ...n,
          children: filterNodesRec(n.children!, mask, hideAgg),
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

  /** Войти в режим сканера мусора: переключить семантику клика и облик сцены. */
  function enterCleanup() {
    const crumbs = $breadcrumbs;
    const path = crumbs.length > 0 ? crumbs[crumbs.length - 1].path : "";
    interaction?.clearSelection();
    hoveredNode.set(null);
    appMode.set({ kind: "cleanup", path });
    nav?.setCleanup({ isMarked: isMarkedFn, isCandidate: isCandidateFn });
  }

  /** Выйти из режима: снять облик/пометки и вернуться в обычный Обзор. */
  function exitCleanup() {
    const path = $appMode.kind === "cleanup" ? $appMode.path : "";
    nav?.setCleanup(null);
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
    const nodes = await getLevel(path, aggSpec(), 2);
    currentUnfilteredNodes = nodes;
    const filtered = getFilteredNodes(nodes);
    nav.rebuildActive(filtered);
    interaction?.clearHover();
    setSummary(nodes, path);
    updateFilterEmpty(nodes);
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
    if (!path) return "Демо";
    const seg = path.split(/[/\\]/).filter(Boolean);
    return seg.length > 0 ? seg[seg.length - 1] : path;
  }

  /** Загрузить `path` как новый корень мира (старт/после скана/прыжок по крошке
   * дальше чем на уровень). Возвращает число узлов (0 → пусто, нечего показывать). */
  async function loadRoot(path: string): Promise<number> {
    // depth=2: каждый район несёт превью своих детей → вложенный treemap + LOD.
    const nodes = await getLevel(path, aggSpec(), 2);
    currentUnfilteredNodes = nodes;
    const filtered = getFilteredNodes(nodes);
    nav?.reset(filtered, path);
    interaction?.clearHover();
    setSummary(nodes, path);
    updateFilterEmpty(nodes);
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
      // Семантика клика в режиме сканера мусора: пометить/снять файл на снос.
      isCleanup: () => appMode.get().kind === "cleanup",
      onMark: (node) => {
        if (node.flags.includes("locked")) return;
        toggleMark(node.path, node.size);
      },
    });

    // LOD активного уровня: покадрово по позиции камеры (дёшево, переключение
    // только на смене состояния). Навигатор знает, какой уровень активен.
    const offLod = handle.onFrame(() => {
      nav?.updateLOD();
    });

    // Позицию окон над зданием ставим покадрово императивно (вне реконсиляции
    // Svelte, docs §4): полное — по якорю выбранного, мини — по якорю
    // наведённого. Контент/режим отрисованы реактивно; здесь только проекция.
    const place = (el: HTMLDivElement | undefined, anchor: Vector3 | null) => {
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
      // cardEl — полное окно по якорю выбранного; hoverEl — мини по наведённому.
      place(cardEl, interaction.selectionAnchor());
      place(hoverEl, interaction.hoverAnchor());
    });

    // ESC — снять выбор (закрыть карточку). Глобально, т.к. фокус на canvas.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") interaction?.clearSelection();
    };
    window.addEventListener("keydown", onKey);

    // Подсветка: фильтр кандидатов И поиск по имени → один предикат навигатору.
    // subscribe срабатывает сразу с текущим значением — nav уже создан выше.
    const offFilter = candidateFilter.subscribe(() => {
      refreshHighlight();
      if (appMode.get().kind === "cleanup") {
        nav?.setCleanup({ isMarked: isMarkedFn, isCandidate: isCandidateFn });
      }
    });
    const offSearch = searchQuery.subscribe(() => refreshHighlight());

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
      offCard();
      offFilter();
      offSearch();
      offCategoryFilter();
      offShowAgg();
      offAgg();
      offMarks();
      if (aggTimer) clearTimeout(aggTimer);
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
    // Новый скан сбрасывает сессионный режим очистки и пометки (vision §I.6/§I.7).
    nav?.setCleanup(null);
    clearMarks();
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
    const childNodes = await getLevel(node.path, aggSpec(), 2);
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

    const parentNodesPromise = getLevel(crumb.path, aggSpec(), 2);

    if (index === $breadcrumbs.length - 2 && nav.canUp(crumb.path)) {
      const parentNodes = await parentNodesPromise;
      currentUnfilteredNodes = parentNodes;
      await nav.up(DRILL_MS);
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
</style>
