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
  | { kind: "goToCrumb"; index: number }
  /** Войти в режим «Сканер мусора» (vision §I.7). */
  | { kind: "enterCleanup" }
  /** Выйти из режима сканера мусора в обычный Обзор. */
  | { kind: "exitCleanup" }
  /** Обновить текущий уровень на сцене. */
  | { kind: "refresh" }
  /** Сделать эту папку корнем (переоткрыть уровень как новый корень). */
  | { kind: "reroot" }
  /** Открыть/закрыть панель скрытого. */
  | { kind: "toggleHidden" }
  /** На уровень вверх (клавиатура: Backspace / Alt+←). Scene берёт предпоследнюю
   *  крошку и делает `goToCrumb`. No-op на корне. */
  | { kind: "up" }
  /** Снять выбор узла (клавиатура: Esc-стек). Эквивалент `clearSelection`. */
  | { kind: "deselect" }
  /** Действие над активным узлом с клавиатуры (vision §I.9/§I.10). «Активный» —
   *  выбранный (карточка), иначе наведённый; `drill`/`properties`/`mark` работают
   *  по наведённому. Реализует Scene (у него доступ к interaction/drill). */
  | { kind: "nodeAction"; action: NodeAction }
  /**
   * Навигация к узлу по пути (vision §I.3: клик по результату поиска → «дойти» до
   * здания). Scene перестраивает мир на уровне-родителе узла и восстанавливает
   * крошки от корня; совпадение остаётся подсвеченным (поиск активен).
   */
  | { kind: "navigateTo"; path: string };

/** Действие над узлом, инициированное с клавиатуры (см. `UiCommand.nodeAction`). */
export type NodeAction =
  | "drill" // войти в наведённую папку (Enter)
  | "properties" // открыть карточку наведённого (Space)
  | "reveal" // показать в проводнике (E)
  | "hide" // скрыть узел (H)
  | "copyPath" // копировать путь (Ctrl+C)
  | "mark"; // пометить/снять на снос — только в cleanup (X)

/** Текущая невыполненная команда; `null` — нет команды (исполнитель её снимает). */
export const uiCommand = atom<UiCommand | null>(null);

/** Поставить команду из header/sub-header (исполнит подписчик в Scene). */
export function dispatchCommand(cmd: UiCommand): void {
  uiCommand.set(cmd);
}

/**
 * Открыта ли панель скрытого в footer (кнопка «Показать скрытое (N)» в header).
 * Сам набор скрытого живёт в `hiddenPaths` (store/mode); это только видимость
 * панели управления возвратом. Снимается, когда возвращать больше нечего.
 */
export const hiddenOpen = atom<boolean>(false);

/** Переключить видимость панели скрытого. */
export function toggleHidden(): void {
  hiddenOpen.set(!hiddenOpen.get());
}

/**
 * Открыто ли всплывающее окно легенды (кнопка «Легенда» справа в footer).
 * Легенда (высота=устаревание, цвет=категория) вынесена из полосы footer в
 * отдельный поповер, чтобы footer по умолчанию нёс размер уровня + путь.
 */
export const legendOpen = atom<boolean>(false);

/** Переключить видимость окна легенды. */
export function toggleLegend(): void {
  legendOpen.set(!legendOpen.get());
}

/**
 * Открыт ли модал подтверждения сноса (кнопка «Снести (X)» в режиме cleanup).
 * Слайс 1: модал показывает список и итог, но реального удаления не делает
 * (нужен крейт `trash` — отдельный проход). Закрытие — `Отмена`/Esc.
 */
export const cleanupConfirmOpen = atom<boolean>(false);

/** Открыть/закрыть модал подтверждения сноса. */
export function setCleanupConfirm(open: boolean): void {
  cleanupConfirmOpen.set(open);
}

/**
 * Открыто ли контекстное меню ПКМ. Само меню — локальный `$state` в Scene
 * (владелец 3D), но его «открытость» нужна центральному обработчику хоткеев для
 * Esc-стека (когда меню открыто, Esc закрывает ИМЕННО его — само меню, а не
 * снимает выбор/поиск). Scene зеркалит сюда открытие/закрытие.
 */
export const contextMenuOpen = atom<boolean>(false);

/** Отразить открытость контекстного меню (пишет Scene). */
export function setContextMenuOpen(open: boolean): void {
  contextMenuOpen.set(open);
}

/**
 * Открыто ли окно-шпаргалка хоткеев (F1 / «?»). Общепрограммное окно поверх всего
 * (как настройки), со своим Esc; центральный обработчик его только переключает.
 */
export const helpOpen = atom<boolean>(false);

/** Переключить окно шпаргалки хоткеев. */
export function toggleHelp(): void {
  helpOpen.set(!helpOpen.get());
}

/** Явно задать видимость окна шпаргалки. */
export function setHelpOpen(open: boolean): void {
  helpOpen.set(open);
}

/**
 * Счётчик-«нонс» запроса фокуса в поле поиска (хоткеи «/» и Ctrl+F). Хоткей
 * инкрементит его; SearchBox подписан и по изменению фокусирует свой input. Через
 * стор, а не прямой вызов — держим канал «клавиатура → DOM» в стор-мосте (§1).
 */
export const searchFocusRequest = atom<number>(0);

/** Попросить фокус в поле поиска (SearchBox сфокусируется по изменению нонса). */
export function requestSearchFocus(): void {
  searchFocusRequest.set(searchFocusRequest.get() + 1);
}

/* ──────────────────────────────── тосты ──────────────────────────────────── */

/**
 * Кратковременная всплывающая плашка-подтверждение (vision-принцип: любое действие
 * должно отражаться в UI). Нужна для действий БЕЗ иного видимого следа — прежде
 * всего «копировать путь» (drill/скрытие/фильтры и так меняют картинку сами).
 * `id` растёт на каждый показ, чтобы компонент рестартовал таймер авто-скрытия
 * даже при одинаковом тексте подряд.
 */
export interface Toast {
  id: number;
  text: string;
}

/** Текущий тост; `null` — плашки нет. */
export const toast = atom<Toast | null>(null);

let toastSeq = 0;

/** Показать плашку-подтверждение (авто-скрытие — на стороне компонента Toast). */
export function showToast(text: string): void {
  toast.set({ id: ++toastSeq, text });
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
