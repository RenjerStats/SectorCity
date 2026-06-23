/**
 * Построение «города» одного уровня как самостоятельной `Group` (vision §II.3:
 * папки — стеклянные купола, детализация по глубине вместо дистанционного LOD).
 *
 * Уровень строится КАНОНИЧЕСКИ: squarified-treemap (`d3-hierarchy`) в прямо-
 * угольнике аспекта своего владельца (нормированном так, что бо́льшая сторона =
 * `CITY_SPAN`), сцентрированный около начала координат. Так как squarify
 * scale-инвариантен, превью района = равномерно уменьшенная копия этого же
 * района «как самостоятельного уровня». Это и делает drill дешёвым: размещение
 * уровня в прямоугольник района — честная similarity `G(local)=s·local+C`
 * (см. `navigator.ts`), а промоут «купол → активный уровень» — пиксель-в-пиксель
 * по домикам (анимируется только снятие стекла, §II.3.6).
 *
 * Координаты d3 → мир — ТОЛЬКО через `layoutToWorld` (docs §5.6).
 *
 * Сущности рендера (vision §II.3):
 *   - «здание» = файл/лист: высота=устаревание (mtime), цвет=категория;
 *   - «папка» = купол: полуматовый стеклянный `RoundedBox` (нейтральный, монохром)
 *     + металлический ободок-основание. Внутри — реальная застройка (на глубине
 *     +1) либо четыре серых куба-заглушки (на глубине +2, купол-«теплица»).
 *
 * Детализация по ГЛУБИНЕ, не по расстоянию до камеры (§II.3.2 — заменяет прежний
 * гистерезис `NEAR_ENTER`/`NEAR_EXIT`): прямые дети текущей папки (+1) — полно-
 * ценные купола с настоящими домиками; папки внутри них (+2) — купола-заглушки с
 * серыми кубами. Облик папки не «дышит» от движения камеры — предсказуемее и
 * точнее ложится на метафору «обособленный контейнер». `updateLOD` поэтому пуст
 * (оставлен для совместимости API: навигатор/тесты зовут его покадрово).
 *
 * Высоты вложенных превью (+1) масштабируются footprint-scale района
 * (`s_D = max(w,d)/CITY_SPAN`): при промоуте в активный уровень превью и активный
 * совпадают по высотам, «иголок» из рассогласования масштабов нет.
 *
 * Контакт с DOM — нет: это императивный 3D-слой. Уровнями владеет `navigator.ts`.
 */
