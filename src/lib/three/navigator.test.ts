/**
 * Тесты бесшовной навигации (`navigator.ts`): drill/up + rebase (origin shift).
 *
 * Регресс-тест бага «после drill вся папка — один блок»: проверяем, что у
 * активного уровня ПОСЛЕ drill видна вложенная застройка (раньше декор накрывал
 * активный уровень). Детализация теперь задаётся ГЛУБИНОЙ, а не расстоянием
 * (vision §II.3.2): купола +1 и их домики видны при любой позиции камеры.
 *
 * Сцена не нужна (WebGL/DOM): `navigator` зависит от `SceneHandle` только по типу
 * (`import type`) и каноническая поза вынесена в `home.ts`. Подсовываем фейковую
 * ручку, чей `flyTo` вызывает `onArrive` синхронно (как реальный — в кадре прилёта).
 */
import { describe, expect, it } from "vitest";
import {
  Group,
  PerspectiveCamera,
  Raycaster,
  Vector3,
  type InstancedMesh,
  type Object3D,
} from "three";
import type { SceneHandle } from "./scene";
import {
  activeView,
  budgetFromS,
  colorFactorFromS,
  createNavigator,
  N_MAX,
} from "./navigator";
import { buildLevel, CITY_SPAN, PREVIEW_MAX_DEPTH } from "./city";
import { spanFromPlacement } from "./transform";
import {
  dir,
  file,
  isHidden,
  matrixAt,
  pickRoles,
  sumVisible,
} from "./test-fixtures";

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
  // Зданий несколько мешей (по категории) — суммируем видимые.
  return sumVisible(pickRoles(view!).buildings);
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

  it("РЕГРЕССИЯ: после drill активный уровень показывает вложенную застройку", async () => {
    const handle = fakeHandle();
    const nav = createNavigator(handle);
    nav.reset(tree(), "root");

    const nodeA = tree()[0];
    await nav.drill(nodeA, nodeA.children!, 0);

    // Купола +1 (/a/x, /a/y) и их домики видны при ЛЮБОЙ позиции камеры —
    // детализация по глубине, не по расстоянию (vision §II.3.2).
    const far = buildingsVisibleAt(handle, nav, FAR);
    const near = buildingsVisibleAt(handle, nav, NEAR_ORIGIN);
    expect(far).toBeGreaterThan(0);
    expect(near).toBe(far); // облик не «дышит» от движения камеры

    nav.dispose();
  });

  it("стек: после 2× drill дед держится, S = композиция подобий (∏ 1/s)", async () => {
    const handle = fakeHandle();
    const nav = createNavigator(handle);
    const t = tree();
    nav.reset(t, "root");

    // Ожидаемые размещения из независимой сборки тех же уровней (как у навигатора).
    const rootLevel = buildLevel(t, { w: CITY_SPAN, d: CITY_SPAN }, "root");
    const gA = rootLevel.childPlacement("/a")!;
    const aLevel = buildLevel(t[0].children!, spanFromPlacement(gA), "/a");
    const gX = aLevel.childPlacement("/a/x")!;
    rootLevel.dispose();
    aLevel.dispose();

    const nodeA = t[0];
    await nav.drill(nodeA, nodeA.children!, 0);
    const nodeAX = nodeA.children![0]; // /a/x
    await nav.drill(nodeAX, nodeAX.children!, 0);

    const info = nav.inspect();
    expect(info.activePath).toBe("/a/x");
    // Декор: ближайший — /a, дальше — root (дед НЕ уничтожен, как было при лимите 2).
    expect(info.decor.map((d) => d.path)).toEqual(["/a", "root"]);
    // S: /a раздут на ×(1/sX), root — на ×(1/(sA·sX)).
    expect(info.decor[0].S).toBeCloseTo(1 / gX.s, 4);
    expect(info.decor[1].S).toBeCloseTo(1 / (gA.s * gX.s), 4);

    nav.dispose();
  });

  it("вертикальный шов (§8): верх плиты decorStack[0] = пол активного (world 0)", async () => {
    const handle = fakeHandle();
    const nav = createNavigator(handle);
    nav.reset(tree(), "root");

    // ДО drill (root активен) держим его baseMesh и индекс плиты /a (декор не пикается,
    // но ссылка на меш переживает смену облика — setDecor мутирует его на месте).
    const view = activeView(handle.content)!;
    const baseMesh = pickRoles(view).base; // плита-постамент района
    let idxA = -1;
    for (let i = 0; i < baseMesh.count; i++) {
      const info = view.resolvePick(baseMesh, i);
      if (info && info.node.path === "/a") idxA = i;
    }
    expect(idxA).toBeGreaterThanOrEqual(0);

    const nodeA = tree()[0];
    await nav.drill(nodeA, nodeA.children!, 0);

    // root → decorStack[0], его плита /a осталась видимой (купол/застройка скрыты).
    const local = matrixAt(baseMesh, idxA);
    expect(isHidden(local)).toBe(false);

    // Локальный верх плиты, поднятый трансформом группы (G⁻¹ с `cy`: scale=S,
    // position.y=−cy/s), должен сесть ровно на пол активного (world y = 0) —
    // вертикальный шов держит сам рибейз-подобие, без ручного подиума.
    const group = baseMesh.parent!; // = root.group с применённым G⁻¹
    const localTopY = local.elements[13] + local.elements[5] / 2;
    const worldTop = group.scale.y * localTopY + group.position.y;
    expect(worldTop).toBeCloseTo(0, 6);

    nav.dispose();
  });

  it("up из стека возвращает геометрию родителя 1:1", async () => {
    const handle = fakeHandle();
    const nav = createNavigator(handle);
    const t = tree();
    nav.reset(t, "root");

    const before = sumVisible(pickRoles(activeView(handle.content)!).buildings);

    const nodeA = t[0];
    await nav.drill(nodeA, nodeA.children!, 0);
    await nav.up(0);

    expect(nav.inspect().activePath).toBe("root");
    expect(nav.inspect().decor).toEqual([]);
    const after = sumVisible(pickRoles(activeView(handle.content)!).buildings);
    expect(after).toBe(before); // та же геометрия root (промоут реального уровня)

    nav.dispose();
  });

  it("двойной up из глубины стека: root снова активен, декор пуст, 1:1", async () => {
    const handle = fakeHandle();
    const nav = createNavigator(handle);
    const t = tree();
    nav.reset(t, "root");

    const before = sumVisible(pickRoles(activeView(handle.content)!).buildings);

    const nodeA = t[0];
    await nav.drill(nodeA, nodeA.children!, 0);
    const nodeAX = nodeA.children![0];
    await nav.drill(nodeAX, nodeAX.children!, 0);

    // Промежуточный up → /a активен, декор = [root].
    await nav.up(0);
    expect(nav.inspect().activePath).toBe("/a");
    expect(nav.inspect().decor.map((d) => d.path)).toEqual(["root"]);

    // Финальный up → root активен, декор пуст.
    await nav.up(0);
    expect(nav.inspect().activePath).toBe("root");
    expect(nav.inspect().decor).toEqual([]);
    const after = sumVisible(pickRoles(activeView(handle.content)!).buildings);
    expect(after).toBe(before);

    nav.dispose();
  });

  it("дочит дальнего слоя на up восстанавливает запас, срезанный N_MAX (план §6)", async () => {
    // Линейная цепочка глубже N_MAX: при глубоком drill самый дальний предок (root)
    // срезается лимитом, а на up должен дочитаться обратно.
    const leaf = file("/a/b/c/d/e/f", 100, "code");
    const e = dir("/a/b/c/d/e", [leaf]);
    const d = dir("/a/b/c/d", [e]);
    const c = dir("/a/b/c", [d]);
    const b = dir("/a/b", [c]);
    const a = dir("/a", [b]);
    const rootNodes = [a];

    const handle = fakeHandle();
    const nav = createNavigator(handle);
    nav.reset(rootNodes, "root");

    // Спускаемся root→a→b→c→d→e (5 drill'ов > N_MAX=4 декор-слоёв).
    const chain = [a, b, c, d, e];
    for (const n of chain) await nav.drill(n, n.children!, 0);

    // Глубоко: декор = 4 ближайших предка, root СРЕЗАН лимитом.
    expect(N_MAX).toBe(4);
    let info = nav.inspect();
    expect(info.activePath).toBe("/a/b/c/d/e");
    expect(info.decor.map((x) => x.path)).toEqual([
      "/a/b/c/d",
      "/a/b/c",
      "/a/b",
      "/a",
    ]);
    // Бюджет каждого слоя = budgetFromS(S_k) (план §5). Цепочка из одиночных детей —
    // СЛАБЫЕ drill'ы (s≈1, S_k≈1), поэтому глубина держится: бюджеты остаются полными.
    expect(info.decor.map((x) => x.budget)).toEqual(
      info.decor.map((x) => budgetFromS(x.S)),
    );
    expect(info.decor.every((x) => x.budget === PREVIEW_MAX_DEPTH)).toBe(true);
    // Буфер полон — дочитывать нечего.
    expect(nav.farthestHeldPath()).toBeNull();
    expect(nav.appendFarAncestor("root", rootNodes)).toBe(false);

    // Поднимаемся на уровень: декор просел до 3, дальний (root) надо добрать.
    await nav.up(0);
    info = nav.inspect();
    expect(info.activePath).toBe("/a/b/c/d");
    expect(info.decor.map((x) => x.path)).toEqual(["/a/b/c", "/a/b", "/a"]);
    expect(info.decor.map((x) => x.budget)).toEqual(
      info.decor.map((x) => budgetFromS(x.S)),
    );
    expect(nav.farthestHeldPath()).toBe("/a"); // его родителя (root) и дочитываем

    const aSBefore = info.decor[info.decor.length - 1].S; // S слоя /a до дочита

    // Дочит root: встаёт в хвост стека подобием-продолжением цепочки.
    expect(nav.appendFarAncestor("root", rootNodes)).toBe(true);
    info = nav.inspect();
    expect(info.decor.map((x) => x.path)).toEqual([
      "/a/b/c",
      "/a/b",
      "/a",
      "root",
    ]);
    // Дочитанный дальний слой получает бюджет по своему S_k (§5).
    expect(info.decor.map((x) => x.budget)).toEqual(
      info.decor.map((x) => budgetFromS(x.S)),
    );
    // S(root) = S(/a) / s, где s — масштаб размещения /a в root (composeChildInverse).
    const rootLevel = buildLevel(
      rootNodes,
      { w: CITY_SPAN, d: CITY_SPAN },
      "root",
    );
    const sA = rootLevel.childPlacement("/a")!.s;
    rootLevel.dispose();
    expect(info.decor[info.decor.length - 1].S).toBeCloseTo(aSBefore / sA, 4);

    // Дочит проявляется ФЕЙДОМ: показанное затемнение стартует с 0 (из фона, §6/§7),
    // а покадровый фейд доводит его до цели colorFactorFromS(S).
    expect(info.decor[info.decor.length - 1].dim).toBe(0);
    nav.updateFade(10000);
    const settled = nav.inspect().decor[info.decor.length - 1];
    expect(settled.dim).toBeCloseTo(colorFactorFromS(settled.S), 6);

    // Буфер снова полон.
    expect(nav.farthestHeldPath()).toBeNull();

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

describe("createNavigator: циклы drill→up не ломают пикинг (регрессия)", () => {
  /** Все живые уровни в контенте: группы с userData.view. */
  function liveViews(content: Group) {
    const views: { group: Object3D; meshes: Set<Object3D> }[] = [];
    content.traverse((obj) => {
      const v = (obj as Group).userData?.view;
      if (v) {
        views.push({
          group: obj,
          meshes: new Set(v.allVisualMeshes()),
        });
      }
    });
    return views;
  }

  /** Инвариант пула: ни один меш не принадлежит двум живым уровням сразу,
   *  и каждый меш уровня — потомок ИМЕННО его группы (не украден другим). */
  function expectNoMeshSharing(content: Group) {
    const views = liveViews(content);
    const owner = new Map<Object3D, Object3D>();
    for (const v of views) {
      for (const m of v.meshes) {
        expect(owner.has(m)).toBe(false); // меш не делится между уровнями
        owner.set(m, v.group);
        // Родительская цепочка меша ведёт в группу его уровня.
        let p: Object3D | null = m.parent;
        let insideOwn = false;
        while (p) {
          if (p === v.group) {
            insideOwn = true;
            break;
          }
          p = p.parent;
        }
        expect(insideOwn).toBe(true);
      }
    }
  }

  /** Меши активного вида принадлежат группе ИМЕННО активного уровня: группа-
   *  владелец каждого pick-меша несёт этот же view И находится в контенте. */
  function expectActiveOwnsItsMeshes(content: Group) {
    const view = activeView(content);
    expect(view).not.toBeNull();
    for (const m of view!.pickMeshes()) {
      // Ближайшая группа-уровень над мешом.
      let p: Object3D | null = m.parent;
      while (p && !(p as Group).userData?.view) p = p.parent;
      expect(p).not.toBeNull();
      expect((p as Group).userData.view).toBe(view);
      // И она смонтирована в контент (уровень реально на сцене).
      let anc: Object3D | null = p;
      while (anc && anc !== content) anc = anc.parent;
      expect(anc).toBe(content);
    }
  }

  /** Реплика interaction.raycastHit: вертикальный луч вниз в точку (x, z) по
   *  pick-мешам АКТИВНОГО вида; вложенные превью пропускаются (isPickTarget). */
  function castDown(content: Group, x: number, z: number) {
    content.updateMatrixWorld(true);
    const view = activeView(content)!;
    const ray = new Raycaster(new Vector3(x, 500, z), new Vector3(0, -1, 0));
    const hits = ray.intersectObjects(view.pickMeshes(), false);
    for (const h of hits) {
      if (h.instanceId == null) continue;
      const mesh = h.object as InstancedMesh;
      if (!view.isPickTarget(mesh, h.instanceId)) continue;
      return view.resolvePick(mesh, h.instanceId)?.node ?? null;
    }
    return null;
  }

  /** Индекс инстанса района `path` в меше куполов активного вида. */
  function domeIndexOf(view: ViewLike2, dome: InstancedMesh, path: string) {
    for (let j = 0; j < dome.count; j++) {
      const info = view.resolvePick(dome, j);
      if (info?.node.path === path) return j;
    }
    return -1;
  }
  type ViewLike2 = ReturnType<typeof activeView> & object;

  it("повторные drill→up в один район: купол восстановлен, застройка на месте", async () => {
    const handle = fakeHandle();
    const nav = createNavigator(handle);
    const t = tree();
    nav.reset(t, "root");
    const buildings0 = sumVisible(
      pickRoles(activeView(handle.content)!).buildings,
    );

    for (let i = 0; i < 3; i++) {
      const nodeA = t[0];
      await nav.drill(nodeA, nodeA.children!, 0);
      expectNoMeshSharing(handle.content);
      await nav.up(0);
      expectNoMeshSharing(handle.content);

      const view = activeView(handle.content)!;
      // Симптом «наведение сквозь купол»: купол /a обязан быть восстановлен
      // после подъёма (не вырожден ZERO), иначе луч проваливается внутрь.
      const roles = pickRoles(view);
      const jA = domeIndexOf(view, roles.dome, "/a");
      expect(jA).toBeGreaterThanOrEqual(0);
      expect(isHidden(matrixAt(roles.dome, jA))).toBe(false);
      // Симптом «домики перестали быть интерактивными»: видимая застройка 1:1.
      expect(sumVisible(roles.buildings)).toBe(buildings0);
    }
    nav.dispose();
  });

  it("РЕГРЕССИЯ: rebuildActive В ПОЛЁТЕ твина — no-op (без двойного dispose)", async () => {
    // Фейк с РУЧНЫМ прилётом: onArrive не зовётся, пока тест сам не «долетит».
    const content = new Group();
    const camera = new PerspectiveCamera();
    let arrive: (() => void) | undefined;
    let resolveFly: (() => void) | undefined;
    const handle = {
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
        arrive = onArrive;
        return new Promise<void>((res) => (resolveFly = res));
      },
      placeCamera(position: Vector3) {
        camera.position.copy(position);
      },
      dispose() {},
    } as unknown as SceneHandle;

    const nav = createNavigator(handle);
    const t = tree();
    nav.reset(t, "root");
    const buildings0 = sumVisible(
      pickRoles(activeView(handle.content)!).buildings,
    );

    const nodeA = t[0];
    const drillP = nav.drill(nodeA, nodeA.children!, 0); // твин «завис» в полёте

    // Пересборка активного уровня посреди твина: раньше disposed'ила уровень,
    // обещанный свопу (двойной возврат мешей в пул → два уровня делят меш).
    nav.rebuildActive(t); // должен быть no-op (interactive=false в полёте)

    arrive?.(); // «долетели»: своп декора/активного
    resolveFly?.();
    await drillP;

    expectNoMeshSharing(handle.content);
    expectActiveOwnsItsMeshes(handle.content);
    expect(nav.inspect().activePath).toBe("/a");
    expect(nav.inspect().decor.map((d) => d.path)).toEqual(["root"]);

    // Подъём обратно: root снова активен, застройка 1:1, меши не делятся.
    const upP = nav.up(0);
    arrive?.();
    resolveFly?.();
    await upP;
    expectNoMeshSharing(handle.content);
    // Ключевой инвариант регрессии: без гарда пересборка-в-полёте оставляла в
    // навигаторе «зомби»-уровень, чьи меши физически принадлежат группе ДРУГОГО
    // уровня (пул выдал их дважды) → пикинг резолвился чужими таблицами.
    expectActiveOwnsItsMeshes(handle.content);
    const view = activeView(handle.content)!;
    expect(sumVisible(pickRoles(view).buildings)).toBe(buildings0);

    nav.dispose();
  });

  it("РЕГРЕССИЯ: маршрут через «Мелочь» (::<other>) и up обратно — пикинг цел", async () => {
    // Ровно пользовательский сценарий: Media → AnakinGame → Мелочь → Hair →
    // Textures, затем up до AnakinGame. Раньше на этом уровне ломался raycast
    // (луч проходил сквозь купола, включая не посещённый Robe).
    const agg = (path: string, children: ReturnType<typeof file>[]) => {
      const size = children.reduce((s, c) => s + c.size, 0);
      return {
        ...file(path, size),
        name: "Мелочь",
        flags: ["aggregated" as const],
        childCount: children.length,
        categoryMask: children.reduce((m, c) => m | c.categoryMask, 0),
        children,
      };
    };
    const textures = dir("/M/AG/Hair/Textures", [
      file("/M/AG/Hair/Textures/t1", 50, "image"),
      file("/M/AG/Hair/Textures/t2", 30, "image"),
    ]);
    const hair = dir("/M/AG/Hair", [textures, file("/M/AG/Hair/h1", 20)]);
    const robe = dir("/M/AG/Robe", [file("/M/AG/Robe/r1", 40, "document")]);
    const other = agg("/M/AG::<other>", [
      hair as unknown as ReturnType<typeof file>,
      file("/M/AG/loose", 10),
    ]);
    const ag = dir("/M/AG", [
      robe,
      other as unknown as ReturnType<typeof file>,
      file("/M/AG/big.bin", 500, "video"),
    ]);
    const t = [ag, file("/M/x.bin", 100, "binary")];

    const handle = fakeHandle();
    const nav = createNavigator(handle);
    nav.reset(t, "/M");

    await nav.drill(ag, ag.children!, 0);
    const agBuildings = sumVisible(
      pickRoles(activeView(handle.content)!).buildings,
    );
    await nav.drill(other, other.children!, 0);
    await nav.drill(hair, hair.children!, 0);
    await nav.drill(textures, textures.children!, 0);

    // Подъём обратно до AnakinGame: Textures → Hair → Мелочь → AnakinGame.
    await nav.up(0);
    await nav.up(0);
    await nav.up(0);

    expect(nav.inspect().activePath).toBe("/M/AG");
    expectNoMeshSharing(handle.content);
    expectActiveOwnsItsMeshes(handle.content);

    const view = activeView(handle.content)!;
    const roles = pickRoles(view);
    // Купола районов AnakinGame (Robe и «Мелочь») восстановлены — луч упирается
    // в купол, а не проходит внутрь. Проверяем НАСТОЯЩИМ Raycaster'ом (как
    // interaction.raycastHit): вертикальный луч в центр купола обязан разрешиться
    // в сам район, а не в содержимое под стеклом и не в пустоту.
    for (const p of ["/M/AG/Robe", "/M/AG::<other>"]) {
      const j = domeIndexOf(view, roles.dome, p);
      expect(j).toBeGreaterThanOrEqual(0);
      const m = matrixAt(roles.dome, j);
      expect(isHidden(m)).toBe(false);
      expect(view.isPickTarget(roles.dome, j)).toBe(true);
      const hitNode = castDown(handle.content, m.elements[12], m.elements[14]);
      expect(hitNode?.path).toBe(p);
    }
    // Видимая застройка уровня 1:1 с первым заходом.
    expect(sumVisible(roles.buildings)).toBe(agBuildings);

    nav.dispose();
  });

  it("зигзаг по районам и глубокий спуск: пикинг и купола целы", async () => {
    const handle = fakeHandle();
    const nav = createNavigator(handle);
    const t = tree();
    nav.reset(t, "root");
    const buildings0 = sumVisible(
      pickRoles(activeView(handle.content)!).buildings,
    );

    const nodeA = t[0];
    const nodeB = t[1];
    // /a → up → /b → up → /a → /a/x → up → up (агрессивная навигация).
    await nav.drill(nodeA, nodeA.children!, 0);
    await nav.up(0);
    await nav.drill(nodeB, nodeB.children!, 0);
    await nav.up(0);
    await nav.drill(nodeA, nodeA.children!, 0);
    const nodeAX = nodeA.children![0];
    await nav.drill(nodeAX, nodeAX.children!, 0);
    expectNoMeshSharing(handle.content);
    await nav.up(0);
    expectNoMeshSharing(handle.content);
    await nav.up(0);
    expectNoMeshSharing(handle.content);

    expect(nav.inspect().activePath).toBe("root");
    const view = activeView(handle.content)!;
    const roles = pickRoles(view);
    // Оба купола (+1 районы /a и /b) восстановлены.
    for (const p of ["/a", "/b"]) {
      const j = domeIndexOf(view, roles.dome, p);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(isHidden(matrixAt(roles.dome, j))).toBe(false);
    }
    expect(sumVisible(roles.buildings)).toBe(buildings0);
    // Каждый pick-меш резолвится в узлы ИМЕННО этого уровня.
    for (const m of view.pickMeshes()) {
      for (let i = 0; i < m.count; i++) {
        const info = view.resolvePick(m, i);
        if (info)
          expect(["/a", "/b", "/c"]).toContain(info.node.path.slice(0, 2));
      }
    }
    nav.dispose();
  });
});

describe("budgetFromS: зум-зависимый LOD-бюджет (план §5)", () => {
  it("полный бюджет пока S мал, ступенчато падает к 0 на удвоениях / за S_drop", () => {
    // S0=1.5, S_drop=7. Полный до S<3; 2 на [3,6); 1 на [6,7]; 0 за S_drop.
    expect(budgetFromS(1)).toBe(3); // S<S0 → полный
    expect(budgetFromS(1.5)).toBe(3);
    expect(budgetFromS(2.9)).toBe(3);
    expect(budgetFromS(3)).toBe(2); // первое удвоение S0 → −1
    expect(budgetFromS(5.9)).toBe(2);
    expect(budgetFromS(6)).toBe(1); // второе удвоение → −1
    expect(budgetFromS(7)).toBe(1);
    expect(budgetFromS(7.5)).toBe(0); // за S_drop → контур
    expect(budgetFromS(50)).toBe(0);
  });

  it("монотонно невозрастающий по S", () => {
    let prev = budgetFromS(1);
    for (let S = 1; S <= 30; S += 0.25) {
      const b = budgetFromS(S);
      expect(b).toBeLessThanOrEqual(prev);
      prev = b;
    }
  });
});

describe("createNavigator: сильный drill срезает бюджет дальнего слоя (план §5)", () => {
  it("малый s (район — малая доля родителя) → S велик → бюджет < полного", async () => {
    // /a — одна из 25 равных по площади ячеек корня, поэтому squarify пакует её в
    // мелкий ~квадрат (≈1/5 стороны → s≈0.2), а не в полосу (как было бы при 2
    // элементах). Drill в неё сильный: S_1 = 1/s велик → LOD дальнего слоя срезан.
    const siblings = Array.from({ length: 24 }, (_, i) =>
      file(`/f${i}`, 40, "binary"),
    );
    const t = [
      dir("/a", [file("/a/1", 25, "code"), file("/a/2", 15, "image")]),
      ...siblings,
    ];

    const rootLevel = buildLevel(t, { w: CITY_SPAN, d: CITY_SPAN }, "root");
    const sA = rootLevel.childPlacement("/a")!.s;
    rootLevel.dispose();
    const expectedBudget = budgetFromS(1 / sA);
    // Фикстура должна реально срезать детализацию (иначе тест бессмыслен).
    expect(expectedBudget).toBeLessThan(PREVIEW_MAX_DEPTH);

    const handle = fakeHandle();
    const nav = createNavigator(handle);
    nav.reset(t, "root");
    const nodeA = t[0];
    await nav.drill(nodeA, nodeA.children!, 0);

    const layer = nav.inspect().decor[0]; // root как декор
    expect(layer.S).toBeCloseTo(1 / sA, 4);
    expect(layer.budget).toBe(expectedBudget);

    nav.dispose();
  });
});

describe("colorFactorFromS: градиентное затемнение декора (план §7.1)", () => {
  it("ближний — чуть темнее активного, квадратично к порогу (не в чёрный)", () => {
    expect(colorFactorFromS(1)).toBeCloseTo(0.6, 6); // L1 заметно темнее активного
    expect(colorFactorFromS(1.5)).toBeCloseTo(0.6, 6); // S0
    expect(colorFactorFromS(7)).toBeCloseTo(0.3, 6); // S_drop → порог, НЕ чёрный
    expect(colorFactorFromS(50)).toBeCloseTo(0.3, 6);
    // Квадратичность: на полпути по S падение = t²-доля диапазона (t=0.5 → ×0.25).
    expect(colorFactorFromS((1.5 + 7) / 2)).toBeCloseTo(0.6 - 0.3 * 0.25, 6);
    // Монотонно вниз и нигде не уходит ниже порога (в чистый чёрный).
    let prev = colorFactorFromS(1);
    for (let S = 1; S <= 30; S += 0.1) {
      const f = colorFactorFromS(S);
      expect(f).toBeLessThanOrEqual(prev + 1e-9);
      expect(f).toBeGreaterThanOrEqual(0.3 - 1e-9);
      prev = f;
    }
  });
});

describe("createNavigator: инвариант кадра свопа + дроп за S_drop (план §6/§7)", () => {
  /** Линейная цепочка одиночных детей (слабые drill'ы): /a→/a/b→/a/b/c→… */
  function weakChain() {
    const e = dir("/a/b/c/d/e", [file("/a/b/c/d/e/f", 100, "code")]);
    const d = dir("/a/b/c/d", [e]);
    const c = dir("/a/b/c", [d]);
    const b = dir("/a/b", [c]);
    const a = dir("/a", [b]);
    return { nodes: [a], a, b, c, d };
  }

  it("своп НЕ трогает показанное затемнение уцелевших слоёв (только фейд, §7)", async () => {
    const { nodes, a, b, c } = weakChain();
    const handle = fakeHandle();
    const nav = createNavigator(handle);
    nav.reset(nodes, "root");

    await nav.drill(a, a.children!, 0);
    await nav.drill(b, b.children!, 0);
    nav.updateFade(10000); // довести фейд до целей перед замером

    const before = new Map(nav.inspect().decor.map((x) => [x.path, x.dim]));
    // Ещё один drill: /a и root уцелевают и при этом сдвигаются (их S растёт) —
    // показанное затемнение обязано остаться прежним (меняем только фейдом, не свопом).
    await nav.drill(c, c.children!, 0);
    for (const x of nav.inspect().decor) {
      if (before.has(x.path)) {
        expect(x.dim).toBe(before.get(x.path)); // заморожено на свопе
      }
    }

    nav.dispose();
  });

  it("слой за S_drop дропается (бюджет 0 → дроп невидим), даже в пределах N_MAX", async () => {
    // Два СИЛЬНЫХ drill (каждый район — 1/25 площади родителя, s≈0.2): после второго
    // S(root) ≈ 25 > S_drop=7 → root дропается, хотя N_MAX (4) его бы удержал.
    const ax = dir("/a/x", [
      file("/a/x/1", 60, "code"),
      file("/a/x/2", 40, "image"),
    ]); // 100
    const aSibs = Array.from({ length: 24 }, (_, i) =>
      file(`/a/f${i}`, 100, "binary"),
    );
    const a = dir("/a", [ax, ...aSibs]); // 2500, 25 равных ячеек
    const rootSibs = Array.from({ length: 24 }, (_, i) =>
      file(`/f${i}`, 2500, "binary"),
    );
    const t = [a, ...rootSibs]; // /a — 1/25 корня

    const handle = fakeHandle();
    const nav = createNavigator(handle);
    nav.reset(t, "root");

    await nav.drill(a, a.children!, 0);
    let info = nav.inspect();
    expect(info.decor.map((x) => x.path)).toEqual(["root"]); // root ещё в кадре
    expect(info.decor[0].S).toBeLessThan(7); // < S_drop

    await nav.drill(ax, ax.children!, 0);
    info = nav.inspect();
    // root ушёл за S_drop и сброшен; держится только ближний /a (в пределах N_MAX).
    expect(info.decor.map((x) => x.path)).toEqual(["/a"]);
    expect(info.decor.length).toBeLessThanOrEqual(N_MAX);

    nav.dispose();
  });
});
