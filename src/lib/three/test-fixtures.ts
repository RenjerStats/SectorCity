/**
 * Синтетические `ScanNode`-деревья и помощники для тестов 3D-слоя.
 *
 * Лежит рядом с тестируемым кодом (не отдельная папка), `*.ts` без `.test` —
 * vitest его не подхватит как набор тестов, но импорт из тестов работает.
 */
import { Matrix4, Vector3, type InstancedMesh } from "three";
import type { Category, ScanNode } from "../ipc/contract";
import { categoryBit } from "../store/mode";

/** Фиксированный «сейчас» эпохи для детерминированных высот в тестах. */
export const FIXED_NOW = 1_700_000_000;

/** Лист-файл: путь, размер, опц. категория (по умолчанию `other`). */
export function file(
  path: string,
  size: number,
  category: Category = "other",
): ScanNode {
  const name = path.split("/").pop() ?? path;
  return {
    path,
    name,
    isDir: false,
    size,
    mtime: FIXED_NOW - 1000,
    atime: FIXED_NOW - 1000,
    childCount: 0,
    category,
    categoryMask: categoryBit(category),
    flags: [],
  };
}

/** Папка-район: путь + дети (размер свёрнут как сумма поддерева). */
export function dir(path: string, children: ScanNode[]): ScanNode {
  const name = path.split("/").pop() ?? path;
  const size = children.reduce((s, c) => s + c.size, 0);
  return {
    path,
    name,
    isDir: true,
    size,
    mtime: FIXED_NOW - 1000,
    atime: FIXED_NOW - 1000,
    childCount: children.length,
    category: "other",
    // Маска папки = объединение масок детей (как считает бэк снизу вверх).
    categoryMask: children.reduce((m, c) => m | c.categoryMask, 0),
    flags: [],
    children,
  };
}

/** Инстанс скрыт (вырожденная матрица scale=0) — не рисуется и не пикается. */
export function isHidden(m: Matrix4): boolean {
  const e = m.elements;
  return e[0] === 0 && e[5] === 0 && e[10] === 0;
}

/** Извлечь матрицу инстанса `i` из меша. */
export function matrixAt(mesh: InstancedMesh, i: number): Matrix4 {
  const m = new Matrix4();
  mesh.getMatrixAt(i, m);
  return m;
}

/** Сколько инстансов меша видимо (не скрыто ZERO_MATRIX). */
export function visibleCount(mesh: InstancedMesh): number {
  let n = 0;
  for (let i = 0; i < mesh.count; i++) {
    if (!isHidden(matrixAt(mesh, i))) n++;
  }
  return n;
}

/** Минимум от `CityView`, нужный помощникам тестов (без импорта типа из city). */
interface ViewLike {
  pickMeshes(): InstancedMesh[];
  resolvePick(
    mesh: InstancedMesh,
    instanceId: number,
  ): { node: ScanNode; drillTarget: ScanNode } | null;
}

/**
 * Меши уровня по ролям. Классификация по первому инстансу: меш ЗДАНИЙ резолвится в
 * файл-лист (`!isDir`, не агрегат), меш-КОНТЕЙНЕР — в папку/агрегат. Зданий несколько
 * (по категории); контейнеры идут стабильным порядком `[dome, base, baseMatte]` (см.
 * `CityView.pickMeshes`). Устойчиво к уровням без папок (контейнеров нет). Применимо к
 * активному облику (в декоре `pickMeshes` пуст — брать меши ДО `setDecor`).
 */
export function pickRoles(view: ViewLike): {
  buildings: InstancedMesh[];
  dome: InstancedMesh;
  base: InstancedMesh;
  baseMatte: InstancedMesh;
} {
  const meshes = view.pickMeshes();
  const buildings: InstancedMesh[] = [];
  const containers: InstancedMesh[] = [];
  for (const m of meshes) {
    const info = m.count > 0 ? view.resolvePick(m, 0) : null;
    const isBuilding =
      !!info && !info.node.isDir && !info.node.flags.includes("aggregated");
    (isBuilding ? buildings : containers).push(m);
  }
  return {
    buildings,
    dome: containers[0],
    base: containers[1],
    baseMatte: containers[2],
  };
}

/** Сумма `count` по нескольким мешам (зданий несколько — по категориям). */
export function sumCount(meshes: InstancedMesh[]): number {
  return meshes.reduce((n, m) => n + m.count, 0);
}

/** Сколько инстансов видимо суммарно по нескольким мешам. */
export function sumVisible(meshes: InstancedMesh[]): number {
  return meshes.reduce((n, m) => n + visibleCount(m), 0);
}

/** Найти (меш + индекс инстанса) здания по пути узла среди категорийных мешей. */
export function findBuilding(
  view: ViewLike,
  buildings: InstancedMesh[],
  path: string,
): { mesh: InstancedMesh; index: number } | null {
  for (const mesh of buildings) {
    for (let i = 0; i < mesh.count; i++) {
      const info = view.resolvePick(mesh, i);
      if (info && info.node.path === path) return { mesh, index: i };
    }
  }
  return null;
}

/**
 * Индекс инстанса с центром основания в (cx, cz) (поиск района по позиции —
 * стабильнее, чем гадать порядок d3-раскладки). `null`, если не нашли.
 */
export function findInstanceAt(
  mesh: InstancedMesh,
  cx: number,
  cz: number,
  eps = 1e-3,
): number | null {
  const pos = new Vector3();
  for (let i = 0; i < mesh.count; i++) {
    pos.setFromMatrixPosition(matrixAt(mesh, i));
    if (Math.abs(pos.x - cx) < eps && Math.abs(pos.z - cz) < eps) return i;
  }
  return null;
}
