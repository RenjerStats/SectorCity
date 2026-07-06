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
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HalfFloatType,
  InstancedMesh,
  Mesh,
  MeshLambertMaterial,
  MeshPhysicalMaterial,
  type Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  VSMShadowMap,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { Easing, Group as TweenGroup, Tween } from "@tweenjs/tween.js";
import { INITIAL_CAMERA_POS, INITIAL_TARGET } from "./home";
import { quality } from "./quality";
import {
  makeBuildingDef,
  releaseBuildingMaterials,
  type BuildingDef,
} from "./buildings";
import type { Category } from "../ipc/contract";

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
  /** Текущая цель орбиты (клон) — для компаса/поворота камеры «на север». */
  cameraTarget(): Vector3;
  /** Спроецировать мировую точку в пиксели canvas; `visible` — точка перед камерой. */
  worldToScreen(v: Vector3): { x: number; y: number; visible: boolean };
  /**
   * Прекомпилировать шейдеры всего текущего содержимого сцены (transmission-стекло
   * куполов + PMREM — самые тяжёлые). Через `renderer.compileAsync` компиляция идёт
   * параллельно (`KHR_parallel_shader_compile`), не блокируя кадр, — вызывать после
   * первой сборки уровня и лишь потом снимать оверлей/фейд (план §1.2, jank первого
   * кадра после пересборки).
   */
  compile(): Promise<void>;
  /**
   * Применить активный уровень графики (`quality.active`) к рендеру: кап
   * pixelRatio, разрешение прохода transmission-стекла, тени (проход + тип карты
   * PCF/VSM) и постобработку (поднять/снять композер GTAO+bloom). Зовётся при
   * смене уровня в настройках. Материалы уровня (стекло/металл/PBR) подхватывает
   * пересборка города — не здесь. MSAA canvas не трогаем (нельзя без пересоздания
   * контекста); при композере сглаживание даёт мультисемплинг его таргета.
   */
  applyQuality(): void;
  /** Вернуть камеру в исходный обзорный ракурс. `ms > 0` — плавный твин
   *  (как drill), иначе мгновенно. */
  resetView(ms?: number): void;
  /** Освободить GPU-ресурсы и снять слушатели. Вызывать при размонтировании. */
  dispose(): void;
}

/**
 * Залогировать реальную видеокарту, обслуживающую WebGL-контекст (через
 * `WEBGL_debug_renderer_info` → `UNMASKED_RENDERER_WEBGL`). Диагностика форса
 * дискретной GPU: если в логе iGPU (Intel/AMD Radeon Graphics), значит
 * `powerPreference` + запись `UserGpuPreferences` в реестр не сработали. Ошибки
 * глотаем — расширение доступно не везде.
 */
