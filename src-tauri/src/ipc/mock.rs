//! Мок-данные фазы 0: детерминированный «один уровень» города.
//!
//! Назначение — доказать сквозной поток `Rust → IPC → фронт → рендер`
//! до того, как появится настоящий Scanner/Aggregator (фазы 1–2).
//! Геометрия детерминирована (повторный вызов даёт те же узлы) — это
//! согласуется с принципом пространственной памяти из ТЗ.

use super::contract::{Category, NodeFlag, ScanNode};

/// Базовая отметка времени (unix-секунды) — точка отсчёта «свежести».
/// 2024-01-01T00:00:00Z; реальные mtime появятся со сканером.
const BASE_MTIME: i64 = 1_704_067_200;

/// Один синтетический узел уровня.
struct MockSpec {
    name: &'static str,
    is_dir: bool,
    size: u64,
    /// Сдвиг mtime от базы в сутках (больше — свежее).
    age_days: i64,
    child_count: u32,
    category: Category,
}

/// Фиксированный набор узлов «корневого» уровня для фазы 0.
const SPECS: &[MockSpec] = &[
    MockSpec {
        name: "Windows",
        is_dir: true,
        size: 38_500_000_000,
        age_days: 12,
        child_count: 24,
        category: Category::Binary,
    },
    MockSpec {
        name: "Program Files",
        is_dir: true,
        size: 21_300_000_000,
        age_days: 40,
        child_count: 31,
        category: Category::Binary,
    },
    MockSpec {
        name: "Users",
        is_dir: true,
        size: 64_900_000_000,
        age_days: 3,
        child_count: 8,
        category: Category::Document,
    },
    MockSpec {
        name: "projects",
        is_dir: true,
        size: 12_100_000_000,
        age_days: 1,
        child_count: 47,
        category: Category::Code,
    },
    MockSpec {
        name: "media",
        is_dir: true,
        size: 53_700_000_000,
        age_days: 90,
        child_count: 6,
        category: Category::Video,
    },
    MockSpec {
        name: "photos",
        is_dir: true,
        size: 18_200_000_000,
        age_days: 220,
        child_count: 14,
        category: Category::Image,
    },
    MockSpec {
        name: "music",
        is_dir: true,
        size: 9_400_000_000,
        age_days: 365,
        child_count: 11,
        category: Category::Audio,
    },
    MockSpec {
        name: "backups.zip",
        is_dir: false,
        size: 7_800_000_000,
        age_days: 730,
        child_count: 0,
        category: Category::Archive,
    },
    MockSpec {
        name: "install.iso",
        is_dir: false,
        size: 4_200_000_000,
        age_days: 500,
        child_count: 0,
        category: Category::Binary,
    },
    MockSpec {
        name: "Прочее",
        is_dir: false,
        size: 1_300_000_000,
        age_days: 300,
        child_count: 0,
        category: Category::Other,
    },
];

const SECONDS_PER_DAY: i64 = 86_400;

/// Собрать детерминированный мок-уровень под заданным корнем.
/// `root` подставляется в начало путей, чтобы фронт видел осмысленные `path`.
pub fn mock_level(root: &str) -> Vec<ScanNode> {
    let base = root.trim_end_matches(['/', '\\']);
    SPECS
        .iter()
        .map(|spec| {
            let path = if base.is_empty() {
                spec.name.to_string()
            } else {
                format!("{base}/{}", spec.name)
            };
            let mtime = BASE_MTIME - spec.age_days * SECONDS_PER_DAY;
            let flags = if spec.name == "Прочее" {
                vec![NodeFlag::Aggregated]
            } else {
                Vec::new()
            };
            ScanNode {
                path,
                name: spec.name.to_string(),
                is_dir: spec.is_dir,
                size: spec.size,
                mtime,
                // atime пока приравниваем к mtime — настоящий придёт со сканером.
                atime: mtime,
                child_count: spec.child_count,
                category: spec.category,
                flags,
            }
        })
        .collect()
}
