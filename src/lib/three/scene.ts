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
      observer.disconnect();
      controls.dispose();
      envRT.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
