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
import { buildLevel, CITY_SPAN, DIM_FACTOR, PREVIEW_MAX_DEPTH } from "./city";
import { spanFromPlacement } from "./transform";
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

  it("вложенные папки — плиты-постаменты: металл на +1/+2, матовая на +3; стекло только у +1", () => {
    // /a (+1) → /a/sub (+2, есть файл /a/sub/f) → /a/sub/deep (+3, содержимое глубже
    // среза превью → пустая матовая плита).
    const nodes = [
      dir("/a", [
        dir("/a/sub", [
          file("/a/sub/f", 100, "code"),
          dir("/a/sub/deep", [file("/a/sub/deep/x", 50, "image")]),
        ]),
      ]),
    ];
    const level = buildLevel(nodes, SPAN, "root");
    const [building, domeMesh, baseMesh, baseMatteMesh] =
      level.view.pickMeshes();

    // Стекло — только у +1 (/a).
    expect(visibleCount(domeMesh)).toBe(1);
    // Металлические плиты: /a (+1) и /a/sub (+2).
    expect(visibleCount(baseMesh)).toBe(2);
    // Матовая плита: /a/sub/deep (+3).
    expect(visibleCount(baseMatteMesh)).toBe(1);
    // Файл /a/sub/f — реальная застройка внутри /a/sub.
    expect(visibleCount(building)).toBe(1);

    // +1 (/a): купол виден, drill в себя; у вложенных папок стекла нет (вырождено).
    for (let i = 0; i < domeMesh.count; i++) {
      const info = level.view.resolvePick(domeMesh, i);
      if (!info) continue;
      if (info.node.path === "/a") {
        expect(isHidden(matrixAt(domeMesh, i))).toBe(false);
        expect(info.drillTarget.path).toBe("/a");
      } else {
        expect(isHidden(matrixAt(domeMesh, i))).toBe(true);
      }
    }

    // Матовая плита /a/sub/deep (+3): пикается в себя, drill — за один шаг в +1 (/a).
    let matteHit = false;
    for (let i = 0; i < baseMatteMesh.count; i++) {
      const info = level.view.resolvePick(baseMatteMesh, i);
      if (info && !isHidden(matrixAt(baseMatteMesh, i))) {
        expect(info.node.path).toBe("/a/sub/deep");
        expect(info.drillTarget.path).toBe("/a");
        matteHit = true;
      }
    }
    expect(matteHit).toBe(true);

    // Металлическая плита /a/sub (+2): пикается в себя, drill — в +1 (/a).
    let subHit = false;
    for (let i = 0; i < baseMesh.count; i++) {
      const info = level.view.resolvePick(baseMesh, i);
      if (info && info.node.path === "/a/sub") {
        expect(isHidden(matrixAt(baseMesh, i))).toBe(false);
        expect(info.drillTarget.path).toBe("/a");
        subHit = true;
      }
    }
    expect(subHit).toBe(true);

    level.dispose();
  });

  it("содержимое папки стоит на её плите, а не на земле (нет проваливания)", () => {
    // /a (+1) → /a/sub (+2) с файлом. Низ домика /a/sub/f должен быть на верхней
    // грани плиты /a/sub (которая сама стоит на плите /a), а не в нуле.
    const nodes = [dir("/a", [dir("/a/sub", [file("/a/sub/f", 100, "code")])])];
    const level = buildLevel(nodes, SPAN, "root");
    const [building] = level.view.pickMeshes();

    const fi = buildingIdxOf(level, "/a/sub/f")!;
    const m = matrixAt(building, fi);
    // Элементы матрицы (column-major): scale.y = m[5], translate.y = m[13].
    const scaleY = m.elements[5];
    const posY = m.elements[13];
    const bottom = posY - scaleY / 2;
    // Низ домика приподнят над землёй на стопку плит (+1 и +2) — заведомо > 0.
    expect(bottom).toBeGreaterThan(1);

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

describe("превью района = он же как активный уровень (drill не меняет форму)", () => {
  // Регрессия: абсолютный padding d3 запекался во вход squarify, и на разном
  // масштабе (превью под стеклом ↔ активный уровень после drill) тот же район
  // получал РАЗНУЮ партицию → папки «переворачивались»/меняли форму при drill.
  // Теперь партиция считается без padding, зазоры наносятся косметически долей
  // размера (аспект сохраняется), поэтому ориентация и аспект каждой под-папки
  // совпадают в превью и после drill — drill стал честным подобием.

  /** Footprint (w, d) и центр основания (cx, cz) здания по пути, из матрицы. */
  function buildingWD(
    level: ReturnType<typeof buildLevel>,
    path: string,
  ): { w: number; d: number; cx: number; cz: number } | null {
    const mesh = level.view.pickMeshes()[0]; // buildingMesh — первый
    for (let i = 0; i < mesh.count; i++) {
      const info = level.view.resolvePick(mesh, i);
      if (info && info.node.path === path) {
        const e = matrixAt(mesh, i).elements;
        // scale.x/scale.z (диагональ) + позиция (e12/e14) — здания не повёрнуты.
        return { w: e[0], d: e[10], cx: e[12], cz: e[14] };
      }
    }
    return null;
  }

  it("ориентация и аспект под-папок совпадают до и после drill", () => {
    // Конфигурация-аналог D:\\Media\\AnakinGame: большой Robe + три поменьше.
    // Одиночный лист в каждой под-папке заполняет её footprint → его форма = форме
    // папки, удобно сравнивать через здания.
    const sub = (p: string, n: number) =>
      dir(p, [file(`${p}/leaf`, n, "code")]);
    const kids = () => [
      sub("/g/robe", 5200),
      sub("/g/models", 1600),
      sub("/g/textures", 1400),
      sub("/g/audio", 900),
    ];

    // Превью: район /g внутри уровня (под стеклом, дети — глубина +2/+3).
    const preview = buildLevel(
      [dir("/g", kids()), dir("/h", [file("/h/x", 9000, "image")])],
      SPAN,
      "root",
    );
    // Drill: те же дети /g как самостоятельный активный уровень — ровно так, как
    // строит навигатор (span из childPlacement, см. navigator.drill).
    const g = preview.childPlacement("/g")!;
    expect(g).not.toBeNull();
    const drilled = buildLevel(kids(), spanFromPlacement(g), "/g");

    for (const leaf of [
      "/g/robe/leaf",
      "/g/models/leaf",
      "/g/textures/leaf",
      "/g/audio/leaf",
    ]) {
      const p = buildingWD(preview, leaf)!;
      const d = buildingWD(drilled, leaf)!;
      expect(p).not.toBeNull();
      expect(d).not.toBeNull();
      // Ориентация (альбом/портрет) обязана совпасть — это и был баг.
      expect(p.w >= p.d).toBe(d.w >= d.d);
      // И аспект: партиция одна, косметический зазор аспект не трогает.
      const arP = Math.max(p.w, p.d) / Math.min(p.w, p.d);
      const arD = Math.max(d.w, d.d) / Math.min(d.w, d.d);
      expect(arP).toBeCloseTo(arD, 4);
      // Бесшовность: при ЕДИНОЙ доле-зазоре превью района = он же как активный
      // уровень, уменьшенный подобием `g.s`. Значит footprint каждого дома в превью
      // = `g.s` × footprint после drill (зазор не меняет класс +2→+1, нет «сжатия»).
      expect(p.w / d.w).toBeCloseTo(g.s, 4);
      expect(p.d / d.d).toBeCloseTo(g.s, 4);
      // И ПОЗИЦИЯ: drill — это `G⁻¹` (навигатор), т.е. дом после drill стоит ровно в
      // `(превью − C)/s`. Если и размер, и позиция сходятся — раскладка бесшовна
      // попиксельно (а видимое «стягивание» — уже не геометрия, а рендер/стекло).
      expect((p.cx - g.cx) / g.s).toBeCloseTo(d.cx, 3);
      expect((p.cz - g.cz) / g.s).toBeCloseTo(d.cz, 3);
    }

    preview.dispose();
    drilled.dispose();
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

  it("декор-LOD по бюджету: инстансы глубже b скрыты, возврат бюджета обратим (план §4)", () => {
    // /a(+1) → /a/sub(+2, файл /a/sub/f) → /a/sub/deep(+3, матовая плита-лист).
    const nodes = [
      dir("/a", [
        dir("/a/sub", [
          file("/a/sub/f", 100, "code"),
          dir("/a/sub/deep", [file("/a/sub/deep/x", 50, "image")]),
        ]),
      ]),
    ];
    const level = buildLevel(nodes, SPAN, "root");
    const [building, dome, baseMesh, baseMatte] = level.view.pickMeshes();

    // budget=2: глубина 3 скрыта (матовая плита /a/sub/deep и файл /a/sub/f), 1–2 видны.
    level.setDecor(undefined, 2);
    expect(visibleCount(baseMatte)).toBe(0); // /a/sub/deep (d3=3)
    expect(visibleCount(building)).toBe(0); // /a/sub/f (d3=3)
    expect(visibleCount(dome)).toBe(1); // /a (d3=1)
    expect(visibleCount(baseMesh)).toBe(2); // /a, /a/sub (d3 1,2)

    // budget=1: остаётся только +1 (/a).
    level.setDecorBudget(1);
    expect(visibleCount(baseMesh)).toBe(1);
    expect(visibleCount(dome)).toBe(1);

    // Возврат бюджета — un-hide без ребилда.
    level.setDecorBudget(3);
    expect(visibleCount(baseMatte)).toBe(1);
    expect(visibleCount(building)).toBe(1);
    expect(visibleCount(baseMesh)).toBe(2);

    // setActive восстанавливает полный облик и пикинг.
    level.setActive();
    expect(level.view.pickMeshes().length).toBeGreaterThan(0);
    expect(visibleCount(building)).toBe(1);

    level.dispose();
  });

  it("плита дрилл-района остаётся видимой (на неё садится активный, §8)", () => {
    const level = buildLevel(rootNodes(), SPAN, "root");
    // [building, dome, base, baseMatte] — меши держим ДО setDecor (декор не пикается).
    const [building, dome, baseMesh] = level.view.pickMeshes();
    const idxA = findInstanceAt(
      baseMesh,
      level.childPlacement("/a")!.cx,
      level.childPlacement("/a")!.cz,
    )!;
    const domeA = findInstanceAt(
      dome,
      level.childPlacement("/a")!.cx,
      level.childPlacement("/a")!.cz,
    )!;
    const a1 = buildingIdxOf(level, "/a/1")!;
    const canonical = matrixAt(baseMesh, idxA).elements.slice(); // плита как у активного

    level.setDecor("/a");

    // Плита /a остаётся на КАНОНИЧЕСКОМ месте (вертикальный сдвиг даёт трансформ группы
    // через `cy`, не репозиция инстанса) — на неё «садится» активный уровень.
    const m = matrixAt(baseMesh, idxA);
    expect(isHidden(m)).toBe(false);
    expect(m.elements.slice()).toEqual(canonical);
    const top = m.elements[13] + m.elements[5] / 2; // верх плиты в ЛОКАЛЕ уровня
    expect(top).toBeCloseTo(level.childPlacement("/a")!.cy, 6); // = contentFloor (cy)

    // Купол и застройка /a скрыты (их несёт активный уровень).
    expect(isHidden(matrixAt(dome, domeA))).toBe(true);
    expect(isHidden(matrixAt(building, a1))).toBe(true);

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

  it("setDecor(dim) + setDecorDim: градиент затемнения, перекраска без матриц (§7.1)", () => {
    const level = buildLevel(rootNodes(), SPAN, "root");
    const [building, dome] = level.view.pickMeshes();

    // Полный цвет (dim=1) — material белый, виден per-instance цвет (как у активного).
    level.setDecor(undefined, PREVIEW_MAX_DEPTH, 1);
    expect((building.material as any).color.r).toBeCloseTo(1);
    expect((dome.material as any).color.r).toBeCloseTo(1);

    // Снимок матриц до фейда — setDecorDim меняет ТОЛЬКО цвет, геометрию не трогает.
    const before = matrixAt(building, 0).elements.slice();
    level.setDecorDim(0.5);
    expect((building.material as any).color.r).toBeCloseTo(0.5);
    expect((dome.material as any).color.r).toBeCloseTo(0.5);
    expect(matrixAt(building, 0).elements.slice()).toEqual(before);

    // Вне декора setDecorDim — no-op.
    level.setActive();
    level.setDecorDim(0.2);
    expect((building.material as any).color.r).toBeCloseTo(1); // активный — белый

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
