//! IPC-команды Tauri. Наружу уходит ТОЛЬКО текущий уровень + превью,
//! уже агрегированные по хвосту на бэке (нейтрализуем границу сериализации).
//!
//! Фаза 1: `start_scan` выполняет реальный обход ФС (см. `crate::scan`) и кладёт
//! дерево в состояние; `get_level` отдаёт детей уровня с tail-агрегацией.
//! Стрим прогресса, отмена и снимок в SQLite — следующие куски фазы 1.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

use super::contract::{ScanNode, ScanProgress};
use crate::error::{AppError, AppResult};
use crate::scan::{scan_with, snapshot, ScanOutcome};
use crate::state::AppState;

/// Событие со стримом прогресса скана (троттлинг на бэке ≤ раз/100 мс).
const SCAN_PROGRESS_EVENT: &str = "scan://progress";

/// Имя файла снимка в каталоге данных приложения.
const SNAPSHOT_FILE: &str = "snapshot.sqlite";

/// Путь к файлу снимка (каталог данных приложения создаётся при необходимости).
/// `None`, если каталог данных недоступен.
pub fn snapshot_db_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(SNAPSHOT_FILE))
}

/// Запустить скан корня. Тяжёлый обход уносим в blocking-пул; прогресс летит
/// событиями `scan://progress`, отмена — через `cancel_scan`. Возвращает `true`,
/// если скан завершился полностью, и `false`, если был отменён.
#[tauri::command]
pub async fn start_scan(
    root: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<bool> {
    tracing::info!(%root, "start_scan");

    // Свежий токен отмены: храним клон в состоянии (для cancel_scan), второй
    // отдаём в blocking-задачу.
    let token = CancellationToken::new();
    *state.scan_cancel.lock().unwrap() = Some(token.clone());

    let emit_handle = app.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        scan_with(&root, &token, move |progress| {
            // Ошибку эмита глотаем: скан важнее доставки прогресса.
            let _ = emit_handle.emit(SCAN_PROGRESS_EVENT, progress);
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("скан-задача прервана: {e}")))??;

    // Скан окончен (успех/отмена) — снять токен.
    *state.scan_cancel.lock().unwrap() = None;

    match outcome {
        ScanOutcome::Completed(tree) => {
            tracing::info!(
                nodes = tree.nodes.len(),
                errors = tree.error_count,
                "скан завершён"
            );
            let summary = ScanProgress {
                entries: tree.nodes.len() as u64,
                bytes: tree.root_node().size,
                errors: tree.error_count,
                done: true,
                cancelled: false,
            };

            // Снимок пишем в blocking-пуле (диск-IO), дерево возвращаем без клона.
            let db_path = snapshot_db_path(&app);
            let tree = tokio::task::spawn_blocking(move || {
                if let Some(db) = db_path {
                    if let Err(e) = snapshot::save(&tree, &db) {
                        tracing::warn!(error = %e, "снимок не сохранён");
                    }
                }
                tree
            })
            .await
            .map_err(|e| AppError::Other(format!("задача снимка прервана: {e}")))?;

            *state.scan.lock().unwrap() = Some(tree);
            let _ = app.emit(SCAN_PROGRESS_EVENT, summary);
            Ok(true)
        }
        ScanOutcome::Cancelled => {
            tracing::info!("скан отменён");
            let _ = app.emit(
                SCAN_PROGRESS_EVENT,
                ScanProgress {
                    entries: 0,
                    bytes: 0,
                    errors: 0,
                    done: true,
                    cancelled: true,
                },
            );
            Ok(false)
        }
    }
}

/// Отменить текущий скан (если идёт). Идемпотентно: без активного скана — no-op.
#[tauri::command]
pub fn cancel_scan(state: State<'_, AppState>) -> AppResult<()> {
    if let Some(token) = state.scan_cancel.lock().unwrap().as_ref() {
        tracing::info!("cancel_scan");
        token.cancel();
    }
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

/// Корень текущего дерева (загруженного снимка или последнего скана), если есть.
/// Фронт по нему строит стартовый уровень без рескана.
#[tauri::command]
pub fn current_root(state: State<'_, AppState>) -> AppResult<Option<String>> {
    Ok(state
        .scan
        .lock()
        .unwrap()
        .as_ref()
        .map(|tree| tree.root_node().path.to_string_lossy().into_owned()))
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
