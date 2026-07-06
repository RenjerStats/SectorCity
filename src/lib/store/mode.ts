/**
 * Машина режимов приложения — discriminated union с явными переходами; гарды
 * на уровне типов отсекают невалидные действия (например DRILL во время `zooming`).
 *
 * Стор (nanostores) — единственная точка контакта 3D-мира и DOM-мира.
 * Низкочастотное (режим, что выбрано) живёт здесь; высокочастотное
 * (позиция оверлея покадрово) пишется в DOM императивно, в обход стора.
 */
import { atom, computed } from "nanostores";
import type {
  Category,
  CleanupGroup,
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
   * Режим «Сканер мусора». Верхнеуровневый режим: включает пометку на снос по
   * Ctrl+ЛКМ (файлы и папки) и через ПКМ-меню; обычный ЛКМ ведёт себя как в
   * обзоре (карточка/drill). Набор помеченного вынесен в отдельный атом
   * `markedForCleanup` — частые клики не должны дёргать союз, а пометка
   * переживает навигацию по уровням.
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
 * Наведённый узел (контент для тултипа) — только «что показать». Позиция
 * тултипа обновляется императивно покадрово, в обход стора: 3D-слой пишет
 * контент сюда, DOM-слой читает.
 */
export const hoveredNode = atom<ScanNode | null>(null);

/**
 * Выбранный узел (контент карточки-окна над зданием) — только «что показать».
 * Позиция карточки обновляется императивно покадрово (ручная проекция мировой
 * точки в пиксели), в обход стора. `null` = карточка скрыта.
 */
export const selectedNode = atom<ScanNode | null>(null);

/**
 * Фильтр-подсветка кандидатов: несовпадающие узлы гасятся в рендере
 * (`navigator.applyHighlight`), совпадающие «светятся». Все условия —
 * конъюнкция; нулевое значение = условие выключено.
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
 * Настройки агрегатора мелочи (блок «Прочее»). Структурно меняют, что свёрнуто
 * (в отличие от фильтра-подсветки, который ничего не убирает). При изменении
 * `Scene` перезапрашивает текущий уровень и пересобирает город (с debounce).
 * Порог `fraction` — доля объёма папки; узел мельче `fraction`·сумма-уровня
 * сворачивается в «Прочее».
 */
export interface AggSettings {
  /** Доля объёма папки 0.01–0.20 (ползунок 1–20%): тайлы мельче сворачиваются. */
  fraction: number;
}

/** Порог по умолчанию: 3% от объёма папки (сворачивает мелочь-точки). */
export const aggSettings = atom<AggSettings>({
  fraction: 0.03,
});

/**
 * Поисковый запрос (подсветка по имени). Подсветка считается вместе с
 * фильтром (конъюнкция) в `Scene` → `applyHighlight`. Пустая строка — поиск
 * выключен.
 */
export const searchQuery = atom<string>("");

/**
 * Результаты глобального поиска по снимку: крупнейшие совпадения по имени со
 * всего дерева (не только текущий уровень). Питают список в footer; клик по
 * результату — навигация к зданию (drill-цепочка). Заполняет владелец сцены
 * (Scene) дебаунс-запросом к IPC `search`; пусто, когда запрос короче минимума.
 */
export const searchResults = atom<ScanNode[]>([]);

/** Идёт ли сейчас запрос глобального поиска (для индикации «ищу…» в footer). */
export const searchPending = atom<boolean>(false);

/** Минимальная длина запроса для глобального поиска. */
export const SEARCH_MIN_CHARS = 2;

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
 * (байты), чтобы итог «N объектов · X ГБ» считался точно и переживал навигацию
 * по уровням (пометки на других уровнях остаются). Сессионный, очищается при
 * выходе из режима / новом скане.
 */
export const markedForCleanup = atom<Map<string, number>>(new Map());

/**
 * Кандидаты на очистку среди узлов текущего уровня (флаг `cleanupCandidate`):
 * кэш-папки, корзина, крупные старые файлы. Питает панель сканера (счётчик,
 * суммарный объём, «отметить все»). Публикует владелец сцены при загрузке /
 * пересборке уровня; пусто вне режима.
 */
export const cleanupCandidatesHere = atom<ScanNode[]>([]);

/**
 * Группы кандидатов по причинам по всему поддереву текущего уровня: питают
 * панель причин сканера. Публикует владелец сцены при входе в режим/смене
 * уровня в режиме (`list_cleanup`); пусто вне режима.
 */
export const cleanupGroups = atom<CleanupGroup[]>([]);

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
 * Бит категории в маске `ScanNode.categoryMask`. Порядок = индекс в
 * `ALL_CATEGORIES` и обязан совпадать с бэком (`code`=0, `document`=1, …,
 * `other`=7) — менять синхронно в обоих местах.
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
 * Показывать ли блок «Мелочь» (агрегат мелких файлов/папок). Выключено — мелочь
 * не отображается вообще, а её площадь перетекает к крупным узлам. Структурно
 * (как фильтр категорий): пересобирает город, а не просто гасит подсветку.
 */
export const showAggregate = atom<boolean>(true);

/* ─────────────────────────── скрытые из визуализации узлы ────────────────── */

/**
 * Стек/список путей узлов, скрытых из визуализации.
 * При скрытии узла, он убирается из раскладки, и соседние узлы занимают его место.
 */
export const hiddenPaths = atom<string[]>([]);

/** Скрыть узел (добавить путь в конец списка, если отсутствует). */
export function hideNode(path: string): void {
  const current = hiddenPaths.get();
  if (!current.includes(path)) {
    hiddenPaths.set([...current, path]);
  }
}

/** Показать скрытый ранее узел (удалить путь из списка). */
export function unhideNode(path: string): void {
  const current = hiddenPaths.get();
  hiddenPaths.set(current.filter((p) => p !== path));
}

/** Очистить список скрытых узлов. No-op, если он уже пуст (чтобы подписчики не
 *  пересобирали город на каждом скане, когда скрывать было нечего). */
export function clearHidden(): void {
  if (hiddenPaths.get().length > 0) hiddenPaths.set([]);
}
