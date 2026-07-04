/**
 * Экспериментальный WebGPU-двойник управляемой сцены (уровень графики
 * `experimental`, quality.active.backend === "webgpu").
 *
 * Зачем отдельный модуль, а не ветка в scene.ts: `WebGPURenderer` — другой бэкенд
 * (нельзя переключить на живом canvas), его инициализация асинхронна, а
 * постобработка идёт через node-конвейер TSL (`RenderPipeline`), а не мёртвый на
 * WebGPU `EffectComposer`. Всё РЕНДЕР-НЕЗАВИСИМОЕ (камера, MapControls, WASD-
 * панорама, твины flyTo, проекция worldToScreen, цикл кадра) намеренно повторяет
 * scene.ts один-в-один — чтобы навигатор/взаимодействие/Svelte видели ИДЕНТИЧНЫЙ
 * `SceneHandle` и не различали бэкенд. Город/материалы (city.ts/buildings.ts)
 * импортируются из "three" и скармливаются сюда без изменений: three опознаёт
 * объекты по утиным флагам (`.isMesh`), WebGPURenderer их принимает.
 *
 * Отличия от scene.ts:
 *   - `WebGPURenderer` + `await init()` → фабрика асинхронная (`createSceneWebGPU`);
 *   - тени PCF (VSM на WebGPU ведёт себя иначе — держим надёжный PCF);
 *   - окружение через `PMREMGenerator` из "three/webgpu" (ядровый не знает про
 *     async-бэкенд); sigma МАЛЕНЬКАЯ — на webgpu-PMREM это радианы, 0.7 клипается;
 *   - постобработка: `RenderPipeline` + TSL `pass → ssgi → bloom` (SSGI — экранное
 *     глобальное освещение, эксклюзив WebGPU; при сбое графа откат на bloom-only).
 *     Прежние «фантомные цвета» куполов дал не pass+transmission, а glassExtras
 *     (clearcoat/dispersion) — с чистым стеклом конвейер живёт (см. quality.ts);
 *   - свет контрастнее WebGL-сцены: ambient/env ниже, солнце ярче — глубокие
 *     PCF-тени.
 */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  InstancedMesh,
  Mesh,
  MeshLambertMaterial,
  MeshPhysicalMaterial,
  type Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Vector3,
} from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { WebGPURenderer, PMREMGenerator, RenderPipeline } from "three/webgpu";
import {
  pass,
  mrt,
  output,
  normalView,
  diffuseColor,
  velocity,
  add,
  vec4,
} from "three/tsl";
import { bloom } from "three/examples/jsm/tsl/display/BloomNode.js";
import { ssgi } from "three/examples/jsm/tsl/display/SSGINode.js";
import { traa } from "three/examples/jsm/tsl/display/TRAANode.js";
import { Easing, Group as TweenGroup, Tween } from "@tweenjs/tween.js";
import { INITIAL_CAMERA_POS, INITIAL_TARGET } from "./home";
import { quality } from "./quality";
import { makeBuildingDef } from "./buildings";
import type { SceneHandle } from "./scene";

/**
 * Поднять WebGPU-сцену в переданном `<canvas>`. АСИНХРОННА (ждёт `renderer.init()`).
 * Возвращает тот же `SceneHandle`, что и `createScene`; владелец обязан вызвать
 * `dispose()` при размонтировании (или при откате на другой бэкенд).
 *
 * Бросает, если WebGPU недоступен/`init()` упал — вызывающий (Scene.svelte) ловит
 * и откатывается на `maximal` (см. пробу `webgpu-support.ts`).
 */
