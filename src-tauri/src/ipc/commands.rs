//! IPC-команды Tauri. Наружу уходит ТОЛЬКО текущий уровень + превью,
//! уже агрегированные по хвосту на бэке (нейтрализуем границу сериализации).
//!
//! Фаза 0: заглушки с зафиксированными сигнатурами. Реализация Scanner/
//! Aggregator/Snapshot появится в фазах 1–2.

use super::contract::ScanNode;
use crate::error::AppResult;

/// Запустить скан корня. Прогресс пойдёт отдельным потоком событий
/// (батчинг ≤ раз/100 мс), скан отменяем через `CancellationToken`.
#[tauri::command]
pub async fn start_scan(root: String) -> AppResult<()> {
    tracing::info!(%root, "start_scan (заглушка)");
    Ok(())
}

/// Дети уровня + превью на +depth; хвост уже свёрнут в «Прочее».
#[tauri::command]
pub async fn get_level(path: String, top_n: u32, depth: u32) -> AppResult<Vec<ScanNode>> {
    tracing::info!(%path, top_n, depth, "get_level (заглушка)");
    Ok(Vec::new())
}

/// Полная правда по одному узлу — для карточки/тултипа.
#[tauri::command]
pub async fn get_node_detail(path: String) -> AppResult<Option<ScanNode>> {
    tracing::info!(%path, "get_node_detail (заглушка)");
    Ok(None)
}

/// Поиск по текущему снимку ФС.
#[tauri::command]
pub async fn search(query: String) -> AppResult<Vec<ScanNode>> {
    tracing::info!(%query, "search (заглушка)");
    Ok(Vec::new())
}
