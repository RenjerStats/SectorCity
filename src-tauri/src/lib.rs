//! SectorCity — Rust-бэкенд.
//!
//! Поток данных: `Scanner(jwalk) → Aggregator(rayon) → Snapshot(SQLite)
//! → IPC(Tauri) → фронт`. Сбоку — `Classifier`. Здесь, в фазе 0, собран
//! каркас: модули, ошибки, контракт IPC и команды-заглушки.

mod classify;
mod error;
mod ipc;
mod scan;
mod state;

use tauri::Manager;

pub use error::{AppError, AppResult};
pub use state::AppState;

/// Точка входа приложения. Мобильный аннотатор оставлен для будущей
/// кросс-платформенной фазы — на десктопе он не мешает.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Логи управляются через RUST_LOG (env-filter). По умолчанию — info.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            ipc::commands::start_scan,
            ipc::commands::cancel_scan,
            ipc::commands::current_root,
            ipc::commands::get_level,
            ipc::commands::get_node_detail,
            ipc::commands::search,
        ])
        .setup(|app| {
            // Переоткрытие без рескана: если снимок есть — поднимаем его в стейт.
            let handle = app.handle().clone();
            if let Some(db) = ipc::commands::snapshot_db_path(&handle) {
                if db.exists() {
                    match scan::snapshot::load(&db) {
                        Ok(tree) => {
                            tracing::info!(nodes = tree.nodes.len(), "снимок загружен");
                            *handle.state::<AppState>().scan.lock().unwrap() = Some(tree);
                        }
                        Err(e) => tracing::warn!(error = %e, "снимок не загружен"),
                    }
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("ошибка запуска приложения Tauri");
}
