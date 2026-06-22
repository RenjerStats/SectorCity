/**
 * Машина режимов приложения — discriminated union + явные переходы.
 * Зафиксировано (C): без XState; невалидные действия отсекаются гардами
 * на уровне типов (напр. DRILL во время `zooming`).
 *
 * Стор (nanostores) — ЕДИНСТВЕННАЯ точка контакта 3D-мира и DOM-мира.
 * Низкочастотное (режим, что выбрано) живёт здесь; высокочастотное
 * (позиция оверлея покадрово) пишется в DOM императивно, в обход стора.
 */
import { atom, computed } from "nanostores";
import type {
  AggMode,
  Category,
  NodeId,
  ScanNode,
  ScanProgress,
} from "../ipc/contract";

export type AppMode =
  | { kind: "scanning"; progress: number }
  | { kind: "idle"; path: string }
  | { kind: "hovering"; path: string; hoveredId: NodeId }
  | { kind: "selected"; path: string; selectedId: NodeId }
  | { kind: "zooming"; from: string; to: string }
  /**
   * Режим «Умный сканер мусора» (vision §I.7). Верхнеуровневый режим: меняет
   * семантику клика по зданию-файлу (пометить/снять на снос), drill по районам
   * сохраняется (нужно ходить по дереву). Набор помеченного вынесен в отдельный
   * атом `markedForCleanup` (как `breadcrumbs`/`hoveredNode`) — частые клики не
   * должны дёргать союз, а пометка переживает навигацию по уровням.
   */
  | { kind: "cleanup"; path: string };

/** Единый источник правды по режиму. Старт — `idle` (корень не выбран, скана нет). */
export const appMode = atom<AppMode>({ kind: "idle", path: "" });

/** Текущий путь уровня, если он определён в этом режиме. */
export const currentPath = computed(appMode, (m) =>
  m.kind === "idle" ||
  m.kind === "hovering" ||
  m.kind === "selected" ||
  m.kind === "cleanup"
    ? m.path
    : null,
);

/** True, пока идёт зум камеры — гард против DRILL/SELECT в этот момент. */
export const isBusy = computed(
  appMode,
  (m) => m.kind === "zooming" || m.kind === "scanning",
);

/** Активен ли режим сканера мусора (для гардов/семантики клика и облика сцены). */
export const cleanupMode = computed(appMode, (m) => m.kind === "cleanup");

/**
 * Детальный прогресс активного скана; `null`, когда скан не идёт.
 * Низкочастотное (≤10/с после троттлинга бэка) — допустимо держать в сторе.
 * Это деталь поверх `appMode.scanning` (которая остаётся грубым флагом режима).
 */
export const scanProgress = atom<ScanProgress | null>(null);

/**
 * Наведённый узел (контент для тултипа). Меняется только при переходе на другое
 * здание — низкочастотно, поэтому в сторе (docs §1). ПОЗИЦИЯ тултипа обновляется
 * императивно покадрово в обход стора, здесь — только «что показать».
 * 3D-слой пишет, DOM-слой читает: единственная точка контакта миров.
 */
export const hoveredNode = atom<ScanNode | null>(null);

/**
 * Выбранный узел (контент карточки-окна над зданием). Меняется по клику —
 * низкочастотно, поэтому в сторе (docs §1, §5.3). ПОЗИЦИЯ карточки обновляется
 * императивно покадрово в обход стора (ручная проекция, docs §4); здесь — только
 * «что показать». `null` = карточка скрыта (режим не `selected`).
 * 3D-слой пишет (клик по файлу), DOM-слой читает: единственная точка контакта.
 */
export const selectedNode = atom<ScanNode | null>(null);

/**
 * Фильтр-подсветка кандидатов (фаза 2, DoD «лучшие кандидаты одним взглядом»).
 * Несовпадающие узлы гасятся в рендере (`navigator.applyHighlight`), совпадающие
 * «светятся». Все условия — конъюнкция; нулевое значение = условие выключено.
 */
