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
import type { NodeId, ScanNode, ScanProgress } from "../ipc/contract";

export type AppMode =
  | { kind: "scanning"; progress: number }
  | { kind: "idle"; path: string }
  | { kind: "hovering"; path: string; hoveredId: NodeId }
  | { kind: "selected"; path: string; selectedId: NodeId }
  | { kind: "zooming"; from: string; to: string };

/** Единый источник правды по режиму. Старт — `idle` (корень не выбран, скана нет). */
export const appMode = atom<AppMode>({ kind: "idle", path: "" });

/** Текущий путь уровня, если он определён в этом режиме. */
export const currentPath = computed(appMode, (m) =>
  m.kind === "idle" || m.kind === "hovering" || m.kind === "selected"
    ? m.path
    : null,
);

/** True, пока идёт зум камеры — гард против DRILL/SELECT в этот момент. */
export const isBusy = computed(
  appMode,
  (m) => m.kind === "zooming" || m.kind === "scanning",
);

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
