//! IPC-команды Tauri. Наружу уходит ТОЛЬКО текущий уровень + превью,
//! уже агрегированные по хвосту на бэке (нейтрализуем границу сериализации).
//!
//! Фаза 1: `start_scan` выполняет реальный обход ФС (см. `crate::scan`) и кладёт
//! дерево в состояние; `get_level` отдаёт детей уровня с tail-агрегацией.
//! Стрим прогресса, отмена и снимок в SQLite — следующие куски фазы 1.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

use super::contract::{
    AggSpec, CleanupGroup, CleanupItemRef, CleanupReason, CurrentRoot, DeleteResult, ScanNode,
    ScanProgress,
};
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

            // Дерево — в стейт и сразу событие `done`: перезапись снимка (диск-IO)
            // больше НЕ на критическом пути завершения скана. Город строится, как
            // только дерево в памяти; снимок дописывается в фоне.
            let tree = std::sync::Arc::new(tree);
            *state.scan.lock().unwrap() = Some(std::sync::Arc::clone(&tree));
            let _ = app.emit(SCAN_PROGRESS_EVENT, summary);

            // Фоновая запись снимка: держит собственную `Arc`-ссылку, читателей
            // (`get_level` и пр.) не блокирует. Задачу не ждём (`start_scan`
            // возвращается сразу после появления города).
            let db_path = snapshot_db_path(&app);
            tokio::task::spawn_blocking(move || {
                if let Some(db) = db_path {
                    if let Err(e) = snapshot::save(&tree, &db) {
                        tracing::warn!(error = %e, "снимок не сохранён");
                    }
                }
            });
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

/// Дети уровня `path` + агрегация мелочи в «Прочее», с превью на `depth` уровней
/// вниз (`depth > 1` → папки несут вложенный treemap своих детей; см.
/// `ScanTree::level`). Порог агрегации задаёт UI через `agg` (относительный по
/// доле объёма папки — см. [`AggSpec`]). До первого скана
/// отдаём мок (плоский, превью нет — сквозной поток фазы 0 работает без скана).
#[tauri::command]
pub async fn get_level(
    path: String,
    agg: AggSpec,
    depth: u32,
    state: State<'_, AppState>,
) -> AppResult<Vec<ScanNode>> {
    tracing::info!(%path, ?agg, depth, "get_level");
    let guard = state.scan.lock().unwrap();
    match guard.as_ref() {
        Some(tree) => Ok(tree.level(&path, &agg, depth)),
        None => Ok(super::mock::mock_level(&path)),
    }
}