export interface CandidateFilter {
  /** Только узлы с флагом `cleanupCandidate`. */
  onlyCandidates: boolean;
  /** Минимальный размер, байты (0 — выключено). */
  minSize: number;
  /** Старше N дней по `mtime` (0 — выключено). */
  olderThanDays: number;
}

/** Текущий фильтр кандидатов. Старт — всё выключено (подсветки нет). */
export const candidateFilter = atom<CandidateFilter>({
  onlyCandidates: false,
  minSize: 0,
  olderThanDays: 0,
});

/** Активен ли хоть один критерий фильтра (для индикации в UI). */
export const filterActive = computed(
  candidateFilter,
  (f) => f.onlyCandidates || f.minSize > 0 || f.olderThanDays > 0,
);

/**
 * Настройки агрегатора мелочи (блок «Прочее»). СТРУКТУРНО меняют, что свёрнуто
 * (в отличие от фильтра-подсветки, который ничего не убирает). При изменении
 * `Scene` перезапрашивает текущий уровень и пересобирает город (с debounce).
 *
 * - `relative` (по умолчанию): `fraction` — доля объёма папки (детерминированно,
 *   независимо от ракурса камеры); применяется на каждом уровне рекурсивно, включая
 *   превью (см. контракт `AggSpec`). Узел мельче `fraction`·сумма-уровня → «Прочее».
 * - `absolute`: `minBytes` — точный порог; только текущий уровень, превью —
 *   относительный фолбэк по `fraction`.
 */
export interface AggSettings {
  mode: AggMode;
  /** Доля объёма папки 0.01–0.20 (ползунок 1–20%): тайлы мельче сворачиваются. */
  fraction: number;
  /** Порог абсолютного режима, байты. */
  minBytes: number;
}

/** Порог по умолчанию: относительный, 3% от объёма папки (сворачивает мелочь-точки). */
export const aggSettings = atom<AggSettings>({
  mode: "relative",
  fraction: 0.03,
  minBytes: 1024 * 1024, // 1 МБ — стартовое значение абсолютного режима
});

/**
 * Поисковый запрос (подсветка по имени, фаза 2 «сцена в тень, совпадения светятся»).
 * Подсветка считается вместе с фильтром (конъюнкция) в `Scene` → `applyHighlight`.
 * Пустая строка — поиск выключен. Низкочастотное (правка из инпута) — допустимо в сторе.
 */
export const searchQuery = atom<string>("");

/** Один шаг навигации (хлебная крошка): путь уровня и его имя. */
export interface Crumb {
  path: string;
  name: string;
}

/**
 * Стек навигации от корня скана вниз (хлебные крошки). Первый элемент — корень,
 * последний — текущий уровень. Drill добавляет, «назад»/клик по крошке — срезает.
 */
export const breadcrumbs = atom<Crumb[]>([]);

/** Путь текущего (последнего) уровня по стеку крошек, либо `null`. */
export const currentLevel = computed(breadcrumbs, (c) =>
  c.length > 0 ? c[c.length - 1].path : null,
);

/* ───────────────────────── сканер мусора: пометка на снос ─────────────────── */

/**
 * Набор узлов, помеченных «на снос» в режиме `cleanup`. Карта `путь → размер`
 * (байты), чтобы итог «N объектов · X ГБ» считался точно и ПЕРЕЖИВАЛ навигацию по
 * уровням (пометки на других уровнях остаются). Сессионный, очищается при
 * выходе из режима / новом скане. Низкочастотное (клики) — допустимо в сторе.
 * Реальное удаление — отдельным проходом (нужен крейт `trash`); сейчас пометка
 * только готовит список и итог.
 */
export const markedForCleanup = atom<Map<string, number>>(new Map());

/**
 * Кандидаты на очистку среди узлов ТЕКУЩЕГО уровня (флаг `cleanupCandidate`):
 * кэш-папки, корзина, крупные старые файлы. Питает панель сканера (счётчик,
 * суммарный объём, «отметить все»). Публикует владелец сцены (Scene) при загрузке
 * / пересборке уровня; пусто вне режима.
 */
export const cleanupCandidatesHere = atom<ScanNode[]>([]);

