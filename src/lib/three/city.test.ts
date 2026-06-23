/**
 * Тесты графики уровня (`city.ts`): папки-купола, детализация по глубине и фикс
 * окклюзии декора (vision §II.3).
 *
 * Three.js-математика матриц работает headless — WebGL не нужен. Видимость
 * инстанса проверяем по его матрице (scale=0 ⇒ скрыт; см. `test-fixtures`).
 *
 * Модель: дистанционного LOD больше нет — детализация задаётся ГЛУБИНОЙ. Прямые
 * дети текущей папки (+1) рисуются полноценными куполами с реальной застройкой
 * ВСЕГДА (камера на облик не влияет). Регрессия, ради которой жив тест декора:
 * «после drill вся папка — один блок» — купол района, ставшего активным уровнем,
 * после `G⁻¹` раздувался в начало координат и накрывал активный город; фикс —
 * `setDecor(excludePath)` скрывает именно этот купол и его застройку.
 */
import { describe, expect, it } from "vitest";
import { Color, PerspectiveCamera } from "three";
import { buildLevel, CITY_SPAN, DIM_FACTOR } from "./city";
import { CATEGORY_COLOR } from "./palette";
import {
  dir,
  file,
  findInstanceAt,
  isHidden,
  matrixAt,
  visibleCount,
} from "./test-fixtures";

const SPAN = { w: CITY_SPAN, d: CITY_SPAN };

/** Корень с двумя папками (+1, есть превью детей) и одним файлом верхнего уровня. */
function rootNodes() {
  return [
    dir("/a", [file("/a/1", 100, "code"), file("/a/2", 60, "image")]),
    dir("/b", [file("/b/1", 80, "document")]),
    file("/c", 30, "archive"),
  ];
}

/** Найти инстанс здания по пути узла (через resolvePick). */
function buildingIdxOf(
  level: ReturnType<typeof buildLevel>,
  path: string,
): number | null {
  const building = level.view.pickMeshes()[0];
  for (let i = 0; i < building.count; i++) {
    const info = level.view.resolvePick(building, i);
    if (info && info.node.path === path) return i;
  }
  return null;
}

describe("buildLevel: купола (+1) и детализация по глубине", () => {
  it("прямые папки (+1) — купола; их домики и файлы верхнего уровня видны всегда", () => {
    const level = buildLevel(rootNodes(), SPAN, "root");
    const [building, dome] = level.view.pickMeshes();

    // Два купола-папки (/a, /b).
    expect(dome.count).toBe(2);
    expect(visibleCount(dome)).toBe(2);

    // Здания: /a/1, /a/2 (внутри купола /a), /b/1 (внутри /b), /c (верхний уровень).
    expect(building.count).toBe(4);
    expect(visibleCount(building)).toBe(4);

    // Облик не зависит от камеры (нет дистанционного LOD).
    const camera = new PerspectiveCamera();
    camera.position.set(0, 5000, 5000);
    level.view.updateLOD(camera);
    expect(visibleCount(dome)).toBe(2);
    expect(visibleCount(building)).toBe(4);

    level.dispose();
  });

  it("папка внутри папки (+2) — серые кубы без своей стеклянной оболочки", () => {
    const nodes = [dir("/a", [dir("/a/sub", [file("/a/sub/1", 100, "code")])])];
    const level = buildLevel(nodes, SPAN, "root");
    const meshes = level.view.pickMeshes();

    // Зданий нет (у /a нет файлов-листьев напрямую) → в пикинге только купол +1
    // (/a). У +2 (/a/sub) своей стеклянной оболочки НЕТ — её кубы попадают в
    // transmission-буфер родителя и размываются; пикается +2 через объемлющий +1.
    expect(meshes.length).toBe(1);
    const domeMesh = meshes[0];

    // Виден ровно один купол (/a, +1); /a/sub своего купола не имеет.
    expect(visibleCount(domeMesh)).toBe(1);

    for (let i = 0; i < domeMesh.count; i++) {
      const info = level.view.resolvePick(domeMesh, i);
      if (!info) continue;
      if (info.node.path === "/a") {
        // +1: видим и drill ведёт в себя.
        expect(isHidden(matrixAt(domeMesh, i))).toBe(false);
        expect(info.drillTarget.path).toBe("/a");
      }
      if (info.node.path === "/a/sub") {
        // +2: инстанс купола вырожден (оболочки нет).
        expect(isHidden(matrixAt(domeMesh, i))).toBe(true);
      }
    }

    level.dispose();
  });

  it("пикинг: купол → drill в папку, файл верхнего уровня → select (drillTarget = он сам)", () => {
    const level = buildLevel(rootNodes(), SPAN, "root");
    const dome = level.view.pickMeshes()[1];

    // Купол /a → drill в /a.
    const idxA = findInstanceAt(
      dome,
      level.childPlacement("/a")!.cx,
      level.childPlacement("/a")!.cz,
    );
    expect(idxA).not.toBeNull();
    expect(level.view.resolvePick(dome, idxA!)!.drillTarget.path).toBe("/a");

    // Файл верхнего уровня /c: drillTarget = он сам (не папка → уйдёт в select).
    const cIdx = buildingIdxOf(level, "/c")!;
    const info = level.view.resolvePick(level.view.pickMeshes()[0], cIdx)!;
    expect(info.drillTarget.path).toBe("/c");
    expect(info.drillTarget.isDir).toBe(false);

    // Вложенный домик /a/1: drillTarget = родительская папка /a.
    const aChild = buildingIdxOf(level, "/a/1")!;
    expect(
      level.view.resolvePick(level.view.pickMeshes()[0], aChild)!.drillTarget
        .path,
    ).toBe("/a");

    level.dispose();
  });
});

