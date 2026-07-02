/**
 * Уровень графики (настройка качества рендера).
 *
 * Три пресета — `minimal | optimal | maximal`. Смысл каналов:
 *   - `minimal`  — дешёвые материалы: НЕТ матового стекла (`transmission`) и
 *     металла/PBR (Lambert без env-отражений), pixelRatio 1, грубая тесселяция.
 *     Снимает самые дорогие статьи рендера (второй проход transmission, PBR+IBL).
 *   - `optimal`  — текущий баланс: матовое стекло куполов, металл плит, PBR-здания,
 *     transmission в половинном разрешении, pixelRatio ≤ 1.5.
 *   - `maximal`  — всё, что улучшает картинку: transmission в полном разрешении,
 *     pixelRatio ≤ 2, более гладкая тесселяция.
 *
 * `quality.active` — единый источник правды, читаемый СИНХРОННО строителями
 * материалов (`buildings.ts`, `city.ts`) в момент сборки уровня и сценой
 * (`scene.ts`) при применении рендер-параметров. Сглаживание (MSAA) НЕ входит в
 * пресет: его нельзя переключить без пересоздания WebGL-контекста, а стоит оно на
 * фоне transmission/PBR/pixelRatio немного — держим его включённым всегда.
 *
 * Смена уровня: стор `graphicsLevel` (store/settings) → `setActiveQuality` →
 * `scene.applyQuality()` (живые рендер-параметры) + пересборка города (материалы).
 */
export type GraphicsLevel = "minimal" | "optimal" | "maximal";

export interface QualityConfig {
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
}

/** Пресеты уровней (см. шапку). */
export const QUALITY: Record<GraphicsLevel, QualityConfig> = {
  minimal: {
    pixelRatioCap: 1,
    transmissionResolutionScale: 0.5,
    frostedGlass: false,
    pbr: false,
    roundSegments: 1,
  },
  optimal: {
    pixelRatioCap: 1.5,
    transmissionResolutionScale: 0.5,
    frostedGlass: true,
    pbr: true,
    roundSegments: 3,
  },
  maximal: {
    pixelRatioCap: 2,
    transmissionResolutionScale: 1,
    frostedGlass: true,
    pbr: true,
    roundSegments: 4,
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
