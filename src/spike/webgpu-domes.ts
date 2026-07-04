/**
 * СПАЙК де-рискинга WebGPU (план, шаг 3). НЕ часть приложения — отдельная страница
 * `spike-webgpu.html`, запускается через `pnpm dev` в обычном Edge/Chrome (WebGPU
 * там нативный) ИЛИ внутри Tauri. Цель — до переписывания `scene.ts` проверить
 * ГЛАВНЫЕ неизвестные экспериментального рендера на РЕАЛЬНЫХ материалах города:
 *
 *   1) transmission-купол (`MeshPhysicalMaterial`, §II.3.7) + per-instance цвет на
 *      `InstancedMesh` — источники помечают эту связку как «tricky» на WebGPU;
 *   2) металл-плита (`MeshStandardMaterial`) + instanceColor;
 *   3) многогрупповое здание (merge-геометрия с группами + массив материалов) +
 *      instanceColor;
 *   4) окружение через `PMREMGenerator.fromScene(RoomEnvironment)` под WebGPU;
 *   5) TSL-постобработка (`PostProcessing` + `pass` → `bloom`) — что заменит нам
 *      мёртвый на WebGPU `EffectComposer`.
 *
 * Что смотреть глазами: купола реально ПРЕЛОМЛЯЮТ фон и красятся индивидуально;
 * плиты бликуют металлом с разными цветами-районами; здания цветные; bloom мягко
 * светит по HDR-бликам. HUD сверху сообщает активный бэкенд (WebGPU vs WebGL-
 * фолбэк), имя адаптера и FPS — это ответ на «а WebView2/4070 реально дают WebGPU».
 *
 * Ключевой приём (и вывод для реального кода): всё ядро (Scene/InstancedMesh/
 * материалы/геометрии/контролы) импортируем из "three" — three опознаёт объекты по
 * утиным флагам (`.isMesh`), поэтому WebGPURenderer их принимает без смены импортов.
 * Из "three/webgpu" берём ТОЛЬКО рендерер и PostProcessing, из аддонов — TSL-ноды.
 */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  BoxGeometry,
  type BufferGeometry,
  Color,
  DirectionalLight,
  InstancedMesh,
  type Material,
  Matrix4,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
// PMREMGenerator + RenderPipeline — из "three/webgpu": у ядровых версий нет
// async-инициализации бэкенда (ядровый PMREM падал `reading 'buffers'`, а
// PostProcessing переименован в RenderPipeline с синхронным render()).
import { WebGPURenderer, PMREMGenerator, RenderPipeline } from "three/webgpu";
import { pass } from "three/tsl";
import { bloom } from "three/examples/jsm/tsl/display/BloomNode.js";
import { probeWebGpu } from "../lib/three/webgpu-support";

/** Палитра районов/куполов (грубое зеркало Okabe–Ito из palette.ts). */
const DISTRICT_COLORS = [
  0xe69f00, 0x56b4e9, 0x009e73, 0xf0e442, 0x0072b2, 0xd55e00, 0xcc79a7,
];
const GLASS_TINT = 0xbfd3d9;

/** Сетка города-макета: NxN ячеек с шагом. */
const GRID = 6;
const SPACING = 2.4;

// ── HUD (DOM-оверлей): статус бэкенда/адаптера/FPS. ──────────────────────────
function makeHud(): {
  set: (html: string) => void;
  fps: (v: number) => void;
} {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;left:12px;top:12px;z-index:10;font:13px/1.5 ui-monospace,monospace;" +
    "color:#e8e8e8;background:rgba(12,12,14,.82);padding:12px 14px;border:1px solid #333;" +
    "border-radius:8px;max-width:560px;white-space:pre-wrap;backdrop-filter:blur(6px)";
  document.body.appendChild(el);
  const fpsEl = document.createElement("div");
  fpsEl.style.cssText = "margin-top:6px;color:#8fd";
  el.appendChild(fpsEl);
  return {
    set: (html) => {
      // Первый узел — текст; fpsEl держим последним.
      el.firstChild!.textContent = "";
      el.insertBefore(document.createTextNode(html), fpsEl);
      // Очистка предыдущего текстового узла, чтобы не накапливать.
      while (el.childNodes.length > 2) el.removeChild(el.firstChild!);
    },
    fps: (v) => (fpsEl.textContent = `FPS: ${v.toFixed(0)}`),
  };
}

// ── Геометрии (в единичном envelope, как в city.ts/buildings.ts). ────────────

/** Купол-папка: скруглённый бокс. */
function domeGeo(): BufferGeometry {
  return new RoundedBoxGeometry(1, 1, 1, 4, 0.14);
}

