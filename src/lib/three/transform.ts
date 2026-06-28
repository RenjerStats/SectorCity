/**
 * Чистая математика origin shift (floating origin) для бесшовной навигации.
 *
 * Размещение уровня в прямоугольник района — similarity `G(local)=s·local+C`
 * (равномерный масштаб `s`, сдвиг `C=(cx,cy,cz)`). `cx/cz` — центр прямоугольника;
 * `cy` — Y-отметка пола содержимого района (верх его плиты-постамента). Ненулевой
 * `cy` делает drill бесшовным ПО ВЕРТИКАЛИ: активный уровень (пол `y=0`) под `G`
 * встаёт ровно на своё превью (которое сидит на плите, т.е. на высоте `cy`), а декор
 * под `G⁻¹` опускается на стопку плит ступенями вниз — «слоёный пирог» (план §8).
 * Эти функции — единственный источник правды по `G`/`G⁻¹`; навигатор только применяет
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

/** Прямое `G(v)=s·v+C` (C=(cx,cy,cz)): канонический локал → мир родителя. */
export function forwardG(v: Vector3, p: Placement): Vector3 {
  return new Vector3(v.x * p.s + p.cx, v.y * p.s + p.cy, v.z * p.s + p.cz);
}

/** Обратное `G⁻¹(v)=(v−C)/s`: мир родителя → канонический локал. */
export function inverseG(v: Vector3, p: Placement): Vector3 {
  return new Vector3(
    (v.x - p.cx) / p.s,
    (v.y - p.cy) / p.s,
    (v.z - p.cz) / p.s,
  );
}

/**
 * Подобие декор-слоя: `world = scale·local + position` (равномерный масштаб, без
 * вращений). Это накопленный трансформ слоя в стеке декораций (`navigator.ts`):
 * у активного уровня — identity, у каждого декора — композиция `G`/`G⁻¹` всех
 * drill/up, через которые он прошёл. `scale` слоя — это и его кумулятивный `S_k`
 * («во сколько раз контент слоя показан крупнее активного», см. план §3.2).
 */
export interface LayerTransform {
  scale: number;
  position: Vector3;
}

/** Тождественное подобие (активный уровень): `world = local`. */
export function identityTransform(): LayerTransform {
  return { scale: 1, position: new Vector3(0, 0, 0) };
}

/**
 * Drill: композиция `G⁻¹` поверх слоя (план §3.1). Вошли в ребёнка с размещением
 * `g`, центр `C=(cx,cy,cz)` — весь стек получает `R(T)=(σ/s, (p−C)/s)`. Масштаб
 * слоя растёт ×(1/s): контекст «раздувается» вокруг по мере углубления, а ненулевой
 * `cy` опускает его по Y (стопка плит вниз — слоёный пирог, план §8).
 */
export function composeInverse(
  g: Placement,
  t: LayerTransform,
): LayerTransform {
  return {
    scale: t.scale / g.s,
    position: new Vector3(
      (t.position.x - g.cx) / g.s,
      (t.position.y - g.cy) / g.s,
      (t.position.z - g.cz) / g.s,
    ),
  };
}

/**
 * Up: композиция `G` поверх слоя (план §3.1) — ровно обратное `composeInverse`.
 * Вышли к родителю с тем же `g` — весь стек получает `U(T)=(s·σ, s·p+C)`. Слой,
 * бывший ближайшим декором (`1/s, −C/s`), снова становится identity.
 */
export function composeForward(
  g: Placement,
  t: LayerTransform,
): LayerTransform {
  return {
    scale: t.scale * g.s,
    position: new Vector3(
      t.position.x * g.s + g.cx,
      t.position.y * g.s + g.cy,
      t.position.z * g.s + g.cz,
    ),
  };
}

/**
 * Трансформ группы, реализующий `G⁻¹` для уровня, бывшего в identity: scale `1/s`,
 * position `−C/s`. Частный случай `composeInverse(g, identity)` — старый активный,
 * становящийся ближайшим декором (`decorStack[0]`).
 */
export function inverseGroupTransform(p: Placement): LayerTransform {
  return composeInverse(p, identityTransform());
}

/**
 * Трансформ ПРЕДКА из трансформа его ребёнка (`up`-дочит дальнего слоя, план §6).
 * Если ребёнок `C` показан подобием `t = T_C`, а в предке `P` он лежит на месте `g`
 * (`g = P.childPlacement(C.path)`), то по инварианту стека `T_C = T_P ∘ g`, откуда
 * `T_P = T_C ∘ g⁻¹` — компонуем `g⁻¹` ИЗНУТРИ (со стороны локала), в отличие от
 * `composeInverse` (та клеит `G⁻¹` снаружи, со стороны мира). Так дочитанный дед
 * встаёт ровно на продолжение цепочки: `S_P = S_C/s` (ещё крупнее, дальше на фон).
 */
export function composeChildInverse(
  g: Placement,
  t: LayerTransform,
): LayerTransform {
  return {
    scale: t.scale / g.s,
    position: new Vector3(
      t.position.x - (t.scale * g.cx) / g.s,
      t.position.y - (t.scale * g.cy) / g.s,
      t.position.z - (t.scale * g.cz) / g.s,
    ),
  };
}
