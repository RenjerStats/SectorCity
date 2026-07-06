/**
 * Единственное место, где живёт конвенция координат d3 ↔ Three.js.
 * d3-treemap даёт 2D-прямоугольник (y вниз); Three.js — 3D (y вверх).
 *
 * Маппинг:
 *   treemap-x   → world-x
 *   treemap-y   → world-z
 *   размер      → footprint (площадь основания, честный масштаб)
 *   устаревание → world-y (высота здания)
 *
 * Любой перевод раскладки в мир идёт через эти функции — больше нигде
 * не пересчитываем оси вручную.
 */

/** Прямоугольник из d3-hierarchy (treemap): левый-верхний и правый-нижний углы. */
export interface TreemapRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Параллелепипед здания в мировых координатах Three.js. */
export interface WorldBox {
  /** Центр основания. */
  centerX: number;
  centerZ: number;
  /** Размеры основания. */
  width: number;
  depth: number;
  /** Высота (кодирует устаревание). */
  height: number;
}

/**
 * Перевод прямоугольника раскладки + высоты в мировой бокс.
 * `height` рассчитывается отдельно из mtime/atime вызывающей стороной
 * (канал «устаревание»), сюда приходит уже готовым.
 */
export function layoutToWorld(rect: TreemapRect, height: number): WorldBox {
  const width = rect.x1 - rect.x0;
  const depth = rect.y1 - rect.y0;
  return {
    centerX: rect.x0 + width / 2,
    centerZ: rect.y0 + depth / 2,
    width,
    depth,
    height,
  };
}
