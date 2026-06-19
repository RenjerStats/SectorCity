/**
 * Бутстрап управляемой 3D-сцены (фаза 0).
 *
 * Это императивный 3D-мир. Он НЕ дёргает DOM/Svelte напрямую — связь только
 * через стор (см. docs/SectorCity-tech.md §1). Здесь живут renderer, камера,
 * MapControls (с ограниченным наклоном), цикл рендера на rAF и реакция на
 * resize. Наполнение «городом» — отдельный слой (city.ts), сцена лишь
 * предоставляет ему контейнер.
 */
import {
  AmbientLight,
  Color,
  DirectionalLight,
  Group,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";

/** Ручка управления сценой для владельца (Svelte-компонента). */
export interface SceneHandle {
  /** Контейнер для контента уровня (город). Город добавляет сюда меши. */
  readonly content: Group;
  /** Вернуть камеру в исходный обзорный ракурс. */
  resetView(): void;
  /** Освободить GPU-ресурсы и снять слушатели. Вызывать при размонтировании. */
  dispose(): void;
}

/** Исходный ракурс камеры — обзор города под лёгким наклоном. */
const INITIAL_CAMERA_POS = new Vector3(0, 140, 180);
const INITIAL_TARGET = new Vector3(0, 0, 0);

/**
 * Поднять сцену в переданном `<canvas>`. Возвращает ручку управления;
 * владелец обязан вызвать `dispose()` при размонтировании.
 */
export function createScene(canvas: HTMLCanvasElement): SceneHandle {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new Scene();
  scene.background = new Color(0x0e0f13);

  const camera = new PerspectiveCamera(50, 1, 0.1, 5000);
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
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  return {
    content,
    resetView() {
      camera.position.copy(INITIAL_CAMERA_POS);
      controls.target.copy(INITIAL_TARGET);
      controls.update();
    },
    dispose() {
      running = false;
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
    },
  };
}
