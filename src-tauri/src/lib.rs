//! SectorCity — Rust-бэкенд.
//!
//! Поток данных: `Scanner(jwalk) → Aggregator(rayon) → Snapshot(SQLite)
//! → IPC(Tauri) → фронт`. Сбоку — `Classifier`. Здесь, в фазе 0, собран
//! каркас: модули, ошибки, контракт IPC и команды-заглушки.

mod classify;
mod error;
mod gpu;
mod ipc;
mod scan;
mod state;

use std::sync::atomic::Ordering;

use tauri::{Emitter, Manager};

pub use error::{AppError, AppResult};
pub use state::AppState;

/// Точка входа приложения. Мобильный аннотатор оставлен для будущей
/// кросс-платформенной фазы — на десктопе он не мешает.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebGPU: Dawn в WebView2 на Windows по умолчанию компилирует HLSL древним
    // FXC — на тяжёлых шейдерах (transmission-купола) это сотни мс на пайплайн.
    // `use_dxc` переключает на современный DXC (заметно быстрее компиляция).
    // Именно env-переменная, не `additionalBrowserArguments` в конфиге окна: env
    // ДОБАВЛЯЕТСЯ к аргументам браузера, а конфиг ЗАМЕЩАЕТ дефолты Tauri.
    // Выставить нужно ДО создания webview; вне Windows WebView2 нет — гейт cfg.
    #[cfg(windows)]
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--enable-dawn-features=use_dxc",
    );

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
            ipc::commands::list_cleanup,
            ipc::commands::cleanup_paths,
            ipc::commands::delete_to_trash,
        ])
        .setup(|app| {
            // Форс дискретной GPU (запись предпочтения в реестр) — в фоне, чтобы
            // reg.exe не задерживал показ окна. Идемпотентно, ошибки не фатальны.
            std::thread::spawn(gpu::ensure_high_performance_gpu);

            // Переоткрытие без рескана: если снимок есть — поднимаем его в стейт.
            // Чтение SQLite уносим в blocking-пул (план §1.1): на большом снимке
            // синхронная загрузка здесь держала показ окна. Пока фон читает, флаг
            // `snapshot_loading` заставляет `current_root` отвечать «ещё не готов»;
            // по завершении летит `snapshot://ready` с корнем (или null).
            let handle = app.handle().clone();
            if let Some(db) = ipc::commands::snapshot_db_path(&handle) {
                if db.exists() {
                    handle
                        .state::<AppState>()
                        .snapshot_loading
                        .store(true, Ordering::SeqCst);
                    tauri::async_runtime::spawn_blocking(move || {
                        let t0 = std::time::Instant::now();
                        match scan::snapshot::load(&db) {
                            Ok(tree) => {
                                tracing::info!(
                                    nodes = tree.nodes.len(),
                                    elapsed_ms = t0.elapsed().as_millis() as u64,
                                    "снимок загружен"
                                );
                                *handle.state::<AppState>().scan.lock().unwrap() =
                                    Some(std::sync::Arc::new(tree));
                            }
                            Err(e) => tracing::warn!(error = %e, "снимок не загружен"),
                        }
                        let state = handle.state::<AppState>();
                        // Порядок важен: сначала снять флаг, потом взять корень —
                        // тогда «loading=false и root=null» гарантированно значит
                        // «снимка нет», а не гонку с этим потоком.
                        state.snapshot_loading.store(false, Ordering::SeqCst);
                        let root = state
                            .scan
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map(|tree| tree.root_node().path.to_string_lossy().into_owned());
                        let _ = handle.emit("snapshot://ready", root);
                    });
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("ошибка запуска приложения Tauri");
}
