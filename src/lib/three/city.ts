/**
 * Построение «города» одного уровня как самостоятельной `Group` (фаза 2:
 * вложенный treemap + LOD + бесшовная навигация).
 *
 * Уровень строится КАНОНИЧЕСКИ: squarified-treemap (`d3-hierarchy`) в прямо-
 * угольнике аспекта своего владельца (нормированном так, что бо́льшая сторона =
 * `CITY_SPAN`), сцентрированный около начала координат. Так как squarify
 * scale-инвариантен (раскладка зависит от аспекта и размеров детей, не от
 * абсолютного размера), превью района = равномерно уменьшенная копия этого же
 * района «как самостоятельного уровня». Это и делает drill дешёвым: размещение
 * уровня в прямоугольник района — честная similarity `G(local)=s·local+C`
 * (см. `navigator.ts`), а промоут «превью → активный» — пиксель-в-пиксель.
 *
 * Координаты d3 → мир — ТОЛЬКО через `layoutToWorld` (docs §5.6).
 *
 * Рендер разводит сущности (docs §5, backlog фаза 2):
 *   - «здание» = файл/лист: высота=устаревание (mtime), цвет=категория;
 *   - «район-плот» = папка: тонкая плита + вложенные здания вблизи, либо грубый
 *     силуэт-блок издалека (LOD).
 *
 * Высоты вложенных превью масштабируются footprint-scale района
 * (`s_D = max(w,d)/CITY_SPAN`): при промоуте в активный уровень (который строится
 * с полными высотами и ставится трансформом `s_D`) превью и активный совпадают,
 * «иголок» из рассогласования масштабов высоты и основания нет.
 *
 * Контакт с DOM — нет: это императивный 3D-слой. Уровнями владеет `navigator.ts`.
 */
import {
  BoxGeometry,
  type Camera,
  CircleGeometry,
  Color,
  ConeGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PlaneGeometry,
  Vector3,
} from "three";
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import type { ScanNode } from "../ipc/contract";
import {
  CATEGORY_COLOR,
  CLEANUP_MARKER_COLOR,
  DISTRICT_PLOT_COLOR,
  GROUND_COLOR,
} from "./palette";
import { layoutToWorld, type TreemapRect } from "./layoutToWorld";

/** Каноническая сторона уровня-владельца (мировые единицы): бо́льшая сторона. */
export const CITY_SPAN = 200;
/**
 * Зазор-«дорога» МЕЖДУ районами (широкий) и зазор между домами ВНУТРИ района
 * (плотный). Депт-зависимый padding: дороги читаются как разметка, а застройка
 * внутри района остаётся плотной (vision §II.3). Дорога должна вмещать ~2 шага
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
/** Внешний отступ детей от рамки района — читаемая граница плота. */
const DISTRICT_PAD = 1.0;
/** Верхняя полоса района (рамка/«крыша») сверх внешнего отступа. */
const DISTRICT_PAD_TOP = 2.5;
/** Диапазон высоты здания (устаревание), мировые единицы. */
const MIN_HEIGHT = 4;
const MAX_HEIGHT = 70;
/** Горизонт «устаревания»: возраст, при котором высота упирается в максимум. */
const MAX_AGE_SECONDS = 3 * 365 * 24 * 3600; // ~3 года
/** Минимальное значение площади, чтобы нулевые узлы не вырождались в точку. */
const MIN_VALUE = 1;
/** Высота плиты-плота района (тонкая подложка под вложенные здания). */
const PLOT_HEIGHT = 2;
/** Множитель затемнения несовпадающих с фильтром/поиском узлов (подсветка). */
export const DIM_FACTOR = 0.12;

/** Дистанции LOD камера→центр района (гистерезис против мерцания на границе). */
const NEAR_ENTER = 130; // ближе этого — район раскрывается во вложенные здания
const NEAR_EXIT = 170; // дальше этого — сворачивается обратно в силуэт

/** Маркер «кандидат на очистку»: перевёрнутая пирамидка над крышей здания. */
const MARKER_GAP = 3; // зазор между крышей и кончиком маркера
const MARKER_HEIGHT = 5;
const MARKER_RADIUS = 2.4;

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
  /** Цель drill при клике (для вложенного превью — родительский район). */
  drillTarget: ScanNode;
}

/**
 * Текущий город уровня (мост для пикинга и LOD). DOM сюда не заглядывает.
 */
