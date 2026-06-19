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
import type { NodeId } from "../ipc/contract";

export type AppMode =
  | { kind: "scanning"; progress: number }
  | { kind: "idle"; path: string }
  | { kind: "hovering"; path: string; hoveredId: NodeId }
  | { kind: "selected"; path: string; selectedId: NodeId }
  | { kind: "zooming"; from: string; to: string };

/** Единый источник правды по режиму. */
export const appMode = atom<AppMode>({ kind: "scanning", progress: 0 });

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
