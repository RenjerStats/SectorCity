/**
 * Уровень графики (настройка качества рендера). Пресеты — `minimal | optimal |
 * high | maximal | experimental`, по нарастающей нагрузке:
 *   - `minimal`  — дешёвые материалы: без матового стекла (`transmission`) и
 *     PBR/металла (Lambert без env-отражений), pixelRatio 1, грубая тесселяция.
 *   - `optimal`  — баланс по умолчанию: матовое стекло, PBR, transmission в
 *     половинном разрешении, pixelRatio ≤ 1.5.
 *   - `high`     — transmission в полном разрешении, pixelRatio ≤ 2, мягкие
 *     PCF-тени, улучшенное стекло (объёмное поглощение, dispersion, clearcoat).
 *   - `maximal`  — всё из `high` + clearcoat на металле, VSM-тени и
 *     постобработка (GTAO + bloom).
 *   - `experimental` — отдельный бэкенд `WebGPURenderer` (scene.webgpu.ts):
 *     node-конвейер TSL с SSGI (экранное глобальное освещение, эксклюзив
 *     WebGPU) вместо GTAO. Требует поддержки WebGPU (`webgpu-support.ts`); при
 *     недоступности UI откатывается на `maximal`. Помечен `backend: "webgpu"`
 *     — сцена пересоздаётся целиком при входе/выходе, так как бэкенд нельзя
 *     переключить на живом canvas.
 *
 * `quality.active` читается синхронно строителями материалов (`buildings.ts`,
 * `city.ts`) при сборке уровня и сценой (`scene.ts`) при применении
 * рендер-параметров. MSAA не входит в пресет: его нельзя переключить без
 * пересоздания WebGL-контекста, поэтому он всегда включён.
 */
export type GraphicsLevel =
  | "minimal"
  | "optimal"
  | "high"
  | "maximal"
  | "experimental";

export interface QualityConfig {
  /**
   * Бэкенд рендера. `"webgl"` — штатный `WebGLRenderer` (scene.ts) для
   * minimal…maximal; `"webgpu"` — `WebGPURenderer` (scene.webgpu.ts) для
   * экспериментального уровня. Сцена выбирает модуль рендера по этому полю и
   * пересоздаётся при пересечении границы (см. Scene.svelte).
   */
  backend: "webgl" | "webgpu";
  /** Кап плотности пикселей: `min(devicePixelRatio, cap)`. */
  pixelRatioCap: number;
  /**
   * Разрешение прохода transmission-стекла (доля). При `frostedGlass=false` не
   * важно (стекло дешёвое, второго прохода нет).
   */
  transmissionResolutionScale: number;
  /** Купола-папки — настоящее матовое стекло (`transmission`, второй проход
   *  сцены). Иначе — дешёвая полупрозрачность (Lambert + opacity). */
  frostedGlass: boolean;
  /** PBR-материалы (металл/сталь/глянец + отражения env-map). Иначе — дешёвый
   *  `MeshLambertMaterial` без металла и отражений. */
  pbr: boolean;
  /** Сегменты скругления кубов купола/плиты (тесселяция скруглённых боксов). */
  roundSegments: number;
  /** Мягкие тени от направленного света. Заметная нагрузка (доп. проход карты
   *  теней каждый кадр) → только высокий и максимальный уровни. */
  shadows: boolean;
  /** VSM-карта теней вместо PCF: по-настоящему мягкие широкие полутени.
   *  Дороже PCF → только максимальный. Требует `shadows=true`. */
  vsmShadows: boolean;
  /** Улучшенное стекло куполов: объёмное поглощение, dispersion (радужное
   *  преломление на краях), clearcoat. Требует `frostedGlass=true`. */
  glassExtras: boolean;
  /** Лак (clearcoat) на металлических плитах-постаментах. */
  clearcoatMetal: boolean;
  /** Постобработка (EffectComposer, scene.ts): GTAO + bloom. Самая дорогая
   *  статья (G-buffer + AO + блюры каждый кадр) → только максимальный. */
  post: boolean;
  /** SSGI — экранное глобальное освещение (TSL node, эксклюзив WebGPU):
   *  непрямой свет и контактное затенение одним проходом node-конвейера
   *  (`RenderPipeline`, scene.webgpu.ts). Только `backend: "webgpu"`. */
  ssgi: boolean;
}

/** Пресеты уровней (см. шапку). */
export const QUALITY: Record<GraphicsLevel, QualityConfig> = {
  minimal: {
    backend: "webgl",
    pixelRatioCap: 1,
    transmissionResolutionScale: 0.5,
    frostedGlass: false,
    pbr: false,
    roundSegments: 1,
    shadows: false,
    vsmShadows: false,
    glassExtras: false,
    clearcoatMetal: false,
    post: false,
    ssgi: false,
  },
  optimal: {
    backend: "webgl",
    pixelRatioCap: 1.5,
    transmissionResolutionScale: 0.5,
    frostedGlass: true,
    pbr: true,
    roundSegments: 3,
    shadows: false,
    vsmShadows: false,
    glassExtras: false,
    clearcoatMetal: false,
    post: false,
    ssgi: false,
  },
  high: {
    backend: "webgl",
    pixelRatioCap: 2,
    transmissionResolutionScale: 1,
    frostedGlass: true,
    pbr: true,
    roundSegments: 4,
    shadows: true,
    vsmShadows: false,
    glassExtras: true,
    clearcoatMetal: false,
    post: false,
    ssgi: false,
  },
  maximal: {
    backend: "webgl",
    pixelRatioCap: 2,
    transmissionResolutionScale: 1,
    frostedGlass: true,
    pbr: true,
    roundSegments: 4,
    shadows: true,
    vsmShadows: true,
    glassExtras: true,
    clearcoatMetal: true,
    post: true,
    ssgi: false,
  },
  // glassExtras выключен нарочно: clearcoat/dispersion давали «фантомные цвета»
  // куполов на этом бэкенде даже при прямом рендере — стекло здесь чистый
  // transmission+roughness+ior. VSM-тени тоже выключены — на WebGPU надёжнее PCF.
  experimental: {
    backend: "webgpu",
    pixelRatioCap: 2,
    transmissionResolutionScale: 1,
    frostedGlass: true,
    pbr: true,
    roundSegments: 4,
    shadows: true,
    vsmShadows: false,
    glassExtras: false,
    clearcoatMetal: true,
    post: true,
    ssgi: true,
  },
};

/** Уровень по умолчанию (совпадает с прежним «зашитым» качеством). */
export const DEFAULT_GRAPHICS: GraphicsLevel = "optimal";

/**
 * Активная конфигурация качества. Держим в объекте-контейнере (а не `export let`),
 * чтобы импортёры видели живое значение поля при мутации из `setActiveQuality`.
 */
export const quality: { level: GraphicsLevel; active: QualityConfig } = {
  level: DEFAULT_GRAPHICS,
  active: QUALITY[DEFAULT_GRAPHICS],
};

/** Установить активный уровень качества (читается при следующей сборке/применении). */
export function setActiveQuality(level: GraphicsLevel): void {
  quality.level = level;
  quality.active = QUALITY[level];
}
