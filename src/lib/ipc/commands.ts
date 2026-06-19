/**
 * Тонкие обёртки над Tauri IPC. Весь поток наружу — «текущий уровень + превью»,
 * уже агрегированный по хвосту на бэке (см. docs/SectorCity-tz.md, §IPC).
 *
 * Заглушки фазы 0: команды на бэке возвращают пустые ответы, пока не
 * реализованы Scanner/Aggregator. Сигнатуры зафиксированы заранее.
 */
import { invoke } from "@tauri-apps/api/core";
import type { ScanNode } from "./contract";

/** Запустить скан корня; прогресс приходит отдельным потоком событий. */
export function startScan(root: string): Promise<void> {
  return invoke("start_scan", { root });
}

/** Дети уровня + превью на +1 уровень; хвост уже свёрнут в «Прочее». */
export function getLevel(
  path: string,
  topN: number,
  depth: number,
): Promise<ScanNode[]> {
  return invoke("get_level", { path, topN, depth });
}

/** Полная правда по одному узлу — для карточки/тултипа. */
export function getNodeDetail(path: string): Promise<ScanNode | null> {
  return invoke("get_node_detail", { path });
}

/** Поиск по текущему снимку ФС. */
export function search(query: string): Promise<ScanNode[]> {
  return invoke("search", { query });
}
