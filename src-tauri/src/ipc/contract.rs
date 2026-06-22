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
    /// Кандидат на очистку (кэш-папка/давность/корзина) — присваивает Classifier.
    CleanupCandidate,
    /// Синтетический узел «Прочее (N файлов)» — честная сумма хвоста.
    Aggregated,
}

/// Режим агрегации мелочи в блок «Прочее».
///
/// - `Relative` — порог как ДОЛЯ объёма папки: файл сворачивается, если его
///   размер меньше `fraction` от свёрнутой суммы родителя. Применяется на КАЖДОМ
///   уровне, включая вложенные превью (у каждой папки — свой масштаб).
/// - `Absolute` — порог как точное число байт: файл сворачивается, если он мельче
///   `min_bytes`. Применяется ТОЛЬКО к запрошенному уровню; во вложенные превью
///   абсолютный порог не уходит (у мелких дочерних папок он выкосил бы всё) —
///   там работает относительный фолбэк по `fraction`.
///
/// ВАЖНО: зеркало TS-типа `AggMode` (src/lib/ipc/contract.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AggMode {
    Relative,
    Absolute,
}

/// Параметры агрегации «Прочее», приходят от UI в `get_level`.
/// ВАЖНО: зеркало TS-типа `AggSpec` (src/lib/ipc/contract.ts).
///
/// Папки в «Прочее» НИКОГДА не сворачиваются (остаются навигируемыми районами) —
/// сворачиваются только файлы. `top_n_cap` — страховочный потолок числа зданий на
/// уровень (перфо), не основной контрол: лишние мелкие файлы поверх потолка тоже
/// уходят в «Прочее». 0 — без потолка.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AggSpec {
    pub mode: AggMode,
    /// Доля объёма папки (0.0–1.0). Порог относительного режима и фолбэк превью.
    pub fraction: f32,
    /// Точный порог в байтах для абсолютного режима (текущий уровень).
    pub min_bytes: u64,
    /// Потолок числа зданий-файлов на уровень (страховка перфо); 0 — без потолка.
    pub top_n_cap: u32,
}

/// Прогресс скана — летит потоком событий `scan://progress` (троттлинг на
/// бэке ≤ раз/100 мс). Финальное событие имеет `done = true`.
/// ВАЖНО: зеркало TS-типа `ScanProgress` (src/lib/ipc/contract.ts).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    /// Сколько входов ФС уже обработано.
    pub entries: u64,
    /// Сумма размеров файлов, увиденных к этому моменту (байты).
    pub bytes: u64,
    /// Сколько входов пропущено из-за ошибок доступа.
    pub errors: u64,
    /// Скан завершён (успехом или отменой).
    pub done: bool,
    /// Скан был отменён пользователем (валиден при `done`).
    pub cancelled: bool,
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
    /// Превью детей (вложенный treemap, +1 уровень). Заполняется ТОЛЬКО при
    /// `get_level(depth > 1)` и только для папок (рекурсивно при `depth > 2`);
    /// иначе пусто. Пустой вектор не сериализуется — payload не раздувается
    /// на листьях и при `depth = 1` (см. docs §5.7, IPC «текущий уровень + превью»).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<ScanNode>,
}
