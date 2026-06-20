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
  forwardG,
  inverseG,
  inverseGroupTransform,
  spanFromPlacement,
} from "./transform";

/**
 * Несколько размещений: квадрат по центру, смещённый, вытянутые прямоугольники.
 * `s` связан с размерами по контракту `city.ts`: `s = max(w,d)/CITY_SPAN`
 * (footprint района / канонический размах) — иначе промоут превью→активный не
 * пиксель-в-пиксель. Фикстуры соблюдают эту связь (CITY_SPAN = 200).
 */
const placements: Placement[] = [
  { s: 0.5, cx: 0, cz: 0, w: 100, d: 100 },
  { s: 0.25, cx: 37, cz: -52, w: 50, d: 50 },
  { s: 0.4, cx: -80, cz: 12, w: 80, d: 40 },
  { s: 73.2 / CITY_SPAN, cx: 5.5, cz: 99.9, w: 24.6, d: 73.2 },
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

  it("forwardG масштабирует y только на s (C.y = 0)", () => {
    const p = placements[2];
    const v = new Vector3(0, 10, 0);
    expect(forwardG(v, p).y).toBeCloseTo(10 * p.s, 6);
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
