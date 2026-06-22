/**
 * Тонкие обёртки над Tauri IPC. Весь поток наружу — «текущий уровень + превью»,
 * уже агрегированный по хвосту на бэке (см. docs/SectorCity-tz.md, §IPC).
 *
 * Заглушки фазы 0: команды на бэке возвращают пустые ответы, пока не
 * реализованы Scanner/Aggregator. Сигнатуры зафиксированы заранее.
 */
import { invoke } from "@tauri-apps/api/core";
import type { AggSpec, ScanNode } from "./contract";

/**
 * Запустить скан корня; прогресс приходит событиями `scan://progress`.
 * Резолвится в `true`, если скан завершился, и `false`, если отменён.
 */
export function startScan(root: string): Promise<boolean> {
  return invoke("start_scan", { root });
}

/** Отменить текущий скан (если идёт). Идемпотентно. */
export function cancelScan(): Promise<void> {
  return invoke("cancel_scan");
}

/**
 * Корень текущего дерева (загруженного снимка или последнего скана) либо `null`.
 * Фронт по нему строит стартовый уровень без рескана.
 */
export function currentRoot(): Promise<string | null> {
  return invoke("current_root");
}

/** Дети уровня + превью на +1 уровень; мелочь уже свёрнута в «Прочее» по `agg`. */
export function getLevel(
  path: string,
  agg: AggSpec,
  depth: number,
): Promise<ScanNode[]> {
  return invoke("get_level", { path, agg, depth });
}

/** Полная правда по одному узлу — для карточки/тултипа. */
export function getNodeDetail(path: string): Promise<ScanNode | null> {
  return invoke("get_node_detail", { path });
}

/** Поиск по текущему снимку ФС. */
export function search(query: string): Promise<ScanNode[]> {
  return invoke("search", { query });
}
