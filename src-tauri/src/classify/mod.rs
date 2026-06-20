//! Классификатор (правила, без ИИ): категория файла по расширению и пометка
//! кэш/мусор-папок. Данные-таблицы — в `data.rs` (контент-тикет 001), логика —
//! здесь.
//!
//! Цвет здания = категория содержимого (см. ТЗ §2). Категория присваивается
//! по расширению; неизвестное → `Other`. Папки сами по себе категории не несут
//! (`Other`), но известные кэш-каталоги помечаются кандидатами на очистку.

mod data;

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

/// Имя каталога — известный кэш/мусор (кандидат на очистку)?
/// Сравнение по точному совпадению имени в нижнем регистре.
pub fn is_cleanup_dir(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    data::CLEANUP_DIR_NAMES.iter().any(|&n| n == lower)
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
    fn detects_cleanup_dirs() {
        assert!(is_cleanup_dir("node_modules"));
        assert!(is_cleanup_dir("Node_Modules"));
        assert!(is_cleanup_dir("__pycache__"));
        assert!(!is_cleanup_dir("src"));
    }

    #[test]
    fn detects_recycle_bin() {
        // Корзина Windows в корне диска — точное имя с учётом регистра.
        assert!(is_cleanup_dir("$Recycle.Bin"));
        assert!(is_cleanup_dir("$RECYCLE.BIN"));
        assert!(is_cleanup_dir(".Trash"));
        assert!(!is_cleanup_dir("Recycle"));
    }
}
