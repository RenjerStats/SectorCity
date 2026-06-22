/**
 * Бесшовная навигация по уровням (фаза 2, «Зум с превью» → «Бесшовная навигация»).
 *
 * Модель ZUI (Pad++/Piccolo): на сцене всегда максимум ДВА уровня —
 *   - `active` — содержимое открытой папки: канонический (identity), кликабельный,
 *     с LOD;
 *   - `decor`  — тот же уровень, откуда пришли (родитель active): силуэты-контекст,
 *     притушен, без пикинга. Раздут после origin shift и выглядывает по краям.
 *
 * Почему дёшево по геометрии: d3-treemap детерминирован и scale-инвариантен, поэтому
 * превью района D внутри родителя СОВПАДАЕТ с раскладкой D как самостоятельного
 * уровня (см. `city.ts`). Drill — не перестройка, а «промоут превью в активный».
 *
 * Origin shift (floating origin). Каждый спуск — подразбиение прямоугольника, и
 * без нормировки активный уровень съёжился бы у нуля (поехали бы depth-buffer,
 * near/far, пороги LOD и контролов, калиброванные под канонический масштаб).
 * Решение: активный уровень ВСЕГДА строится канонически (identity), а камера после
 * каждого drill встаёт в одну и ту же каноническую позу `P`. «Сдвиг» прячется так:
 *   - размещение уровня в прямоугольник района — similarity `G(local)=s·local+C`;
 *   - в `onArrive` твина: новый active строится канонически (identity), старый
 *     active → decor получает `G⁻¹` (scale `1/s`, pos `−C/s`), камера = `P`.
 * Поскольку одну и ту же `G` применяли бы и к контенту, и к камере, картинка
 * пиксель-в-пиксель та же до и после — origin shift невидим (см. backlog).
 *
 * Это императивный 3D-слой: данные уровней (IPC `get_level`) подаёт владелец
 * (`Scene.svelte`), навигатор отвечает за геометрию, камеру и rebase. С DOM не
 * общается — мост пикинга кладёт в `content.userData` (см. `activeView`).
 */
import type { Group } from "three";
import type { ScanNode } from "../ipc/contract";
import type { SceneHandle } from "./scene";
import { INITIAL_CAMERA_POS, INITIAL_TARGET } from "./home";
import { buildLevel, CITY_SPAN, type CityView, type Level } from "./city";
import {
  forwardG,
  inverseG,
  inverseGroupTransform,
  spanFromPlacement,
} from "./transform";

/** Мост пикинга: активный уровень для слоя взаимодействия (либо `null`). */
export function activeView(content: Group): CityView | null {
  return (content.userData.activeView as CityView | undefined) ?? null;
}

/** Можно ли сейчас пикать (false во время твина зума — чтобы не ловить хвосты). */
export function isInteractive(content: Group): boolean {
  return content.userData.interactive === true;
}

/** Управление навигацией для владельца сцены. */
export interface CityNavigator {
  /** Сбросить мир к единственному активному уровню (старт/после скана/прыжок). */
  reset(nodes: ScanNode[], path: string): void;
  /**
   * Пересобрать активный уровень новыми `nodes` НА МЕСТЕ: тот же путь и span,
   * камера и декор-родитель не трогаются (смена порога агрегатора — это перерас-
   * кладка текущего уровня, а не навигация). `nodes` должны быть детьми того же
   * активного пути. Если активного уровня нет — no-op.
   */
  rebuildActive(nodes: ScanNode[]): void;
  /** Бесшовный drill в район `node`; `childNodes` = `get_level(node.path)`. */
  drill(node: ScanNode, childNodes: ScanNode[], ms: number): Promise<void>;
  /** Можно ли бесшовно подняться к `parentPath` (это текущий декор-родитель). */
  canUp(parentPath: string): boolean;
  /** Бесшовный подъём к родителю (промоут декора в активный). */
  up(ms: number): Promise<void>;
  /** Покадрово: LOD активного уровня по позиции камеры. */
  updateLOD(): void;
  /**
   * Подсветка-фильтр: применить предикат к активному уровню и запомнить его —
   * навигатор переприменяет его при каждой смене активного (drill/up/reset), так
   * что фильтр «переживает» навигацию. `null` — снять подсветку.
   */
  applyHighlight(match: ((node: ScanNode) => boolean) | null): void;
  /** Освободить все уровни. */
  dispose(): void;
}

