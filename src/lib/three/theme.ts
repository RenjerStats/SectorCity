/**
 * Числовое зеркало тем для 3D-слоя (Three не читает CSS-переменные — см.
 * docs/SectorCity-vision.md §II.11, тикет 010). DOM берёт цвета из themes.css,
 * 3D — те же цвета отсюда, чтобы оба мира красились из одной точки.
 *
 * ВАЖНО: рантайм-свап материалов сцены (setColor/dispose при смене темы) ещё не
 * подключён — сейчас 3D-слой красится под дефолт (graphite-red). Эти карты —
 * источник истины для будущей проводки, значения синхронны с themes.css.
 */

/** Идентификатор темы = значение атрибута data-theme на :root. */
export type ThemeName =
  | "graphite-red"
  | "carbon-amber"
  | "slate-teal"
  | "mono-white";

/** Числовое зеркало темы для 3D-слоя. Значения 0xRRGGBB. */
export interface Theme3D {
  bg: number; // фон сцены (совпадает с --bg темы)
  ground: number; // «земля» города
  dot: number; // точки-дороги (dot-grid), непрозрачный эквивалент --dot
  accent: number; // подсветка выбора/hover (совпадает с --accent)
}

export const DEFAULT_THEME: ThemeName = "graphite-red";

export const THEMES_3D: Record<ThemeName, Theme3D> = {
  "graphite-red": {
    bg: 0x080808,
    ground: 0x1a1d24,
    dot: 0x2a2a2a,
    accent: 0xd71921,
  },
  "carbon-amber": {
    bg: 0x0d0d0d,
    ground: 0x21201a,
    dot: 0x38352d,
    accent: 0xe0a33e,
  },
  "slate-teal": {
    bg: 0x0e1316,
    ground: 0x1a2226,
    dot: 0x33423f,
    accent: 0x2db3a6,
  },
  "mono-white": {
    bg: 0x0a0a0a,
    ground: 0x1c1c1c,
    dot: 0x333333,
    accent: 0xffffff,
  },
};
