//! Состояние приложения, разделяемое между IPC-командами.
//!
//! Пока здесь только результат последнего скана (дерево в памяти). Снимок в
//! SQLite (быстрое переоткрытие/diff) ляжет рядом отдельной фазой.

use std::sync::Mutex;

use crate::scan::ScanTree;

/// Tauri-managed состояние. Доступ из команд через `tauri::State<AppState>`.
#[derive(Default)]
pub struct AppState {
    /// Дерево последнего успешного скана; `None` до первого `start_scan`.
    pub scan: Mutex<Option<ScanTree>>,
}