export interface CityView {
  /** Покадрово: пересчитать LOD районов по позиции камеры (дёшево, см. §LOD). */
  updateLOD(camera: Camera): void;
  /** Меши, по которым идёт raycast (здания + плоты + силуэты); маркеры исключены. */
  pickMeshes(): InstancedMesh[];
  /** Разрешить попадание (меш+инстанс) в узел/цель-drill, либо `null`. */
  resolvePick(mesh: Object3D, instanceId: number): PickInfo | null;
}

/**
 * Уровень города — самостоятельная `Group` с канонической раскладкой. Размещение
 * в мир (в прямоугольник района родителя) задаётся трансформом группы извне
 * (`navigator.ts`). Активный уровень рисуется полностью и кликабелен; декор —
 * грубые силуэты, притушен, без пикинга (`setDecor`).
 */
export interface Level {
  /** Контейнер уровня; навигатор задаёт его scale/position (similarity). */
  readonly group: Group;
  /** Путь корня этого уровня (для крошек/идентификации). */
  readonly path: string;
  /** Мост пикинга/LOD активного уровня. */
  readonly view: CityView;
  /** Размещение дочернего района по пути (канонический фрейм уровня), либо `null`. */
  childPlacement(path: string): Placement | null;
  /**
   * Переключить облик: декор (силуэты, притушено, без пикинга). `excludePath` —
   * район, ставший активным уровнем: его силуэт ОБЯЗАТЕЛЬНО скрываем, иначе после
   * `G⁻¹` он раздувается до `CITY_SPAN` в начале координат и накрывает активный
   * уровень (был баг «после drill вся папка — один блок»).
   */
  setDecor(excludePath?: string): void;
  /** Переключить облик: активный (полный рендер + LOD + пикинг). */
  setActive(): void;
  /**
   * Подсветка-фильтр (фаза 2, DoD «кандидаты одним взглядом»): несовпадающие с
   * предикатом узлы гасятся домножением per-instance цвета на `DIM_FACTOR`,
   * совпадающие остаются в полном цвете → «сцена в тень, совпадения светятся».
   * `null` — снять подсветку (вернуть базовые цвета). Канал цвета не подменяется,
   * только притеняется (палитра категорий сохраняется).
   */
  setHighlight(match: ((node: ScanNode) => boolean) | null): void;
  /** Освободить GPU-ресурсы (geometry/material всех мешей). */
  dispose(): void;
}

/** LOD-группа района: id инстансов и текущее состояние «вблизи». */
interface DistrictLod {
  center: Vector3;
  coarseId: number;
  plotId: number;
  buildingIds: number[];
  near: boolean;
}

/** Накопитель района при раскладке (до постройки мешей). */
interface DistrictAcc {
  node: ScanNode;
  rect: TreemapRect;
  coarseHeight: number;
  center: Vector3;
  /** footprint-scale района: max(w,d)/CITY_SPAN (масштаб вложенных высот). */
  footprintScale: number;
}

/** Накопитель здания при раскладке. */
interface BuildingAcc {
  node: ScanNode;
  rect: TreemapRect;
  height: number;
  /** Индекс района-владельца в `districts` (вложенное превью), либо `null`. */
  districtIdx: number | null;
}

/**
 * Вложенная squarified-раскладка уровня в прямоугольнике `span` (аспект владельца,
 * нормированный к CITY_SPAN). Строит настоящую d3-иерархию из `ScanNode.children`
 * (превью), возвращает накопители районов и зданий с прямоугольниками в координатах
 * раскладки (y вниз), сцентрированными около начала координат. Высоты вложенных
 * (depth 2) зданий масштабируются footprint-scale района (см. шапку файла).
 */
