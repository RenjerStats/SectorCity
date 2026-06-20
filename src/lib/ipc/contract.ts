/**
 * Контракт данных между Rust и фронтом.
 *
 * ВАЖНО: этот тип — зеркало Rust-структуры `ScanNode`
 * (src-tauri/src/ipc/contract.rs). Поля и имена держим в синхроне:
 * serde на бэке сериализует ровно эти ключи (camelCase отключён,
 * см. derive в Rust). Любое изменение правим в обоих местах.
 */

/** Идентификатор узла на фронте. Сейчас это путь; при необходимости заменим. */
export type NodeId = string;

/** Категория содержимого — единственный канал для цвета (colorblind-safe). */
export type Category =
  | "code"
  | "document"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "binary"
  | "other";

/** Пометки узла, влияющие на отрисовку и обход. */
export type NodeFlag =
  | "symlink"
  | "reparsePoint"
  | "permissionDenied"
  /** Кандидат на очистку (кэш-папка/давность/корзина) — присваивает Classifier. */
  | "cleanupCandidate"
  /** Синтетический узел «Прочее (N файлов)» — честная сумма хвоста. */
  | "aggregated";

/**
 * Прогресс скана — приходит потоком событий `scan://progress`
 * (троттлинг на бэке ≤ раз/100 мс). Финальное событие имеет `done = true`.
 * ВАЖНО: зеркало Rust-структуры `ScanProgress` (src-tauri/src/ipc/contract.rs).
 */
export interface ScanProgress {
  /** Сколько входов ФС уже обработано. */
  entries: number;
  /** Сумма размеров файлов, увиденных к этому моменту (байты). */
  bytes: number;
  /** Сколько входов пропущено из-за ошибок доступа. */
  errors: number;
  /** Скан завершён (успехом или отменой). */
  done: boolean;
  /** Скан был отменён пользователем (валиден при `done`). */
  cancelled: boolean;
}

/**
 * Один узел дерева ФС в том виде, в каком он уходит на фронт.
 * Для папок `size` — уже свёрнутая сумма (агрегация на бэке).
 */
export interface ScanNode {
  path: string;
  name: string;
  isDir: boolean;
  /** Размер в байтах; для папок — рекурсивная сумма. */
  size: number;
  /** Время модификации, unix-секунды. База для высоты (устаревание). */
  mtime: number;
  /** Время доступа, unix-секунды. Только как уточнение при достоверности. */
  atime: number;
  /** Число прямых детей (для папок). */
  childCount: number;
  category: Category;
  flags: NodeFlag[];
  /**
   * Превью детей (вложенный treemap, +1 уровень). Присутствует ТОЛЬКО при
   * `getLevel(depth > 1)` и только у папок (рекурсивно при `depth > 2`); иначе
   * поле отсутствует (на бэке пустой вектор не сериализуется). Опционально.
   */
  children?: ScanNode[];
}
