/**
 * Тесты графики уровня (`city.ts`): LOD-переключения и фикс окклюзии декора.
 *
 * Three.js-математика матриц работает headless — WebGL не нужен. Видимость
 * инстанса проверяем по его матрице (scale=0 ⇒ скрыт; см. `test-fixtures`).
 *
 * Регрессия, ради которой написан тест: «после drill вся папка — один блок, LOD
 * намертво ломается». Причина была в декоре — силуэт района, ставшего активным
 * уровнем, после `G⁻¹` раздувался в начало координат и накрывал активный город.
 * Фикс: `setDecor(excludePath)` скрывает силуэт именно этого района.
 */
import { describe, expect, it } from "vitest";
import { Color, PerspectiveCamera } from "three";
import { buildLevel, CITY_SPAN } from "./city";
import { DISTRICT_PLOT_COLOR } from "./palette";
import {
  dir,
  file,
  findInstanceAt,
  isHidden,
  matrixAt,
  visibleCount,
} from "./test-fixtures";

const SPAN = { w: CITY_SPAN, d: CITY_SPAN };

/** Корень с двумя районами (есть превью детей) и одним файлом верхнего уровня. */
function rootNodes() {
  return [
    dir("/a", [file("/a/1", 100, "code"), file("/a/2", 60, "image")]),
    dir("/b", [file("/b/1", 80, "document")]),
    file("/c", 30, "archive"),
  ];
}

describe("buildLevel + LOD", () => {
  it("далёкая камера: районы — силуэты, вложенные превью скрыты", () => {
    const level = buildLevel(rootNodes(), SPAN, "root");
    const camera = new PerspectiveCamera();
    camera.position.set(0, 5000, 5000); // далеко от всех районов

    level.view.updateLOD(camera);

    const meshes = level.view.pickMeshes(); // [building, plot, coarse]
    const building = meshes[0];
    const plot = meshes[1];
    const coarse = meshes[2];

    // Оба района видны грубыми силуэтами.
    expect(visibleCount(coarse)).toBe(2);
    // Плоты районов скрыты, пока район далёкий.
    expect(visibleCount(plot)).toBe(0);
    // Из зданий виден только файл верхнего уровня (/c); вложенные превью скрыты.
    expect(visibleCount(building)).toBe(1);

    level.dispose();
  });

  it("камера у района: он раскрывается (силуэт↓, плот↑, вложенные здания↑)", () => {
    const level = buildLevel(rootNodes(), SPAN, "root");
    const coarse = level.view.pickMeshes()[2];
    const building = level.view.pickMeshes()[0];
    const plot = level.view.pickMeshes()[1];

    const pa = level.childPlacement("/a");
    expect(pa).not.toBeNull();
    const idxA = findInstanceAt(coarse, pa!.cx, pa!.cz);
    expect(idxA).not.toBeNull();

    const camera = new PerspectiveCamera();
    camera.position.set(pa!.cx, 10, pa!.cz); // вплотную к району /a

    const buildingsVisibleBefore = visibleCount(building);
    level.view.updateLOD(camera);

    // Силуэт /a погас, плот /a зажёгся.
    expect(isHidden(matrixAt(coarse, idxA!))).toBe(true);
    expect(isHidden(matrixAt(plot, idxA!))).toBe(false);
    // Появились вложенные здания (как минимум превью /a).
    expect(visibleCount(building)).toBeGreaterThan(buildingsVisibleBefore);

    level.dispose();
  });
});

describe("setDecor (фикс окклюзии) / setActive", () => {
  it("setDecor(excludePath) скрывает вложенный район, а прочие папки раскрывает как декор", () => {
    const level = buildLevel(rootNodes(), SPAN, "root");
    const meshes = level.view.pickMeshes();
    const coarse = meshes[2];
    const plot = meshes[1];

    const pa = level.childPlacement("/a")!;
    const pb = level.childPlacement("/b")!;
    const idxA = findInstanceAt(coarse, pa.cx, pa.cz)!;
    const idxB = findInstanceAt(coarse, pb.cx, pb.cz)!;

    level.setDecor("/a");

    // Исключённый район /a (ставший активным) полностью скрыт на всех мешах:
    expect(isHidden(matrixAt(coarse, idxA))).toBe(true);
    expect(isHidden(matrixAt(plot, idxA))).toBe(true);

    // А соседний район /b раскрыт (силуэт скрыт, но plot виден):
    expect(isHidden(matrixAt(coarse, idxB))).toBe(true);
    expect(isHidden(matrixAt(plot, idxB))).toBe(false);

    // Декор не кликабелен.
    expect(level.view.pickMeshes()).toEqual([]);

    level.dispose();
  });

  it("setActive возвращает все силуэты и пикинг", () => {
    const level = buildLevel(rootNodes(), SPAN, "root");
    const coarse = level.view.pickMeshes()[2];
    const pa = level.childPlacement("/a")!;
    const idxA = findInstanceAt(coarse, pa.cx, pa.cz)!;

    level.setDecor("/a");
    expect(isHidden(matrixAt(coarse, idxA))).toBe(true);

    level.setActive();
    // Силуэт /a снова в игре (LOD пересчитает по камере), пикинг доступен.
    expect(isHidden(matrixAt(coarse, idxA))).toBe(false);
    expect(level.view.pickMeshes().length).toBeGreaterThan(0);

    level.dispose();
  });

  it("папки на превью (depth 2) окрашиваются в DISTRICT_PLOT_COLOR", () => {
    const nodes = [
      dir("/a", [
        dir("/a/sub", [file("/a/sub/1", 100, "code")])
      ])
    ];
    const level = buildLevel(nodes, SPAN, "root");
    const building = level.view.pickMeshes()[0]; // buildingMesh

    let subIdx: number | null = null;
    for (let i = 0; i < building.count; i++) {
      const info = level.view.resolvePick(building, i);
      if (info && info.node.path === "/a/sub") {
        subIdx = i;
        break;
      }
    }
    expect(subIdx).not.toBeNull();

    const col = new Color();
    building.getColorAt(subIdx!, col);
    expect(col.getHex()).toBe(DISTRICT_PLOT_COLOR);
    level.dispose();
  });

  it("в режиме decor buildingMesh и plotMesh остаются видимыми, но приглушаются цветом (не полупрозрачные)", () => {
    const level = buildLevel(rootNodes(), SPAN, "root");
    const meshes = level.view.pickMeshes();
    const building = meshes[0];
    const plot = meshes[1];

    level.setDecor("/a");

    expect(building.visible).toBe(true);
    expect(plot.visible).toBe(true);

    const buildMat = building.material as any;
    expect(buildMat.transparent).toBe(false);
    expect(buildMat.color.r).toBeCloseTo(0.35);
    expect(buildMat.color.g).toBeCloseTo(0.35);
    expect(buildMat.color.b).toBeCloseTo(0.35);

    const plotMat = plot.material as any;
    expect(plotMat.transparent).toBe(false);
    const expectedPlotColor = new Color(DISTRICT_PLOT_COLOR).multiplyScalar(0.35);
    expect(plotMat.color.r).toBeCloseTo(expectedPlotColor.r);
    expect(plotMat.color.g).toBeCloseTo(expectedPlotColor.g);
    expect(plotMat.color.b).toBeCloseTo(expectedPlotColor.b);

    level.dispose();
  });
});

