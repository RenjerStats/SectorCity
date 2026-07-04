/**
 * СПАЙК гибридного конвейера «SSGI + матовые купола» (продолжение webgpu-domes).
 * НЕ часть приложения — страница `spike-hybrid.html`, открывать через `pnpm dev`
 * → http://127.0.0.1:1420/spike-hybrid.html (Edge/Chrome, WebGPU нативный).
 *
 * Контекст: в three r184 transmission-стекло ВНУТРИ `pass()` (обязателен для
 * SSGI) сэмплирует битый backdrop — фантомные цвета (см. коммент к `experimental`
 * в quality.ts). Спайк проверяет ОБХОД: город рендерится через SSGI-конвейер, а
 * купола — ВТОРЫМ прямым проходом ПОВЕРХ готового кадра, где «мороз» получен не
 * transmission'ом, а официальным приёмом webgpu_backdrop_area:
 * `backdropNode = hashBlur(viewportSharedTexture())` — блюр уже скомпозиченного
 * (SSGI-освещённого) кадра. Окклюзия куполов зданиями — вручную: Discard по
 * depth-текстуре городского прохода (у второго прохода нет z-буфера сцены).
 *
 * Три режима для сравнения глазами (кнопки в HUD / клавиши 1-2-3):
 *   1 «стекло»  — прямой рендер, честный transmission, БЕЗ постобработки
 *                 (режим офиц. примера webgpu_materials_transmission) — эталон
 *                 того, как должен выглядеть мороз;
 *   2 «SSGI»    — полный конвейер pass→SSGI→TRAA→bloom, купола — дешёвая
 *                 полупрозрачность (текущий experimental-уровень);
 *   3 «гибрид»  — SSGI-конвейер по городу + морозные купола поверх (цель спайка).
 *
 * Что смотреть в гибриде:
 *   - купола РАЗМЫВАЮТ город за собой (мороз), без фантомных цветов;
 *   - здание ПЕРЕД куполом закрывает его (Discard-окклюзия работает, край
 *     жёсткий — допустимо);
 *   - FPS против режимов 1 и 2 (у мороза цена — копия фреймбуфера + N сэмплов
 *     блюра на фрагмент купола).
 *
 * Открытый вопрос спайка: видит ли `viewportSharedTexture` во втором проходе
 * именно ВЫВОД RenderPipeline (композит на канвасе), а не пустой/старый буфер.
 *
 * ВЕРДИКТ (июль 2026): гибрид ЗАБРАКОВАН — купола вторым проходом рисуются
 * поверх кадра и не стираются (шлейф: после pipeline.render() канвас не
 * перечищается для второго прохода корректно). Чинить не стали. Развилка решена
 * в пользу режима 1 «стекло»: честный transmission БЕЗ постобработки, на нашей
 * сцене он мало отличим от SSGI. Перенесено в приложение: quality.ts
 * (`experimental`: frostedGlass=true, post/ssgi=false) + контрастный свет в
 * scene.webgpu.ts. Спайк оставлен как репро для issue апстриму (режимы 2/3).
 */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  BoxGeometry,
  type BufferGeometry,
  Color,
  DirectionalLight,
  Group,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  WebGPURenderer,
  PMREMGenerator,
  RenderPipeline,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
} from "three/webgpu";
import {
  pass,
  mrt,
  output,
  normalView,
  diffuseColor,
  velocity,
  add,
  vec4,
  Fn,
  Discard,
  float,
  color as tslColor,
  screenUV,
  positionView,
  perspectiveDepthToViewZ,
  cameraNear,
  cameraFar,
  viewportSharedTexture,
  reflector,
  type TSLNode,
} from "three/tsl";
import { bloom } from "three/examples/jsm/tsl/display/BloomNode.js";
import { ssgi } from "three/examples/jsm/tsl/display/SSGINode.js";
import { traa } from "three/examples/jsm/tsl/display/TRAANode.js";
import { hashBlur } from "three/examples/jsm/tsl/display/hashBlur.js";
import { probeWebGpu } from "../lib/three/webgpu-support";

/** Палитра районов/куполов (грубое зеркало Okabe–Ito из palette.ts). */
const DISTRICT_COLORS = [
  0xe69f00, 0x56b4e9, 0x009e73, 0xf0e442, 0x0072b2, 0xd55e00, 0xcc79a7,
];
const GLASS_TINT = 0xbfd3d9;

/** Сетка города-макета: NxN ячеек с шагом. */
const GRID = 6;
const SPACING = 2.4;

