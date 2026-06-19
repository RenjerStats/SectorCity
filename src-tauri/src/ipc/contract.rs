//! Контракт данных «бэк ↔ фронт».
//!
//! ВАЖНО: зеркало TS-типа `ScanNode` (src/lib/ipc/contract.ts).
//! `rename_all = "camelCase"` приводит snake_case-поля Rust к camelCase
//! ключам JSON, которые ждёт фронт. Менять — синхронно в обоих местах.

use serde::{Deserialize, Serialize};

/// Категория содержимого — единственный канал для цвета (colorblind-safe).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Code,
    Document,
    Image,
    Video,
    Audio,
    Archive,
    Binary,
    Other,
}

/// Пометки узла, влияющие на отрисовку и обход.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeFlag {
    Symlink,
    ReparsePoint,
    PermissionDenied,
    /// Синтетический узел «Прочее (N файлов)» — честная сумма хвоста.
    Aggregated,
}

/// Один узел дерева ФС в том виде, в каком он уходит на фронт.
/// Для папок `size` — уже свёрнутая рекурсивная сумма.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanNode {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    /// Размер в байтах; для папок — рекурсивная сумма.
    pub size: u64,
    /// Время модификации, unix-секунды. База высоты (устаревание).
    pub mtime: i64,
    /// Время доступа, unix-секунды. Только как уточнение при достоверности.
    pub atime: i64,
    /// Число прямых детей (для папок).
    pub child_count: u32,
    pub category: Category,
    pub flags: Vec<NodeFlag>,
}