import {
  BoxGeometry,
  type Camera,
  CircleGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import type { ScanNode } from "../ipc/contract";
import {
  AGGREGATE_COLOR,
  CATEGORY_COLOR,
  CLEANUP_MARK_COLOR,
  DOME_RING_COLOR,
  GLASS_COLOR,
  GLASS_ROUGHNESS,
  GROUND_COLOR,
  STUB_COLOR,
} from "./palette";
import { layoutToWorld, type TreemapRect } from "./layoutToWorld";

/** Каноническая сторона уровня-владельца (мировые единицы): бо́льшая сторона. */
export const CITY_SPAN = 200;
/**
 * Зазор-«дорога» МЕЖДУ районами (широкий) и зазор между домами ВНУТРИ района
 * (плотный). Депт-зависимый padding: дороги читаются как разметка, а застройка
 * внутри купола остаётся плотной (vision §II.3.4). Дорога должна вмещать ~2 шага
 * dot-grid (`ROAD_DOT_CELL`), иначе сетка выглядит как набор точек, а не улица.
 */
const ROAD_WIDTH = 9;
const BUILDING_GAP = 0.6;
/**
 * Дороги — точечные «бордюры» вокруг блоков (точки из геометрии раскладки, не из
 * мировой решётки): по периметру каждого блока, равномерно вдоль стороны, с
 * яркими точками на углах-перекрёстках. Вокруг города — равномерное поле-апрон,
 * гаснущее по расстоянию от края города (не по камере).
 */
const CURB_OFFSET = 1.4; // вынос бордюра в зазор от грани блока
const CURB_STEP = 4; // шаг точек вдоль стороны блока
const CURB_DOT_ALPHA = 0.16; // яркость точки бордюра (смешение с белым)
const CORNER_DOT_ALPHA = 0.26; // яркость точки-перекрёстка (угол)
const CORNER_SCALE = 1.7; // во сколько крупнее точка-перекрёсток
const DOT_R = 0.55; // базовый радиус точки, мир
const GROUND_APRON = 3; // во сколько раз земля больше города
const GROUND_EDGE_COLOR = 0x080808; // = --bg: к нему гаснут земля и сетка у краёв
const APRON_STEP = 6; // шаг сетки-поля вокруг города
const APRON_DOT_ALPHA = 0.12; // базовая яркость точки поля (до угасания)
/**
 * Внешний отступ детей от рамки района. Должен быть БОЛЬШЕ `DOME_FOOTPRINT_INSET`:
 * разница = зазор между застройкой и стеклом купола. Без зазора домики у самой
 * стенки не размываются (transmission блюрит по экранному смещению ≈ глубине за
 * стеклом) и могут «протыкать» стекло, ломая буфер глубины (vision §II.3.7).
 */
const DISTRICT_PAD = 3.0;
/** Верхняя полоса района (рамка/«крыша») сверх внешнего отступа. */
const DISTRICT_PAD_TOP = 2.5;
/** Диапазон высоты здания (устаревание), мировые единицы. */
const MIN_HEIGHT = 4;
const MAX_HEIGHT = 70;
/** Горизонт «устаревания»: возраст, при котором высота упирается в максимум. */
const MAX_AGE_SECONDS = 3 * 365 * 24 * 3600; // ~3 года
/** Минимальное значение площади, чтобы нулевые узлы не вырождались в точку. */
const MIN_VALUE = 1;
/** Множитель затемнения несовпадающих с фильтром/поиском узлов (подсветка). */
export const DIM_FACTOR = 0.12;

/** Высота металлического ободка-основания купола (тонкий постамент), мир. */
const RING_HEIGHT = 2.2;
/** Вынос ободка наружу за грань купола — «поребрик» выступает из-под стекла. */
const RING_RIM = 1.0;
/**
 * Купол охватывает свою застройку с запасом-«воздухом» сверху (§II.3.5: высота
 * самого купола — производная, величину НЕ кодирует). Footprint купола слегка
 * утоплен внутрь рамки района, чтобы металлический ободок выступал «поребриком».
 */
const DOME_AIR = 8; // запас над самым высоким домиком (зазор «застройка↔стекло»)
const DOME_MIN_HEIGHT = 9; // минимальная высота купола (тощие папки читаемы)
const DOME_FOOTPRINT_INSET = 0.8; // насколько footprint купола уже рамки района
/** Скруглённый стеклянный куб: радиус скругления и сегменты на единичном боксе. */
const DOME_ROUND_RADIUS = 0.06;
const DOME_ROUND_SEGMENTS = 3;

/** «Теплица» на +2: серые кубы-заглушки (без своей стеклянной оболочки). */
const STUB_CANON_HEIGHT = 12; // высота серого куба-заглушки (до footprint-scale)
/** Относительные высоты четырёх кубов — «четыре разных серых куба» (§II.3.2). */
const STUB_HEIGHT_RATIOS = [1.0, 0.7, 0.85, 0.55];
const STUB_GAP = 0.18; // доля зазора между кубами в footprint теплицы

/** Притушенный серый материал декора (контекст-родитель). */
const DECOR_GRAY = 0.35;

/** Прямоугольник-владелец уровня (мировые единицы), задаёт аспект раскладки. */
export interface LevelSpan {
  w: number;
  d: number;
}

/** Размещение дочернего района: similarity `G(local)=s·local+C` (C.y=0). */
export interface Placement {
  /** Равномерный масштаб (footprint района / канонический размах). */
  s: number;
  /** Центр прямоугольника района в координатах ЭТОГО уровня. */
  cx: number;
  cz: number;
  /** Размеры прямоугольника района (для канонического span дочернего уровня). */
  w: number;
  d: number;
}

/** Обёртка датума для d3-иерархии: либо синтетический корень, либо узел. */
interface TreeDatum {
  node?: ScanNode;
  children?: TreeDatum[];
}

/** Разрешение пикинга: что под курсором и что drill'ить кликом. */
export interface PickInfo {
  /** Узел под курсором (для тултипа/обводки). */
  node: ScanNode;
  /** Цель drill при клике (для вложенного содержимого — родительский район). */
  drillTarget: ScanNode;
}

/**
 * Текущий город уровня (мост для пикинга). DOM сюда не заглядывает.
 */
export interface CityView {
  /**
   * Покадровый хук (оставлен для совместимости API). Детализация задаётся ГЛУБИНОЙ,
   * не расстоянием (§II.3.2), поэтому здесь делать нечего — облик статичен.
   */
  updateLOD(camera: Camera): void;
  /** Меши, по которым идёт raycast (купола-папки + здания-файлы). */
  pickMeshes(): InstancedMesh[];
  /** Разрешить попадание (меш+инстанс) в узел/цель-drill, либо `null`. */
  resolvePick(mesh: Object3D, instanceId: number): PickInfo | null;
}

/**
 * Уровень города — самостоятельная `Group` с канонической раскладкой. Размещение
 * в мир (в прямоугольник района родителя) задаётся трансформом группы извне
 * (`navigator.ts`). Активный уровень рисуется полностью и кликабелен; декор —
 * притушен, без пикинга (`setDecor`).
 */
export interface Level {
  /** Контейнер уровня; навигатор задаёт его scale/position (similarity). */
  readonly group: Group;
  /** Путь корня этого уровня (для крошек/идентификации). */
  readonly path: string;
  /** Прямоугольник, в котором построен уровень — чтобы пересобрать его на месте
   *  (смена порога агрегатора) с тем же масштабом, не трогая камеру. */
  readonly span: LevelSpan;
  /** Мост пикинга активного уровня. */
  readonly view: CityView;
  /** Размещение дочернего района по пути (канонический фрейм уровня), либо `null`. */
  childPlacement(path: string): Placement | null;
  /**
   * Переключить облик: декор (притушено, без пикинга). `excludePath` — район,
   * ставший активным уровнем: его купол и вся застройка ОБЯЗАТЕЛЬНО скрываются,
   * иначе после `G⁻¹` они раздуваются в начало координат и накрывают активный
   * уровень (был баг «после drill вся папка — один блок»).
   */
  setDecor(excludePath?: string): void;
  /** Переключить облик: активный (полный рендер + пикинг). */
  setActive(): void;
  /**
   * Подсветка-фильтр (vision §I.4б): несовпадающие с предикатом узлы гасятся
   * домножением per-instance цвета на `DIM_FACTOR`, совпадающие остаются в полном
   * цвете → «сцена в тень, совпадения светятся». `null` — снять подсветку. Канал
   * цвета не подменяется, только притеняется (палитра категорий сохраняется).
   */
  setHighlight(match: ((node: ScanNode) => boolean) | null): void;
  /**
   * Облик режима «Сканер мусора» (vision §I.7). При `view ≠ null` сцена уходит в
   * «вид очистки»: не-кандидаты приглушаются (×`DIM_FACTOR`), кандидаты
   * (флаг `cleanupCandidate`) — в полном цвете, помеченные на снос (`isMarked`) —
   * перекрашены в красный акцент `CLEANUP_MARK_COLOR`. `null` — выйти из вида
   * (владелец затем восстанавливает подсветку-фильтр через `setHighlight`).
   */
  setCleanup(
    view: {
      isMarked: (node: ScanNode) => boolean;
      isCandidate: (node: ScanNode) => boolean;
    } | null,
  ): void;
  /** Освободить GPU-ресурсы (geometry/material всех мешей). */
  dispose(): void;
}

/** Накопитель купола-района при раскладке (до постройки мешей). */
interface DistrictAcc {
  node: ScanNode;
  rect: TreemapRect;
  center: Vector3;
  /** footprint-scale района: max(w,d)/CITY_SPAN (масштаб вложенных высот). */
  footprintScale: number;
  /** Глубина относительно текущей папки: 1 (+1, реальные домики) или 2 (+2, заглушка). */
  depth: 1 | 2;
  /** Для +2: индекс родительского +1-купола в `districts` (для исключения в декоре). */
  parentIdx: number | null;
  /** Самый высокий внутренний элемент (домик/купол-теплица) — высота купола = он + воздух. */
  maxChildHeight: number;
}

/** Накопитель здания при раскладке. */
interface BuildingAcc {
  node: ScanNode;
  rect: TreemapRect;
  height: number;
  /** Индекс +1-купола-владельца в `districts` (вложенный домик), либо `null` (файл верхнего уровня). */
  districtIdx: number | null;
}

/** Контейнер = папка ИЛИ блок-агрегат «Мелочь» (навигируемый купол). */
function isContainer(node: ScanNode): boolean {
  return node.isDir || node.flags.includes("aggregated");
}

/**
 * Вложенная squarified-раскладка уровня в прямоугольнике `span` (аспект владельца,
 * нормированный к CITY_SPAN). Строит настоящую d3-иерархию из `ScanNode.children`
 * (превью), классифицирует узлы по глубине и возвращает накопители куполов и
 * зданий с прямоугольниками в координатах раскладки (y вниз), сцентрированными
 * около начала координат.
 */
function layoutNested(
  nodes: ScanNode[],
  span: LevelSpan,
  nowSeconds: number,
): { districts: DistrictAcc[]; buildings: BuildingAcc[] } {
  // Раскладку обрезаем на глубине +2: прямые дети (+1) несут свою застройку, а
  // папки внутри них (+2) становятся листьями-«теплицами» (стекло + серые кубы),
  // их реальных детей в раскладку НЕ тянем (§II.3.2). `depth`: дети текущей папки
  // приходят как 1, их дети — 2; глубже не идём.
  const toDatum = (node: ScanNode, depth: number): TreeDatum => {
    const kids = node.children;
    return kids && kids.length > 0 && depth < 2
      ? { node, children: kids.map((k) => toDatum(k, depth + 1)) }
      : { node };
  };
  const rootDatum: TreeDatum = { children: nodes.map((n) => toDatum(n, 1)) };

  const root = hierarchy<TreeDatum>(rootDatum, (d) => d.children).sum((d) =>
    // Значение только у листьев; d3 сворачивает площади районов вверх сам.
    d.children && d.children.length > 0
      ? 0
      : Math.max(d.node ? d.node.size : 0, MIN_VALUE),
  );

  // treemap() добавляет x0/y0/x1/y1 — итерируем именно прямоугольный результат.
  const laidOut = treemap<TreeDatum>()
    .tile(treemapSquarify)
    .size([span.w, span.d])
    // Депт-зависимый зазор: корень (между районами) — широкая дорога; район
    // (между его домами) — плотная застройка.
    .paddingInner((node) => (node.depth === 0 ? ROAD_WIDTH : BUILDING_GAP))
    .paddingOuter(DISTRICT_PAD)
    .paddingTop(DISTRICT_PAD_TOP)(root);

  const halfW = span.w / 2;
  const halfD = span.d / 2;
  const center = (d: { x0: number; y0: number; x1: number; y1: number }) => ({
    x0: d.x0 - halfW,
    y0: d.y0 - halfD,
    x1: d.x1 - halfW,
    y1: d.y1 - halfD,
  });

  const districts: DistrictAcc[] = [];
  const buildings: BuildingAcc[] = [];
  const districtIdxByNode = new Map<ScanNode, number>();

  // descendants(): pre-order (родитель раньше детей) — купол заводим до его
  // вложенного содержимого, чтобы те нашли индекс владельца и его footprint-scale.
  for (const d of laidOut.descendants()) {
    const node = d.data.node;
    if (!node) continue; // синтетический корень
    const rect = center(d);

    if (d.depth === 1 && isContainer(node)) {
      // +1 купол: прямой ребёнок текущей папки → полноценная застройка внутри.
      const c = layoutToWorld(rect, 0);
      const idx = districts.length;
      districtIdxByNode.set(node, idx);
      districts.push({
        node,
        rect,
        center: new Vector3(c.centerX, 0, c.centerZ),
        footprintScale: Math.max(c.width, c.depth) / CITY_SPAN,
        depth: 1,
        parentIdx: null,
        maxChildHeight: 0,
      });
    } else if (d.depth === 2 && isContainer(node)) {
      // +2 «теплица»: папка внутри папки → только серые кубы-заглушки (без своей
      // стеклянной оболочки — иначе она рендерилась бы поверх стекла родителя
      // чётко). Высота кубов фиксирована под scale; они под «крышей» родителя.
      const c = layoutToWorld(rect, 0);
      const parentIdx =
        d.ancestors().reduce<number | null>((acc, a) => {
          if (acc !== null) return acc;
          const an = a.data.node;
          return an && a.depth === 1
            ? (districtIdxByNode.get(an) ?? null)
            : acc;
        }, null) ?? null;
      const parentScale =
        parentIdx !== null ? districts[parentIdx].footprintScale : 1;
      const stubH = STUB_CANON_HEIGHT * parentScale; // самый высокий куб-заглушка
      districts.push({
        node,
        rect,
        center: new Vector3(c.centerX, 0, c.centerZ),
        footprintScale: Math.max(c.width, c.depth) / CITY_SPAN,
        depth: 2,
        parentIdx,
        maxChildHeight: stubH,
      });
      // Кубы-заглушки должны помещаться под «крышей» родительского +1 купола.
      if (parentIdx !== null) {
        districts[parentIdx].maxChildHeight = Math.max(
          districts[parentIdx].maxChildHeight,
          stubH,
        );
      }
    } else {
      // Лист-файл: здание верхнего уровня (+0) или вложенный домик (+1, внутри купола).
      let districtIdx: number | null = null;
      let scale = 1;
      if (d.depth === 2) {
        const ancestor = d.ancestors().find((a) => a.depth === 1)?.data.node;
        districtIdx = (ancestor && districtIdxByNode.get(ancestor)) ?? null;
        if (districtIdx !== null) scale = districts[districtIdx].footprintScale;
      }
      const height = heightFromMtime(node.mtime, nowSeconds) * scale;
      buildings.push({ node, rect, height, districtIdx });
      if (districtIdx !== null) {
        districts[districtIdx].maxChildHeight = Math.max(
          districts[districtIdx].maxChildHeight,
          height,
        );
      }
    }
  }

  return { districts, buildings };
}

/** Высота купола из самого высокого внутреннего элемента + запас-«воздух». */
function domeHeight(d: DistrictAcc): number {
  return Math.max(DOME_MIN_HEIGHT, d.maxChildHeight + DOME_AIR);
}

/** Высота из устаревания: чем старше mtime, тем выше (канал «устаревание»). */
function heightFromMtime(mtime: number, nowSeconds: number): number {
  const age = Math.max(0, nowSeconds - mtime);
  const t = Math.min(1, age / MAX_AGE_SECONDS);
  return MIN_HEIGHT + t * (MAX_HEIGHT - MIN_HEIGHT);
}

/** Вырожденная матрица (scale=0): инстанс не рисуется и не ловится raycast. */
const ZERO_MATRIX = new Matrix4().makeScale(0, 0, 0);

/**
 * Базовый цвет здания-файла. Синтетический блок «Мелочь» (флаг `aggregated`) →
 * собственный цвет-агрегата (не из категорийной палитры — чтобы не путать с
 * папкой/категорией); иначе — цвет категории.
 */
function baseBuildingColor(node: ScanNode): number {
  if (node.flags.includes("aggregated")) return AGGREGATE_COLOR;
  return CATEGORY_COLOR[node.category];
}

/**
 * Базовый цвет металлического ободка-основания купола. Обычная папка → нейтральный
 * металл; блок «Мелочь» (`aggregated`) несёт цвет-агрегат, чтобы читаться как
 * «объединённая мелочь», а не обычная папка. Стекло купола всегда нейтрально
 * (§II.3.5) — категорийный тинт допустим только здесь, на основании.
 */
function ringBaseColor(node: ScanNode): number {
  return node.flags.includes("aggregated") ? AGGREGATE_COLOR : DOME_RING_COLOR;
}

/**
 * Построить уровень `nodes` в собственной `Group` (канонически, в прямоугольнике
 * `span`). Группа создаётся в identity — размещение в мир задаёт навигатор.
 *
 * Меши уровня:
 *   - `buildingMesh` — файлы (верхнего уровня + вложенные домики +1);
 *   - `domeMesh`     — стеклянные купола папок (прозрачный проход, §II.3.7);
 *   - `ringMesh`     — металлические ободки-основания куполов;
 *   - `stubMesh`     — серые кубы-заглушки в куполах-теплицах +2.
 */
export function buildLevel(
  nodes: ScanNode[],
  span: LevelSpan,
  path: string,
): Level {
  const group = new Group();

  const nowSeconds = Math.floor(Date.now() / 1000);
  const { districts, buildings } = layoutNested(nodes, span, nowSeconds);

  // Земля — большой матовый «апрон» вокруг города с радиальным угасанием цвета к
  // краям. Дороги — отдельный слой точек-«бордюров» вокруг блоков + поле-сетка.
  const ground = makeFadedGround(span);
  group.add(ground);
  const roadDots = buildRoadDots(span, districts, buildings);
  group.add(roadDots);

  const dummy = new Object3D();
  const color = new Color();

  // Карта «путь района → размещение» (для drill/up) и «путь → индекс купола»
  // (для исключения купола, ставшего активным уровнем, в декоре).
  const placements = new Map<string, Placement>();
  const districtIndexByPath = new Map<string, number>();

  // --- Здания: файлы верхнего уровня + вложенные домики (+1, внутри куполов).
  const buildingPick: (PickInfo | null)[] = [];
  let buildingMesh: InstancedMesh | null = null;
  const buildingReal: Matrix4[] = [];

  if (buildings.length > 0) {
    buildingMesh = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      new MeshLambertMaterial(),
      buildings.length,
    );
    buildings.forEach((b, i) => {
      const box = layoutToWorld(b.rect, b.height);
      dummy.position.set(box.centerX, box.height / 2, box.centerZ);
      dummy.scale.set(box.width, box.height, box.depth);
      dummy.updateMatrix();
      buildingReal[i] = dummy.matrix.clone();
      buildingMesh!.setMatrixAt(i, dummy.matrix);
      buildingMesh!.setColorAt(i, color.set(baseBuildingColor(b.node)));

      // Внутри +1-купола клик ведёт в РОДИТЕЛЬСКИЙ район (как и клик по самому
      // куполу); файл верхнего уровня — это select (drillTarget = он сам, не папка).
      const drillTarget =
        b.districtIdx !== null ? districts[b.districtIdx].node : b.node;
      buildingPick[i] = { node: b.node, drillTarget };
    });
    buildingMesh.instanceMatrix.needsUpdate = true;
    if (buildingMesh.instanceColor)
      buildingMesh.instanceColor.needsUpdate = true;
    group.add(buildingMesh);
  }

  // --- Купола (+1, стекло) + ободки (металл). На +2 (теплицы) отдельной СТЕКЛЯННОЙ
  // оболочки НЕТ: прозрачный объект не попадает в буфер, который сэмплит
  // `transmission`, и потому рендерился бы поверх стекла родителя ЧЁТКО (а его
  // дешёвый материал ничего не размывает). +2 представлен только НЕПРОЗРАЧНЫМИ
  // серыми кубами — они попадают в буфер и размываются стеклом родительского +1
  // купола (а +2 всегда внутри +1). Так заглушки «теплицы» читаются так же мутно,
  // как и файлы внутри купола. domeMesh индексируется районом `j`; инстансы +2
  // вырождены (ZERO_MATRIX), пикинг +2 идёт через объемлющий купол +1.
  const districtPick: (PickInfo | null)[] = [];
  let domeMesh: InstancedMesh | null = null;
  let ringMesh: InstancedMesh | null = null;
  const domeReal: Matrix4[] = [];
  const ringReal: Matrix4[] = [];

  // --- Кубы-заглушки куполов-теплиц (+2): 4 на купол; запоминаем их район.
  interface StubAcc {
    matrix: Matrix4;
    districtIdx: number;
  }
  const stubs: StubAcc[] = [];

  if (districts.length > 0) {
    // +1 стекло — НАСТОЯЩЕЕ матовое (`transmission`, вариант (б) из §II.3.7):
    // дешёвый `transparent+opacity` физически НЕ размывает содержимое (только гасит
    // альфой). `transmission` преломляет фон, `roughness` размывает его по мипам
    // transmission-таргета → «мороз». Требует env-map (см. scene.ts). Тинт держим
    // per-instance (GLASS_COLOR), material.color белый.
    domeMesh = new InstancedMesh(
      new RoundedBoxGeometry(1, 1, 1, DOME_ROUND_SEGMENTS, DOME_ROUND_RADIUS),
      new MeshPhysicalMaterial({
        metalness: 0,
        roughness: GLASS_ROUGHNESS, // мороз: размывает прошедший свет
        transmission: 1, // преломляет/пропускает фон (настоящее стекло)
        thickness: 6, // «толщина» стекла — глубина преломления/затухания
        ior: 1.45,
        transparent: true,
        depthWrite: false, // прозрачный проход: домики внутри просвечивают
      }),
      districts.length,
    );
    domeMesh.renderOrder = 2; // после непрозрачных (здания/ободки/заглушки)
    // Ободок — тот же скруглённый куб, что и купол (совпадение кривизны углов),
    // footprint чуть БОЛЬШЕ купола (выступает поребриком). Металл виден только за
    // счёт отражений env-map (см. scene.ts) — без неё рендерился бы чёрным. Только
    // у +1 (постамент-обособление); у +2-теплиц ободка нет (вырожден).
    ringMesh = new InstancedMesh(
      new RoundedBoxGeometry(1, 1, 1, DOME_ROUND_SEGMENTS, DOME_ROUND_RADIUS),
      new MeshStandardMaterial({ metalness: 0.9, roughness: 0.35 }),
      districts.length,
    );

    districts.forEach((d, j) => {
      const full = layoutToWorld(d.rect, 0); // footprint района целиком (под ободок)

      // Купол: footprint утоплен внутрь рамки, чтобы ободок выступал поребриком.
      const dw = Math.max(1, full.width - DOME_FOOTPRINT_INSET * 2);
      const dd = Math.max(1, full.depth - DOME_FOOTPRINT_INSET * 2);

      if (d.depth === 1) {
        // +1: стеклянный купол + металлический ободок.
        const h = domeHeight(d);
        dummy.position.set(full.centerX, h / 2, full.centerZ);
        dummy.scale.set(dw, h, dd);
        dummy.updateMatrix();
        domeReal[j] = dummy.matrix.clone();
        domeMesh!.setMatrixAt(j, dummy.matrix);
        domeMesh!.setColorAt(j, color.set(GLASS_COLOR));

        dummy.position.set(full.centerX, RING_HEIGHT / 2, full.centerZ);
        dummy.scale.set(dw + RING_RIM * 2, RING_HEIGHT, dd + RING_RIM * 2);
        dummy.updateMatrix();
        ringReal[j] = dummy.matrix.clone();
        ringMesh!.setMatrixAt(j, dummy.matrix);
        ringMesh!.setColorAt(j, color.set(ringBaseColor(d.node)));
      } else {
        // +2: ни купола, ни ободка — только серые кубы-заглушки (непрозрачные →
        // размываются стеклом родительского +1). Инстансы купола/ободка вырождены.
        domeReal[j] = ZERO_MATRIX;
        ringReal[j] = ZERO_MATRIX;
        domeMesh!.setMatrixAt(j, ZERO_MATRIX);
        ringMesh!.setMatrixAt(j, ZERO_MATRIX);
        buildStubs(stubs, d, j, dw, dd, full.centerX, full.centerZ, dummy);
      }

      // Пикинг купола: +1 → drill в сам район; +2 (заглушка внутри +1) → drill в
      // родительский +1 (за один шаг ходим только на уровень глубже, §II.3.7).
      const drillTarget =
        d.depth === 2 && d.parentIdx !== null
          ? districts[d.parentIdx].node
          : d.node;
      districtPick[j] = { node: d.node, drillTarget };
      districtIndexByPath.set(d.node.path, j);
      // childPlacement только для +1 (реальные прямые дети текущего уровня).
      if (d.depth === 1) {
        placements.set(d.node.path, {
          s: Math.max(full.width, full.depth) / CITY_SPAN,
          cx: full.centerX,
          cz: full.centerZ,
          w: full.width,
          d: full.depth,
        });
      }
    });
    domeMesh.instanceMatrix.needsUpdate = true;
    ringMesh.instanceMatrix.needsUpdate = true;
    if (domeMesh.instanceColor) domeMesh.instanceColor.needsUpdate = true;
    if (ringMesh.instanceColor) ringMesh.instanceColor.needsUpdate = true;
    group.add(ringMesh);
    group.add(domeMesh);
  }

  // --- Кубы-заглушки в один InstancedMesh (после раскладки всех теплиц).
  // Непрозрачные: размываются стеклом родительского +1 купола (см. выше).
  let stubMesh: InstancedMesh | null = null;
  if (stubs.length > 0) {
    stubMesh = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({ roughness: 0.7, metalness: 0 }),
      stubs.length,
    );
    stubs.forEach((s, k) => {
      stubMesh!.setMatrixAt(k, s.matrix);
      stubMesh!.setColorAt(k, color.set(STUB_COLOR));
    });
    stubMesh.instanceMatrix.needsUpdate = true;
    if (stubMesh.instanceColor) stubMesh.instanceColor.needsUpdate = true;
    group.add(stubMesh);
  }

  // Облик: декор притушен, активный — полный. `excludedIdx` — район, ставший
  // активным уровнем (его купол/застройка в декоре скрыты).
  let isDecor = false;
  let excludedIdx: number | null = null;

  /** Принадлежит ли купол `j` исключённому поддереву (сам район или его +2-теплицы). */
  const districtExcluded = (j: number): boolean =>
    excludedIdx !== null &&
    (j === excludedIdx || districts[j].parentIdx === excludedIdx);

  const view: CityView = {
    updateLOD() {
      // Детализация по глубине статична (§II.3.2) — покадрово делать нечего.
    },
    pickMeshes() {
      if (isDecor) return []; // декор не кликабелен (docs: формы без raycast)
      const out: InstancedMesh[] = [];
      if (buildingMesh) out.push(buildingMesh);
      if (domeMesh) out.push(domeMesh); // +1 купола; +2 пикается через объемлющий +1
      return out;
    },
    resolvePick(mesh, instanceId) {
      if (mesh === buildingMesh) return buildingPick[instanceId] ?? null;
      if (mesh === domeMesh) return districtPick[instanceId] ?? null;
      return null;
    },
  };

  /** Притушить общий material меша до серого (per-instance цвета сохраняются). */
  function grayOut(mesh: InstancedMesh): void {
    const mat = mesh.material as MeshStandardMaterial | MeshLambertMaterial;
    mat.color.setRGB(DECOR_GRAY, DECOR_GRAY, DECOR_GRAY);
  }
  /** Вернуть общий material меша к белому (per-instance цвет = итоговый). */
  function whiten(mesh: InstancedMesh): void {
    const mat = mesh.material as MeshStandardMaterial | MeshLambertMaterial;
    mat.color.setRGB(1, 1, 1);
  }

  /** Привести инстансы в декор-облик: притушено, исключённое поддерево скрыто. */
  function applyDecor(): void {
    ground.visible = false;
    roadDots.visible = false;

    if (buildingMesh) {
      buildings.forEach((b, i) => {
        const hide = b.districtIdx !== null && b.districtIdx === excludedIdx;
        buildingMesh!.setMatrixAt(i, hide ? ZERO_MATRIX : buildingReal[i]);
      });
      buildingMesh.instanceMatrix.needsUpdate = true;
      grayOut(buildingMesh);
    }
    if (domeMesh && ringMesh) {
      // +2 инстансы купола/ободка и так вырождены (domeReal/ringReal = ZERO).
      districts.forEach((_, j) => {
        const hide = districtExcluded(j);
        domeMesh!.setMatrixAt(j, hide ? ZERO_MATRIX : domeReal[j]);
        ringMesh!.setMatrixAt(j, hide ? ZERO_MATRIX : ringReal[j]);
      });
      domeMesh.instanceMatrix.needsUpdate = true;
      ringMesh.instanceMatrix.needsUpdate = true;
      grayOut(domeMesh);
      grayOut(ringMesh);
    }
    if (stubMesh) {
      stubs.forEach((s, k) => {
        const hide = districtExcluded(s.districtIdx);
        stubMesh!.setMatrixAt(k, hide ? ZERO_MATRIX : s.matrix);
      });
      stubMesh.instanceMatrix.needsUpdate = true;
      grayOut(stubMesh);
    }
  }

  /** Вернуть активный облик: всё видимо, материал плотный/белый, пикинг доступен. */
  function applyActive(): void {
    ground.visible = true;
    roadDots.visible = true;

    if (buildingMesh) {
      buildings.forEach((_, i) =>
        buildingMesh!.setMatrixAt(i, buildingReal[i]),
      );
      buildingMesh.instanceMatrix.needsUpdate = true;
      whiten(buildingMesh);
    }
    if (domeMesh && ringMesh) {
      districts.forEach((_, j) => {
        domeMesh!.setMatrixAt(j, domeReal[j]);
        ringMesh!.setMatrixAt(j, ringReal[j]);
      });
      domeMesh.instanceMatrix.needsUpdate = true;
      ringMesh.instanceMatrix.needsUpdate = true;
      whiten(domeMesh);
      whiten(ringMesh);
    }
    if (stubMesh) {
      stubs.forEach((s, k) => stubMesh!.setMatrixAt(k, s.matrix));
      stubMesh.instanceMatrix.needsUpdate = true;
      whiten(stubMesh);
    }
  }

  return {
    group,
    path,
    span,
    view,
    childPlacement(p) {
      return placements.get(p) ?? null;
    },
    setDecor(excludePath) {
      if (isDecor) return;
      isDecor = true;
      excludedIdx =
        (excludePath !== undefined
          ? districtIndexByPath.get(excludePath)
          : undefined) ?? null;
      applyDecor();
    },
    setActive() {
      if (!isDecor) return;
      isDecor = false;
      excludedIdx = null;
      applyActive();
    },
    setHighlight(match) {
      paintAll((node, base) => {
        color.set(base);
        if (match && !match(node)) color.multiplyScalar(DIM_FACTOR);
        return color;
      });
    },
    setCleanup(cleanup) {
      paintAll((node, base) => {
        if (!cleanup) {
          color.set(base);
          return color;
        }
        if (cleanup.isMarked(node)) {
          color.set(CLEANUP_MARK_COLOR);
          return color;
        }
        color.set(base);
        if (!cleanup.isCandidate(node)) color.multiplyScalar(DIM_FACTOR);
        return color;
      });
    },
    dispose() {
      disposeGroup(group);
    },
  };

  /**
   * Перекрасить per-instance цвета всех мешей по правилу `paint(node, baseColor)`.
   * База: здания — цвет файла; купол — нейтральное стекло; ободок — цвет района;
   * заглушка — серый, по узлу её +2-района. Купол/ободок/заглушки одного района
   * красятся согласованно (узел района).
   */
  function paintAll(paint: (node: ScanNode, base: number) => Color): void {
    if (buildingMesh) {
      buildings.forEach((b, i) => {
        const c = paint(b.node, baseBuildingColor(b.node));
        buildingMesh!.setColorAt(i, c);
      });
      if (buildingMesh.instanceColor)
        buildingMesh.instanceColor.needsUpdate = true;
    }
    if (domeMesh && ringMesh) {
      // +2 инстансы купола/ободка вырождены (не видны), но цвет держим согласованным.
      districts.forEach((d, j) => {
        domeMesh!.setColorAt(j, paint(d.node, GLASS_COLOR));
        ringMesh!.setColorAt(j, paint(d.node, ringBaseColor(d.node)));
      });
      if (domeMesh.instanceColor) domeMesh.instanceColor.needsUpdate = true;
      if (ringMesh.instanceColor) ringMesh.instanceColor.needsUpdate = true;
    }
    if (stubMesh) {
      stubs.forEach((s, k) => {
        const node = districts[s.districtIdx].node;
        stubMesh!.setColorAt(k, paint(node, STUB_COLOR));
      });
      if (stubMesh.instanceColor) stubMesh.instanceColor.needsUpdate = true;
    }
  }
}

