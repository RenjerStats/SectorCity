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
  BufferGeometry,
  Float32BufferAttribute,
  type InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Object3D,
  PointLight,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
} from "three";
import type { ScanNode } from "../ipc/contract";
import type { CityView, PickInfo } from "./city";
import type { SceneHandle } from "./scene";
import { activeView, isInteractive } from "./navigator";
import { THEMES_3D } from "./theme";
import { theme } from "../store/settings";
import { quality } from "./quality";
import {
  cursorLightColor,
  cursorLightIntensity,
  cursorLightPos,
} from "./cursor-light-shared";

/** Колбэки наружу: владелец заворачивает их в стор / машину режимов. */
export interface InteractionCallbacks {
  /** Наведение сменилось (узел или `null`, когда курсор ушёл со зданий). */
  onHover(node: ScanNode | null): void;
  /** Клик по району (папке) ИЛИ по блоку «Прочее» → drill (навигатор сам считает
   *  зум; «Прочее» бэк раскрывает по синтетическому пути в его хвост). */
  onDrill(node: ScanNode): void;
  /** Клик по зданию-файлу → SELECT (карточка над зданием); `null` = снять выбор
   *  (клик мимо зданий). Район и «Прочее» уходят в `onDrill`, не сюда. */
  onSelect(node: ScanNode | null): void;
  /** Активен ли режим сканера мусора (включает пометку по Ctrl+ЛКМ). */
  isCleanup(): boolean;
  /** Режим cleanup: Ctrl+ЛКМ по узлу (файлу ИЛИ папке-району) — пометить/снять
   *  на снос. Обычный ЛКМ ведёт себя как в стандартном режиме (карточка/drill),
   *  чтобы не путать пользователя; пометка также доступна через ПКМ-меню. */
  onMark(node: ScanNode): void;
  /**
   * ПКМ по узлу (vision §I.10): открыть контекстное меню. `info` — узел под
   * курсором и его цель-drill (район), либо `null` (клик мимо зданий → меню не
   * нужно). `x`/`y` — экранные координаты курсора для позиционирования меню.
   */
  onContext(info: PickInfo | null, x: number, y: number): void;
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
  /**
   * Выбрать узел, на котором было открыто контекстное меню (пункт «Свойства» →
   * карточка). Использует Hit, пойманный при ПКМ, поэтому карточка корректно
   * заякоривается над зданием. No-op, если ПКМ не по зданию.
   */
  selectContext(): void;
  /**
   * Выбрать НАВЕДЁННЫЙ узел (хоткей «Свойства» = Space). Использует текущий hover-
   * Hit, поэтому карточка заякоривается над зданием. No-op, если ничего не наведено.
   */
  selectHovered(): void;
  /** Снять слушатели и освободить ресурсы highlight-mesh. */
  dispose(): void;
}

/** Порог в пикселях: смещение больше — это перетаскивание камеры, не клик. */
const CLICK_SLOP = 5;

/**
 * Геометрия обводки — «уголки-визир» (corner brackets): из каждого угла единичного
 * бокса ([-0.5…0.5]³) три коротких луча вдоль сходящихся рёбер. Читается как
 * технический прицел/скобки (эстетика Nothing/dot-matrix), а не сплошная рамка.
 * Масштабируется матрицей инстанса, поэтому длина уголков пропорциональна сторонам
 * здания (уголки «обнимают» углы, центр рёбер открыт).
 */