function layoutNested(
  nodes: ScanNode[],
  span: LevelSpan,
  nowSeconds: number,
): { districts: DistrictAcc[]; buildings: BuildingAcc[] } {
  const toDatum = (node: ScanNode): TreeDatum => {
    const kids = node.children;
    return kids && kids.length > 0
      ? { node, children: kids.map(toDatum) }
      : { node };
  };
  const rootDatum: TreeDatum = { children: nodes.map(toDatum) };

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
    // (между его домами) — плотная застройка. paddingInner(node) оценивается на
    // РОДИТЕЛЕ и разделяет его детей.
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

  // descendants(): pre-order (родитель раньше детей) — район заводим до его
  // вложенных зданий, чтобы те нашли индекс владельца и его footprint-scale.
  for (const d of laidOut.descendants()) {
    const node = d.data.node;
    if (!node) continue; // синтетический корень
    const rect = center(d);

    const isDistrict = d.depth === 1 && !!d.children && d.children.length > 0;
    if (isDistrict) {
      const c = layoutToWorld(rect, 0);
      const idx = districts.length;
      districtIdxByNode.set(node, idx);
      const footprintScale = Math.max(c.width, c.depth) / CITY_SPAN;
      districts.push({
        node,
        rect,
        coarseHeight: heightFromMtime(node.mtime, nowSeconds),
        center: new Vector3(c.centerX, 0, c.centerZ),
        footprintScale,
      });
    } else {
      // Лист: здание верхнего уровня (depth 1) или вложенное превью (depth 2).
      let districtIdx: number | null = null;
      let scale = 1;
      if (d.depth === 2) {
        const ancestor = d.ancestors().find((a) => a.depth === 1)?.data.node;
        districtIdx = (ancestor && districtIdxByNode.get(ancestor)) ?? null;
        if (districtIdx !== null) scale = districts[districtIdx].footprintScale;
      }
      buildings.push({
        node,
        rect,
        height: heightFromMtime(node.mtime, nowSeconds) * scale,
        districtIdx,
      });
    }
  }

  return { districts, buildings };
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
 * Построить уровень `nodes` в собственной `Group` (канонически, в прямоугольнике
 * `span`). Группа создаётся в identity — размещение в мир задаёт навигатор.
 *
 * Уровень рисуется тремя `InstancedMesh`: здания (файлы + вложенные превью),
 * плиты-плоты районов и грубые силуэты районов. LOD прячет/показывает их группами
 * по дистанции (см. `CityView.updateLOD`).
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
  // краям (город не висит в вакууме). Дороги — отдельный слой точек-«бордюров»
  // вокруг блоков + поле-сетка на апроне; оба строятся ПОСЛЕ раскладки, т.к.
  // нужны прямоугольники блоков. В декоре оба прячутся (см. applyDecor).
  const ground = makeFadedGround(span);
  group.add(ground);
  const roadDots = buildRoadDots(span, districts, buildings);
  group.add(roadDots);

  const dummy = new Object3D();
  const color = new Color();

  // Карта «путь района → размещение» для drill/up (childPlacement) и «путь →
  // индекс инстанса района» (для скрытия силуэта района, ставшего активным).
  const placements = new Map<string, Placement>();
  const districtIndexByPath = new Map<string, number>();

  // --- Здания: файлы верхнего уровня (видны всегда) + вложенные превью (видны
  // только когда район «вблизи»). Реальные матрицы храним для LOD-восстановления.
  const buildingPick: (PickInfo | null)[] = [];
  let buildingMesh: InstancedMesh | null = null;
  const buildingReal: Matrix4[] = [];
  const lod: DistrictLod[] = districts.map((d) => ({
    center: d.center,
    coarseId: -1,
    plotId: -1,
    buildingIds: [],
    near: false,
  }));
  lod.forEach((l, j) => {
    l.coarseId = j;
    l.plotId = j;
  });

  // Маркеры «кандидат на очистку» — только над узлами верхнего уровня (depth 1).
  const markerTops: { x: number; z: number; y: number }[] = [];

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

      // Вложенные превью стартуют скрытыми (район далёкий → силуэт); файлы видны.
      const hidden = b.districtIdx !== null;
      buildingMesh!.setMatrixAt(i, hidden ? ZERO_MATRIX : dummy.matrix);
      const nodeColor = b.node.isDir
        ? DISTRICT_PLOT_COLOR
        : CATEGORY_COLOR[b.node.category];
      buildingMesh!.setColorAt(i, color.set(nodeColor));

      if (b.districtIdx !== null) lod[b.districtIdx].buildingIds.push(i);

      const drillTarget =
        b.districtIdx !== null ? districts[b.districtIdx].node : b.node;
      buildingPick[i] = { node: b.node, drillTarget };

      // Маркер очистки — только для здания верхнего уровня (файл-кандидат).
      if (b.districtIdx === null && b.node.flags.includes("cleanupCandidate")) {
        markerTops.push({ x: box.centerX, z: box.centerZ, y: box.height });
      }
    });
    buildingMesh.instanceMatrix.needsUpdate = true;
    if (buildingMesh.instanceColor)
      buildingMesh.instanceColor.needsUpdate = true;
    group.add(buildingMesh);
  }

  // --- Плоты и силуэты районов. Один общий материал-тинт (канал цвета — за
  // категорией зданий, район нейтрален). Плот стартует скрытым, силуэт — видимым.
  const districtPick: (PickInfo | null)[] = [];
  let plotMesh: InstancedMesh | null = null;
  let coarseMesh: InstancedMesh | null = null;
  const plotReal: Matrix4[] = [];
  const coarseReal: Matrix4[] = [];

  if (districts.length > 0) {
    plotMesh = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      new MeshLambertMaterial({ color: new Color(DISTRICT_PLOT_COLOR) }),
      districts.length,
    );
    coarseMesh = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      new MeshLambertMaterial({ color: new Color(DISTRICT_PLOT_COLOR) }),
      districts.length,
    );
    districts.forEach((d, j) => {
      // Плот — тонкая плита на прямоугольнике района.
      const plot = layoutToWorld(d.rect, PLOT_HEIGHT);
      dummy.position.set(plot.centerX, PLOT_HEIGHT / 2, plot.centerZ);
      dummy.scale.set(plot.width, PLOT_HEIGHT, plot.depth);
      dummy.updateMatrix();
      plotReal[j] = dummy.matrix.clone();
      plotMesh!.setMatrixAt(j, ZERO_MATRIX); // старт: далёкий → плот скрыт

      // Силуэт — блок во весь прямоугольник, высота = устаревание района.
      const coarse = layoutToWorld(d.rect, d.coarseHeight);
      dummy.position.set(coarse.centerX, coarse.height / 2, coarse.centerZ);
      dummy.scale.set(coarse.width, coarse.height, coarse.depth);
      dummy.updateMatrix();
      coarseReal[j] = dummy.matrix.clone();
      coarseMesh!.setMatrixAt(j, dummy.matrix); // старт: далёкий → силуэт виден

      // Per-instance цвет плота/силуэта = белый: произведение с material.color
      // даёт DISTRICT_PLOT_COLOR (декор домножает material.color — не ломается),
      // зато подсветка-фильтр может притенять отдельные районы (setHighlight).
      plotMesh!.setColorAt(j, color.set(0xffffff));
      coarseMesh!.setColorAt(j, color.set(0xffffff));

      districtPick[j] = { node: d.node, drillTarget: d.node };
      districtIndexByPath.set(d.node.path, j);
      placements.set(d.node.path, {
        s: Math.max(plot.width, plot.depth) / CITY_SPAN,
        cx: plot.centerX,
        cz: plot.centerZ,
        w: plot.width,
        d: plot.depth,
      });

      if (d.node.flags.includes("cleanupCandidate")) {
        markerTops.push({
          x: coarse.centerX,
          z: coarse.centerZ,
          y: coarse.height,
        });
      }
    });
    plotMesh.instanceMatrix.needsUpdate = true;
    coarseMesh.instanceMatrix.needsUpdate = true;
    if (plotMesh.instanceColor) plotMesh.instanceColor.needsUpdate = true;
    if (coarseMesh.instanceColor) coarseMesh.instanceColor.needsUpdate = true;
    group.add(plotMesh);
    group.add(coarseMesh);
  }

  // Аннотация формой: над каждым узлом-кандидатом верхнего уровня — пирамидка.
  let markerMesh: InstancedMesh | null = null;
  if (markerTops.length > 0) {
    markerMesh = buildCleanupMarkers(group, markerTops);
  }

  // Облик: декор показывает только силуэты, притушенные; активный — всё.
  // `excludedIdx` — район, ставший активным уровнем (его силуэт в декоре скрыт).
  let isDecor = false;
  let excludedIdx: number | null = null;

  const view: CityView = {
    updateLOD(camera) {
      if (isDecor || !coarseMesh || !plotMesh) return; // декор/нет районов
      const cam = camera.position;
      let coarseDirty = false;
      let plotDirty = false;
      let buildingDirty = false;
      const wc = new Vector3();
      for (const d of lod) {
        // Центр района в МИРЕ: уровень может быть смещён/масштабирован группой.
        wc.copy(d.center);
        group.localToWorld(wc);
        const dist = Math.hypot(cam.x - wc.x, cam.y - wc.y, cam.z - wc.z);
        const want = d.near ? dist < NEAR_EXIT : dist < NEAR_ENTER;
        if (want === d.near) continue;
        d.near = want;
        if (want) {
          coarseMesh.setMatrixAt(d.coarseId, ZERO_MATRIX);
          plotMesh.setMatrixAt(d.plotId, plotReal[d.plotId]);
          for (const id of d.buildingIds)
            buildingMesh!.setMatrixAt(id, buildingReal[id]);
        } else {
          coarseMesh.setMatrixAt(d.coarseId, coarseReal[d.coarseId]);
          plotMesh.setMatrixAt(d.plotId, ZERO_MATRIX);
          for (const id of d.buildingIds)
            buildingMesh!.setMatrixAt(id, ZERO_MATRIX);
        }
        coarseDirty = true;
        plotDirty = true;
        if (d.buildingIds.length > 0) buildingDirty = true;
      }
      if (coarseDirty) coarseMesh.instanceMatrix.needsUpdate = true;
      if (plotDirty) plotMesh.instanceMatrix.needsUpdate = true;
      if (buildingDirty && buildingMesh)
        buildingMesh.instanceMatrix.needsUpdate = true;
    },
    pickMeshes() {
      if (isDecor) return []; // декор не кликабелен (docs: формы без raycast)
      const out: InstancedMesh[] = [];
      if (buildingMesh) out.push(buildingMesh);
      if (plotMesh) out.push(plotMesh);
      if (coarseMesh) out.push(coarseMesh);
      return out;
    },
    resolvePick(mesh, instanceId) {
      if (mesh === buildingMesh) return buildingPick[instanceId] ?? null;
      if (mesh === plotMesh || mesh === coarseMesh)
        return districtPick[instanceId] ?? null;
      return null;
    },
  };

  /** Привести инстансы в декор-облик: только силуэты, притушенные. Силуэт района
   * `excludedIdx` (ставшего активным уровнем) скрыт — иначе он накрыл бы активный. */
  function applyDecor(): void {
    ground.visible = false;
    roadDots.visible = false;
    if (buildingMesh) {
      buildingMesh.visible = true;
      // Скрываем внутренние здания исключённого района (чтобы не перекрывали активный уровень),
      // а все остальные здания (включая файлы родительского уровня) показываем.
      buildings.forEach((b, i) => {
        if (b.districtIdx === excludedIdx) {
          buildingMesh!.setMatrixAt(i, ZERO_MATRIX);
        } else {
          buildingMesh!.setMatrixAt(i, buildingReal[i]);
        }
      });
      buildingMesh.instanceMatrix.needsUpdate = true;

      const mat = buildingMesh.material as MeshLambertMaterial;
      mat.color.setRGB(0.35, 0.35, 0.35); // Притушенные цвета
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
    }

    if (plotMesh) {
      plotMesh.visible = true;
      // Скрываем подложку исключённого района, остальные показываем.
      for (let j = 0; j < plotReal.length; j++) {
        plotMesh.setMatrixAt(j, j === excludedIdx ? ZERO_MATRIX : plotReal[j]);
      }
      plotMesh.instanceMatrix.needsUpdate = true;

      const mat = plotMesh.material as MeshLambertMaterial;
      mat.color.copy(new Color(DISTRICT_PLOT_COLOR).multiplyScalar(0.35));
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
    }

    if (markerMesh) markerMesh.visible = false;

    if (coarseMesh) {
      // В режиме декорации все папки раскрыты, поэтому скрываем все их силуэты-блоки
      for (let j = 0; j < coarseReal.length; j++)
        coarseMesh.setMatrixAt(j, ZERO_MATRIX);
      coarseMesh.instanceMatrix.needsUpdate = true;
      const mat = coarseMesh.material as MeshLambertMaterial;
      mat.color.copy(new Color(DISTRICT_PLOT_COLOR).multiplyScalar(0.35));
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
    }
  }

  /** Вернуть активный облик: всё видимо, материал плотный, LOD снова работает. */
  function applyActive(): void {
    ground.visible = true;
    roadDots.visible = true;
    if (buildingMesh) {
      buildingMesh.visible = true;
      const mat = buildingMesh.material as MeshLambertMaterial;
      mat.color.setRGB(1, 1, 1); // Восстанавливаем оригинальные цвета
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
    }
    if (plotMesh) {
      plotMesh.visible = true;
      const mat = plotMesh.material as MeshLambertMaterial;
      mat.color.setHex(DISTRICT_PLOT_COLOR);
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
    }
    if (markerMesh) markerMesh.visible = true;
    if (coarseMesh) {
      const mat = coarseMesh.material as MeshLambertMaterial;
      mat.color.setHex(DISTRICT_PLOT_COLOR);
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
    }
    // Сбросить LOD-состояние: пусть updateLOD пересчитает по текущей камере.
    for (const d of lod) d.near = false;
    if (coarseMesh) {
      for (let j = 0; j < coarseReal.length; j++)
        coarseMesh.setMatrixAt(j, coarseReal[j]);
      coarseMesh.instanceMatrix.needsUpdate = true;
    }
    if (plotMesh) {
      for (let j = 0; j < plotReal.length; j++)
        plotMesh.setMatrixAt(j, ZERO_MATRIX);
      plotMesh.instanceMatrix.needsUpdate = true;
    }
    if (buildingMesh) {
      // Восстанавливаем файлы верхнего уровня и скрываем вложенные здания.
      buildings.forEach((b, i) => {
        buildingMesh!.setMatrixAt(
          i,
          b.districtIdx === null ? buildingReal[i] : ZERO_MATRIX,
        );
      });
      buildingMesh.instanceMatrix.needsUpdate = true;
    }
  }

  return {
    group,
    path,
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
      excludedIdx = null; // вернётся в активный — все силуэты снова в игре (LOD)
      applyActive();
    },
    setHighlight(match) {
      // Здания: база — цвет категории (папка-превью → структурный цвет плота).
      if (buildingMesh) {
        buildings.forEach((b, i) => {
          const base = b.node.isDir
            ? DISTRICT_PLOT_COLOR
            : CATEGORY_COLOR[b.node.category];
          color.set(base);
          if (match && !match(b.node)) color.multiplyScalar(DIM_FACTOR);
          buildingMesh!.setColorAt(i, color);
        });
        if (buildingMesh.instanceColor)
          buildingMesh.instanceColor.needsUpdate = true;
      }
      // Районы (плот + силуэт): база — белый (см. инициализацию выше).
      if (plotMesh && coarseMesh) {
        districts.forEach((d, j) => {
          color.setRGB(1, 1, 1);
          if (match && !match(d.node)) color.multiplyScalar(DIM_FACTOR);
          plotMesh!.setColorAt(j, color);
          coarseMesh!.setColorAt(j, color);
        });
        if (plotMesh.instanceColor) plotMesh.instanceColor.needsUpdate = true;
        if (coarseMesh.instanceColor)
          coarseMesh.instanceColor.needsUpdate = true;
      }
    },
    dispose() {
      disposeGroup(group);
    },
  };
}

