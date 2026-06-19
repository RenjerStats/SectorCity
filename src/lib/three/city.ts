/**
 * Построение «города» одного уровня из данных (фаза 0).
 *
 * Берёт `ScanNode[]`, раскладывает их детерминированной раскладкой и строит
 * боксы через единый модуль координат `layoutToWorld`. Кодирование (черновое
 * для фазы 0): площадь основания ∝ размер, высота ∝ устаревание (mtime),
 * цвет = категория. Настоящий squarified-treemap и InstancedMesh — фаза 1+.
 *
 * Раскладка детерминирована: один и тот же вход даёт ту же геометрию
 * (пространственная память, см. ТЗ).
 */
import { BoxGeometry, Color, Group, Mesh, MeshLambertMaterial } from "three";
import type { Category, ScanNode } from "../ipc/contract";
import { layoutToWorld, type TreemapRect } from "./layoutToWorld";

/** Палитра по категориям (черновая, colorblind-aware уточним в фазе 2). */
const CATEGORY_COLOR: Record<Category, number> = {
  code: 0x4e79a7,
  document: 0xf28e2b,
  image: 0x59a14f,
  video: 0xe15759,
  audio: 0xb07aa1,
  archive: 0xedc948,
  binary: 0x76b7b2,
  other: 0x8a8f98,
};

/** Целевой размах города по стороне, мировые единицы. */
const CITY_SPAN = 200;
/** Диапазон высоты здания (устаревание), мировые единицы. */
const MIN_HEIGHT = 4;
const MAX_HEIGHT = 70;
/** Горизонт «устаревания»: возраст, при котором высота упирается в максимум. */
const MAX_AGE_SECONDS = 3 * 365 * 24 * 3600; // ~3 года

/**
 * Простая детерминированная раскладка: квадраты со стороной ∝ √размер,
 * уложенные строками с переносом. Возвращает прямоугольники в координатах
 * раскладки (y вниз), сцентрированные около начала координат.
 */
function layoutNodes(nodes: ScanNode[]): TreemapRect[] {
  const maxSize = Math.max(1, ...nodes.map((n) => n.size));
  // Масштаб так, чтобы крупнейший узел получил заметную, но не гигантскую долю.
  const scale = (CITY_SPAN * 0.35) / Math.sqrt(maxSize);
  const gap = 4;
  const rowWidth = CITY_SPAN;

  const rects: TreemapRect[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  for (const node of nodes) {
    const side = Math.max(6, Math.sqrt(node.size) * scale);
    if (cursorX > 0 && cursorX + side > rowWidth) {
      cursorX = 0;
      cursorY += rowHeight + gap;
      rowHeight = 0;
    }
    rects.push({
      x0: cursorX,
      y0: cursorY,
      x1: cursorX + side,
      y1: cursorY + side,
    });
    cursorX += side + gap;
    rowHeight = Math.max(rowHeight, side);
  }

  // Центрируем весь набор относительно начала координат.
  const maxX = Math.max(...rects.map((r) => r.x1));
  const maxY = Math.max(...rects.map((r) => r.y1));
  const dx = maxX / 2;
  const dy = maxY / 2;
  return rects.map((r) => ({
    x0: r.x0 - dx,
    y0: r.y0 - dy,
    x1: r.x1 - dx,
    y1: r.y1 - dy,
  }));
}

/** Высота из устаревания: чем старше mtime, тем выше (канал «устаревание»). */
function heightFromMtime(mtime: number, nowSeconds: number): number {
  const age = Math.max(0, nowSeconds - mtime);
  const t = Math.min(1, age / MAX_AGE_SECONDS);
  return MIN_HEIGHT + t * (MAX_HEIGHT - MIN_HEIGHT);
}

/**
 * Заполнить контейнер сцены боксами по данным уровня. Предыдущее содержимое
 * очищается с явным освобождением geometry/material (без утечек GPU при смене
 * уровня — см. docs/SectorCity-tech.md §5).
 */
export function buildCity(content: Group, nodes: ScanNode[]): void {
  clearCity(content);
  if (nodes.length === 0) return;

  const rects = layoutNodes(nodes);
  const nowSeconds = Math.floor(Date.now() / 1000);

  nodes.forEach((node, i) => {
    const height = heightFromMtime(node.mtime, nowSeconds);
    const box = layoutToWorld(rects[i], height);

    const geometry = new BoxGeometry(box.width, box.height, box.depth);
    const material = new MeshLambertMaterial({
      color: new Color(CATEGORY_COLOR[node.category]),
    });
    const mesh = new Mesh(geometry, material);
    // Бокс центрируется по своей высоте → приподнимаем, чтобы стоял на земле.
    mesh.position.set(box.centerX, box.height / 2, box.centerZ);
    mesh.userData.path = node.path; // пригодится для picking в фазе 1
    content.add(mesh);
  });
}

/** Очистить город, освободив GPU-ресурсы. */
export function clearCity(content: Group): void {
  for (const child of [...content.children]) {
    content.remove(child);
    if (child instanceof Mesh) {
      child.geometry.dispose();
      const mat = child.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
  }
}
