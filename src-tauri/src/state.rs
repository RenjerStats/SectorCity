//! Состояние приложения, разделяемое между IPC-командами.
//!
//! Пока здесь только результат последнего скана (дерево в памяти). Снимок в
//! SQLite (быстрое переоткрытие/diff) ляжет рядом отдельной фазой.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;

use crate::scan::ScanTree;

/// Tauri-managed состояние. Доступ из команд через `tauri::State<AppState>`.
#[derive(Default)]
pub struct AppState {
    /// Дерево последнего успешного скана; `None` до первого `start_scan`.
    /// Обёрнуто в `Arc`, чтобы фоновая запись снимка держала свою ссылку и не
    /// блокировала читателей (`get_level` и пр.) на время дисковой записи —
    /// перезапись снимка ушла с критического пути завершения скана.
    pub scan: Mutex<Option<Arc<ScanTree>>>,
    /// Токен отмены текущего скана; `Some` пока скан выполняется.
    pub scan_cancel: Mutex<Option<CancellationToken>>,
    /// Снимок прошлого скана ещё читается из SQLite в фоне (см. `setup` в lib.rs).
    /// Пока `true`, `current_root` честно отвечает «ещё не готов», а не «пусто» —
    /// фронт ждёт события `snapshot://ready` вместо старта на демо-городе.
    pub snapshot_loading: AtomicBool,
}
