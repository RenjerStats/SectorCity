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
  /** Узел заблокирован для удаления (системный файл/папка). */
  | "locked"
  /** Синтетический узел «Мелочь (N элементов)» — честная сумма хвоста (файлы и
   *  папки мельче порога). Навигируем: путь `{уровень}::<other>` раскрывает хвост. */
  | "aggregated";

/**
 * Параметры агрегации «Прочее» для `getLevel`. Зеркало Rust-структуры `AggSpec`.
 * Сворачиваются И файлы, И папки (свёрнутая папка доступна через навигируемый блок
 * «Прочее»). `topNCap` — потолок числа узлов в head на уровень (страховка перфо),
 * не основной контрол (0 — без потолка).
 *
 * Порог ВСЕГДА относительный (доля площади уровня): применяется одинаково на каждом
 * уровне, включая вложенные превью, поэтому «Мелочь» в превью купола и после drill
 * совпадает. Абсолютного (по байтам) режима нет — площадь в treemap относительна.
 */
export interface AggSpec {
  /** Доля объёма папки (0.0–1.0): порог агрегации.
   *  Узел сворачивается, если его размер меньше `fraction`·суммы уровня. */
  fraction: number;
  /** Потолок числа зданий-файлов на уровень; 0 — без потолка. */
  topNCap: number;
}

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
  /**
   * Битовая маска категорий ФАЙЛОВ в поддереве узла (зеркало Rust `category_mask`):
   * файл — бит своей категории; папка — объединение по всем потомкам; блок «Мелочь»
   * — объединение свёрнутого хвоста. Порядок битов = индекс в `ALL_CATEGORIES`
   * (`code`=0 … `other`=7). Структурный фильтр по категориям прячет папку/«Мелочь»,
   * у которой маска не пересекается с выбранными категориями (см. `categoryMaskOf`).
   */
  categoryMask: number;
  flags: NodeFlag[];
  /**
   * Кандидатура на очистку: (причина, уверенность) от движка правил v2.
   * Отсутствует, когда узел не кандидат (бэк не сериализует пустое). Флаг
   * `cleanupCandidate` в `flags` дублируется (обратная совместимость).
   */
  cleanup?: CleanupInfo;
  /**
   * Превью детей (вложенный treemap, +1 уровень). Присутствует ТОЛЬКО при
   * `getLevel(depth > 1)` и только у папок (рекурсивно при `depth > 2`); иначе
   * поле отсутствует (на бэке пустой вектор не сериализуется). Опционально.
   */
  children?: ScanNode[];
}

/**
 * Причина кандидатуры на очистку (движок правил v2, план §2.1).
 * Зеркало Rust-enum `CleanupReason` (src-tauri/src/ipc/contract.rs).
 * Подписи и тексты-объяснения — в `src/lib/cleanup.ts`.
 */
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

/** Уверенность правила очистки. Зеркало Rust-enum `Confidence`. */
export type Confidence = "safe" | "likely" | "review";

/** Тройка «правило → уверенность» на узле. Зеркало Rust `CleanupInfo`. */
export interface CleanupInfo {
  reason: CleanupReason;
  confidence: Confidence;
}

/**
 * Группа кандидатов одной причины по поддереву — элемент ответа `list_cleanup`.
 * Зеркало Rust-структуры `CleanupGroup`.
 */
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

/** Лёгкая ссылка на кандидата (для массовой пометки). Зеркало `CleanupItemRef`. */
export interface CleanupItemRef {
  path: string;
  size: number;
  /** Время модификации, unix-секунды (для фильтра давности при пометке). */
  mtime: number;
}

/**
 * Ответ `current_root` с учётом фоновой загрузки снимка при старте приложения.
 * Зеркало Rust-структуры `CurrentRoot` (src-tauri/src/ipc/contract.rs).
 */
export interface CurrentRoot {
  /** Снимок ещё читается из SQLite в фоне: корень МОЖЕТ появиться — фронт ждёт
   *  события `snapshot://ready` (payload: string | null), а не стартует на демо. */
  loading: boolean;
  /** Корень дерева либо `null` (окончательно, когда `loading === false`). */
  root: string | null;
}

/** Результат удаления файлов в Корзину. Зеркало Rust-структуры `DeleteResult`. */
export interface DeleteResult {
  /** Пути, успешно перемещённые в корзину. */
  deleted: string[];
  /** Суммарный объём освобождённого места в байтах. */
  freed: number;
  /** Пути, которые не удалось удалить. */
  failed: string[];
}