function logGpuRenderer(renderer: WebGLRenderer): void {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (ext) {
      const name = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      console.info("[SectorCity] GPU (WebGL renderer):", name);
    }
  } catch {
    /* диагностика необязательна */
  }
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
  // Кап плотности пикселей и разрешение прохода transmission-стекла — из активного
  // уровня графики (`quality.active`). Кап срезает фрагменты на HiDPI (DPR 2 = 4×
  // пикселей); transmission куполов — второй полный проход opaque-сцены каждый кадр,
  // его таргет рендерим в доле разрешения (содержимое и так размыто «морозом» по
  // мипам, деградация почти не видна). Меняется живьём в `applyQuality`.
  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio, quality.active.pixelRatioCap),
  );
  renderer.transmissionResolutionScale =
    quality.active.transmissionResolutionScale;
  // Мягкие тени — включаются с высокого уровня (см. quality.active.shadows).
  // Тип карты по уровню: PCF + `shadow.radius` для мягкого края (высокий) или VSM
  // (максимальный) — там radius задаёт настоящий блюр карты, полутени шире и мягче.
  // (`PCFSoftShadowMap` в этой версии three депрекейчена.) Смена типа живьём
  // корректна: следом идёт пересборка города — все материалы-получатели новые.
  renderer.shadowMap.type = quality.active.vsmShadows
    ? VSMShadowMap
    : PCFShadowMap;
  renderer.shadowMap.enabled = quality.active.shadows;
  // ACES filmic tone mapping: без него значения >1 (блик на лаке/стекле, env-
  // отражение стали при почти-зеркальной roughness) режутся В ЖЁСТКИЙ БЕЛЫЙ
  // (`NoToneMapping` = линейный clamp) — отсюда «выжженные» пятна на высоком/
  // максимальном качестве (там впервые появляются clearcoat/PBR-металл). ACES даёт
  // мягкий плечевой спад у ярких бликов вместо обрезки — их площадь и резкость
  // заметно меньше. Действует на ВСЕХ уровнях (безвредно для матовых Lambert), но
  // заметнее всего там, где вообще есть яркие блики.
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  logGpuRenderer(renderer);

  const scene = new Scene();
  scene.background = new Color(0x080808); // = --bg (Nothing deep black, синхр. с DOM)

  // Окружение (IBL) для PBR-материалов: без него металл-ободок купола рендерится
  // ЧЁРНЫМ (у металла нет диффуза — только отражения), а стекло не ловит fresnel.
  // `RoomEnvironment` — лёгкая процедурная «студия»; PMREM генерится один раз.
  // Lambert-материалы города (здания/земля) envMap игнорируют → остаются матовыми.
  //
  // Sigma блюра 0.7 (было 0.04) — КЛЮЧЕВОЕ против «выжженного» пятна: в
  // RoomEnvironment стоят area-лампы с HDR-яркостью до ~50, и почти плоская крыша
  // купола отражала одну и ту же лампу всей площадью — никакие envMapIntensity/ACES
  // не спасали (50×0.45≈22 — всё равно клип в белый, а на максимальном это ещё и
  // корм для bloom → засветка на всю сцену). Сильный блюр размазывает лампы по
  // сфере: пик падает на порядок, отражения становятся мягкими градиентами.
  const pmrem = new PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.7);
  scene.environment = envRT.texture;
  // Env светит ВО ВСЕ СТОРОНЫ и картой теней не затеняется — это «бестеневой»
  // заполняющий свет, из-за которого тени на зданиях выцветали. Глушим его вдвое,
  // контраст света/тени возвращаем направленному солнцу (интенсивность ниже).
  scene.environmentIntensity = 0.5;

  // far большой: декор (родительский уровень) после origin shift раздут в 1/s и
  // выглядывает по краям холста — он должен оставаться в пределах отсечения.
  const camera = new PerspectiveCamera(50, 1, 0.1, 20000);
  camera.position.copy(INITIAL_CAMERA_POS);

  // Свет: мягкая заливка + направленный, чтобы читались грани зданий. Солнце стоит
  // под ~40° над горизонтом (не в зените): тени получаются ДЛИННЕЕ здания и явно
  // «уходят» в сторону от источника — их видно между зданиями и на земле (при
  // почти-зенитном свете тень пряталась под самим домом).
  // Заливка ambient гасит контраст тени: там, где включён просчёт теней (высокий/
  // максимальный), она ЗАМЕТНО слабее — тень освещена ТОЛЬКО ambient, и на 0.6 она
  // читалась еле-еле (жалоба «тени почти не видны»). Без теней (мин/оптимальный)
  // оставляем ambient как было — сдвигать общую яркость там незачем.
  const AMBIENT_NORMAL = 0.6;
  const AMBIENT_SHADOWED = 0.32;
  const ambient = new AmbientLight(
    0xffffff,
    quality.active.shadows ? AMBIENT_SHADOWED : AMBIENT_NORMAL,
  );
  scene.add(ambient);
  // Солнце — главный источник контраста свет/тень. 0.9 (при env, заглушенном до
  // 0.5, см. environmentIntensity выше): освещённая сторона заметно ярче тени —
  // тени на зданиях читаются, а не тонут в бестеневом env-заполнении. Специулярный
  // блик солнца на стекле/лаке при этой интенсивности ACES дожимает без клипа.
  const sun = new DirectionalLight(0xffffff, 0.9);
  sun.position.set(80, 120, 120);
  scene.add(sun);
  scene.add(sun.target); // цель в (0,0,0): фиксируем направление света и теней
  // Тени направленного света (высокий/максимальный; `castShadow` включает сам
  // просчёт). Ортокамера теней покрывает активный уровень (город центрирован в
  // начале координат после origin-shift) + вылет длинных теней наружу; заполняющий
  // ambient не даёт теням стать чёрными. bias/normalBias гасят «акне» на гранях
  // инстансированных боксов; `radius` даёт мягкий (не рваный) край — у PCF это
  // джиттер выборок, у VSM (максимальный) настоящий блюр карты, поэтому там радиус
  // больше.
  const SHADOW_EXTENT = 180; // полупролёт ортокамеры теней (мировые единицы)
  const PCF_SHADOW_RADIUS = 4;
  const VSM_SHADOW_RADIUS = 10;
  const shadowRadius = () =>
    quality.active.vsmShadows ? VSM_SHADOW_RADIUS : PCF_SHADOW_RADIUS;
  sun.castShadow = quality.active.shadows;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.left = -SHADOW_EXTENT;
  sun.shadow.camera.right = SHADOW_EXTENT;
  sun.shadow.camera.top = SHADOW_EXTENT;
  sun.shadow.camera.bottom = -SHADOW_EXTENT;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 900;
  sun.shadow.bias = -0.0005;
  // normalBias сдвигает точку выборки вдоль нормали — на 1.2 мировых единицы он
  // «снимал» тень с самих зданий (высота от 4): контактные тени здание-на-здание
  // исчезали, оставалась только тень на земле. Тексель карты ≈ 0.09 мировых единиц
  // (4096 на пролёт 360) — 0.3 (~3 текселя) хватает против акне на гранях боксов.
  sun.shadow.normalBias = 0.3;
  sun.shadow.radius = shadowRadius();
  sun.shadow.camera.updateProjectionMatrix();

  const content = new Group();
  scene.add(content);

  // MapControls: панорама как на карте, наклон ограничен — нельзя уйти под
  // землю и нельзя сорваться в строго-верхний вид (читаемость высоты зданий).
  const controls = new MapControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minPolarAngle = 0.35; // ~20° от вертикали
  controls.maxPolarAngle = 1.35; // ~77°, чуть выше горизонта
  // Границы зума СУЖЕНЫ ×2 (было 30/1200): не подлетать вплотную к зданиям и не
  // отъезжать так далеко, что город вырождается в пятно. LOD от границ не зависит.
  controls.minDistance = 60;
  controls.maxDistance = 600;
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

  // ── Постобработка (максимальный уровень, quality.active.post) ───────────────
  // EffectComposer, цепочка RenderPass → GTAO → bloom → OutputPass.
  //   - Таргет мультисемплим сами (samples=4, WebGL2): встроенный MSAA canvas при
  //     рендере через композер не участвует. HalfFloat — HDR-конвейер, чтобы bloom
  //     видел значения >1; OutputPass делает tone mapping + sRGB.
  //   - GTAO — контактное затенение в стыках зданий/плит/земли; radius в мировых
  //     единицах (здания — единицы…десятки при CITY_SPAN=200). Стеклянные купола
  //     попадают в G-buffer как сплошные боксы — это осознанно: даёт контактную
  //     тень по их периметру.
  //   - Bloom с порогом 1.0 — светятся ТОЛЬКО HDR-света (блики env на стали,
  //     стекле, лаке), диффузные цвета порога не достигают.
  // Живёт/умирает в applyQuality при смене уровня; dispose — при размонтировании.
  // (Экспериментальный WebGPU-уровень использует ОТДЕЛЬНЫЙ рендер — scene.webgpu.ts;
  // сюда, в WebGL-сцену, он не заходит.)
  let composer: EffectComposer | null = null;
  let postPasses: { dispose(): void }[] = [];

  function buildPost(): void {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    composer = new EffectComposer(
      renderer,
      new WebGLRenderTarget(w, h, { samples: 4, type: HalfFloatType }),
    );
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    const passes: { dispose(): void }[] = [];

    const render = new RenderPass(scene, camera);
    composer.addPass(render);
    passes.push(render);

    const gtao = new GTAOPass(scene, camera, w, h);
    gtao.updateGtaoMaterial({
      radius: 2.5, // мировые единицы — радиус «ощупывания» соседней геометрии
      distanceExponent: 1,
      thickness: 1,
      scale: 1.2, // сила затенения
      samples: 16,
    });
    composer.addPass(gtao);
    passes.push(gtao);

    // strength снижена (0.35 → 0.18): при добавленном ACES tone mapping (см. выше)
    // сами блики уже мягче и не режутся в чистый белый, поэтому прежняя сила bloom
    // поверх них давала избыточное разрастающееся свечение («жалоба на блики»).
    const bloom = new UnrealBloomPass(new Vector2(w, h), 0.18, 0.4, 1.0);
    composer.addPass(bloom);
    passes.push(bloom);

    const output = new OutputPass();
    composer.addPass(output);
    passes.push(output);

    postPasses = passes;
  }

  function disposePost(): void {
    if (!composer) return;
    for (const p of postPasses) p.dispose();
    postPasses = [];
    composer.dispose(); // свои таргеты композера; пассы выше — отдельно
    composer = null;
  }

  if (quality.active.post) buildPost();

  // Твины камеры (drill-зум) и покадровые колбэки слоёв крутятся в этом же rAF.
  const tweens = new TweenGroup();
  const frameCallbacks = new Set<() => void>();

  /** Подогнать буфер рендера (и композера) и аспект под фактический размер canvas. */
  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    if (composer) {
      // pixelRatio первым: setSize композера умножает на него внутри.
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    }
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
    if (composer) composer.render();
    else renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  /** Твин камеры (общая реализация для `flyTo` ручки и плавного `resetView`). */
  function flyTo(
    position: Vector3,
    target: Vector3,
    ms: number,
    onArrive?: () => void,
    onProgress?: (p: number) => void,
  ): Promise<void> {
    return new Promise((resolve) => {
      // На время перелёта глушим пользовательский ввод, чтобы не драться с твином.
      controls.enabled = false;
      // Клампы дистанции — только для пользовательского зума: покадровый
      // controls.update() клампит безусловно, и при drill в мелкий район
      // (конечная дистанция 228·s < minDistance) он ломал бы траекторию твина
      // (камера упирается в минимум, а на свопе — скачок). Снимаем на время
      // перелёта; onArrive ставит камеру в каноническую позу (дистанция в
      // границах), после чего возвращаем.
      const savedMin = controls.minDistance;
      const savedMax = controls.maxDistance;
      controls.minDistance = 0;
      controls.maxDistance = Infinity;
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
          controls.minDistance = savedMin;
          controls.maxDistance = savedMax;
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
    add(object) {
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
      // Создаем геометрию и материалы для «прогрева» кэша.
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
      const instMeshStatic = new InstancedMesh(
        testGeo,
        createTestMat(false),
        1,
      );
      // У боевых куполов уровня есть instanceColor (тинт GLASS_COLOR) — его
      // наличие меняет программу (USE_INSTANCING_COLOR): греем ЦВЕТНОЙ вариант.
      instMeshStatic.setColorAt(0, new Color(0xffffff));

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

      // Наборы материалов — из пула buildings.ts: после прогрева ВОЗВРАЩАЕМ их
      // (не dispose — иначе программы категорий выкидываются из кэша рендера,
      // а пул не наполняется).
      const warmDefs: { cat: Category; def: BuildingDef }[] = [];
      for (const cat of CATEGORIES) {
        const def = makeBuildingDef(cat);
        const instMesh = new InstancedMesh(def.geometry, def.materials, 1);
        // Боевые меши категорий несут instanceColor с рождения — греем тот же
        // (цветной) вариант программ, иначе первый уровень компилировал бы заново.
        instMesh.setColorAt(0, new Color(0xffffff));
        scene.add(instMesh);
        buildingMeshes.push(instMesh);
        warmDefs.push({ cat, def });
      }

      try {
        await renderer.compileAsync(scene, camera);
      } catch (err) {
        console.warn("прекомпиляция шейдеров не удалась:", err);
      } finally {
        scene.remove(meshFlight);
        scene.remove(instMeshFlight);
        scene.remove(instMeshStatic);

        meshFlight.material.dispose();
        instMeshFlight.material.dispose();
        instMeshStatic.material.dispose();
        testGeo.dispose();

        for (const instMesh of buildingMeshes) scene.remove(instMesh);
        for (const { cat, def } of warmDefs)
          releaseBuildingMaterials(cat, def.materials);
      }
    },
    applyQuality() {
      renderer.setPixelRatio(
        Math.min(window.devicePixelRatio, quality.active.pixelRatioCap),
      );
      renderer.transmissionResolutionScale =
        quality.active.transmissionResolutionScale;
      // Тени: переключаем проход, тип карты (PCF/VSM) и просчёт света. Материалы/
      // меши уровня подхватят castShadow/receiveShadow и перекомпилируются под
      // новый тип карты на пересборке города (следует сразу за applyQuality).
      renderer.shadowMap.enabled = quality.active.shadows;
      renderer.shadowMap.type = quality.active.vsmShadows
        ? VSMShadowMap
        : PCFShadowMap;
      sun.castShadow = quality.active.shadows;
      sun.shadow.radius = shadowRadius();
      ambient.intensity = quality.active.shadows
        ? AMBIENT_SHADOWED
        : AMBIENT_NORMAL;
      // Постобработка: композер пересобираем ЦЕЛИКОМ (не только вкл/выкл) под новый
      // размер/pixelRatio. Пересборка на смене уровня дёшева и не каждокадрова.
      disposePost();
      if (quality.active.post) buildPost();
      resize(); // пере-применить размер буфера (и композера) под новый pixelRatio
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
      disposePost();
      envRT.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
