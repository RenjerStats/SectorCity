/**
 * Палитра категорий: цвет здания + приглушённый тинт «земли» района + подпись.
 * Цвет — единственный канал для категории содержимого (см. ТЗ §2).
 *
 * ВНИМАНИЕ: значения здесь — ЧЕРНОВЫЕ (тикет 002 на Gemini заменит их на
 * выверенную colorblind-safe палитру). Структура и имена экспортов фиксированы —
 * рендер (`city.ts`) и будущая легенда импортируют отсюда.
 */
import type { Category } from "../ipc/contract";

/** Основной цвет здания по категории (hex 0xRRGGBB). */
export const CATEGORY_COLOR: Record<Category, number> = {
  code: 0x4e79a7,
  document: 0xf28e2b,
  image: 0x59a14f,
  video: 0xe15759,
  audio: 0xb07aa1,
  archive: 0xedc948,
  binary: 0x76b7b2,
  other: 0x8a8f98,
};

/** Человекочитаемая подпись категории (для легенды/тултипа). */
export const CATEGORY_LABEL: Record<Category, string> = {
  code: "Код",
  document: "Документы",
  image: "Изображения",
  video: "Видео",
  audio: "Аудио",
  archive: "Архивы",
  binary: "Бинарные",
  other: "Прочее",
};

/** Нейтральный цвет «земли» города. */
export const GROUND_COLOR = 0x1a1d24;
