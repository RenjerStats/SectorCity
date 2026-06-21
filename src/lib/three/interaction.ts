/**
 * Слой взаимодействия: наведение (raycast), обводка наведённого здания
 * (highlight-mesh) и клик-drill по районам. Императивная часть 3D-мира.
 *
 * Архитектура (docs §1, §5): picking — CPU raycast с rAF-троттлингом (обработка
 * не чаще кадра). Raycast идёт по нескольким `InstancedMesh` уровня (здания,
 * плоты, силуэты районов — `CityView.pickMeshes`); попадание разрешается в узел и
 * цель drill через `CityView.resolvePick`. Обводка одного инстанса через
 * OutlinePass невозможна — держим ОДИН highlight-mesh (рёбра бокса) и ставим его
 * трансформ = матрице наведённого инстанса того меша, в который попали (docs §5.1).
 *
 * Контакт с DOM — только через колбэки, которые владелец заворачивает в стор.
 * Прямой связи raycaster ↔ DOM нет.
 */
import {
  BoxGeometry,
  EdgesGeometry,
  type InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
} from "three";
import type { ScanNode } from "../ipc/contract";
import type { SceneHandle } from "./scene";
import { activeView, isInteractive } from "./navigator";

/** Колбэки наружу: владелец заворачивает их в стор / машину режимов. */
export interface InteractionCallbacks {
  /** Наведение сменилось (узел или `null`, когда курсор ушёл со зданий). */
  onHover(node: ScanNode | null): void;
  /** Клик по району (папке) → drill (бесшовный зум считает навигатор сам). */
  onDrill(node: ScanNode): void;
  /** Клик по зданию-файлу → SELECT (карточка над зданием); `null` = снять выбор
   *  (клик мимо зданий). Район уходит в `onDrill`, синтетическое «Прочее» — никуда. */
  onSelect(node: ScanNode | null): void;
}

/** Управление слоем взаимодействия. */
export interface InteractionController {
  /** Якорь тултипа — верх центра наведённого здания в мире, либо `null`. */
  hoverAnchor(): Vector3 | null;
  /** Якорь карточки — верх центра выбранного здания в мире, либо `null`. */
  selectionAnchor(): Vector3 | null;
  /** Сбросить наведение (напр. после смены уровня). */
  clearHover(): void;
  /** Снять выбор (напр. при drill/смене уровня). Шлёт `onSelect(null)`. */
  clearSelection(): void;
  /** Снять слушатели и освободить ресурсы highlight-mesh. */
  dispose(): void;
}

/** Порог в пикселях: смещение больше — это перетаскивание камеры, не клик. */
const CLICK_SLOP = 5;

/** Попадание raycast: меш уровня + индекс инстанса в нём. */
interface Hit {
  mesh: InstancedMesh;
  id: number;
}

