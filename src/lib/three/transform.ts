/**
 * Чистая математика origin shift (floating origin) для бесшовной навигации.
 *
 * Размещение уровня в прямоугольник района — similarity `G(local)=s·local+C`
 * (равномерный масштаб `s`, сдвиг `C=(cx,0,cz)` — центр прямоугольника). Эти
 * функции — единственный источник правды по `G`/`G⁻¹`; навигатор только применяет
 * их к группам и камере. Вынесены отдельно и без зависимостей от DOM/WebGL —
 * чтобы покрыть тестами (см. `transform.test.ts`).
 */
import { Vector3 } from "three";
import { CITY_SPAN, type LevelSpan, type Placement } from "./city";

/**
 * Каноническая span дочернего уровня из размеров прямоугольника района. Аспект
 * сохраняется, бо́льшая сторона нормируется к `CITY_SPAN` (squarify scale-
 * инвариантен → промоут превью→активный пиксель-в-пиксель).
 */
export function spanFromPlacement(p: Placement): LevelSpan {
  const m = Math.max(p.w, p.d);
  return { w: (p.w / m) * CITY_SPAN, d: (p.d / m) * CITY_SPAN };
}

/** Прямое `G(v)=s·v+C` (C.y=0): канонический локал → мир родителя. */
export function forwardG(v: Vector3, p: Placement): Vector3 {
  return new Vector3(v.x * p.s + p.cx, v.y * p.s, v.z * p.s + p.cz);
}

/** Обратное `G⁻¹(v)=(v−C)/s`: мир родителя → канонический локал. */
export function inverseG(v: Vector3, p: Placement): Vector3 {
  return new Vector3((v.x - p.cx) / p.s, v.y / p.s, (v.z - p.cz) / p.s);
}

/**
 * Трансформ группы, реализующий `G⁻¹` для уровня, бывшего в identity: scale `1/s`,
 * position `−C/s`. Применяется к старому активному, когда он становится декором.
 */
export function inverseGroupTransform(p: Placement): {
  scale: number;
  position: Vector3;
} {
  return {
    scale: 1 / p.s,
    position: new Vector3(-p.cx / p.s, 0, -p.cz / p.s),
  };
}