export function createNavigator(handle: SceneHandle): CityNavigator {
  const content = handle.content;
  let active: Level | null = null;
  let decor: Level | null = null;
  // Текущий предикат подсветки-фильтра; переприменяется при смене активного.
  let currentMatch: ((node: ScanNode) => boolean) | null = null;

  function setActiveView(level: Level | null): void {
    content.userData.activeView = level ? level.view : null;
  }
  function setInteractive(on: boolean): void {
    content.userData.interactive = on;
  }

  function disposeLevel(level: Level): void {
    content.remove(level.group);
    level.dispose();
  }

  function reset(nodes: ScanNode[], path: string): void {
    if (active) disposeLevel(active);
    if (decor) disposeLevel(decor);
    decor = null;
    // Корень/прыжок: квадратный канонический холст.
    active = buildLevel(nodes, { w: CITY_SPAN, d: CITY_SPAN }, path);
    content.add(active.group);
    active.setHighlight(currentMatch); // фильтр переживает пересборку уровня
    setActiveView(active);
    setInteractive(true);
    handle.placeCamera(INITIAL_CAMERA_POS, INITIAL_TARGET);
  }

  function rebuildActive(nodes: ScanNode[]): void {
    if (!active) return;
    const { path, span } = active;
    // Активный уровень всегда в identity (origin shift), поэтому пересборка с тем
    // же span сохраняет геометрию под камерой; декор-родитель остаётся как есть
    // (его превью данного района и так скрыто, см. drill → setDecor).
    disposeLevel(active);
    active = buildLevel(nodes, span, path);
    content.add(active.group);
    active.setHighlight(currentMatch); // подсветка переживает пересборку
    setActiveView(active);
  }

  async function drill(
    node: ScanNode,
    childNodes: ScanNode[],
    ms: number,
  ): Promise<void> {
    if (!active) return;
    const g = active.childPlacement(node.path);
    if (!g) {
      // Узел не район текущего активного уровня — деградируем в обычную пересборку.
      reset(childNodes, node.path);
      return;
    }
    const fromActive = active;
    const fromDecor = decor;

    // Камера летит к `G(P)`: вид «внутрь» района; превью уточняется LOD по пути.
    const camTo = forwardG(INITIAL_CAMERA_POS, g);
    const tgtTo = forwardG(INITIAL_TARGET, g);

    setInteractive(false);
    await handle.flyTo(camTo, tgtTo, ms, () => {
      // origin shift в кадре завершения (см. шапку): следующий render нормирован.
      const next = buildLevel(childNodes, spanFromPlacement(g), node.path);
      content.add(next.group); // канонически, identity
      next.setHighlight(currentMatch); // фильтр переживает drill

      // Старый активный → декор в `G⁻¹` (раздут, выглядывает по краям). Силуэт
      // самого района `node` скрываем — иначе он накрыл бы новый активный уровень.
      const inv = inverseGroupTransform(g);
      fromActive.group.scale.setScalar(inv.scale);
      fromActive.group.position.copy(inv.position);
      fromActive.setHighlight(null); // декор — нейтральный контекст, без подсветки
      fromActive.setDecor(node.path);

      // Лимит 2 уровня: старый декор больше не нужен.
      if (fromDecor) disposeLevel(fromDecor);

      active = next;
      decor = fromActive;
      setActiveView(active);
      handle.placeCamera(INITIAL_CAMERA_POS, INITIAL_TARGET);
      setInteractive(true);
    });
  }

  function canUp(parentPath: string): boolean {
    return decor !== null && decor.path === parentPath;
  }

  async function up(ms: number): Promise<void> {
    if (!active || !decor) return;
    const parent = decor;
    const child = active;
    const g = parent.childPlacement(child.path);
    if (!g) {
      // Несогласованность — деградируем: оставляем родителя как есть нельзя без
      // данных, поэтому просто промоутим без анимации.
      reset([], parent.path);
      return;
    }

    // Камера отъезжает к `G⁻¹(P)`: родитель (декор, раздут) кадрируется целиком.
    const camTo = inverseG(INITIAL_CAMERA_POS, g);
    const tgtTo = inverseG(INITIAL_TARGET, g);

    setInteractive(false);
    await handle.flyTo(camTo, tgtTo, ms, () => {
      // Уходящий активный (центр кадра) убираем — его место займёт превью в родителе.
      disposeLevel(child);

      // Родитель (декор) → активный: identity + полный облик.
      parent.group.position.set(0, 0, 0);
      parent.group.scale.setScalar(1);
      parent.setActive();
      parent.setHighlight(currentMatch); // фильтр переживает подъём

      active = parent;
      // Деда как контекст-декор не достраиваем: его аспект зависит от пра-деда
      // (его уже нет в памяти), а строить «на глаз» — рассинхрон шва. Подъём
      // остаётся бесшовным (промоутим реальную геометрию родителя), декор пуст.
      decor = null;
      setActiveView(active);
      handle.placeCamera(INITIAL_CAMERA_POS, INITIAL_TARGET);
      setInteractive(true);
    });
  }

  function updateLOD(): void {
    active?.view.updateLOD(handle.camera);
  }

  function applyHighlight(match: ((node: ScanNode) => boolean) | null): void {
    currentMatch = match;
    active?.setHighlight(match);
  }

  function dispose(): void {
    if (active) disposeLevel(active);
    if (decor) disposeLevel(decor);
    active = null;
    decor = null;
    setActiveView(null);
    setInteractive(false);
  }

  return {
    reset,
    rebuildActive,
    drill,
    canUp,
    up,
    updateLOD,
    applyHighlight,
    dispose,
  };
}
