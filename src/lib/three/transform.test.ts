/**
 * Тесты математики origin shift (`transform.ts`). Чистые функции, без DOM/WebGL.
 *
 * Главный инвариант UX: размещение уровня в район — similarity `G`, и `G⁻¹∘G = id`.
 * Если он ломается, превью «промоутится» не пиксель-в-пиксель → шов на drill/up.
 */
import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { CITY_SPAN, type Placement } from "./city";
import {
  composeChildInverse,
  composeForward,
  composeInverse,
  forwardG,
  identityTransform,
  inverseG,
  inverseGroupTransform,
  type LayerTransform,
  spanFromPlacement,
} from "./transform";

/** Применить подобие-слой `t` к точке: world = t.scale·v + t.position. */
function applyLayer(t: LayerTransform, v: Vector3): Vector3 {
  return new Vector3(
    t.scale * v.x + t.position.x,
    t.scale * v.y + t.position.y,
    t.scale * v.z + t.position.z,
  );
}

/**
 * Несколько размещений: квадрат по центру, смещённый, вытянутые прямоугольники.
 * `s` связан с размерами по контракту `city.ts`: `s = max(w,d)/CITY_SPAN`
 * (footprint района / канонический размах) — иначе промоут превью→активный не
 * пиксель-в-пиксель. Фикстуры соблюдают эту связь (CITY_SPAN = 200).
 */
const placements: Placement[] = [
  { s: 0.5, cx: 0, cy: 0, cz: 0, w: 100, d: 100 },
  { s: 0.25, cx: 37, cy: 2.2, cz: -52, w: 50, d: 50 },
  { s: 0.4, cx: -80, cy: 1.1, cz: 12, w: 80, d: 40 },
  { s: 73.2 / CITY_SPAN, cx: 5.5, cy: 3.3, cz: 99.9, w: 24.6, d: 73.2 },
];

const samples: Vector3[] = [
  new Vector3(0, 0, 0),
  new Vector3(1, 2, 3),
  new Vector3(-40, 140, 180),
  new Vector3(99.9, -3.3, -77.7),
];

describe("forwardG / inverseG", () => {
  it("inverseG отменяет forwardG (G⁻¹∘G = id)", () => {
    for (const p of placements) {
      for (const v of samples) {
        const back = inverseG(forwardG(v, p), p);
        expect(back.x).toBeCloseTo(v.x, 6);
        expect(back.y).toBeCloseTo(v.y, 6);
        expect(back.z).toBeCloseTo(v.z, 6);
      }
    }
  });

  it("forwardG по Y: y·s + cy (вертикальный шов §8)", () => {
    const p = placements[2];
    const v = new Vector3(0, 10, 0);
    expect(forwardG(v, p).y).toBeCloseTo(10 * p.s + p.cy, 6);
    // Пол активного (y=0) под `G` садится ровно на `cy` (верх плиты района) —
    // отсюда бесшовность по вертикали и стопка плит вниз в декоре.
    expect(forwardG(new Vector3(0, 0, 0), p).y).toBeCloseTo(p.cy, 6);
  });

  it("forwardG переносит центр района в C", () => {
    const p = placements[1];
    const c = forwardG(new Vector3(0, 0, 0), p);
    expect(c.x).toBeCloseTo(p.cx, 6);
    expect(c.z).toBeCloseTo(p.cz, 6);
  });
});

describe("spanFromPlacement", () => {
  it("сохраняет аспект и нормирует бо́льшую сторону к CITY_SPAN", () => {
    for (const p of placements) {
      const span = spanFromPlacement(p);
      expect(Math.max(span.w, span.d)).toBeCloseTo(CITY_SPAN, 6);
      // аспект тот же, что у прямоугольника района
      expect(span.w / span.d).toBeCloseTo(p.w / p.d, 6);
    }
  });

  it("канонический размах × s ≈ реальная сторона района", () => {
    // s = max(w,d)/CITY_SPAN, поэтому span * s возвращает исходные стороны.
    for (const p of placements) {
      const span = spanFromPlacement(p);
      expect(span.w * p.s).toBeCloseTo(p.w, 6);
      expect(span.d * p.s).toBeCloseTo(p.d, 6);
    }
  });
});