/**
 * Четыре серых куба-заглушки 2×2 внутри footprint купола-теплицы (+2). Высоты
 * разные («четыре разных серых куба», §II.3.2). Кубы — фиксированный декоративный
 * паттерн (не отражают реальное число детей), нарочито невзрачный.
 */
function buildStubs(
  out: { matrix: Matrix4; districtIdx: number }[],
  d: DistrictAcc,
  districtIdx: number,
  domeW: number,
  domeD: number,
  cx: number,
  cz: number,
  dummy: Object3D,
): void {
  const gx = domeW * STUB_GAP;
  const gz = domeD * STUB_GAP;
  const cellW = (domeW - gx) / 2;
  const cellD = (domeD - gz) / 2;
  const baseH = STUB_CANON_HEIGHT * d.footprintScale;
  let k = 0;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const h = baseH * STUB_HEIGHT_RATIOS[k % STUB_HEIGHT_RATIOS.length];
      const px = cx + (sx * (cellW + gx)) / 2;
      const pz = cz + (sz * (cellD + gz)) / 2;
      dummy.position.set(px, h / 2, pz);
      dummy.scale.set(cellW * 0.8, h, cellD * 0.8);
      dummy.updateMatrix();
      out.push({ matrix: dummy.matrix.clone(), districtIdx });
      k++;
    }
  }
}