/** Помечен ли путь на снос. */
export function isMarked(path: string): boolean {
  return markedForCleanup.get().has(path);
}

/** Пометить/снять один узел (новая Map — иначе nanostores не заметит). */
export function toggleMark(path: string, size: number): void {
  const next = new Map(markedForCleanup.get());
  if (next.has(path)) next.delete(path);
  else next.set(path, size);
  markedForCleanup.set(next);
}

/** Пометить набор узлов разом (mass-mark по причине/уровню). */
export function markMany(
  nodes: readonly { path: string; size: number }[],
): void {
  const next = new Map(markedForCleanup.get());
  for (const n of nodes) next.set(n.path, n.size);
  markedForCleanup.set(next);
}

/** Снять набор узлов разом. */
export function unmarkMany(paths: readonly string[]): void {
  const next = new Map(markedForCleanup.get());
  for (const p of paths) next.delete(p);
  markedForCleanup.set(next);
}

/** Снять все пометки (выход из режима / подтверждённый снос / новый скан). */
export function clearMarks(): void {
  markedForCleanup.set(new Map());
}

/** Число помеченных на снос. */
export const markedCount = computed(markedForCleanup, (m) => m.size);

/** Суммарный объём помеченного на снос (байты). */
export const markedBytes = computed(markedForCleanup, (m) => {
  let sum = 0;
  for (const v of m.values()) sum += v;
  return sum;
});

/* ─────────────────────────── фильтр по категориям ───────────────────────── */

export const ALL_CATEGORIES: Category[] = [
  "code",
  "document",
  "image",
  "video",
  "audio",
  "archive",
  "binary",
  "other",
];

/**
 * Бит категории в маске `ScanNode.categoryMask`. Порядок = индекс в `ALL_CATEGORIES`
 * и ОБЯЗАН совпадать с `category_bit` на бэке (src-tauri/src/scan/mod.rs): `code`=0,
 * `document`=1, …, `other`=7. Менять порядок — синхронно в обоих местах.
 */
export function categoryBit(cat: Category): number {
  return 1 << ALL_CATEGORIES.indexOf(cat);
}

/** Битовая маска набора категорий (для пересечения с `ScanNode.categoryMask`). */
export function categoryMaskOf(cats: Iterable<Category>): number {
  let mask = 0;
  for (const c of cats) mask |= categoryBit(c);
  return mask;
}

/** Набор включённых категорий для отображения в городе. По умолчанию включены все. */
export const categoryFilter = atom<Set<Category>>(new Set(ALL_CATEGORIES));

/** Показывает, пуст ли уровень после применения фильтра по категориям (выставляет Scene). */
export const categoryFilterEmpty = atom<boolean>(false);

/** Включить/выключить одну категорию. */
export function toggleCategory(cat: Category): void {
  const current = categoryFilter.get();
  const next = new Set(current);
  if (next.has(cat)) {
    next.delete(cat);
  } else {
    next.add(cat);
  }
  categoryFilter.set(next);
}

/** Включить только указанную категорию (все остальные выключить). */
export function soloCategory(cat: Category): void {
  categoryFilter.set(new Set([cat]));
}

/** Включить все категории (сбросить фильтр). */
export function resetCategories(): void {
  categoryFilter.set(new Set(ALL_CATEGORIES));
}

/** Активен ли фильтр категорий (хотя бы одна категория выключена). */
export const categoryFilterActive = computed(
  categoryFilter,
  (s) => s.size < ALL_CATEGORIES.length,
);

/**
 * Показывать ли блок «Мелочь» (агрегат мелких файлов/папок). Выключено — мелочь не
 * отображается ВООБЩЕ (ни единым блоком, ни зданиями): пользователю, которому
 * мелкие файлы не интересны, они не мозолят глаза, а их площадь перетекает к
 * крупным. Структурно (как фильтр категорий и скрытие): пересобирает город,
 * раскладку базы не «дим»-ит, а реально меняет. Действует на всех уровнях, включая
 * LOD-превью. Сессионно, держится при навигации.
 */
export const showAggregate = atom<boolean>(true);