describe("composeInverse / composeForward (стек декораций, план §3.1)", () => {
  const layers: LayerTransform[] = [
    identityTransform(),
    { scale: 2, position: new Vector3(10, 0, -4) },
    { scale: 0.7, position: new Vector3(-3, 5, 8) },
  ];

  it("composeForward отменяет composeInverse (U∘R = id)", () => {
    for (const g of placements) {
      for (const t of layers) {
        const back = composeForward(g, composeInverse(g, t));
        expect(back.scale).toBeCloseTo(t.scale, 6);
        expect(back.position.x).toBeCloseTo(t.position.x, 6);
        expect(back.position.y).toBeCloseTo(t.position.y, 6);
        expect(back.position.z).toBeCloseTo(t.position.z, 6);
      }
    }
  });

  it("composeInverse(g, identity) = inverseGroupTransform(g) (старый active → decor[0])", () => {
    for (const g of placements) {
      const a = composeInverse(g, identityTransform());
      const b = inverseGroupTransform(g);
      expect(a.scale).toBeCloseTo(b.scale, 6);
      expect(a.position.x).toBeCloseTo(b.position.x, 6);
      expect(a.position.y).toBeCloseTo(b.position.y, 6);
      expect(a.position.z).toBeCloseTo(b.position.z, 6);
    }
  });

  it("S_k после серии drill = ∏(1/s) (кумулятивный масштаб слоя, §3.2)", () => {
    // Начинаем с identity (активный), последовательно дриллим — слой раздувается.
    let t = identityTransform();
    let prod = 1;
    for (const g of placements) {
      t = composeInverse(g, t);
      prod *= 1 / g.s;
      expect(t.scale).toBeCloseTo(prod, 6);
    }
    // И обратный путь возвращает identity (scale → 1).
    for (let i = placements.length - 1; i >= 0; i--) {
      t = composeForward(placements[i], t);
    }
    expect(t.scale).toBeCloseTo(1, 6);
    expect(t.position.x).toBeCloseTo(0, 6);
    expect(t.position.z).toBeCloseTo(0, 6);
  });
});

describe("inverseGroupTransform", () => {
  it("совпадает с inverseG покомпонентно (трансформ группы = G⁻¹)", () => {
    for (const p of placements) {
      const t = inverseGroupTransform(p);
      expect(t.scale).toBeCloseTo(1 / p.s, 6);
      // Группа в identity, к которой применили этот трансформ, переводит
      // канонический локал v в мир так же, как inverseG(v) переводит обратно:
      // здесь проверяем, что позиция группы = G⁻¹(0).
      const originBack = inverseG(new Vector3(0, 0, 0), p);
      expect(t.position.x).toBeCloseTo(originBack.x, 6);
      expect(t.position.y).toBeCloseTo(originBack.y, 6);
      expect(t.position.z).toBeCloseTo(originBack.z, 6);
    }
  });
});

describe("composeChildInverse (дочит предка на up, план §6)", () => {
  it("инвариант стека: T_child = T_parent ∘ g (предок продолжает цепочку)", () => {
    // Берём произвольный трансформ ребёнка и размещение g ребёнка в предке. Тогда
    // предок T_P = composeChildInverse(g, T_child) обязан переводить точку g(v)
    // (локал ребёнка → локал предка) в тот же мир, что и сам ребёнок локалом v.
    const childTransforms: LayerTransform[] = [
      identityTransform(),
      { scale: 2.5, position: new Vector3(7, 0, -3) },
      { scale: 0.8, position: new Vector3(-11, 4, 60) },
    ];
    for (const g of placements) {
      for (const tc of childTransforms) {
        const tp = composeChildInverse(g, tc);
        expect(tp.scale).toBeCloseTo(tc.scale / g.s, 6);
        for (const v of samples) {
          const childWorld = applyLayer(tc, v);
          const parentWorld = applyLayer(tp, forwardG(v, g));
          expect(parentWorld.x).toBeCloseTo(childWorld.x, 4);
          expect(parentWorld.y).toBeCloseTo(childWorld.y, 4);
          expect(parentWorld.z).toBeCloseTo(childWorld.z, 4);
        }
      }
    }
  });
});