/** Плита-постамент: плоский скруглённый бокс. */
function plateGeo(): BufferGeometry {
  const g = new RoundedBoxGeometry(1.6, 0.18, 1.6, 3, 0.06);
  g.translate(0, 0.09, 0);
  return g;
}

/** Здание: корпус + корона, merge с ГРУППАМИ (2 материала) — как в buildings.ts. */
function buildingGeo(): BufferGeometry {
  const body = new BoxGeometry(1, 1, 1).toNonIndexed();
  body.translate(0, 0.5, 0);
  const crown = new BoxGeometry(0.78, 0.3, 0.78).toNonIndexed();
  crown.translate(0, 1.15, 0);
  return mergeGeometries([body, crown], true)!; // true → группы под массив материалов
}

// ── Материалы (точные зеркала city.ts/buildings.ts на максимальном уровне). ──

/** Матовое стекло купола: transmission + roughness + clearcoat (§II.3.7). */
function domeMaterial(): MeshPhysicalMaterial {
  return new MeshPhysicalMaterial({
    metalness: 0,
    roughness: 0.29,
    transmission: 1,
    thickness: 6,
    ior: 1.5,
    transparent: true,
    depthWrite: true,
    envMapIntensity: 0.45,
    clearcoat: 0.5,
    clearcoatRoughness: 0.3,
    attenuationColor: new Color(GLASS_TINT),
    attenuationDistance: 40,
    dispersion: 0.35,
  });
}

/** Металл-плита. */
function plateMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    metalness: 0.7,
    roughness: 0.5,
    envMapIntensity: 0.5,
  });
}

/** Материалы здания: графит-корпус + цветная корона (instanceColor домножит). */
function buildingMaterials(): Material[] {
  return [
    new MeshStandardMaterial({ color: 0x2a2c30, metalness: 0, roughness: 0.7 }),
    new MeshStandardMaterial({ color: 0xffffff, metalness: 0, roughness: 0.5 }),
  ];
}

/** Разложить N инстансов по сетке; вернуть их мировые центры (низ на y=0). */
function gridMatrices(
  count: number,
  yScale = 1,
): { m: Matrix4; x: number; z: number }[] {
  const out: { m: Matrix4; x: number; z: number }[] = [];
  const half = ((GRID - 1) * SPACING) / 2;
  for (let i = 0; i < count; i++) {
    const gx = i % GRID;
    const gz = Math.floor(i / GRID);
    const x = gx * SPACING - half;
    const z = gz * SPACING - half;
    const m = new Matrix4().makeScale(1, yScale, 1);
    m.setPosition(x, 0, z);
    out.push({ m, x, z });
  }
  return out;
}