function makeReticleGeometry(): BufferGeometry {
  const s = 0.5;
  const arm = 0.22; // доля половины стороны, которую занимает один луч уголка
  const signs = [-1, 1];
  const p: number[] = [];
  for (const sx of signs) {
    for (const sy of signs) {
      for (const sz of signs) {
        const cx = sx * s;
        const cy = sy * s;
        const cz = sz * s;
        p.push(cx, cy, cz, cx - sx * arm, cy, cz); // луч вдоль X
        p.push(cx, cy, cz, cx, cy - sy * arm, cz); // луч вдоль Y
        p.push(cx, cy, cz, cx, cy, cz - sz * arm); // луч вдоль Z
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(p, 3));
  return g;
}

/** Попадание raycast: меш уровня + индекс инстанса в нём. */
interface Hit {
  mesh: InstancedMesh;
  id: number;
  point?: Vector3;
  normal?: Vector3;
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
  // Старт нажатия ПКМ — чтобы отличить вращение сцены (MapControls RIGHT=ROTATE) от
  // клика: если к моменту contextmenu курсор ушёл дальше порога, меню не открываем.
  let rightDown: { x: number; y: number } | null = null;
  // Hit + узел, пойманные при ПКМ (для пункта меню «Свойства» → карточка).
  let lastContext: { hit: Hit; node: ScanNode } | null = null;

  // Один highlight-mesh: «уголки-визир» вокруг наведённого инстанса (трансформ =
  // его матрица). Форма-прицел + акцентный цвет темы вместо белой рамки — «под стиль».
  const highlightMat = new LineBasicMaterial({
    color: THEMES_3D[theme.get()].accent,
  });
  const highlight = new LineSegments(makeReticleGeometry(), highlightMat);
  highlight.visible = false;
  highlight.matrixAutoUpdate = false;
  handle.add(highlight);

  // Временный точечный источник света, привязанный к курсору.
  // Изначально интенсивность 0 (выключен), но видимость включена (visible=true),
  // чтобы избежать повторной компиляции шейдеров при включении/выключении источника.
  const cursorLight = new PointLight(THEMES_3D[theme.get()].accent, 0, 75);
  handle.add(cursorLight);

  // Обводка следует за темой (стор-мост, docs §1): при смене темы перекрашиваем
  // акцент визира. subscribe шлёт текущее значение сразу — цвет всегда актуален.
  const unsubTheme = theme.subscribe((name) => {
    const accentColor = THEMES_3D[name].accent;
    highlightMat.color.setHex(accentColor);
    cursorLight.color.setHex(accentColor);
  });

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
      // Скрытые LOD-инстансы (scale=0) вырождены и не дают пересечения; hits
      // отсортированы по дистанции (intersectObjects) — идём от ближнего к дальнему.
      if (h.instanceId == null) continue;
      const mesh = h.object as InstancedMesh;
      // Вложенные превью-домики под куполом прозрачны для пикинга: пропускаем их,
      // чтобы курсор упирался в купол/плиту папки, а не в содержимое под стеклом
      // (надёжное и предсказуемое наведение вместо случайного зацепа при ракурсе).
      if (!view.isPickTarget(mesh, h.instanceId)) continue;

      let normal: Vector3 | undefined;
      if (h.face) {
        normal = h.face.normal.clone();
        const instanceMatrix = new Matrix4();
        mesh.getMatrixAt(h.instanceId, instanceMatrix);
        normal.transformDirection(instanceMatrix);
      }
      return {
        mesh,
        id: h.instanceId,
        point: h.point.clone(),
        normal,
      };
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

  function getCursorTarget(): { point: Vector3; normal: Vector3 } | null {
    if (!pointerInside || !isInteractive(handle.content)) return null;
    const view = activeView(handle.content);
    if (!view) return null;

    const targets: Object3D[] = [];
    handle.content.traverse((obj) => {
      if (obj.userData.view) {
        const levelView = obj.userData.view as CityView;
        targets.push(...levelView.allVisualMeshes());
      }
      if (obj.name === "ground" && obj.visible) {
        targets.push(obj);
      }
    });

    if (targets.length === 0) return null;
    raycaster.setFromCamera(pointer, handle.camera);
    const hits = raycaster.intersectObjects(targets, false);
    for (const h of hits) {
      let meshView = view;
      let parent: Object3D | null = h.object.parent;
      while (parent) {
        if (parent.userData.view) {
          meshView = parent.userData.view as CityView;
          break;
        }
        parent = parent.parent;
      }

      if (h.object.type === "InstancedMesh") {
        const mesh = h.object as InstancedMesh;
        if (h.instanceId == null || !meshView.isPickTarget(mesh, h.instanceId)) continue;
      }

      if (h.face) {
        const normal = h.face.normal.clone();
        if (h.object.type === "InstancedMesh") {
          const instanceMatrix = new Matrix4();
          (h.object as InstancedMesh).getMatrixAt(h.instanceId!, instanceMatrix);
          normal.transformDirection(instanceMatrix);
        } else {
          normal.transformDirection(h.object.matrixWorld);
        }
        return {
          point: h.point.clone(),
          normal,
        };
      }
    }
    return null;
  }

  function updateCursorLight(): void {
    const target = quality.level === "experimental" ? getCursorTarget() : null;
    if (target) {
      const offset = 3.5;
      cursorLight.position.copy(target.point).addScaledVector(target.normal, offset);
      cursorLight.intensity = 120;

      // Обновляем разделяемые юниформы
      cursorLightPos.value.copy(cursorLight.position);
      cursorLightIntensity.value = cursorLight.intensity;
      cursorLightColor.value.copy(cursorLight.color);
    } else {
      cursorLight.intensity = 0;

      // Обновляем разделяемые юниформы
      cursorLightIntensity.value = 0;
    }
  }

  function setHover(hit: Hit | null): void {
    if (sameHit(hit, hovered)) {
      if (hit) {
        applyHighlight(hit); // камера могла сдвинуться — освежить
      }
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
    updateCursorLight();
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
    if (e.button === 2) {
      // Запоминаем старт ПКМ для различения «поворот камеры» vs «клик» (см. rightDown).
      rightDown = { x: e.clientX, y: e.clientY };
      return;
    }
    if (e.button !== 0) return; // прочие кнопки нам не интересны
    down = { x: e.clientX, y: e.clientY }; // ЛКМ — клик/drill
  }
  function onUp(e: PointerEvent): void {
    if (e.button !== 0 || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > CLICK_SLOP) return; // это был пан камеры, не клик
    // Ctrl (или ⌘ на mac) — модификатор пометки на снос в режиме cleanup.
    pick(e.ctrlKey || e.metaKey);
  }

  /** ПКМ: разрешить узел под курсором (точно по координатам события) и открыть
   *  контекстное меню (vision §I.10). Не трогает выбор/наведение — это отдельный
   *  канал. Браузерное меню подавляем (`preventDefault`). */
  function onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    // Вращение сцены ПКМ-драгом не должно оканчиваться кликом/меню: если между
    // нажатием ПКМ и его отпусканием курсор сместился дальше порога — это был поворот
    // камеры, а не клик по объекту. Меню в этом случае не открываем.
    const rd = rightDown;
    rightDown = null;
    if (rd && Math.hypot(e.clientX - rd.x, e.clientY - rd.y) > CLICK_SLOP) {
      dirty = true; // вернуть наведение к фактической позиции после поворота
      return;
    }
    lastContext = null;
    const view = activeView(handle.content);
    if (!view || !isInteractive(handle.content)) {
      cb.onContext(null, e.clientX, e.clientY);
      return;
    }
    const rect = handle.canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    const hit = raycastHit();
    dirty = true; // вернуть наведение к фактической позиции на следующем кадре
    const info = hit ? view.resolvePick(hit.mesh, hit.id) : null;
    if (hit && info) lastContext = { hit, node: info.node };
    cb.onContext(info, e.clientX, e.clientY);
  }

  function pick(markModifier: boolean): void {
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
    // Режим сканера мусора: Ctrl+ЛКМ помечает УЗЕЛ ПОД КУРСОРОМ на снос — и файл,
    // и папку-район (проверка ДО drill-ветки, иначе папку не пометить). Обычный
    // ЛКМ ниже ведёт себя как в стандартном режиме (карточка/drill) — по фидбеку:
    // разная семантика ЛКМ путала, а папки было не выбрать.
    if (markModifier && cb.isCleanup()) {
      cb.onMark(info.node);
      return;
    }
    // Drill в реальные папки-районы И в навигируемый блок «Прочее» (бэк раскрывает
    // синтетический путь `{уровень}::<other>` в его хвост). Цель — drillTarget:
    // внутри вложенного превью это родительский район (не aggregated), поэтому клик
    // по «Прочее» в превью ведёт в район; «Прочее» верхнего уровня drill'ит само себя.
    const t = info.drillTarget;
    if (t.isDir || t.flags.includes("aggregated")) {
      setSelected(null); // уходим на новый уровень — старый выбор не актуален
      cb.onDrill(t);
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
  canvas.addEventListener("contextmenu", onContextMenu);

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
      cursorLight.intensity = 0;
    },
    clearSelection() {
      setSelected(null);
    },
    selectContext() {
      if (lastContext) setSelected(lastContext.hit, lastContext.node);
    },
    selectHovered() {
      if (!hovered) return;
      const view = activeView(handle.content);
      const info = view?.resolvePick(hovered.mesh, hovered.id);
      if (info) setSelected(hovered, info.node);
    },
    dispose() {
      offFrame();
      unsubTheme();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("contextmenu", onContextMenu);
      highlight.geometry.dispose();
      (highlight.material as LineBasicMaterial).dispose();
      cursorLight.parent?.remove(cursorLight);
    },
  };
}