/** clamp+smoothstep на [0,1] — мягкая интерполяция для радиального угасания. */
function smoothstep01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** Радиальное «t» угасания земли/сетки: 0 в центре города, 1 — к краю апрона. */
function groundFade(x: number, z: number, half: number): number {
  const r = Math.min(1, Math.hypot(x, z) / half);
  return smoothstep01((r - 0.35) / 0.6);
}

/**
 * Земля-«апрон»: большой матовый план вокруг города (×GROUND_APRON), цвет
 * радиально гаснет к краям из `GROUND_COLOR` в `GROUND_EDGE_COLOR` (=--bg) через
 * vertex-colors — у города нет «парящего» острого края, он тает в фон.
 */
function makeFadedGround(span: LevelSpan): Mesh {
  const S = Math.max(span.w, span.d) * GROUND_APRON;
  const geo = new PlaneGeometry(S, S, 48, 48);
  const base = new Color(GROUND_COLOR);
  const edge = new Color(GROUND_EDGE_COLOR);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const half = S / 2;
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    // План ещё не повёрнут: локальные (x,y) → мировые (x,z) после rotateX(-90°).
    const t = groundFade(pos.getX(i), pos.getY(i), half);
    c.copy(base).lerp(edge, t);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new Float32BufferAttribute(colors, 3));
  const ground = new Mesh(geo, new MeshLambertMaterial({ vertexColors: true }));
  ground.rotation.x = -Math.PI / 2; // в плоскость XZ
  ground.position.y = -0.01; // чуть ниже основания зданий
  return ground;
}