export function setupInteraction(
  handle: SceneHandle,
  cb: InteractionCallbacks,
): InteractionController {
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let pointerInside = false;
  let dirty = false; // указатель сдвинулся — нужен пересчёт на следующем кадре
  let hovered: Hit | null = null;
  let selected: Hit | null = null;
  let down: { x: number; y: number } | null = null;

  // Один highlight-mesh: рёбра единичного бокса, трансформ = матрица инстанса.
  const highlight = new LineSegments(
    new EdgesGeometry(new BoxGeometry(1, 1, 1)),
    new LineBasicMaterial({ color: 0xffffff }),
  );
  highlight.visible = false;
  highlight.matrixAutoUpdate = false;
  handle.add(highlight);

  const m = new Matrix4();
  const pos = new Vector3();
  const scale = new Vector3();
  const quat = new Quaternion();
  const grow = new Vector3(1.015, 1.015, 1.015); // чуть крупнее — без z-fight

  /** Ближайшее попадание по мешам активного уровня, либо `null`. */
  function raycastHit(): Hit | null {
    const view = activeView(handle.content);
    if (!view) return null;
    const meshes = view.pickMeshes();
    if (meshes.length === 0) return null;
    raycaster.setFromCamera(pointer, handle.camera);
    const hits = raycaster.intersectObjects(meshes, false);
    for (const h of hits) {
      // Скрытые LOD-инстансы (scale=0) вырождены и не дают пересечения; первое
      // попадание уже ближайшее (intersectObjects сортирует по дистанции).
      if (h.instanceId != null) {
        return { mesh: h.object as InstancedMesh, id: h.instanceId };
      }
    }
    return null;
  }

  /** Поставить обводку на инстанс `id` меша `mesh`. */
  function applyHighlight(hit: Hit): void {
    hit.mesh.getMatrixAt(hit.id, m);
    highlight.matrix.copy(m).scale(grow);
    highlight.visible = true;
  }

  /** Два попадания указывают на один и тот же инстанс? */
  function sameHit(a: Hit | null, b: Hit | null): boolean {
    return a === b || (!!a && !!b && a.mesh === b.mesh && a.id === b.id);
  }

  function setHover(hit: Hit | null): void {
    if (sameHit(hit, hovered)) {
      if (hit) applyHighlight(hit); // камера могла сдвинуться — освежить
      return;
    }
    hovered = hit;
    const view = activeView(handle.content);
    if (!hit || !view) {
      highlight.visible = false;
      cb.onHover(null);
      return;
    }
    applyHighlight(hit);
    cb.onHover(view.resolvePick(hit.mesh, hit.id)?.node ?? null);
  }

  // rAF-троттлинг: тяжёлый raycast делаем максимум раз в кадр и только если
  // указатель двигался (docs §5.2).
  const offFrame = handle.onFrame(() => {
    if (!dirty) return;
    dirty = false;
    // Во время твина зума (origin shift не завершён) пикинг выключен.
    const live = pointerInside && isInteractive(handle.content);
    setHover(live ? raycastHit() : null);
  });

  function toNdc(e: PointerEvent): void {
    const rect = handle.canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function onMove(e: PointerEvent): void {
    toNdc(e);
    pointerInside = true;
    dirty = true;
  }
  function onLeave(): void {
    pointerInside = false;
    dirty = true;
  }
  function onDown(e: PointerEvent): void {
    down = { x: e.clientX, y: e.clientY };
  }
  function onUp(e: PointerEvent): void {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > CLICK_SLOP) return; // это был пан камеры, не клик
    pick();
  }

  function pick(): void {
    if (!isInteractive(handle.content)) return; // твин зума ещё идёт
    const view = activeView(handle.content);
    if (!view) return;
    const hit = hovered ?? raycastHit();
    if (!hit) {
      setSelected(null); // клик по пустому месту — снять выбор
      return;
    }
    const info = view.resolvePick(hit.mesh, hit.id);
    if (!info) {
      setSelected(null); // клик мимо разрешимого узла — снять выбор
      return;
    }
    // Drill только в реальные папки. Агрегированное «Прочее» и файлы — не районы.
    // Цель — drillTarget: для вложенного превью это родительский район.
    const t = info.drillTarget;
    if (t.isDir && !t.flags.includes("aggregated")) {
      setSelected(null); // уходим на новый уровень — старый выбор не актуален
      cb.onDrill(t);
      return;
    }
    // Не район — это файл/лист. Синтетическое «Прочее» не выбираем (нет пути).
    if (info.node.flags.includes("aggregated")) {
      setSelected(null);
      return;
    }
    setSelected(hit, info.node);
  }

  /** Запомнить выбранный инстанс и отдать узел наружу (или снять выбор). */
  function setSelected(hit: Hit | null, node?: ScanNode): void {
    selected = hit;
    cb.onSelect(hit ? (node ?? null) : null);
  }

  const canvas = handle.canvas;
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);

  return {
    hoverAnchor() {
      if (!hovered) return null;
      hovered.mesh.getMatrixAt(hovered.id, m);
      m.decompose(pos, quat, scale);
      return new Vector3(pos.x, pos.y + scale.y / 2, pos.z);
    },
    selectionAnchor() {
      if (!selected) return null;
      selected.mesh.getMatrixAt(selected.id, m);
      m.decompose(pos, quat, scale);
      return new Vector3(pos.x, pos.y + scale.y / 2, pos.z);
    },
    clearHover() {
      hovered = null;
      highlight.visible = false;
      cb.onHover(null);
    },
    clearSelection() {
      setSelected(null);
    },
    dispose() {
      offFrame();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      highlight.geometry.dispose();
      (highlight.material as LineBasicMaterial).dispose();
    },
  };
}
