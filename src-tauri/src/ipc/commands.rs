//! IPC-команды Tauri. Наружу уходит ТОЛЬКО текущий уровень + превью,
//! уже агрегированные по хвосту на бэке (нейтрализуем границу сериализации).
//!
//! Фаза 1: `start_scan` выполняет реальный обход ФС (см. `crate::scan`) и кладёт
//! дерево в состояние; `get_level` отдаёт детей уровня с tail-агрегацией.
//! Стрим прогресса, отмена и снимок в SQLite — следующие куски фазы 1.

use tauri::State;

use super::contract::ScanNode;
use crate::error::{AppError, AppResult};
use crate::scan::scan_root;
use crate::state::AppState;

/// Запустить скан корня. Тяжёлый обход уносим в blocking-пул, результат кладём
/// в состояние. Прогресс/отмена появятся отдельным куском (события Tauri).
#[tauri::command]
pub async fn start_scan(root: String, state: State<'_, AppState>) -> AppResult<()> {
    tracing::info!(%root, "start_scan");
    let scan_root_path = root.clone();
    let tree = tokio::task::spawn_blocking(move || scan_root(&scan_root_path))
        .await
        .map_err(|e| AppError::Other(format!("скан-задача прервана: {e}")))??;

    tracing::info!(
        nodes = tree.nodes.len(),
        errors = tree.error_count,
        "скан завершён"
    );
    *state.scan.lock().unwrap() = Some(tree);
    Ok(())
}

/// Дети уровня `path` + tail-агрегация в «Прочее». До первого скана отдаём мок
/// (сквозной поток фазы 0 продолжает работать без выбора реальной папки).
#[tauri::command]
pub async fn get_level(
    path: String,
    top_n: u32,
    depth: u32,
    state: State<'_, AppState>,
) -> AppResult<Vec<ScanNode>> {
    tracing::info!(%path, top_n, depth, "get_level");
    let guard = state.scan.lock().unwrap();
    match guard.as_ref() {
        Some(tree) => Ok(tree.level(&path, top_n as usize)),
        None => Ok(super::mock::mock_level(&path)),
    }
}

/// Полная правда по одному узлу — для карточки/тултипа.
#[tauri::command]
pub async fn get_node_detail(
    path: String,
    state: State<'_, AppState>,
) -> AppResult<Option<ScanNode>> {
    tracing::info!(%path, "get_node_detail");
    let guard = state.scan.lock().unwrap();
    Ok(guard
        .as_ref()
        .and_then(|tree| tree.index_of(&path).map(|i| tree.to_contract(i))))
}

/// Поиск по текущему снимку ФС.
#[tauri::command]
pub async fn search(query: String) -> AppResult<Vec<ScanNode>> {
    tracing::info!(%query, "search (заглушка)");
    Ok(Vec::new())
}
