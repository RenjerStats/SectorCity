//! Классификатор (правила, без ИИ): категория файла по расширению и движок
//! правил очистки v2 (`rules.rs`, пост-проход по дереву). Данные-таблицы — в
//! `data.rs` (контент-тикет 001), логика — здесь и в `rules.rs`.
//!
//! Цвет здания = категория содержимого (см. ТЗ §2). Категория присваивается
//! по расширению; неизвестное → `Other`. Папки сами по себе категории не несут
//! (`Other`); кандидаты на очистку размечает `rules::apply_cleanup`.

mod data;
mod rules;

pub use rules::{apply_cleanup, confidence_of};

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use crate::ipc::contract::Category;

/// Ленивая карта «расширение → категория» (строится один раз из таблицы).
fn ext_map() -> &'static HashMap<&'static str, Category> {
    static MAP: OnceLock<HashMap<&'static str, Category>> = OnceLock::new();
    MAP.get_or_init(|| data::EXTENSION_CATEGORY.iter().copied().collect())
}

/// Категория узла. Папки — всегда `Other` (цвет района — отдельный канал,
/// фаза 2); файлы — по расширению, неизвестное расширение → `Other`.
pub fn classify(path: &Path, is_dir: bool) -> Category {
    if is_dir {
        return Category::Other;
    }
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            let lower = ext.to_ascii_lowercase();
            ext_map()
                .get(lower.as_str())
                .copied()
                .unwrap_or(Category::Other)
        }
        None => Category::Other,
    }
}

/// Порог «крупного» файла для эвристики очистки (байты).
pub const STALE_LARGE_MIN_SIZE: u64 = 100 * 1024 * 1024; // 100 МБ
/// Порог «давности» для эвристики очистки (секунды).
pub const STALE_AGE_SECONDS: i64 = 180 * 24 * 3600; // ~6 месяцев

/// Файл — кандидат на очистку по эвристике «крупный И давно не трогался».
/// База давности — `mtime` (atime недостоверен, ТЗ §5.9). `mtime`/`now` —
/// unix-секунды. Папки сюда не попадают: для них работает `is_cleanup_dir`.
pub fn is_stale_large_file(size: u64, mtime: i64, now: i64) -> bool {
    size >= STALE_LARGE_MIN_SIZE && now.saturating_sub(mtime) >= STALE_AGE_SECONDS
}

/// Проверить, заблокирован ли узел (системный файл или папка).
/// Windows-специфичные системные пути, скрытые/системные атрибуты, или критические файлы.
pub fn is_locked_path(path: &Path, name: &str) -> bool {
    let lower_name = name.to_ascii_lowercase();

    // 1. Критические файлы Windows на диске
    if lower_name == "pagefile.sys" || lower_name == "hiberfil.sys" || lower_name == "swapfile.sys"
    {
        return true;
    }

    // 2. Системные директории Windows в путях
    for component in path.components() {
        if let Some(s) = component.as_os_str().to_str() {
            let lower_s = s.to_ascii_lowercase();
            if lower_s == "windows"
                || lower_s == "program files"
                || lower_s == "program files (x86)"
                || lower_s == "programdata"
            {
                return true;
            }
        }
    }

    false
}

/// Проверить атрибуты метаданных (на Windows — System атрибут).
pub fn is_system_by_attrs(meta: &std::fs::Metadata) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        let attrs = meta.file_attributes();
        // FILE_ATTRIBUTE_SYSTEM = 0x4
        (attrs & 0x4) != 0
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = meta;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn classifies_by_extension_case_insensitive() {
        assert_eq!(classify(Path::new("a/b/main.RS"), false), Category::Code);
        assert_eq!(classify(Path::new("movie.MP4"), false), Category::Video);
        assert_eq!(classify(Path::new("photo.jpg"), false), Category::Image);
    }

    #[test]
    fn unknown_and_extensionless_are_other() {
        assert_eq!(classify(Path::new("file.qwxyz"), false), Category::Other);
        assert_eq!(classify(Path::new("README"), false), Category::Other);
    }

    #[test]
    fn directories_are_other() {
        assert_eq!(
            classify(Path::new("some.dir.with.dots"), true),
            Category::Other
        );
    }

    #[test]
    fn stale_large_file_heuristic() {
        let now = 1_000_000_000;
        let big = STALE_LARGE_MIN_SIZE;
        let old = now - STALE_AGE_SECONDS;
        // Крупный И старый → кандидат.
        assert!(is_stale_large_file(big, old, now));
        // Крупный, но свежий → нет.
        assert!(!is_stale_large_file(big, now, now));
        // Старый, но мелкий → нет.
        assert!(!is_stale_large_file(1024, old, now));
    }

    #[test]
    fn detects_locked_paths() {
        assert!(is_locked_path(
            Path::new("C:\\Windows\\System32\\cmd.exe"),
            "cmd.exe"
        ));
        assert!(is_locked_path(
            Path::new("D:\\Program Files\\Rust\\bin"),
            "bin"
        ));
        assert!(is_locked_path(
            Path::new("C:\\pagefile.sys"),
            "pagefile.sys"
        ));
        assert!(!is_locked_path(
            Path::new("C:\\projects\\my_project"),
            "my_project"
        ));
    }
}
