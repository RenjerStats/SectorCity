//! Граница IPC: контракт данных и команды Tauri.
//!
//! Модули публичные намеренно: `tauri::generate_handler!` должен видеть
//! команды по полному пути (`ipc::commands::start_scan`), иначе не находит
//! скрытые элементы, которые генерирует макрос `#[tauri::command]`.

pub mod commands;
pub mod contract;
