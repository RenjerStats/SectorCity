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
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { Easing, Group as TweenGroup, Tween } from "@tweenjs/tween.js";

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
  /** Плавно перевести камеру (позиция + цель) за `ms`. Резолвится по прилёте. */
  flyTo(position: Vector3, target: Vector3, ms: number): Promise<void>;
  /** Спроецировать мировую точку в пиксели canvas; `visible` — точка перед камерой. */
  worldToScreen(v: Vector3): { x: number; y: number; visible: boolean };
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
    flyTo(position, target, ms) {
      return new Promise((resolve) => {
        // На время перелёта глушим пользовательский ввод, чтобы не драться с твином.
        controls.enabled = false;
        const camFrom = camera.position.clone();
        const tgtFrom = controls.target.clone();
        const t = { p: 0 };
        new Tween(t, tweens)
          .to({ p: 1 }, ms)
          .easing(Easing.Cubic.InOut)
          .onUpdate(() => {
            camera.position.lerpVectors(camFrom, position, t.p);
            controls.target.lerpVectors(tgtFrom, target, t.p);
          })
          .onComplete(() => {
            controls.enabled = true;
            resolve();
          })
          .start();
      });
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
      renderer.dispose();
    },
  };
}