describe("setDecor (фикс окклюзии) / setActive", () => {
  it("setDecor(excludePath) скрывает купол и застройку ставшего активным района", () => {
    const level = buildLevel(rootNodes(), SPAN, "root");
    const [building, dome] = level.view.pickMeshes();

    const idxA = findInstanceAt(
      dome,
      level.childPlacement("/a")!.cx,
      level.childPlacement("/a")!.cz,
    )!;
    const idxB = findInstanceAt(
      dome,
      level.childPlacement("/b")!.cx,
      level.childPlacement("/b")!.cz,
    )!;
    const a1 = buildingIdxOf(level, "/a/1")!;

    level.setDecor("/a");

    // Купол /a скрыт, его внутренний домик /a/1 скрыт.
    expect(isHidden(matrixAt(dome, idxA))).toBe(true);
    expect(isHidden(matrixAt(building, a1))).toBe(true);
    // Соседний купол /b остаётся виден (контекст-декор).
    expect(isHidden(matrixAt(dome, idxB))).toBe(false);

    // Декор не кликабелен.
    expect(level.view.pickMeshes()).toEqual([]);

    level.dispose();
  });

  it("setActive возвращает купол и пикинг", () => {
    const level = buildLevel(rootNodes(), SPAN, "root");
    const dome = level.view.pickMeshes()[1];
    const idxA = findInstanceAt(
      dome,
      level.childPlacement("/a")!.cx,
      level.childPlacement("/a")!.cz,
    )!;

    level.setDecor("/a");
    expect(isHidden(matrixAt(dome, idxA))).toBe(true);

    level.setActive();
    expect(isHidden(matrixAt(dome, idxA))).toBe(false);
    expect(level.view.pickMeshes().length).toBeGreaterThan(0);

    level.dispose();
  });

  it("в декоре меши видимы, но material притушен до серого (не полупрозрачны)", () => {
    const level = buildLevel(rootNodes(), SPAN, "root");
    const [building, dome] = level.view.pickMeshes();

    level.setDecor("/a");

    const buildMat = building.material as any;
    expect(buildMat.color.r).toBeCloseTo(0.35);
    const domeMat = dome.material as any;
    expect(domeMat.color.r).toBeCloseTo(0.35);

    level.dispose();
  });

  it("setHighlight: несовпадающие здания гаснут, совпадающие — в полном цвете", () => {
    const level = buildLevel(rootNodes(), SPAN, "root");
    const building = level.view.pickMeshes()[0];

    const cIdx = buildingIdxOf(level, "/c")!; // файл верхнего уровня (archive)
    const aChildIdx = buildingIdxOf(level, "/a/1")!; // вложенный домик (code)

    // Подсветить только /c: оно — в полном цвете категории, /a/1 — притушено.
    level.setHighlight((n) => n.path === "/c");
    const col = new Color();
    building.getColorAt(cIdx, col);
    expect(col.getHex()).toBe(CATEGORY_COLOR.archive);
    building.getColorAt(aChildIdx, col);
    const dim = new Color(CATEGORY_COLOR.code).multiplyScalar(DIM_FACTOR);
    expect(col.r).toBeCloseTo(dim.r);
    expect(col.g).toBeCloseTo(dim.g);
    expect(col.b).toBeCloseTo(dim.b);

    // Снятие подсветки возвращает базовый цвет категории.
    level.setHighlight(null);
    building.getColorAt(aChildIdx, col);
    expect(col.getHex()).toBe(CATEGORY_COLOR.code);

    level.dispose();
  });
});
