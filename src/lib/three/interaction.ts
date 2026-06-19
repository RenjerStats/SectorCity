/**
 * Слой взаимодействия: наведение (raycast), обводка наведённого здания
 * (highlight-mesh) и клик-drill по районам. Императивная часть 3D-мира.
 *
 * Архитектура (docs §1, §5): picking — CPU raycast с rAF-троттлингом (обработка
 * не чаще кадра). Обводка одного инстанса `InstancedMesh` через OutlinePass
 * невозможна — держим ОДИН отдельный highlight-mesh (рёбра бокса) и ставим его
 * трансформ = матрице наведённого инстанса (docs §5.1).
 *
 * Контакт с DOM — только через колбэки, которые владелец заворачивает в стор.
 * Прямой связи raycaster ↔ DOM нет.
 */
import {
  BoxGeometry,
  EdgesGeometry,
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
import { getCityMesh } from "./city";

/** Колбэки наружу: владелец заворачивает их в стор / машину режимов. */
export interface InteractionCallbacks {
  /** Наведение сменилось (узел или `null`, когда курсор ушёл со зданий). */
  onHover(node: ScanNode | null): void;
  /** Клик по району (папке) → drill. `center` — мировой центр основания. */
  onDrill(node: ScanNode, center: Vector3): void;
}

/** Управление слоем взаимодействия. */
export interface InteractionController {
  /** Якорь тултипа — верх центра наведённого здания в мире, либо `null`. */
  hoverAnchor(): Vector3 | null;
  /** Сбросить наведение (напр. после смены уровня). */
  clearHover(): void;
  /** Снять слушатели и освободить ресурсы highlight-mesh. */
  dispose(): void;
}

/** Порог в пикселях: смещение больше — это перетаскивание камеры, не клик. */
const CLICK_SLOP = 5;

export function setupInteraction(
  handle: SceneHandle,
  cb: InteractionCallbacks,
): InteractionController {
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let pointerInside = false;
  let dirty = false; // указатель сдвинулся — нужен пересчёт на следующем кадре
  let hoveredId: number | null = null;
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

  function meshAndNodes() {
    const mesh = getCityMesh(handle.content);
    const nodes = mesh?.userData.nodes as ScanNode[] | undefined;
    return mesh && nodes ? { mesh, nodes } : null;
  }

  function raycastInstance(): number | null {
    const mn = meshAndNodes();
    if (!mn) return null;
    raycaster.setFromCamera(pointer, handle.camera);
    const hits = raycaster.intersectObject(mn.mesh);
    return hits.length > 0 ? (hits[0].instanceId ?? null) : null;
  }

  function applyHighlight(id: number): void {
    const mn = meshAndNodes();
    if (!mn) {
      highlight.visible = false;
      return;
    }
    mn.mesh.getMatrixAt(id, m);
    highlight.matrix.copy(m).scale(grow);
    highlight.visible = true;
  }

  function setHover(id: number | null): void {
    if (id === hoveredId) {
      if (id !== null) applyHighlight(id); // камера могла сдвинуться — освежить
      return;
    }
    hoveredId = id;
    const mn = meshAndNodes();
    if (id === null || !mn) {
      highlight.visible = false;
      cb.onHover(null);
      return;
    }
    applyHighlight(id);
    cb.onHover(mn.nodes[id] ?? null);
  }

  // rAF-троттлинг: тяжёлый raycast делаем максимум раз в кадр и только если
  // указатель двигался (docs §5.2).
  const offFrame = handle.onFrame(() => {
    if (!dirty) return;
    dirty = false;
    setHover(pointerInside ? raycastInstance() : null);
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
    const mn = meshAndNodes();
    if (!mn) return;
    const id = hoveredId ?? raycastInstance();
    if (id === null) return;
    const node = mn.nodes[id];
    if (!node) return;
    // Drill только в реальные папки. Агрегированное «Прочее» и файлы — не районы.
    const aggregated = node.flags.includes("aggregated");
    if (node.isDir && !aggregated) {
      mn.mesh.getMatrixAt(id, m);
      m.decompose(pos, quat, scale);
      cb.onDrill(node, new Vector3(pos.x, 0, pos.z));
    }
  }

  const canvas = handle.canvas;
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);

  return {
    hoverAnchor() {
      if (hoveredId === null) return null;
      const mn = meshAndNodes();
      if (!mn) return null;
      mn.mesh.getMatrixAt(hoveredId, m);
      m.decompose(pos, quat, scale);
      return new Vector3(pos.x, pos.y + scale.y / 2, pos.z);
    },
    clearHover() {
      hoveredId = null;
      highlight.visible = false;
      cb.onHover(null);
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
