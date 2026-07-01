/**
 * Бутстрап управляемой 3D-сцены (фазы 0–1).
 *
 * Это императивный 3D-мир. Он НЕ дёргает DOM/Svelte напрямую — связь только
 * через стор (см. docs/SectorCity-tech.md §1). Здесь живут renderer, камера,
 * MapControls (с ограниченным наклоном), единый цикл рендера на rAF (он же
 * крутит твины камеры и зарегистрированные покадровые колбэки) и реакция на
 * resize. Наполнение «городом» — отдельный слой (city.ts); взаимодействие
 * (raycast/hover/drill) — interaction.ts; сцена лишь даёт им контейнер и сервисы.
 */
import {
  AmbientLight,
  Color,
  DirectionalLight,
  Group,
  type Object3D,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Easing, Group as TweenGroup, Tween } from "@tweenjs/tween.js";
import { INITIAL_CAMERA_POS, INITIAL_TARGET } from "./home";

/** Ручка управления сценой для владельца (Svelte-компонента) и слоёв. */
export interface SceneHandle {
  /** Контейнер для контента уровня (город). Город добавляет сюда меши. */
  readonly content: Group;
  /** Камера сцены (нужна для raycast и проекции тултипа). */
  readonly camera: PerspectiveCamera;
  /** Canvas рендера (нужен для координат указателя и размеров вьюпорта). */
  readonly canvas: HTMLCanvasElement;
  /** Добавить объект прямо в сцену (напр. highlight-mesh, живущий вне уровней). */
  add(object: Object3D): void;
  /** Зарегистрировать покадровый колбэк; возвращает функцию отписки. */
  onFrame(cb: () => void): () => void;
  /**
   * Плавно перевести камеру (позиция + цель) за `ms`. Резолвится по прилёте.
   * `onArrive` (если задан) вызывается СИНХРОННО в кадре завершения, до повторного
   * включения контролов и резолва — туда навигатор кладёт rebase (origin shift),
   * чтобы нормировка координат прошла без видимого кадра «до». `onProgress` (если
   * задан) зовётся КАЖДЫЙ кадр твина с СЫРЫМ прогрессом `p∈[0,1]` (без сглаживания —
   * easing к камере применяется здесь же): туда навигатор вешает сопутствующие
   * анимации drill/up (затемнение периметра, снятие купола), чтобы они занимали ровно
   * тот же отрезок, что и зум.
   */
  flyTo(
    position: Vector3,
    target: Vector3,
    ms: number,
    onArrive?: () => void,
    onProgress?: (p: number) => void,
  ): Promise<void>;
  /** Жёстко поставить камеру (позиция + цель) и обновить контролы. */
  placeCamera(position: Vector3, target: Vector3): void;
  /** Спроецировать мировую точку в пиксели canvas; `visible` — точка перед камерой. */
  worldToScreen(v: Vector3): { x: number; y: number; visible: boolean };
  /** Вернуть камеру в исходный обзорный ракурс. */
  resetView(): void;
  /** Освободить GPU-ресурсы и снять слушатели. Вызывать при размонтировании. */
  dispose(): void;
}

/**
 * Поднять сцену в переданном `<canvas>`. Возвращает ручку управления;
 * владелец обязан вызвать `dispose()` при размонтировании.
 */
