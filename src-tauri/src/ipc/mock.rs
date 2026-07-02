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
    /// Кандидат на очистку — для демонстрации маркера без реального скана.
    is_cleanup: bool,
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
        is_cleanup: false,
    },
    MockSpec {
        name: "Program Files",
        is_dir: true,
        size: 21_300_000_000,
        age_days: 40,
        child_count: 31,
        category: Category::Binary,
        is_cleanup: false,
    },
    MockSpec {
        name: "Users",
        is_dir: true,
        size: 64_900_000_000,
        age_days: 3,
        child_count: 8,
        category: Category::Document,
        is_cleanup: false,
    },
    MockSpec {
        name: "projects",
        is_dir: true,
        size: 12_100_000_000,
        age_days: 1,
        child_count: 47,
        category: Category::Code,
        is_cleanup: false,
    },
    MockSpec {
        name: "media",
        is_dir: true,
        size: 53_700_000_000,
        age_days: 90,
        child_count: 6,
        category: Category::Video,
        is_cleanup: false,
    },
    MockSpec {
        name: "photos",
        is_dir: true,
        size: 18_200_000_000,
        age_days: 220,
        child_count: 14,
        category: Category::Image,
        is_cleanup: false,
    },
    MockSpec {
        name: "music",
        is_dir: true,
        size: 9_400_000_000,
        age_days: 365,
        child_count: 11,
        category: Category::Audio,
        is_cleanup: false,
    },
    MockSpec {
        name: "backups.zip",
        is_dir: false,
        size: 7_800_000_000,
        age_days: 730,
        child_count: 0,
        category: Category::Archive,
        is_cleanup: false,
    },
    MockSpec {
        name: "install.iso",
        is_dir: false,
        size: 4_200_000_000,
        age_days: 500,
        child_count: 0,
        category: Category::Binary,
        is_cleanup: false,
    },
    // Корзина на корне диска — кандидат на очистку (демонстрирует маркер).
    MockSpec {
        name: "$Recycle.Bin",
        is_dir: true,
        size: 6_100_000_000,
        age_days: 150,
        child_count: 3,
        category: Category::Other,
        is_cleanup: true,
    },
    MockSpec {
        name: "Мелочь",
        is_dir: false,
        size: 1_300_000_000,
        age_days: 300,
        child_count: 0,
        category: Category::Other,
        is_cleanup: false,
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
            let mut flags = Vec::new();
            if spec.name == "Мелочь" {
                flags.push(NodeFlag::Aggregated);
            }
            if spec.is_cleanup {
                flags.push(NodeFlag::CleanupCandidate);
            }
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
                // Мок плоский (без детей): маску ставим по собственной категории
                // узла — демо-фильтр по категориям тогда работает и до скана.
                category_mask: crate::scan::category_bit(spec.category),
                flags,
                // Мок-кандидаты несут условную причину (демо панели причин).
                cleanup: spec
                    .is_cleanup
                    .then_some(crate::ipc::contract::CleanupInfo {
                        reason: crate::ipc::contract::CleanupReason::StaleLarge,
                        confidence: crate::ipc::contract::Confidence::Review,
                    }),
                // Мок плоский: реальные дети (и превью depth>1) придут со сканером.
                children: Vec::new(),
            }
        })
        .collect()
}