async function main(): Promise<void> {
  const hud = makeHud();

  const cap = await probeWebGpu();
  const canvas = document.createElement("canvas");
  canvas.style.cssText =
    "position:fixed;inset:0;width:100%;height:100%;display:block";
  document.body.appendChild(canvas);

  const renderer = new WebGPURenderer({ canvas, antialias: true });
  try {
    await renderer.init();
  } catch (err) {
    hud.set(`❌ WebGPURenderer.init() упал:\n${String(err)}`);
    return;
  }
  const isWebGpu = renderer.backend?.isWebGPUBackend === true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.setClearColor(0x080808, 1);

  const scene = new Scene();
  scene.background = new Color(0x080808);

  // Окружение (IBL) — тот же путь, что в scene.ts. Под WebGPU это открытый вопрос
  // спайка: оборачиваем в try/catch, чтобы провал PMREM не убил весь тест.
  let envOk = false;
  try {
    const pmrem = new PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.7);
    scene.environment = envRT.texture;
    scene.environmentIntensity = 0.5;
    envOk = true;
  } catch (err) {
    console.warn("[spike] PMREM/RoomEnvironment под WebGPU не завёлся:", err);
  }

  const camera = new PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    500,
  );
  camera.position.set(10, 9, 14);

  const ambient = new AmbientLight(0xffffff, 0.4);
  scene.add(ambient);
  const sun = new DirectionalLight(0xffffff, 1.2);
  sun.position.set(8, 12, 6);
  scene.add(sun);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.target.set(0, 1, 0);

  const color = new Color();

  // Плиты под каждой ячейкой.
  const plates = gridMatrices(GRID * GRID);
  const plateMesh = new InstancedMesh(
    plateGeo(),
    plateMaterial(),
    plates.length,
  );
  plates.forEach((p, i) => {
    plateMesh.setMatrixAt(i, p.m);
    plateMesh.setColorAt(
      i,
      color
        .set(DISTRICT_COLORS[i % DISTRICT_COLORS.length])
        .multiplyScalar(0.5),
    );
  });
  plateMesh.instanceMatrix.needsUpdate = true;
  if (plateMesh.instanceColor) plateMesh.instanceColor.needsUpdate = true;
  scene.add(plateMesh);

  // Шахматка: половина ячеек — купол, половина — здание. Разнесём поверх плит.
  const cells = gridMatrices(GRID * GRID);
  const domeIdx: number[] = [];
  const bldIdx: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    const gx = i % GRID;
    const gz = Math.floor(i / GRID);
    if ((gx + gz) % 2 === 0) domeIdx.push(i);
    else bldIdx.push(i);
  }

  // Купола (transmission) — приподняты на плите, масштаб по Y ~1.4 (высота=возраст).
  const domeMesh = new InstancedMesh(domeGeo(), domeMaterial(), domeIdx.length);
  domeIdx.forEach((cellI, j) => {
    const c = cells[cellI];
    const m = new Matrix4().makeScale(1, 1.4, 1);
    m.setPosition(c.x, 0.18 + 0.7, c.z);
    domeMesh.setMatrixAt(j, m);
    // Индивидуальный тинт купола — прямая проверка instanceColor на transmission.
    domeMesh.setColorAt(
      j,
      color
        .set(DISTRICT_COLORS[j % DISTRICT_COLORS.length])
        .lerp(new Color(GLASS_TINT), 0.6),
    );
  });
  domeMesh.instanceMatrix.needsUpdate = true;
  if (domeMesh.instanceColor) domeMesh.instanceColor.needsUpdate = true;
  scene.add(domeMesh);

  // Здания (многогрупповые) — instanceColor красит обе группы (корпус+корону).
  const bldMesh = new InstancedMesh(
    buildingGeo(),
    buildingMaterials(),
    bldIdx.length,
  );
  bldIdx.forEach((cellI, j) => {
    const c = cells[cellI];
    const m = new Matrix4().makeScale(0.85, 0.6 + (j % 4) * 0.35, 0.85);
    m.setPosition(c.x, 0.18, c.z);
    bldMesh.setMatrixAt(j, m);
    bldMesh.setColorAt(
      j,
      color.set(DISTRICT_COLORS[(j + 3) % DISTRICT_COLORS.length]),
    );
  });
  bldMesh.instanceMatrix.needsUpdate = true;
  if (bldMesh.instanceColor) bldMesh.instanceColor.needsUpdate = true;
  scene.add(bldMesh);

  // TSL-постобработка: pass(scene,camera) → bloom по HDR-бликам. Заменяет мёртвый
  // на WebGPU EffectComposer. Оборачиваем: провал не должен ронять базовый рендер.
  let post: RenderPipeline | null = null;
  try {
    post = new RenderPipeline(renderer);
    const scenePass = pass(scene, camera);
    const colorNode = scenePass.getTextureNode();
    const bl = bloom(colorNode, 0.2, 0.4, 1.0);
    post.outputNode = colorNode.add(bl);
  } catch (err) {
    console.warn("[spike] TSL RenderPipeline не завёлся:", err);
    post = null;
  }

  hud.set(
    [
      `Бэкенд: ${isWebGpu ? "WebGPU ✓" : "WebGL2 (фолбэк) ⚠"}`,
      `Проба navigator.gpu: ${cap.supported ? "ok" : "нет — " + (cap.reason ?? "")}`,
      `Адаптер: ${cap.adapterName ?? "н/д"}`,
      `Окружение (PMREM): ${envOk ? "ok" : "провал (см. консоль)"}`,
      `Постобработка (TSL bloom): ${post ? "ok" : "провал (см. консоль)"}`,
      "",
      "Смотри: купола преломляют фон и имеют РАЗНЫЙ тинт; плиты — металл разных",
      "цветов; здания цветные; bloom мягко светит. ЛКМ-орбита, колесо-зум.",
    ].join("\n"),
  );

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Цикл: setAnimationLoop (рекомендованный для WebGPU) + FPS по времени кадра.
  let last = performance.now();
  let acc = 0;
  let frames = 0;
  renderer.setAnimationLoop((time) => {
    const dt = time - last;
    last = time;
    acc += dt;
    frames++;
    if (acc >= 500) {
      hud.fps((frames * 1000) / acc);
      acc = 0;
      frames = 0;
    }
    controls.update();
    // render() синхронный (команды очередятся на устройстве) — так рекомендует r181+
    // вместо renderAsync(), раз бэкенд уже инициализирован через await init().
    if (post) post.render();
    else renderer.render(scene, camera);
  });
}

void main();
