/**
 * Стор настроек приложения (окно настроек).
 *
 * Тема — единый источник правды об активной теме: атом `theme` + применение к
 * `:root[data-theme]` (DOM перекрашивается из themes.css) и сохранение в
 * localStorage. 3D-слой подписывается на этот же атом — например, обводка-визир
 * берёт из него акцент (interaction.ts).
 *
 * Значения свотчей (акцент/фон) читаем из числового зеркала THEMES_3D (three/
 * theme.ts), чтобы пикер не расходился с реальными цветами тем в themes.css.
 */
import { atom } from "nanostores";
import { DEFAULT_THEME, THEMES_3D, type ThemeName } from "../three/theme";
import {
  DEFAULT_GRAPHICS,
  QUALITY,
  setActiveQuality,
  type GraphicsLevel,
} from "../three/quality";
import { aggSettings } from "./mode";

const STORAGE_KEY = "sectorcity:theme";

/** Темы для пикера: имя + подпись. Порядок = порядок показа в окне настроек. */
export const THEME_ORDER: { name: ThemeName; label: string }[] = [
  { name: "graphite-red", label: "Graphite / Red" },
  { name: "carbon-amber", label: "Carbon / Amber" },
  { name: "slate-teal", label: "Slate / Teal" },
  { name: "mono-white", label: "Mono / White" },
];

/** Число 0xRRGGBB → CSS-строка `#rrggbb` (для свотчей пикера). */
function hex(n: number): string {
  return "#" + n.toString(16).padStart(6, "0");
}
/** Акцент темы как CSS-hex (свотч). */
export function accentHex(name: ThemeName): string {
  return hex(THEMES_3D[name].accent);
}
/** Фон темы как CSS-hex (свотч). */
export function bgHex(name: ThemeName): string {
  return hex(THEMES_3D[name].bg);
}

function isTheme(v: string | null): v is ThemeName {
  return v != null && v in THEMES_3D;
}

function initialTheme(): ThemeName {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isTheme(saved)) return saved;
  } catch {
    // localStorage недоступен (напр. в node-тестах) — молча берём дефолт.
  }
  return DEFAULT_THEME;
}

/** Активная тема. Меняется из окна настроек; DOM и 3D читают её отсюда. */
export const theme = atom<ThemeName>(initialTheme());

/** Применить тему к :root (data-theme) — DOM перекрашивается из themes.css. */
export function applyTheme(name: ThemeName): void {
  document.documentElement.dataset.theme = name;
}

/** Сменить тему: стор + DOM + сохранение. 3D-подписчики обновятся сами. */
export function setTheme(name: ThemeName): void {
  theme.set(name);
  applyTheme(name);
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // Не критично: тема применится, просто не переживёт перезапуск.
  }
}

/* ────────────────────────── качество графики (рендер) ────────────────────── */

/** Уровни графики для пикера: уровень + подпись + пояснение. Порядок = показ. */
export const GRAPHICS_ORDER: {
  level: GraphicsLevel;
  label: string;
  sub: string;
}[] = [
  {
    level: "minimal",
    label: "Минимальный",
    sub: "Дешёвые материалы: без матового стекла и металла. Для слабых машин.",
  },
  {
    level: "optimal",
    label: "Оптимальный",
    sub: "Матовое стекло куполов и металл плит, сбалансированная нагрузка.",
  },
  {
    level: "high",
    label: "Высокий",
    sub: "Мягкие тени, улучшенное стекло куполов, полное разрешение стекла и пикселей.",
  },
  {
    level: "maximal",
    label: "Максимальный",
    sub: "Всё из высокого + контактное затенение и свечение бликов (постобработка), VSM-тени, лак на металле.",
  },
  {
    level: "experimental",
    label: "Экспериментальный (WebGPU)",
    sub: "Отдельный рендер на WebGPU: матовое стекло куполов, SSGI (экранное глобальное освещение), контрастные тени и полуотражающий пол. Требует поддержки WebGPU; при недоступности откатывается на «Максимальный». Сцена пересоздаётся при переключении.",
  },
];

const GRAPHICS_KEY = "sectorcity:graphics";

function isGraphics(v: string | null): v is GraphicsLevel {
  return v != null && v in QUALITY;
}

function initialGraphics(): GraphicsLevel {
  try {
    const saved = localStorage.getItem(GRAPHICS_KEY);
    if (isGraphics(saved)) return saved;
  } catch {
    // localStorage недоступен — дефолт ниже.
  }
  return DEFAULT_GRAPHICS;
}

