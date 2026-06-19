/**
 * Палитра категорий: цвет здания + приглушённый тинт «земли» района + подпись.
 * Цвет — единственный канал для категории содержимого (см. ТЗ §2).
 *
 * Сгенерировано как качественная (categorical) colorblind-safe палитра
 * на основе набора Окабэ–Ито (Okabe–Ito) с повышением яркости синего цвета
 * для обеспечения читаемости и контраста на тёмном фоне сцены (~#0e0f13).
 */
import type { Category } from "../ipc/contract";

/** Основной цвет здания по категории (hex 0xRRGGBB). */
export const CATEGORY_COLOR: Record<Category, number> = {
  code: 0x56b4e9, // Голубой (Sky Blue)
  document: 0xf0e442, // Жёлтый (Yellow)
  image: 0x009e73, // Зелёный (Bluish Green)
  video: 0xe69f00, // Оранжевый (Orange)
  audio: 0xcc79a7, // Розово-пурпурный (Reddish Purple)
  archive: 0xd55e00, // Кирпично-красный (Vermillion)
  binary: 0x298bd9, // Синий (Blue, осветлён под тёмную тему)
  other: 0x8a8f98, // Нейтральный серый (Gray)
};

/** Человекочитаемая подпись категории (для легенды/тултипа). */
export const CATEGORY_LABEL: Record<Category, string> = {
  code: "Код и скрипты",
  document: "Документы",
  image: "Изображения",
  video: "Видео",
  audio: "Аудио",
  archive: "Архивы",
  binary: "Бинарные / БД",
  other: "Прочее",
};

/** Нейтральный цвет «земли» города. */
export const GROUND_COLOR = 0x1a1d24;