/** Маркеры-флажки кандидатов на очистку: один `InstancedMesh` пирамидок. */
function buildCleanupMarkers(
  group: Group,
  tops: { x: number; z: number; y: number }[],
): InstancedMesh {
  // ConeGeometry с 4 гранями = пирамидка; апекс по умолчанию вверху.
  const geometry = new ConeGeometry(MARKER_RADIUS, MARKER_HEIGHT, 4);
  const material = new MeshBasicMaterial({
    color: new Color(CLEANUP_MARKER_COLOR),
  });
  const markers = new InstancedMesh(geometry, material, tops.length);
  const dummy = new Object3D();
  tops.forEach((t, i) => {
    // Поворот на π вокруг X → апекс смотрит ВНИЗ (на крышу); π/4 вокруг Y —
    // ромбовидный силуэт. Центр ставим так, чтобы кончик висел в MARKER_GAP
    // над крышей: tip = center.y − H/2.
    dummy.position.set(t.x, t.y + MARKER_GAP + MARKER_HEIGHT / 2, t.z);
    dummy.rotation.set(Math.PI, Math.PI / 4, 0);
    dummy.updateMatrix();
    markers.setMatrixAt(i, dummy.matrix);
  });
  markers.instanceMatrix.needsUpdate = true;
  // Метка, чтобы пикинг/hover отличали маркеры от городских мешей.
  markers.userData.isCleanupMarker = true;
  group.add(markers);
  return markers;
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
 * Слой точек-дорог: бордюры вокруг блоков верхнего уровня (районы + файлы) +
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

  // 1) Бордюры вокруг блоков верхнего уровня (районы + файлы верхнего уровня;
  //    вложенные превью внутри районов — не блоки, у них нет дорог).
  for (const d of districts) addCurbDots(dots, d.rect);
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
