/**
 * Уровень графики (настройка качества рендера).
 *
 * Четыре пресета — `minimal | optimal | high | maximal`. Смысл каналов:
 *   - `minimal`  — дешёвые материалы: НЕТ матового стекла (`transmission`) и
 *     металла/PBR (Lambert без env-отражений), pixelRatio 1, грубая тесселяция.
 *     Снимает самые дорогие статьи рендера (второй проход transmission, PBR+IBL).
 *   - `optimal`  — баланс по умолчанию: матовое стекло куполов, металл плит,
 *     PBR-здания, transmission в половинном разрешении, pixelRatio ≤ 1.5.
 *   - `high`     — прежний «максимальный»: transmission в полном разрешении,
 *     pixelRatio ≤ 2, гладкая тесселяция, мягкие PCF-тени + улучшенное стекло
 *     куполов (объёмное поглощение, dispersion, clearcoat).
 *   - `maximal`  — всё из `high` + лак (clearcoat) на металлических плитах,
 *     VSM-тени (по-настоящему мягкие широкие полутени) и постобработка:
 *     GTAO (контактное затенение) + bloom (композер, см. scene.ts).
 *   - `experimental` — ОТДЕЛЬНЫЙ БЭКЕНД: `WebGPURenderer` вместо WebGL (см.
 *     scene.webgpu.ts). Матовое стекло куполов (чистый transmission, без
 *     glassExtras — см. коммент у пресета) + node-конвейер TSL: SSGI (экранное
 *     глобальное освещение, эксклюзив WebGPU) + bloom; контрастный свет и
 *     полуотражающий пол. Требует поддержки WebGPU в среде (проба
 *     `webgpu-support.ts`); при недоступности UI откатывается на `maximal`.
 *     Помечен `backend: "webgpu"` — сцена по нему выбирает рендерер и
 *     ПЕРЕСОЗДаётся целиком при входе/выходе (бэкенд нельзя переключить на
 *     живом canvas).
 *
 * `quality.active` — единый источник правды, читаемый СИНХРОННО строителями
 * материалов (`buildings.ts`, `city.ts`) в момент сборки уровня и сценой
 * (`scene.ts`) при применении рендер-параметров. Сглаживание (MSAA) НЕ входит в
 * пресет: его нельзя переключить без пересоздания WebGL-контекста, а стоит оно на
 * фоне transmission/PBR/pixelRatio немного — держим его включённым всегда (при
 * постобработке роль MSAA берёт мультисемплинг таргета композера).
 *
 * Смена уровня: стор `graphicsLevel` (store/settings) → `setActiveQuality` →
 * `scene.applyQuality()` (живые рендер-параметры) + пересборка города (материалы).
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
  /**
   * Купола-папки — настоящее матовое стекло (`transmission`, второй проход сцены).
   * Иначе — дешёвая полупрозрачность (Lambert + opacity), без второго прохода.
   */
  frostedGlass: boolean;
  /**
   * PBR-материалы (металл/сталь/глянец + отражения env-map). Иначе — дешёвый
   * `MeshLambertMaterial` без металла и отражений («только дешёвые материалы»).
   */
  pbr: boolean;
  /** Сегменты скругления кубов купола/плиты (тесселяция скруглённых боксов). */
  roundSegments: number;
  /**
   * Мягкие тени от направленного света (карта теней + сглаживание). Здания и
   * плиты отбрасывают тень на землю и друг на друга; заполняющий ambient не даёт им
   * стать чёрными — лёгкое затенение. Заметная нагрузка (доп. проход карты теней
   * каждый кадр) → высокий и максимальный уровни.
   */
  shadows: boolean;
  /**
   * VSM-карта теней вместо PCF: по-настоящему мягкие широкие полутени
   * (`shadow.radius` там — размах блюра карты). Дороже PCF (блюр-проходы карты)
   * → только максимальный. Требует `shadows=true`.
   */
  vsmShadows: boolean;
  /**
   * Улучшенное стекло куполов: объёмное поглощение (`attenuation*` — толща
   * получает глубину цвета), `dispersion` (радужное преломление на краях),
   * `clearcoat` (глянцевый слой поверх мороза). Почти бесплатно на фоне уже
   * включённого transmission-прохода. Требует `frostedGlass=true`.
   */
  glassExtras: boolean;
  /** Лак (clearcoat) на металлических плитах-постаментах — «полированный» металл. */
  clearcoatMetal: boolean;
  /**
   * Постобработка (EffectComposer, см. scene.ts): GTAO — контактное затенение в
   * стыках зданий/плит/земли, bloom — свечение HDR-бликов. Самая дорогая статья
   * (G-buffer + AO + блюры каждый кадр) → только максимальный.
   */
  post: boolean;
  /**
   * SSGI — экранное глобальное освещение (`ssgi` node, TSL, эксклюзив WebGPU):
   * непрямой отражённый свет между зданиями/плитами/землёй, контактное затенение и
   * лёгкие отражения одним проходом node-конвейера (`RenderPipeline`, scene.webgpu.ts).
   * Заменяет связку GTAO+SSR старого абсурда, но дешевле и без «пилы» экранного марша.
   * Только `backend: "webgpu"`.
   */
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
  // Экспериментальный WebGPU-уровень: стекло + SSGI ВМЕСТЕ. «Фантомные цвета»
  // куполов, из-за которых конвейер раньше выключали, дал НЕ pass+transmission,
  // а glassExtras: clearcoat/dispersion мешали отражения даже при прямом рендере
  // (проверено вживую, гейт по backend в makeDomeMaterial снят — управляет только
  // флаг). Поэтому стекло здесь — чистый эталон transmission+roughness+ior
  // (glassExtras:false), а node-конвейер TSL (pass → SSGI → TRAA → bloom)
  // возвращён. VSM-тени выключены — на WebGPU надёжнее PCF; контраст добран
  // светом (низкий ambient + яркое солнце, см. scene.webgpu.ts). Бонус бэкенда:
  // полуотражающий пол (reflector в makeFadedGround, city.ts).
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