// ── Параметры гибридного мороза (крутить при визуальной оценке). ─────────────
/** Радиус hashBlur в UV экрана — «сила мороза» (transmission-аналог roughness). */
const FROST_BLUR = 0.03;
/** Сэмплов блюра на фрагмент: меньше — шумнее и быстрее. */
const FROST_TAPS = 32;
/** Зазор сравнения viewZ купол-vs-город (мир. ед.) — против z-акне у подошвы. */
const OCCLUSION_EPS = 0.05;

type Mode = "glass" | "ssgi" | "hybrid";
const MODE_LABELS: Record<Mode, string> = {
  glass: "1 · стекло (transmission, без post)",
  ssgi: "2 · SSGI (купола дешёвые)",
  hybrid: "3 · гибрид (SSGI + мороз поверх)",
};

// ── HUD: статус + кнопки режимов + FPS. ──────────────────────────────────────
function makeHud(onMode: (m: Mode) => void): {
  set: (text: string) => void;
  fps: (v: number) => void;
  setActive: (m: Mode) => void;
} {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;left:12px;top:12px;z-index:10;font:13px/1.5 ui-monospace,monospace;" +
    "color:#e8e8e8;background:rgba(12,12,14,.82);padding:12px 14px;border:1px solid #333;" +
    "border-radius:8px;max-width:560px;white-space:pre-wrap;backdrop-filter:blur(6px)";
  document.body.appendChild(el);

  const textEl = document.createElement("div");
  el.appendChild(textEl);

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:6px;margin-top:8px;flex-wrap:wrap";
  el.appendChild(btnRow);
  const buttons = new Map<Mode, HTMLButtonElement>();
  for (const m of ["glass", "ssgi", "hybrid"] as Mode[]) {
    const b = document.createElement("button");
    b.textContent = MODE_LABELS[m];
    b.style.cssText =
      "font:12px ui-monospace,monospace;color:#e8e8e8;background:#1c1c20;" +
      "border:1px solid #444;border-radius:6px;padding:4px 8px;cursor:pointer";
    b.addEventListener("click", () => onMode(m));
    btnRow.appendChild(b);
    buttons.set(m, b);
  }

  const fpsEl = document.createElement("div");
  fpsEl.style.cssText = "margin-top:6px;color:#8fd";
  el.appendChild(fpsEl);

  return {
    set: (text) => (textEl.textContent = text),
    fps: (v) => (fpsEl.textContent = `FPS: ${v.toFixed(0)}`),
    setActive: (m) => {
      for (const [k, b] of buttons) {
        b.style.background = k === m ? "#2d4a2d" : "#1c1c20";
        b.style.borderColor = k === m ? "#6a6" : "#444";
      }
    },
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

// ── Материалы куполов: по одному на режим. ───────────────────────────────────

/** Режим 1: честный transmission (зеркало §II.3.7 / офиц. примера). */
function glassDomeMaterial(): MeshPhysicalMaterial {
  return new MeshPhysicalMaterial({
    metalness: 0,
    roughness: 0.29,
    transmission: 1,
    thickness: 6,
    ior: 1.45,
    transparent: true,
    depthWrite: true,
    envMapIntensity: 0.45,
  });
}

/** Режим 2: дешёвая полупрозрачность (текущий experimental в city.ts). */
function cheapDomeMaterial(): MeshLambertMaterial {
  return new MeshLambertMaterial({
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  });
}

/**
 * Режим 3: мороз БЕЗ transmission — `backdropNode` (LightsNode подменяет им
 * totalDiffuse) = hashBlur разделяемой копии фреймбуфера, т.е. купол размывает
 * уже пост-обработанный город за собой; спекуляр env ложится поверх штатно.
 * `cityDepthTex` (depth городского pass) даёт ручную окклюзию: город ближе
 * фрагмента купола → Discard (у второго прохода нет z-буфера сцены). Если
 * конвейер не собрался (null) — мороз без окклюзии (купола сквозь здания).
 */
function frostedDomeMaterial(cityDepthTex: TSLNode | null) {
  const mat = new MeshStandardNodeMaterial({
    metalness: 0,
    roughness: 0.22, // поверхность: блики env поверх мороза
    envMapIntensity: 0.45,
    transparent: true,
    depthWrite: true, // купол-vs-купол пофрагментно, как в city.ts
  });
  mat.backdropNode = Fn(() => {
    if (cityDepthTex) {
      const cityViewZ = perspectiveDepthToViewZ(
        cityDepthTex.sample(screenUV).r,
        cameraNear,
        cameraFar,
      );
      // viewZ отрицательный к камере: «город ближе» ⇔ cityViewZ > domeViewZ.
      Discard(cityViewZ.greaterThan(positionView.z.add(OCCLUSION_EPS)));
    }
    return hashBlur(viewportSharedTexture(), float(FROST_BLUR), {
      repeats: float(FROST_TAPS),
    }).rgb.mul(tslColor(GLASS_TINT));
  })();
  return mat;
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
function gridMatrices(count: number): { m: Matrix4; x: number; z: number }[] {
  const out: { m: Matrix4; x: number; z: number }[] = [];
  const half = ((GRID - 1) * SPACING) / 2;
  for (let i = 0; i < count; i++) {
    const gx = i % GRID;
    const gz = Math.floor(i / GRID);
    const x = gx * SPACING - half;
    const z = gz * SPACING - half;
    const m = new Matrix4();
    m.setPosition(x, 0, z);
    out.push({ m, x, z });
  }
  return out;
}

async function main(): Promise<void> {
  const cap = await probeWebGpu();
  const canvas = document.createElement("canvas");
  canvas.style.cssText =
    "position:fixed;inset:0;width:100%;height:100%;display:block";
  document.body.appendChild(canvas);

  const renderer = new WebGPURenderer({ canvas, antialias: true });
  const hud = makeHud((m) => applyMode(m));
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
  // Тени: PCF (на WebGPU надёжнее VSM, см. scene.webgpu.ts).
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  // Две сцены: город (в конвейер) и купола (прямой проход поверх в гибриде).
  // В режимах 1-2 купола живут в sceneMain (scene.add() перепривязывает).
  const sceneMain = new Scene();
  sceneMain.background = new Color(0x080808);
  const sceneDomes = new Scene();
  sceneDomes.background = null; // рисуем поверх готового кадра — фон не мазать

  // Окружение (IBL) — обеим сценам. sigma малая: на webgpu-PMREM это радианы
  // (0.7 клипается по сэмплам, см. scene.webgpu.ts).
  let envOk = false;
  try {
    const pmrem = new PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    sceneMain.environment = envRT.texture;
    sceneMain.environmentIntensity = 0.5;
    sceneDomes.environment = envRT.texture;
    sceneDomes.environmentIntensity = 0.5;
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

  // Свет: sceneMain + КЛОНЫ в sceneDomes (объект живёт в одной сцене, а куполам
  // во втором проходе нужны те же лампы, иначе спекуляр/диффуз не совпадут).
  // Ambient приглушён (0.32, как в scene.webgpu.ts при тенях) — иначе тени блёкнут.
  sceneMain.add(new AmbientLight(0xffffff, 0.32));
  const sun = new DirectionalLight(0xffffff, 1.2);
  sun.position.set(8, 12, 6);
  // PCF-тени солнца: ортокамера накрывает сетку города + зеркало с полом.
  const SHADOW_EXTENT = 14;
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -SHADOW_EXTENT;
  sun.shadow.camera.right = SHADOW_EXTENT;
  sun.shadow.camera.top = SHADOW_EXTENT;
  sun.shadow.camera.bottom = -SHADOW_EXTENT;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 60;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03; // мировые ед.: мир спайка мелкий (здания ~1-2)
  sun.shadow.radius = 4;
  sun.shadow.camera.updateProjectionMatrix();
  sceneMain.add(sun);
  sceneDomes.add(new AmbientLight(0xffffff, 0.32));
  // Куполам чужая карта теней не нужна (они ничего не принимают/не отбрасывают
  // во втором проходе) — у клона тени выключаем, чтобы не рендерить её дважды.
  const sunDomes = sun.clone();
  sunDomes.castShadow = false;
  sceneDomes.add(sunDomes);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.target.set(0, 1, 0);

  const color = new Color();

  // ── Город: плиты + здания (в sceneMain всегда). ─────────────────────────────
  const cityGroup = new Group();
  sceneMain.add(cityGroup);

  // Пол под городом — приёмник теней (без него теням не на что падать: плиты
  // почти вплотную к зданиям). Чуть ниже y=0, чтобы не воевать с дном плит.
  const ground = new Mesh(
    new PlaneGeometry(60, 60),
    new MeshStandardMaterial({
      color: 0x17181c,
      metalness: 0,
      roughness: 0.9,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  ground.receiveShadow = true;
  cityGroup.add(ground);

  // Зеркало сбоку от города (проверка отражений, офиц. приём webgpu_reflection):
  // `reflector()` рендерит sceneMain из отражённой камеры, узел = colorNode
  // unlit-материала; `target` — дитё меша, задаёт плоскость отражения. В гибриде
  // зеркало живёт в городском pass → куполов в нём НЕТ (они в другой сцене) и
  // отражение без SSGI — это ожидаемая цена гибрида, оценить приемлемость на глаз.
  const mirrorHalf = ((GRID - 1) * SPACING) / 2 + 2.6;
  let mirrorOk = false;
  try {
    const mirrorNode = reflector({ resolutionScale: 0.5 });
    const mirrorMat = new MeshBasicNodeMaterial();
    // Лёгкий холодный тинт, чтобы зеркало читалось стеклом, а не дырой в мире.
    mirrorMat.colorNode = mirrorNode.rgb.mul(tslColor(0xdde4ea));
    const mirror = new Mesh(new PlaneGeometry(14, 6), mirrorMat);
    mirror.position.set(-mirrorHalf, 3, 0);
    mirror.rotation.y = Math.PI / 2; // нормаль +X, лицом к центру города
    mirror.add(mirrorNode.target);
    cityGroup.add(mirror);
    mirrorOk = true;
  } catch (err) {
    console.warn("[spike] reflector (зеркало) не завёлся:", err);
  }

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
  plateMesh.castShadow = true;
  plateMesh.receiveShadow = true;
  cityGroup.add(plateMesh);

  // Шахматка: половина ячеек — купол, половина — здание.
  const cells = gridMatrices(GRID * GRID);
  const domeIdx: number[] = [];
  const bldIdx: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    const gx = i % GRID;
    const gz = Math.floor(i / GRID);
    if ((gx + gz) % 2 === 0) domeIdx.push(i);
    else bldIdx.push(i);
  }

  // Здания ВЫШЕ куполов через одно — чтобы проверять окклюзию гибрида (здание
  // перед куполом обязано его закрывать, у второго прохода нет z-буфера сцены).
  const bldMesh = new InstancedMesh(
    buildingGeo(),
    buildingMaterials(),
    bldIdx.length,
  );
  bldIdx.forEach((cellI, j) => {
    const c = cells[cellI];
    const m = new Matrix4().makeScale(0.85, 0.6 + (j % 5) * 0.5, 0.85);
    m.setPosition(c.x, 0.18, c.z);
    bldMesh.setMatrixAt(j, m);
    bldMesh.setColorAt(
      j,
      color.set(DISTRICT_COLORS[(j + 3) % DISTRICT_COLORS.length]),
    );
  });
  bldMesh.instanceMatrix.needsUpdate = true;
  if (bldMesh.instanceColor) bldMesh.instanceColor.needsUpdate = true;
  bldMesh.castShadow = true;
  bldMesh.receiveShadow = true;
  cityGroup.add(bldMesh);

  // ── Купола: один InstancedMesh, материал меняется по режиму. ────────────────
  const matGlass = glassDomeMaterial();
  const matCheap = cheapDomeMaterial();
  // Явный generic Material: материал меша меняется по режиму (стекло/альфа/мороз).
  const domeMesh = new InstancedMesh<BufferGeometry, Material>(
    domeGeo(),
    matGlass,
    domeIdx.length,
  );
  domeMesh.renderOrder = 3;
  domeIdx.forEach((cellI, j) => {
    const c = cells[cellI];
    const m = new Matrix4().makeScale(1, 1.4, 1);
    m.setPosition(c.x, 0.18 + 0.7, c.z);
    domeMesh.setMatrixAt(j, m);
    // Индивидуальный тинт. В гибриде красит только lit-часть (backdrop-мороз
    // тонируется общим GLASS_TINT — per-instance тинт мороза потребовал бы
    // instance-узла в TSL, вне рамок спайка).
    domeMesh.setColorAt(
      j,
      color
        .set(DISTRICT_COLORS[j % DISTRICT_COLORS.length])
        .lerp(new Color(GLASS_TINT), 0.6),
    );
  });
  domeMesh.instanceMatrix.needsUpdate = true;
  if (domeMesh.instanceColor) domeMesh.instanceColor.needsUpdate = true;
  // Тени куполов выключены сознательно: стекло не должно давать глухую тень, а в
  // гибриде купола физически вне городского прохода (одинаково во всех режимах).
  domeMesh.castShadow = false;
  domeMesh.receiveShadow = false;
  sceneMain.add(domeMesh);

  // ── Конвейер SSGI (общий для режимов 2 и 3). ────────────────────────────────
  // pass(sceneMain): в режиме 2 купола внутри sceneMain — конвейер рендерит их;
  // в режиме 3 они перепривязаны в sceneDomes — pass видит только город (граф
  // читает сцену на каждом кадре, пересборка не нужна). Настройки — зеркало
  // scene.webgpu.ts, кроме thickness: мир спайка мельче (здания ~1-2 ед.).
  let pipeline: RenderPipeline | null = null;
  let cityDepthTex: TSLNode | null = null;
  try {
    const scenePass = pass(sceneMain, camera);
    scenePass.setMRT(
      mrt({ output, diffuseColor, normal: normalView, velocity }),
    );
    const colorNode = scenePass.getTextureNode("output");
    const diffuseNode = scenePass.getTextureNode("diffuseColor");
    const depthNode = scenePass.getTextureNode("depth");
    const normalNode = scenePass.getTextureNode("normal");
    const velocityNode = scenePass.getTextureNode("velocity");

    const gi = ssgi(colorNode, depthNode, normalNode, camera);
    gi.sliceCount.value = 2;
    gi.stepCount.value = 8;
    gi.giIntensity.value = 2.5;
    gi.thickness.value = 1;
    const giTex = gi.getTextureNode();
    const composite = vec4(
      add(colorNode.rgb.mul(giTex.a), diffuseNode.rgb.mul(giTex.rgb)),
      colorNode.a,
    );
    const lit = traa(composite, depthNode, velocityNode, camera);
    const bl = bloom(lit, 0.2, 0.4, 1.0);
    pipeline = new RenderPipeline(renderer);
    pipeline.outputNode = lit.add(bl);
    cityDepthTex = depthNode;
  } catch (err) {
    console.warn("[spike] SSGI-конвейер не собрался:", err);
    pipeline = null;
  }
  const matFrosted = frostedDomeMaterial(cityDepthTex);

  // ── Режимы. ─────────────────────────────────────────────────────────────────
  let mode: Mode = "hybrid";

  function applyMode(next: Mode): void {
    mode = next;
    if (next === "hybrid") {
      sceneDomes.add(domeMesh); // перепривязка ИЗ sceneMain
      domeMesh.material = matFrosted;
    } else {
      sceneMain.add(domeMesh);
      domeMesh.material = next === "glass" ? matGlass : matCheap;
    }
    hud.setActive(next);
    hud.set(
      [
        `Бэкенд: ${isWebGpu ? "WebGPU ✓" : "WebGL2 (фолбэк) ⚠"}`,
        `Адаптер: ${cap.adapterName ?? "н/д"} · PMREM: ${envOk ? "ok" : "провал"}`,
        `Конвейер SSGI: ${pipeline ? "ok" : "ПРОВАЛ — режимы 2/3 деградируют (см. консоль)"}`,
        `Зеркало (reflector): ${mirrorOk ? "ok" : "провал (см. консоль)"} · Тени: PCF`,
        `Режим: ${MODE_LABELS[next]}`,
        "",
        next === "glass"
          ? "Эталон мороза: честный transmission, постобработки НЕТ.\n" +
            "Тени PCF на полу/плитах; в зеркале — город с куполами."
          : next === "ssgi"
            ? "Текущий experimental: SSGI+TRAA+bloom, купола — дешёвая альфа."
            : "Цель: мороз = hashBlur(viewportSharedTexture) ПОВЕРХ SSGI-кадра.\n" +
              "Проверь: 1) купола размывают город (не альфа); 2) нет фантомных\n" +
              "цветов; 3) здание перед куполом закрывает его (Discard по depth);\n" +
              "4) в зеркале города НЕТ куполов (они вне прохода) — оценить, критично ли.",
      ].join("\n"),
    );
  }

  // Клавиши 1-2-3.
  window.addEventListener("keydown", (e) => {
    if (e.code === "Digit1") applyMode("glass");
    else if (e.code === "Digit2") applyMode("ssgi");
    else if (e.code === "Digit3") applyMode("hybrid");
  });

  applyMode(mode);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ── Цикл кадра. ─────────────────────────────────────────────────────────────
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

    if (mode === "glass") {
      renderer.render(sceneMain, camera);
    } else if (mode === "ssgi") {
      if (pipeline) pipeline.render();
      else renderer.render(sceneMain, camera);
    } else {
      // Гибрид: композит города на канвас, затем купола ПОВЕРХ. autoClearColor
      // выключаем только на второй проход (грузить цвет, не смывать); depth при
      // этом чистится штатно — купола z-тестятся между собой, город режет Discard.
      if (pipeline) pipeline.render();
      else renderer.render(sceneMain, camera);
      renderer.autoClearColor = false;
      renderer.render(sceneDomes, camera);
      renderer.autoClearColor = true;
    }
  });
}

void main();
