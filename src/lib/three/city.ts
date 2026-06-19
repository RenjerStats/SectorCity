/**
 * Построение «города» одного уровня из данных (фаза 1).
 *
 * Раскладка — squarified-treemap (`d3-hierarchy`): честная площадь основания ∝
 * размер. Рендер — один `InstancedMesh` на весь уровень (нативная скорость,
 * см. docs §5.2). Кодирование: площадь = размер, высота = устаревание (mtime),
 * цвет = категория (палитра — `palette.ts`).
 *
 * Перевод координат d3 → мир идёт ТОЛЬКО через `layoutToWorld` (единая
 * конвенция осей, docs §5.6). Раскладка детерминирована: тот же вход (узлы уже
 * приходят отсортированными по размеру) даёт ту же геометрию — пространственная
 * память (ТЗ).
 */
import {
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  PlaneGeometry,
} from "three";
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import type { ScanNode } from "../ipc/contract";
import { CATEGORY_COLOR, GROUND_COLOR } from "./palette";
import { layoutToWorld, type TreemapRect } from "./layoutToWorld";

/** Целевой размах города по стороне (мировые единицы) — сторона treemap-холста. */
const CITY_SPAN = 200;
/** Отступ между прямоугольниками (padded treemap) — читаемость границ. */
const TILE_PADDING = 1.5;
/** Диапазон высоты здания (устаревание), мировые единицы. */
const MIN_HEIGHT = 4;
const MAX_HEIGHT = 70;
/** Горизонт «устаревания»: возраст, при котором высота упирается в максимум. */
const MAX_AGE_SECONDS = 3 * 365 * 24 * 3600; // ~3 года
/** Минимальное значение площади, чтобы нулевые узлы не вырождались в точку. */
const MIN_VALUE = 1;

/** Обёртка датума для d3-иерархии: либо синтетический корень, либо узел уровня. */
interface TreeDatum {
  node?: ScanNode;
  children?: TreeDatum[];
}

/**
 * Squarified-treemap текущего уровня. Возвращает прямоугольники в координатах
 * раскладки (y вниз), сцентрированные около начала координат, в порядке,
 * совпадающем с порядком `nodes`.
 */
function layoutNodes(nodes: ScanNode[]): TreemapRect[] {
  const rootDatum: TreeDatum = { children: nodes.map((node) => ({ node })) };

  const root = hierarchy<TreeDatum>(rootDatum, (d) => d.children).sum((d) =>
    d.node ? Math.max(d.node.size, MIN_VALUE) : 0,
  );

  const laidOut = treemap<TreeDatum>()
    .tile(treemapSquarify)
    .size([CITY_SPAN, CITY_SPAN])
    .paddingInner(TILE_PADDING)(root);

  // Сопоставление узел → прямоугольник по идентичности данных (порядок листьев
  // d3 не обязан совпадать с входным), затем выдаём в порядке `nodes`.
  const byNode = new Map<ScanNode, TreemapRect>();
  for (const leaf of laidOut.leaves()) {
    if (leaf.data.node) {
      byNode.set(leaf.data.node, {
        x0: leaf.x0,
        y0: leaf.y0,
        x1: leaf.x1,
        y1: leaf.y1,
      });
    }
  }

  const half = CITY_SPAN / 2;
  return nodes.map((node) => {
    const r = byNode.get(node) ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
    // Центрируем холст treemap относительно начала координат.
    return {
      x0: r.x0 - half,
      y0: r.y0 - half,
      x1: r.x1 - half,
      y1: r.y1 - half,
    };
  });
}

/** Высота из устаревания: чем старше mtime, тем выше (канал «устаревание»). */
function heightFromMtime(mtime: number, nowSeconds: number): number {
  const age = Math.max(0, nowSeconds - mtime);
  const t = Math.min(1, age / MAX_AGE_SECONDS);
  return MIN_HEIGHT + t * (MAX_HEIGHT - MIN_HEIGHT);
}

/**
 * Заполнить контейнер сцены городом по данным уровня. Предыдущее содержимое
 * очищается с явным освобождением geometry/material (без утечек GPU при смене
 * уровня — docs §5.5). Узлы уровня рисуются одним `InstancedMesh`.
 *
 * В `userData.nodes` инстанс-меша кладётся массив узлов в порядке инстансов —
 * мост `instanceId → ScanNode` для будущего пикинга (фаза 1, взаимодействие).
 */
export function buildCity(content: Group, nodes: ScanNode[]): void {
  clearCity(content);
  if (nodes.length === 0) return;

  // Земля под городом — нейтральный тинт, чтобы город «стоял» на плоскости.
  const ground = new Mesh(
    new PlaneGeometry(CITY_SPAN * 1.1, CITY_SPAN * 1.1),
    new MeshLambertMaterial({ color: new Color(GROUND_COLOR) }),
  );
  ground.rotation.x = -Math.PI / 2; // в плоскость XZ
  ground.position.y = -0.01; // чуть ниже основания зданий
  content.add(ground);

  const rects = layoutNodes(nodes);
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Единичный бокс (центр в начале), масштабируем/двигаем матрицей инстанса.
  const geometry = new BoxGeometry(1, 1, 1);
  const material = new MeshLambertMaterial();
  const mesh = new InstancedMesh(geometry, material, nodes.length);

  const dummy = new Object3D();
  const color = new Color();
  nodes.forEach((node, i) => {
    const height = heightFromMtime(node.mtime, nowSeconds);
    const box = layoutToWorld(rects[i], height);

    dummy.position.set(box.centerX, box.height / 2, box.centerZ);
    dummy.scale.set(box.width, box.height, box.depth);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, color.set(CATEGORY_COLOR[node.category]));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  // Мост для пикинга: индекс инстанса → узел.
  mesh.userData.nodes = nodes;
  content.add(mesh);
}

/**
 * Текущий `InstancedMesh` уровня (город зданий) внутри контейнера, либо `null`.
 * Слой взаимодействия берёт через него raycast и `userData.nodes` (мост
 * `instanceId → ScanNode`). Земля — обычный `Mesh`, поэтому фильтруем по типу.
 */
export function getCityMesh(content: Group): InstancedMesh | null {
  for (const child of content.children) {
    if (child instanceof InstancedMesh) return child;
  }
  return null;
}

/** Очистить город, освободив GPU-ресурсы (geometry/material обоих типов мешей). */
export function clearCity(content: Group): void {
  for (const child of [...content.children]) {
    content.remove(child);
    if (child instanceof InstancedMesh || child instanceof Mesh) {
      child.geometry.dispose();
      const mat = child.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
  }
}
