/**
 * Сторы «оболочки» UI (header / footer / 3D-viewport) — см.
 * docs/SectorCity-vision.md, Часть I (§I.11) и Приложение B.
 *
 * Оболочка композиции: сверху Header, по центру 3D-сцена, снизу Footer. Footer —
 * контекст-зависимое поле: дефолтный контент выбирается по `appMode`, но любой
 * компонент может ВРЕМЕННО «занять» footer под себя через слот (`footerSlot`).
 *
 * Связь header ↔ владелец сцены (Scene.svelte) — тоже через стор (data-only
 * канал `uiCommand`), как требует несущий принцип «миры общаются только через
 * стор» (docs/SectorCity-tech.md §1): Header не дёргает 3D/IPC напрямую.
 */
import { atom } from "nanostores";
import type { Snippet } from "svelte";
import type { Category } from "../ipc/contract";

/* ─────────────────────────── команды header → scene ─────────────────────── */

/**
 * Команда от header к владельцу сцены. Data-only «канал намерений»: Header
 * пишет команду, Scene (единственный владелец 3D/IPC) её исполняет и сразу
 * сбрасывает в `null`. Так кнопки шапки не лезут в 3D-мир напрямую.
 */
export type UiCommand =
  | { kind: "scan" }
  | { kind: "cancel" }
  | { kind: "reset" }
  /** Прыжок по хлебной крошке (крошки переехали в sub-header). */
  | { kind: "goToCrumb"; index: number };

/** Текущая невыполненная команда; `null` — нет команды (исполнитель её снимает). */
export const uiCommand = atom<UiCommand | null>(null);

/** Поставить команду из header/sub-header (исполнит подписчик в Scene). */
export function dispatchCommand(cmd: UiCommand): void {
  uiCommand.set(cmd);
}

/**
 * Открыта ли панель фильтров в footer (тумблер «Фильтры» в header). Сам фильтр
 * живёт в `candidateFilter`; это только видимость панели управления им.
 */
export const filtersOpen = atom<boolean>(false);

/** Переключить видимость панели фильтров. */
export function toggleFilters(): void {
  filtersOpen.set(!filtersOpen.get());
}

/* ──────────────────────────────── слот footer ───────────────────────────── */

/**
 * Переопределение контента footer. Если задано — Footer рисует ЭТОТ сниппет
 * вместо дефолта по режиму. Так компонент (фильтры, сканер мусора, результаты
 * поиска…) «модифицирует footer под себя»: ставит свой сниппет на время жизни и
 * снимает при размонтировании.
 *
 * Модель «один владелец за раз» (последний писатель побеждает): режимы взаимно-
 * исключающие, а слот — это аварийный люк поверх дефолта. Снимать строго своим
 * `clearFooterSlot()` в cleanup-хуке, чтобы не оставить чужой контент.
 */
export const footerSlot = atom<Snippet | null>(null);

/** Занять footer своим контентом. */
export function setFooterSlot(content: Snippet): void {
  footerSlot.set(content);
}

/** Освободить footer (вернуть дефолт по режиму). */
export function clearFooterSlot(): void {
  footerSlot.set(null);
}

/* ─────────────────────── сводка уровня для дефолта footer ────────────────── */

/**
 * Сводка текущего уровня — питает дефолтный контент footer (полоса заполнения по
 * категориям + итоги). Это композиция ТЕКУЩЕГО уровня (его прямые дети), а не
 * всего диска: честный ответ «из чего состоит то, что я сейчас вижу».
 *
 * Низкочастотное (меняется на смене уровня) — допустимо в сторе. Пишет владелец
 * сцены (Scene) после загрузки уровня; читает Footer.
 */
export interface LevelSummary {
  /** Путь уровня (для подписи). */
  path: string;
  /** Суммарный размер прямых детей уровня, байты. */
  totalBytes: number;
  /** Число файлов среди прямых детей (папки не считаем). */
  fileCount: number;
  /** Разбивка размера по категориям (для сегментов полосы). */
  byCategory: Partial<Record<Category, number>>;
}

/** Сводка текущего уровня; `null` — пока уровень не загружен. */
export const levelSummary = atom<LevelSummary | null>(null);