export async function createSceneWebGPU(
  canvas: HTMLCanvasElement,
): Promise<SceneHandle> {
  const renderer = new WebGPURenderer({ canvas, antialias: false });
  await renderer.init();

  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio, quality.active.pixelRatioCap),
  );
  renderer.shadowMap.enabled = quality.active.shadows;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new Scene();
  scene.background = new Color(0x080808);



  // Окружение (IBL). PMREM из "three/webgpu" (знает про async-бэкенд, вызывать
  // ПОСЛЕ init). sigma здесь — радианы: 0.7 клипается (нужно 341 сэмпл при максимуме
  // 20), поэтому берём малую и компенсируем ярко́сть ламп RoomEnvironment пониженной
  // environmentIntensity (иначе вернётся «выжженный» блик, как было на WebGL).
  let envDispose: (() => void) | null = null;
  try {
    const pmrem = new PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    // IBL ниже WebGL-сцены (0.5 → 0.35): env заполняет тени, а этому уровню нужен
    // контраст; сильнее не роняем — env питает отражения стекла/металла.
    scene.environmentIntensity = 0.35;
    envDispose = () => {
      envRT.dispose();
      pmrem.dispose();
    };
  } catch (err) {
    console.warn("[webgpu] PMREM/RoomEnvironment не завёлся:", err);
  }

  const camera = new PerspectiveCamera(50, 1, 0.1, 20000);
  camera.position.copy(INITIAL_CAMERA_POS);

  // Свет: схема как в scene.ts, но КОНТРАСТНЕЕ. Итерации по просьбам: спайк
  // (ambient 0.32/sun 1.2) → «глубже» (0.18/1.35) → «+30%» (0.12/env 0.40) →
  // «ещё +30%» (0.08/env 0.35). Низкая заливка + яркое солнце = выраженные
  // PCF-тени; тени в глубине дозаполняет SSGI (giIntensity, см. buildPipeline).
  const AMBIENT_SHADOWED = 0.08;
  const AMBIENT_NORMAL = 0.6;
  const ambient = new AmbientLight(
    0xffffff,
    quality.active.shadows ? AMBIENT_SHADOWED : AMBIENT_NORMAL,
  );
  scene.add(ambient);
  const sun = new DirectionalLight(0xffffff, 1.35);
  sun.position.set(80, 120, 120);
  scene.add(sun);
  scene.add(sun.target);
  const SHADOW_EXTENT = 180;
  sun.castShadow = quality.active.shadows;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.left = -SHADOW_EXTENT;
  sun.shadow.camera.right = SHADOW_EXTENT;
  sun.shadow.camera.top = SHADOW_EXTENT;
  sun.shadow.camera.bottom = -SHADOW_EXTENT;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 900;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.3;
  sun.shadow.radius = 4;
  sun.shadow.camera.updateProjectionMatrix();

  const content = new Group();
  scene.add(content);

  // ── MapControls + WASD-панорама + зум «+/−» (идентично scene.ts) ────────────
  const controls = new MapControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minPolarAngle = 0.35;
  controls.maxPolarAngle = 1.35;
  controls.minDistance = 30;
  controls.maxDistance = 1200;
  controls.target.copy(INITIAL_TARGET);
  controls.update();

  const PAN_CODES: Record<string, [number, number]> = {
    KeyW: [0, 1],
    KeyS: [0, -1],
    KeyA: [-1, 0],
    KeyD: [1, 0],
  };
  const ZOOM_CODES: Record<string, number> = {
    Equal: 1,
    NumpadAdd: 1,
    Minus: -1,
    NumpadSubtract: -1,
  };
  const panHeld = new Set<string>();
  const zoomHeld = new Set<string>();
  const panForward = new Vector3();
  const panRight = new Vector3();
  const panMove = new Vector3();
  const camOffset = new Vector3();
  const WORLD_UP = new Vector3(0, 1, 0);
  const PAN_SPEED = 0.012;
  const ZOOM_RATE = 0.03;

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
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget()) return;
    if (e.code in PAN_CODES) panHeld.add(e.code);
    else if (e.code in ZOOM_CODES) zoomHeld.add(e.code);
  }
  function onPanKeyUp(e: KeyboardEvent) {
    panHeld.delete(e.code);
    zoomHeld.delete(e.code);
  }
  function onBlur() {
    panHeld.clear();
    zoomHeld.clear();
  }
  function applyPan() {
    if (panHeld.size === 0 || !controls.enabled) return;
    camera.getWorldDirection(panForward);
    panForward.y = 0;
    if (panForward.lengthSq() < 1e-6) return;
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
  function applyZoom() {
    if (zoomHeld.size === 0 || !controls.enabled) return;
    let dir = 0;
    for (const code of zoomHeld) dir += ZOOM_CODES[code];
    if (dir === 0) return;
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

  // ── Постобработка: node-конвейер TSL (RenderPipeline). ──────────────────────
  // pass(scene,camera) с MRT (нормали) → SSGI (непрямой свет/контактное затенение,
  // эксклюзив WebGPU) → bloom. Граф SSGI на некоторых драйверах может не собраться —
  // тогда откат на bloom-only, затем на прямой рендер (устойчивость важнее эффекта).
  let pipeline: RenderPipeline | null = null;

  function buildPipeline(): void {
    if (!quality.active.post) return;
    try {
      // MRT сцены: beauty (output), диффуз-альбедо и нормали вида — их требует
      // композит SSGI, плюс velocity для темпорального денойза (TRAA). Нормали
      // кладём как есть (SSGINode сам делает `.rgb.normalize()` при сэмпле).
      const scenePass = pass(scene, camera);
      scenePass.setMRT(
        mrt({ output, diffuseColor, normal: normalView, velocity }),
      );
      const colorNode = scenePass.getTextureNode("output");
      const diffuseNode = scenePass.getTextureNode("diffuseColor");
      const depthNode = scenePass.getTextureNode("depth");
      const normalNode = scenePass.getTextureNode("normal");
      const velocityNode = scenePass.getTextureNode("velocity");

      let litNode = colorNode;
      if (quality.active.ssgi) {
        // SSGI отдаёт vec4(GI.rgb, AO.a) — НЕ готовую картинку. Композитим как в
        // офиц. примере: beauty·AO (затенение) + diffuse·GI (непрямой отражённый
        // свет). Без этого шага на экран уходил бы только шумный GI-член — сцена
        // была бы чёрной (прежний баг). SSGI темпоральный (jitter/кадр) →
        // разрешаем его TRAA-денойзом ниже, иначе видимый шум.
        const gi = ssgi(colorNode, depthNode, normalNode, camera);
        gi.sliceCount.value = 2; // качество среза (деф. 1) — как в примере
        gi.stepCount.value = 16; // шагов марша (деф. 12) — компромисс скорость/шум
        // Дефолт giIntensity=10 рассчитан на почти ТЁМНУЮ сцену офиц. примера
        // (point light + чёрный ambient, GI там — главный свет). Наш город уже
        // освещён (ambient+env+солнце) → 10 заливал тени и красил стекло куполов
        // «грязными» смесями цветов соседних зданий (bleeding ×10). Оставляем GI
        // лёгкой добавкой отражённого света, а не вторым солнцем.
        gi.giIntensity.value = 2.5;
        // Толщина поверхностей для марша (мир. ед.): при деф. 1 лучи «просачивались»
        // сквозь здания/купола толще 1 ед. → светлые протечки-пятна. Здания у нас
        // на порядок толще — поднимаем, протечек меньше.
        gi.thickness.value = 4;
        const giTex = gi.getTextureNode();
        const composite = vec4(
          add(colorNode.rgb.mul(giTex.a), diffuseNode.rgb.mul(giTex.rgb)),
          colorNode.a,
        );
        litNode = traa(composite, depthNode, velocityNode, camera);
      }
      // Bloom по HDR-бликам (порог 1.0 — светятся только >1, диффуз не трогает).
      // Тон-маппинг/sRGB накладывает сам RenderPipeline (outputColorTransform).
      const bl = bloom(litNode, 0.2, 0.4, 1.0);

      pipeline = new RenderPipeline(renderer);
      pipeline.outputNode = litNode.add(bl);
    } catch (err) {
      console.warn(
        "[webgpu] SSGI-конвейер не собрался — откат на bloom-only:",
        err,
      );
      try {
        const scenePass = pass(scene, camera);
        const colorNode = scenePass.getTextureNode();
        const bl = bloom(colorNode, 0.2, 0.4, 1.0);
        pipeline = new RenderPipeline(renderer);
        pipeline.outputNode = colorNode.add(bl);
      } catch (err2) {
        console.warn("[webgpu] bloom-конвейер тоже не собрался:", err2);
        pipeline = null;
      }
    }
  }

  function disposePipeline(): void {
    if (pipeline) {
      pipeline.dispose();
      pipeline = null;
    }
  }

  buildPipeline();

  // ── Цикл кадра, resize, твины (rAF, как в scene.ts). ────────────────────────
  const tweens = new TweenGroup();
  const frameCallbacks = new Set<() => void>();

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
    // render() синхронный (команды очередятся на устройстве) — рекомендованный
    // путь r181+ вместо renderAsync(), раз бэкенд уже инициализирован (await init).
    if (pipeline) pipeline.render();
    else renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  function flyTo(
    position: Vector3,
    target: Vector3,
    ms: number,
    onArrive?: () => void,
    onProgress?: (p: number) => void,
  ): Promise<void> {
    return new Promise((resolve) => {
      controls.enabled = false;
      const camFrom = camera.position.clone();
      const tgtFrom = controls.target.clone();
      const t = { p: 0 };
      new Tween(t, tweens)
        .to({ p: 1 }, ms)
        .onUpdate(() => {
          const e = Easing.Cubic.InOut(t.p);
          camera.position.lerpVectors(camFrom, position, e);
          controls.target.lerpVectors(tgtFrom, target, e);
          onProgress?.(t.p);
        })
        .onComplete(() => {
          onArrive?.();
          controls.enabled = true;
          resolve();
        })
        .start();
    });
  }

  return {
    content,
    camera,
    canvas,
    add(object: Object3D) {
      scene.add(object);
    },
    onFrame(cb) {
      frameCallbacks.add(cb);
      return () => frameCallbacks.delete(cb);
    },
    flyTo,
    placeCamera(position, target) {
      camera.position.copy(position);
      controls.target.copy(target);
      controls.update();
    },
    cameraTarget() {
      return controls.target.clone();
    },
    worldToScreen(v) {
      const p = v.clone().project(camera);
      return {
        x: (p.x * 0.5 + 0.5) * (canvas.clientWidth || 1),
        y: (-p.y * 0.5 + 0.5) * (canvas.clientHeight || 1),
        visible: p.z < 1,
      };
    },
    async compile() {
      // Создаем геометрию и материалы для «прогрева» кэша WebGPU.
      // Нам нужно прогреть 3 конфигурации купола, чтобы при drill/up рантайм не зависал.
      const testGeo = new SphereGeometry(1, 4, 4);

      const createTestMat = (flight: boolean) => {
        if (quality.active.frostedGlass) {
          const mat = new MeshPhysicalMaterial({
            metalness: 0,
            roughness: 0.38, // GLASS_ROUGHNESS
            transmission: 1,
            thickness: 6,
            ior: quality.active.glassExtras ? 1.5 : 1.45,
            transparent: true,
            side: DoubleSide,
            depthWrite: !flight,
            envMapIntensity: 0.45,
          });
          if (quality.active.glassExtras) {
            mat.attenuationColor = new Color(0xbfd3d9); // GLASS_ATTENUATION_COLOR
            mat.attenuationDistance = 40; // GLASS_ATTENUATION_DISTANCE
            mat.clearcoat = 0.5;
            mat.clearcoatRoughness = 0.3;
            mat.dispersion = 0.35; // GLASS_DISPERSION
          }
          if (flight) mat.color.set(0xcfd2d6); // GLASS_COLOR
          return mat;
        } else {
          const mat = new MeshLambertMaterial({
            transparent: true,
            opacity: 0.28, // CHEAP_DOME_OPACITY
            depthWrite: false,
          });
          if (flight) mat.color.set(0xcfd2d6); // GLASS_COLOR
          return mat;
        }
      };

      const meshFlight = new Mesh(testGeo, createTestMat(true));
      const instMeshFlight = new InstancedMesh(testGeo, createTestMat(true), 1);
      const instMeshStatic = new InstancedMesh(testGeo, createTestMat(false), 1);

      scene.add(meshFlight);
      scene.add(instMeshFlight);
      scene.add(instMeshStatic);

      // Прогреваем также все категории зданий, чтобы при их появлении после окончания
      // анимации не происходило повторной компиляции и сборки геометрий в рантайме.
      const buildingMeshes: InstancedMesh[] = [];
      const CATEGORIES = [
        "other",
        "code",
        "document",
        "image",
        "video",
        "audio",
        "archive",
        "binary",
      ] as const;

      for (const cat of CATEGORIES) {
        const def = makeBuildingDef(cat);
        const instMesh = new InstancedMesh(def.geometry, def.materials, 1);
        scene.add(instMesh);
        buildingMeshes.push(instMesh);
      }

      try {
        await renderer.compileAsync(scene, camera);
      } catch (err) {
        console.warn("прекомпиляция шейдеров (webgpu) не удалась:", err);
      } finally {
        scene.remove(meshFlight);
        scene.remove(instMeshFlight);
        scene.remove(instMeshStatic);

        meshFlight.material.dispose();
        instMeshFlight.material.dispose();
        instMeshStatic.material.dispose();
        testGeo.dispose();

        for (const instMesh of buildingMeshes) {
          scene.remove(instMesh);
          if (Array.isArray(instMesh.material)) {
            instMesh.material.forEach((m) => m.dispose());
          } else {
            instMesh.material.dispose();
          }
        }
      }
    },
    applyQuality() {
      // На WebGPU-уровне применяем базовые параметры. Смена уровня НА другой бэкенд
      // обрабатывается ремоунтом сцены в Scene.svelte (этот handle тогда dispose'ится),
      // поэтому здесь — только то, что осмысленно в пределах experimental.
      renderer.setPixelRatio(
        Math.min(window.devicePixelRatio, quality.active.pixelRatioCap),
      );
      renderer.shadowMap.enabled = quality.active.shadows;
      sun.castShadow = quality.active.shadows;
      ambient.intensity = quality.active.shadows
        ? AMBIENT_SHADOWED
        : AMBIENT_NORMAL;
      disposePipeline();
      buildPipeline();
      resize();
    },
    resetView(ms) {
      if (ms && ms > 0) {
        void flyTo(INITIAL_CAMERA_POS.clone(), INITIAL_TARGET.clone(), ms);
        return;
      }
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
      disposePipeline();
      envDispose?.();
      renderer.dispose();
    },
  };
}