export function createScene(canvas: HTMLCanvasElement): SceneHandle {
  // `powerPreference: "high-performance"` — подсказка вебвью/ОС выбрать ДИСКРЕТНУЮ
  // GPU, а не встроенную (на ноутбуках с переключаемой графикой WebGL по умолчанию
  // часто садится на iGPU). На WebView2/Chromium это маппится в DXGI-предпочтение
  // high-performance. `failIfMajorPerformanceCaveat: false` — не падать в софт-рендер.
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
    failIfMajorPerformanceCaveat: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new Scene();
  scene.background = new Color(0x080808); // = --bg (Nothing deep black, синхр. с DOM)

  // Окружение (IBL) для PBR-материалов: без него металл-ободок купола рендерится
  // ЧЁРНЫМ (у металла нет диффуза — только отражения), а стекло не ловит fresnel.
  // `RoomEnvironment` — лёгкая процедурная «студия»; PMREM генерится один раз.
  // Lambert-материалы города (здания/земля) envMap игнорируют → остаются матовыми.
  const pmrem = new PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;

  // far большой: декор (родительский уровень) после origin shift раздут в 1/s и
  // выглядывает по краям холста — он должен оставаться в пределах отсечения.
  const camera = new PerspectiveCamera(50, 1, 0.1, 20000);
  camera.position.copy(INITIAL_CAMERA_POS);

  // Свет: мягкая заливка + направленный, чтобы читались грани зданий.
  scene.add(new AmbientLight(0xffffff, 0.6));
  const sun = new DirectionalLight(0xffffff, 1.1);
  sun.position.set(80, 200, 120);
  scene.add(sun);

  const content = new Group();
  scene.add(content);

  // MapControls: панорама как на карте, наклон ограничен — нельзя уйти под
  // землю и нельзя сорваться в строго-верхний вид (читаемость высоты зданий).
  const controls = new MapControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minPolarAngle = 0.35; // ~20° от вертикали
  controls.maxPolarAngle = 1.35; // ~77°, чуть выше горизонта
  controls.minDistance = 30;
  controls.maxDistance = 1200;
  controls.target.copy(INITIAL_TARGET);
  controls.update();

  // WASD-панорама камеры (игровая раскладка вместо стрелок). Держим в 3D-слое,
  // как и мышиные MapControls, — это управление камерой, а не UI-хоткей. Ключи по
  // `event.code` (физическая позиция) → работает на любой раскладке (в т.ч. ЙЦУКЕН).
  // Плавное движение: набор зажатых кодов + интегрирование в кадре (damping даёт
  // инерцию через сам controls.update). Скорость масштабируем расстоянием до цели,
  // чтобы панорама ощущалась одинаково на любом зуме.
  const PAN_CODES: Record<string, [number, number]> = {
    KeyW: [0, 1], // вперёд (от камеры)
    KeyS: [0, -1], // назад
    KeyA: [-1, 0], // влево
    KeyD: [1, 0], // вправо
  };
  // Зум с клавиатуры «+/−» — чистый дубль колеса мыши (приблизить/отдалить). Коды
  // физические: «=/+» (Equal) и «-» (Minus) + их numpad-варианты, поэтому раскладка
  // и Shift не важны. Приближение = уменьшение дистанции до цели (в границах контролов).
  const ZOOM_CODES: Record<string, number> = {
    Equal: 1,
    NumpadAdd: 1, // приблизить
    Minus: -1,
    NumpadSubtract: -1, // отдалить
  };
  const panHeld = new Set<string>();
  const zoomHeld = new Set<string>();
  const panForward = new Vector3();
  const panRight = new Vector3();
  const panMove = new Vector3();
  const camOffset = new Vector3();
  const WORLD_UP = new Vector3(0, 1, 0);
  /** Доля дистанции до цели, проходимая за кадр при полном нажатии (≈60 к/с). */
  const PAN_SPEED = 0.012;
  /** Доля дистанции, на которую «наезжает» зум за кадр удержания «+/−». */
  const ZOOM_RATE = 0.03;

  /** Фокус в текстовом поле — тогда WASD это набор текста, камеру не двигаем. */
  function isTypingTarget(): boolean {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      el.isContentEditable
    );
  }
  function onPanKeyDown(e: KeyboardEvent) {
    // Ctrl/Alt/Meta-комбинации — это хоткеи (Ctrl+W и пр.), не управление камерой.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget()) return;
    if (e.code in PAN_CODES) panHeld.add(e.code);
    else if (e.code in ZOOM_CODES) zoomHeld.add(e.code);
  }
  function onPanKeyUp(e: KeyboardEvent) {
    panHeld.delete(e.code);
    zoomHeld.delete(e.code);
  }
  // Сброс при потере фокуса окна: иначе «залипнет» зажатая клавиша.
  function onBlur() {
    panHeld.clear();
    zoomHeld.clear();
  }

  /** Проинтегрировать панораму за кадр по зажатым WASD (в плоскости земли). */
  function applyPan() {
    if (panHeld.size === 0 || !controls.enabled) return;
    // forward = направление камеры, спроецированное на землю (XZ); right ⟂ ему.
    camera.getWorldDirection(panForward);
    panForward.y = 0;
    if (panForward.lengthSq() < 1e-6) return; // взгляд строго вниз — пропускаем
    panForward.normalize();
    panRight.crossVectors(panForward, WORLD_UP).normalize();
    let fwd = 0;
    let strafe = 0;
    for (const code of panHeld) {
      const [sx, sz] = PAN_CODES[code];
      strafe += sx;
      fwd += sz;
    }
    if (fwd === 0 && strafe === 0) return;
    const step = camera.position.distanceTo(controls.target) * PAN_SPEED;
    panMove
      .set(0, 0, 0)
      .addScaledVector(panForward, fwd)
      .addScaledVector(panRight, strafe);
    if (panMove.lengthSq() === 0) return;
    panMove.normalize().multiplyScalar(step);
    camera.position.add(panMove);
    controls.target.add(panMove);
  }

  /** Проинтегрировать зум за кадр по зажатым «+/−» (дубль колеса): двигаем камеру
   *  вдоль луча к цели, дистанцию клампим границами контролов. */
  function applyZoom() {
    if (zoomHeld.size === 0 || !controls.enabled) return;
    let dir = 0;
    for (const code of zoomHeld) dir += ZOOM_CODES[code];
    if (dir === 0) return; // «+» и «−» одновременно — гасят друг друга
    camOffset.copy(camera.position).sub(controls.target);
    const dist = camOffset.length();
    if (dist < 1e-6) return;
    const factor = dir > 0 ? 1 - ZOOM_RATE : 1 + ZOOM_RATE;
    const next = Math.max(
      controls.minDistance,
      Math.min(controls.maxDistance, dist * factor),
    );
    camOffset.setLength(next);
    camera.position.copy(controls.target).add(camOffset);
  }

  window.addEventListener("keydown", onPanKeyDown);
  window.addEventListener("keyup", onPanKeyUp);
  window.addEventListener("blur", onBlur);

  // Твины камеры (drill-зум) и покадровые колбэки слоёв крутятся в этом же rAF.
  const tweens = new TweenGroup();
  const frameCallbacks = new Set<() => void>();

  /** Подогнать буфер рендера и аспект под фактический размер canvas. */
  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  let running = true;
  function tick() {
    if (!running) return;
    tweens.update();
    applyPan();
    applyZoom();
    controls.update();
    for (const cb of frameCallbacks) cb();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  return {
    content,
    camera,
    canvas,
    add(object) {
      scene.add(object);
    },
    onFrame(cb) {
      frameCallbacks.add(cb);
      return () => frameCallbacks.delete(cb);
    },
    flyTo(position, target, ms, onArrive, onProgress) {
      return new Promise((resolve) => {
        // На время перелёта глушим пользовательский ввод, чтобы не драться с твином.
        controls.enabled = false;
        const camFrom = camera.position.clone();
        const tgtFrom = controls.target.clone();
        const t = { p: 0 };
        new Tween(t, tweens)
          .to({ p: 1 }, ms)
          // Easing применяем ВРУЧНУЮ к камере (Cubic.InOut, как раньше) — чтобы в
          // `onProgress` отдать СЫРОЙ прогресс: сопутствующие анимации навигатора
          // ведут собственные кривые, но на том же отрезке времени.
          .onUpdate(() => {
            const e = Easing.Cubic.InOut(t.p);
            camera.position.lerpVectors(camFrom, position, e);
            controls.target.lerpVectors(tgtFrom, target, e);
            onProgress?.(t.p);
          })
          .onComplete(() => {
            // rebase идёт ДО повторного включения контролов и резолва, в этом же
            // кадре — следующий render уже нормированный (origin shift невидим).
            onArrive?.();
            controls.enabled = true;
            resolve();
          })
          .start();
      });
    },
    placeCamera(position, target) {
      camera.position.copy(position);
      controls.target.copy(target);
      controls.update();
    },
    worldToScreen(v) {
      const p = v.clone().project(camera);
      return {
        x: (p.x * 0.5 + 0.5) * (canvas.clientWidth || 1),
        y: (-p.y * 0.5 + 0.5) * (canvas.clientHeight || 1),
        visible: p.z < 1,
      };
    },
    resetView() {
      camera.position.copy(INITIAL_CAMERA_POS);
      controls.target.copy(INITIAL_TARGET);
      controls.update();
    },
    dispose() {
      running = false;
      frameCallbacks.clear();
      window.removeEventListener("keydown", onPanKeyDown);
      window.removeEventListener("keyup", onPanKeyUp);
      window.removeEventListener("blur", onBlur);
      observer.disconnect();
      controls.dispose();
      envRT.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