/// Корень текущего дерева (загруженного снимка или последнего скана), если есть.
/// Фронт по нему строит стартовый уровень без рескана. Пока снимок читается в
/// фоне (`snapshot_loading`), отвечаем `loading = true` — фронт покажет «загружаю
/// снимок…» и дождётся события `snapshot://ready` вместо старта на демо-городе.
#[tauri::command]
pub fn current_root(state: State<'_, AppState>) -> AppResult<CurrentRoot> {
    // Порядок важен (зеркален фоновой задаче «положить дерево → снять флаг»):
    // сначала флаг, потом корень. Тогда «loading=false, root=None» гарантированно
    // значит «снимка нет и не будет», а не гонку с фоновым потоком; loading=true
    // при уже готовом дереве безвреден — событие `snapshot://ready` ещё впереди.
    let loading = state
        .snapshot_loading
        .load(std::sync::atomic::Ordering::SeqCst);
    let root = state
        .scan
        .lock()
        .unwrap()
        .as_ref()
        .map(|tree| tree.root_node().path.to_string_lossy().into_owned());
    Ok(CurrentRoot {
        loading: loading && root.is_none(),
        root,
    })
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

/// Максимум результатов поиска (страховка от перегрузки списка и сериализации).
const SEARCH_LIMIT: usize = 200;

/// Глобальный поиск по имени в текущем снимке ФС (vision §I.3): регистронезависимое
/// вхождение подстроки в имя узла. Результаты — крупнейшие первыми (ответ «что самое
/// тяжёлое из совпавшего»), не более [`SEARCH_LIMIT`]. Корень из выдачи исключаем
/// (он не «здание» в выдаче, к нему незачем «доходить»).
#[tauri::command]
pub async fn search(query: String, state: State<'_, AppState>) -> AppResult<Vec<ScanNode>> {
    tracing::info!(%query, "search");
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let guard = state.scan.lock().unwrap();
    let Some(tree) = guard.as_ref() else {
        return Ok(Vec::new());
    };

    let mut hits: Vec<usize> = tree
        .nodes
        .iter()
        .enumerate()
        .filter(|(i, n)| *i != tree.root && n.name.to_lowercase().contains(&needle))
        .map(|(i, _)| i)
        .collect();
    // Крупнейшие первыми; при равенстве — стабильно по индексу (детерминизм выдачи).
    hits.sort_by(|&a, &b| tree.nodes[b].size.cmp(&tree.nodes[a].size).then(a.cmp(&b)));
    hits.truncate(SEARCH_LIMIT);
    Ok(hits.into_iter().map(|i| tree.to_contract(i)).collect())
}

/// Топ-N кандидатов на причину в ответе `list_cleanup` (остальные — лениво
/// через `cleanup_paths`, план §2.2).
const CLEANUP_TOP_ITEMS: usize = 10;

/// Группы кандидатов на очистку по причинам ПО ВСЕМУ ПОДДЕРЕВУ `scope`
/// (панель причин сканера мусора, план §2.2). Синтетический суффикс
/// `::<other>` в `scope` срезается. Без снимка/скана — пусто.
#[tauri::command]
pub async fn list_cleanup(
    scope: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<CleanupGroup>> {
    tracing::info!(%scope, "list_cleanup");
    let guard = state.scan.lock().unwrap();
    Ok(guard
        .as_ref()
        .map(|tree| tree.cleanup_groups(&scope, CLEANUP_TOP_ITEMS))
        .unwrap_or_default())
}

/// Все кандидаты одной причины в поддереве `scope` (лёгкие ссылки путь+размер,
/// крупнейшие первыми) — для массовой пометки причины целиком.
#[tauri::command]
pub async fn cleanup_paths(
    scope: String,
    reason: CleanupReason,
    state: State<'_, AppState>,
) -> AppResult<Vec<CleanupItemRef>> {
    tracing::info!(%scope, ?reason, "cleanup_paths");
    let guard = state.scan.lock().unwrap();
    Ok(guard
        .as_ref()
        .map(|tree| tree.cleanup_paths(&scope, reason))
        .unwrap_or_default())
}

/// Переместить список файлов/папок в Корзину.
/// Обновляет дерево в памяти и перезаписывает снимок SQLite.
#[tauri::command]
pub async fn delete_to_trash(paths: Vec<String>, app: AppHandle) -> AppResult<DeleteResult> {
    tracing::info!(?paths, "delete_to_trash");

    let app_handle = app.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let mut deleted = Vec::new();
        let mut failed = Vec::new();
        let mut freed = 0;

        let mut scan_guard = state.scan.lock().unwrap();

        for p in paths {
            let path_ref = std::path::Path::new(&p);

            // Проверим замок безопасности: если файл помечен как системный, снос заблокирован
            let mut is_locked = false;
            if let Some(ref tree) = *scan_guard {
                if let Some(idx) = tree.index_of(&p) {
                    is_locked = tree.nodes[idx].is_locked;
                }
            }

            if is_locked {
                tracing::warn!(%p, "попытка удалить заблокированный узел отклонена");
                failed.push(p);
                continue;
            }

            // Перемещение в корзину через crate trash
            match trash::delete(path_ref) {
                Ok(_) => {
                    let mut freed_bytes = 0;
                    if let Some(ref mut tree) = *scan_guard {
                        // `make_mut`: обычно ссылка уникальна (фоновая запись снимка
                        // после скана давно завершена) → правка на месте без клона.
                        if let Some(bytes) = std::sync::Arc::make_mut(tree).delete_node(&p) {
                            freed_bytes = bytes;
                        }
                    }
                    freed += freed_bytes;
                    deleted.push(p);
                }
                Err(e) => {
                    tracing::error!(%p, error = %e, "не удалось переместить в корзину");
                    failed.push(p);
                }
            }
        }

        // Обновить снимок SQLite
        if !deleted.is_empty() {
            if let Some(ref tree) = *scan_guard {
                if let Some(db_path) = snapshot_db_path(&app_handle) {
                    if let Err(e) = snapshot::save(tree, &db_path) {
                        tracing::warn!(error = %e, "не удалось перезаписать снимок после удаления");
                    }
                }
            }
        }

        DeleteResult {
            deleted,
            freed,
            failed,
        }
    })
    .await
    .map_err(|e| AppError::Other(format!("задача удаления прервана: {e}")))?;

    Ok(outcome)
}