/**
 * Активный уровень графики. Зеркалим его в `quality.active` (three/quality)
 * сразу при инициализации, до монтирования сцены, чтобы первый же город
 * собрался с правильными материалами.
 */
export const graphicsLevel = atom<GraphicsLevel>(initialGraphics());
setActiveQuality(graphicsLevel.get());

/** Сменить уровень графики: зеркало в `quality.active` + стор + сохранение.
 *  Применение (рендер-параметры + пересборка города) делает подписчик в сцене.
 *  `setActiveQuality` — СТРОГО до `set`: nanostores зовёт подписчиков синхронно,
 *  и `applyQuality()` сцены читает `quality.active` прямо из подписчика — при
 *  обратном порядке рендер получал параметры ПРЕДЫДУЩЕГО уровня (тени на
 *  максимальном не включались, а на смене вниз вспыхивали на кадр). */
export function setGraphicsLevel(level: GraphicsLevel): void {
  setActiveQuality(level);
  graphicsLevel.set(level);
  try {
    localStorage.setItem(GRAPHICS_KEY, level);
  } catch {
    // Не критично — просто не переживёт перезапуск.
  }
}

/* ───────────────────────── отображение (построение города) ──────────────── */

/**
 * Порог свёртки в «Прочее» — доля объёма папки; тайлы мельче сворачиваются в
 * один блок. Источник истины — атом `aggSettings` (store/mode), на который
 * подписана сцена; здесь только границы, дефолт и персист.
 */
export const AGG_FRACTION_MIN = 0.01;
export const AGG_FRACTION_MAX = 0.2;
export const AGG_FRACTION_DEFAULT = 0.03;

const AGG_KEY = "sectorcity:aggFraction";

// Восстановить сохранённый порог до монтирования сцены. Значение вне диапазона игнорируем.
try {
  const raw = localStorage.getItem(AGG_KEY);
  const f = raw != null ? Number(raw) : NaN;
  if (Number.isFinite(f) && f >= AGG_FRACTION_MIN && f <= AGG_FRACTION_MAX) {
    aggSettings.set({ fraction: f });
  }
} catch {
  // localStorage недоступен — остаётся дефолт из store/mode.
}

// Персист порога: subscribe шлёт текущее значение сразу и на каждое изменение.
aggSettings.subscribe((a) => {
  try {
    localStorage.setItem(AGG_KEY, String(a.fraction));
  } catch {
    // Не критично — просто не переживёт перезапуск.
  }
});

/* ─────────────────────────────── сохранение ──────────────────────────────── */

const RESTORE_KEY = "sectorcity:restoreLastScan";

function initRestoreLastScan(): boolean {
  try {
    const v = localStorage.getItem(RESTORE_KEY);
    if (v === "0") return false;
    if (v === "1") return true;
  } catch {
    // недоступно — дефолт ниже
  }
  return true; // по умолчанию восстанавливаем снимок прошлого скана
}

/**
 * Восстанавливать ли при запуске снимок последнего скана. Если выключено —
 * приложение стартует на демо-городе с приглашением выбрать папку.
 */
export const restoreLastScan = atom<boolean>(initRestoreLastScan());

/** Задать «восстанавливать последний скан» + сохранить. */
export function setRestoreLastScan(v: boolean): void {
  restoreLastScan.set(v);
  try {
    localStorage.setItem(RESTORE_KEY, v ? "1" : "0");
  } catch {
    // не критично
  }
}

/* ───────────────────────────────── прочее ────────────────────────────────── */

/** Сбросить все настройки к значениям по умолчанию. */
export function resetSettings(): void {
  setTheme(DEFAULT_THEME);
  setGraphicsLevel(DEFAULT_GRAPHICS);
  aggSettings.set({ fraction: AGG_FRACTION_DEFAULT });
  setRestoreLastScan(true);
}

/* ──────────────────────────── видимость окна ─────────────────────────────── */

/** Открыто ли окно настроек (всплывает по кнопке-шестерёнке в шапке справа). */
export const settingsOpen = atom<boolean>(false);

/** Переключить видимость окна настроек. */
export function toggleSettings(): void {
  settingsOpen.set(!settingsOpen.get());
}

/** Явно задать видимость окна настроек. */
export function setSettingsOpen(open: boolean): void {
  settingsOpen.set(open);
}
