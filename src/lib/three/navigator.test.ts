/**
 * Тесты бесшовной навигации (`navigator.ts`): drill/up + rebase (origin shift).
 *
 * Это ГЛАВНЫЙ регресс-тест бага «после drill LOD намертво ломается»: проверяем,
 * что у активного уровня ПОСЛЕ drill LOD снова реагирует на камеру (далёкая —
 * силуэты, близкая — вложенные здания). Раньше декор накрывал активный уровень и
 * LOD «висел».
 *
 * Сцена не нужна (WebGL/DOM): `navigator` зависит от `SceneHandle` только по типу
 * (`import type`) и каноническая поза вынесена в `home.ts`. Подсовываем фейковую
 * ручку, чей `flyTo` вызывает `onArrive` синхронно (как реальный — в кадре прилёта).
 */
import { describe, expect, it } from "vitest";
import { Group, PerspectiveCamera, Vector3, type Object3D } from "three";
import type { SceneHandle } from "./scene";
import { activeView, createNavigator } from "./navigator";
import { dir, file, visibleCount } from "./test-fixtures";

/** Фейковая ручка сцены: flyTo мгновенно «прилетает» и зовёт onArrive синхронно. */
function fakeHandle(): SceneHandle {
  const content = new Group();
  const camera = new PerspectiveCamera();
  const h: Partial<SceneHandle> = {
    content,
    camera,
    add(_o: Object3D) {},
    onFrame: () => () => {},
    flyTo(
      position: Vector3,
      _target: Vector3,
      _ms: number,
      onArrive?: () => void,
    ) {
      camera.position.copy(position);
      onArrive?.();
      return Promise.resolve();
    },
    placeCamera(position: Vector3, _target: Vector3) {
      camera.position.copy(position);
    },
    dispose() {},
  };
  return h as SceneHandle;
}

/** Двухуровневое дерево: /a — район с под-районами /a/x,/a/y (для LOD после drill). */
function tree() {
  return [
    dir("/a", [
      dir("/a/x", [file("/a/x/1", 100, "code"), file("/a/x/2", 40, "image")]),
      dir("/a/y", [file("/a/y/1", 60, "document")]),
    ]),
    dir("/b", [file("/b/1", 80, "archive")]),
    file("/c", 30, "binary"),
  ];
}

/** Число видимых зданий активного уровня при заданной позиции камеры. */
function buildingsVisibleAt(
  handle: SceneHandle,
  nav: ReturnType<typeof createNavigator>,
  pos: Vector3,
): number {
  handle.camera.position.copy(pos);
  nav.updateLOD();
  const view = activeView(handle.content);
  expect(view).not.toBeNull();
  return visibleCount(view!.pickMeshes()[0]); // [building, plot, coarse]
}

const FAR = new Vector3(0, 5000, 5000);
const NEAR_ORIGIN = new Vector3(0, 10, 0);

describe("createNavigator: reset / drill / up", () => {
  it("reset: один активный уровень, подняться некуда", () => {
    const handle = fakeHandle();
    const nav = createNavigator(handle);
    nav.reset(tree(), "root");

    expect(activeView(handle.content)).not.toBeNull();
    expect(nav.canUp("root")).toBe(false);

    nav.dispose();
  });

  it("drill в /a: активным становится /a, наверх ведёт к root", async () => {
    const handle = fakeHandle();
    const nav = createNavigator(handle);
    nav.reset(tree(), "root");

    const nodeA = tree()[0];
    await nav.drill(nodeA, nodeA.children!, 0);

    // Поднявшись — попадём в root (он стал декором-родителем).
    expect(nav.canUp("root")).toBe(true);
    expect(activeView(handle.content)).not.toBeNull();

    nav.dispose();
  });

  it("РЕГРЕССИЯ: после drill LOD активного уровня снова работает", async () => {
    const handle = fakeHandle();
    const nav = createNavigator(handle);
    nav.reset(tree(), "root");

    const nodeA = tree()[0];
    await nav.drill(nodeA, nodeA.children!, 0);

    // Далёкая камера — вложенных зданий не видно (только силуэты под-районов).
    expect(buildingsVisibleAt(handle, nav, FAR)).toBe(0);
    // Близкая камера — под-районы раскрылись во вложенные здания (LOD ожил).
    expect(buildingsVisibleAt(handle, nav, NEAR_ORIGIN)).toBeGreaterThan(0);

    nav.dispose();
  });

  it("up: возвращаемся в root, подниматься больше некуда", async () => {
    const handle = fakeHandle();
    const nav = createNavigator(handle);
    nav.reset(tree(), "root");

    const nodeA = tree()[0];
    await nav.drill(nodeA, nodeA.children!, 0);
    expect(nav.canUp("root")).toBe(true);

    await nav.up(0);

    // Декор-родителя больше нет (лимит 2 уровня; дед не достраивается).
    expect(nav.canUp("root")).toBe(false);
    // root снова активен и кликабелен.
    const view = activeView(handle.content);
    expect(view).not.toBeNull();
    expect(view!.pickMeshes().length).toBeGreaterThan(0);

    nav.dispose();
  });
});
