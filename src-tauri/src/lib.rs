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
            ipc::commands::get_level,
            ipc::commands::get_node_detail,
            ipc::commands::search,
        ])
        .run(tauri::generate_context!())
        .expect("ошибка запуска приложения Tauri");
}
