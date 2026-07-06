/**
 * Контракт данных между Rust и фронтом — зеркало Rust-структур в
 * `src-tauri/src/ipc/contract.rs`. Поля и имена держим в синхроне на обеих
 * сторонах вручную.
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
  /** Узел заблокирован для удаления (системный файл/папка). */
  | "locked"
  /** Синтетический узел «Мелочь (N элементов)» — честная сумма хвоста (файлы и
   *  папки мельче порога). Навигируем: путь `{уровень}::<other>` раскрывает хвост. */
  | "aggregated";

/**
 * Параметры агрегации «Прочее» для `getLevel`. Сворачиваются и файлы, и папки
 * мельче порога (свёрнутый хвост доступен через навигируемый блок «Прочее»).
 * Порог всегда относительный (доля площади уровня), а не абсолютный по байтам —
 * так «Мелочь» в превью и после drill совпадает на любом уровне.
 */
export interface AggSpec {
  /** Доля объёма папки (0.0–1.0): порог агрегации.
   *  Узел сворачивается, если его размер меньше `fraction`·суммы уровня. */
  fraction: number;
  /** Потолок числа зданий-файлов на уровень; 0 — без потолка. */
  topNCap: number;
}

/** Прогресс скана — приходит потоком событий `scan://progress` (троттлинг на
 *  бэке). Финальное событие имеет `done = true`. */
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
  /**
   * Битовая маска категорий файлов в поддереве узла: файл — бит своей категории,
   * папка — объединение по всем потомкам, блок «Мелочь» — объединение хвоста.
   * Бит = индекс в `ALL_CATEGORIES`. Фильтр по категориям прячет узел, чья маска
   * не пересекается с выбранными категориями.
   */
  categoryMask: number;
  flags: NodeFlag[];
  /** Кандидатура на очистку: (причина, уверенность) от движка правил. Отсутствует,
   *  когда узел не кандидат; флаг `cleanupCandidate` в `flags` дублирует это. */
  cleanup?: CleanupInfo;
  /** Превью детей (вложенный treemap, +1 уровень); присутствует только при
   *  `getLevel(depth > 1)` и только у папок. */
  children?: ScanNode[];
}

/** Причина кандидатуры на очистку; подписи и объяснения — в `src/lib/cleanup.ts`. */
export type CleanupReason =
  | "packageCache"
  | "buildArtifact"
  | "browserCache"
  | "gpuCache"
  | "tempDir"
  | "tempFile"
  | "interruptedDownload"
  | "crashDump"
  | "recycleBin"
  | "windowsOld"
  | "installerInDownloads"
  | "emptyDir"
  | "staleLarge";

/** Уверенность правила очистки. */
export type Confidence = "safe" | "likely" | "review";

/** Тройка «правило → уверенность» на узле. */
export interface CleanupInfo {
  reason: CleanupReason;
  confidence: Confidence;
}

/** Группа кандидатов одной причины по поддереву — элемент ответа `list_cleanup`. */
export interface CleanupGroup {
  reason: CleanupReason;
  confidence: Confidence;
  /** Число кандидатов причины (вложенные не задваиваются). */
  count: number;
  /** Суммарный объём кандидатов причины, байты. */
  bytes: number;
  /** Крупнейшие N кандидатов (для списка); остальные — лениво `cleanup_paths`. */
  topItems: ScanNode[];
}

/** Лёгкая ссылка на кандидата (для массовой пометки). */
export interface CleanupItemRef {
  path: string;
  size: number;
  /** Время модификации, unix-секунды (для фильтра давности при пометке). */
  mtime: number;
}

/** Ответ `current_root` с учётом фоновой загрузки снимка при старте приложения. */
export interface CurrentRoot {
  /** Снимок ещё читается из SQLite в фоне: корень МОЖЕТ появиться — фронт ждёт
   *  события `snapshot://ready` (payload: string | null), а не стартует на демо. */
  loading: boolean;
  /** Корень дерева либо `null` (окончательно, когда `loading === false`). */
  root: string | null;
}

/** Результат удаления файлов в Корзину. */
export interface DeleteResult {
  /** Пути, успешно перемещённые в корзину. */
  deleted: string[];
  /** Суммарный объём освобождённого места в байтах. */
  freed: number;
  /** Пути, которые не удалось удалить. */
  failed: string[];
}