/** Одна точка дороги: позиция (мир XZ), масштаб и «яркость» (смешение с белым). */
interface DotSpec {
  x: number;
  z: number;
  scale: number;
  alpha: number;
}

/** Точки по периметру блока (бордюр): углы — ярко/крупно, стороны — равномерно. */
function addCurbDots(dots: DotSpec[], r: TreemapRect): void {
  const x0 = r.x0 - CURB_OFFSET;
  const x1 = r.x1 + CURB_OFFSET;
  const z0 = r.y0 - CURB_OFFSET; // treemap-y → world-z
  const z1 = r.y1 + CURB_OFFSET;
  // Углы-перекрёстки.
  for (const [cx, cz] of [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ]) {
    dots.push({ x: cx, z: cz, scale: CORNER_SCALE, alpha: CORNER_DOT_ALPHA });
  }
  // Промежуточные точки сторон (без концов — углы уже добавлены).
  const side = (
    a0: number,
    a1: number,
    fixed: number,
    horizontal: boolean,
  ): void => {
    const len = a1 - a0;
    const n = Math.floor(len / CURB_STEP);
    if (n < 2) return;
    const step = len / n;
    for (let k = 1; k < n; k++) {
      const a = a0 + k * step;
      dots.push(
        horizontal
          ? { x: a, z: fixed, scale: 1, alpha: CURB_DOT_ALPHA }
          : { x: fixed, z: a, scale: 1, alpha: CURB_DOT_ALPHA },
      );
    }
  };
  side(x0, x1, z0, true); // низ
  side(x0, x1, z1, true); // верх
  side(z0, z1, x0, false); // лево
  side(z0, z1, x1, false); // право
}

