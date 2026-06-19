//! Ошибки приложения. `thiserror` для типов библиотеки, сериализация в
//! строку — чтобы ошибка доезжала до фронта через Tauri IPC.

use serde::{Serialize, Serializer};

/// Ошибка уровня приложения. Возвращается из IPC-команд.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("ошибка ввода-вывода: {0}")]
    Io(#[from] std::io::Error),

    #[error("ошибка БД: {0}")]
    Db(String),

    #[error("команда ещё не реализована: {0}")]
    NotImplemented(&'static str),

    #[error("{0}")]
    Other(String),
}

/// Tauri требует, чтобы тип ошибки команды реализовывал `Serialize`.
/// Отдаём фронту человекочитаемую строку.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