/**
 * Слой точек-дорог: бордюры вокруг блоков верхнего уровня (купола-районы + файлы) +
 * равномерное поле-сетка на апроне, гаснущее по расстоянию от края города.
 * Один `InstancedMesh` с per-instance цветом; цвет точки = локальный цвет земли,
 * подмешанный к белому на её «яркость», так далёкие точки тают вместе с землёй.
 */
function buildRoadDots(
  span: LevelSpan,
  districts: DistrictAcc[],
  buildings: BuildingAcc[],
): InstancedMesh {
  const dots: DotSpec[] = [];

  // 1) Бордюры вокруг блоков верхнего уровня (купола +1 + файлы верхнего уровня;
  //    вложенное содержимое куполов — не блоки, у них нет дорог).
  for (const d of districts) {
    if (d.depth === 1) addCurbDots(dots, d.rect);
  }
  for (const b of buildings) {
    if (b.districtIdx === null) addCurbDots(dots, b.rect);
  }

  // 2) Поле-сетка вокруг города; точки внутри города опускаем (там бордюры).
  const cityHalfW = span.w / 2;
  const cityHalfD = span.d / 2;
  const S = Math.max(span.w, span.d) * GROUND_APRON;
  const half = S / 2;
  const falloff = Math.max(span.w, span.d); // угасание за ~ширину города
  const skipW = cityHalfW + CURB_OFFSET * 2;
  const skipD = cityHalfD + CURB_OFFSET * 2;
  for (let x = -half; x <= half; x += APRON_STEP) {
    for (let z = -half; z <= half; z += APRON_STEP) {
      if (Math.abs(x) < skipW && Math.abs(z) < skipD) continue; // город
      const dx = Math.max(0, Math.abs(x) - cityHalfW);
      const dz = Math.max(0, Math.abs(z) - cityHalfD);
      const fade = 1 - Math.hypot(dx, dz) / falloff;
      if (fade <= 0.02) continue; // далёкие невидимые точки не создаём
      dots.push({ x, z, scale: 1, alpha: APRON_DOT_ALPHA * fade });
    }
  }

  // Собираем InstancedMesh. Точка — плоский кружок (CircleGeometry в XY),
  // кладём в XZ поворотом и масштабируем под «яркость»/угол на матрице инстанса.
  const mesh = new InstancedMesh(
    new CircleGeometry(DOT_R, 10),
    new MeshBasicMaterial(),
    dots.length,
  );
  const dummy = new Object3D();
  const base = new Color(GROUND_COLOR);
  const edge = new Color(GROUND_EDGE_COLOR);
  const white = new Color(0xffffff);
  const col = new Color();
  for (let i = 0; i < dots.length; i++) {
    const d = dots[i];
    dummy.position.set(d.x, 0.02, d.z); // чуть выше земли — без z-fight
    dummy.rotation.set(-Math.PI / 2, 0, 0);
    dummy.scale.setScalar(d.scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    // Цвет = локальный цвет земли (с тем же радиальным угасанием) → белый на alpha.
    col
      .copy(base)
      .lerp(edge, groundFade(d.x, d.z, half))
      .lerp(white, d.alpha);
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false; // апрон широкий — не отсекать целиком по bbox
  return mesh;
}

/** Освободить GPU-ресурсы группы (geometry/material/текстуры) и очистить её. */
function disposeGroup(group: Group): void {
  const disposeMat = (m: Material): void => {
    const tex = (m as MeshLambertMaterial).map;
    if (tex) tex.dispose(); // текстура земли (dot-grid)
    m.dispose();
  };
  for (const child of [...group.children]) {
    group.remove(child);
    if (child instanceof InstancedMesh || child instanceof Mesh) {
      child.geometry.dispose();
      const mat = child.material;
      if (Array.isArray(mat)) mat.forEach(disposeMat);
      else disposeMat(mat);
    }
  }
}
