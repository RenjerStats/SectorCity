//! Данные классификатора: расширение → категория и таблицы правил очистки v2.
//! Сгенерировано как контент-таблица (тикет 001). Только данные, без логики.

use crate::ipc::contract::{Category, CleanupReason};

/// Пары (расширение_без_точки_в_нижнем_регистре, категория).
/// Отсортировано по категории, внутри — по алфавиту. Без дубликатов расширений.
pub const EXTENSION_CATEGORY: &[(&str, Category)] = &[
    ("7z", Category::Archive),
    ("apk", Category::Archive),
    ("arj", Category::Archive),
    ("bz2", Category::Archive),
    ("cab", Category::Archive),
    ("cpio", Category::Archive),
    ("dmg", Category::Archive),
    ("ear", Category::Archive),
    ("gz", Category::Archive),
    ("iso", Category::Archive),
    ("jar", Category::Archive),
    ("lzma", Category::Archive),
    ("pkg", Category::Archive),
    ("rar", Category::Archive),
    ("tar", Category::Archive),
    ("tbz2", Category::Archive),
    ("tgz", Category::Archive),
    ("war", Category::Archive),
    ("xz", Category::Archive),
    ("z", Category::Archive),
    ("zip", Category::Archive),
    ("zipx", Category::Archive),
    ("aac", Category::Audio),
    ("aif", Category::Audio),
    ("aiff", Category::Audio),
    ("alac", Category::Audio),
    ("ape", Category::Audio),
    ("flac", Category::Audio),
    ("m4a", Category::Audio),
    ("mid", Category::Audio),
    ("midi", Category::Audio),
    ("mp3", Category::Audio),
    ("ogg", Category::Audio),
    ("opus", Category::Audio),
    ("wav", Category::Audio),
    ("wma", Category::Audio),
    ("a", Category::Binary),
    ("accdb", Category::Binary),
    ("bin", Category::Binary),
    ("dat", Category::Binary),
    ("db", Category::Binary),
    ("deb", Category::Binary),
    ("dll", Category::Binary),
    ("dmp", Category::Binary),
    ("dylib", Category::Binary),
    ("elf", Category::Binary),
    ("exe", Category::Binary),
    ("img", Category::Binary),
    ("lib", Category::Binary),
    ("mdb", Category::Binary),
    ("msi", Category::Binary),
    ("o", Category::Binary),
    ("obj", Category::Binary),
    ("pdb", Category::Binary),
    ("qcow2", Category::Binary),
    ("rpm", Category::Binary),
    ("so", Category::Binary),
    ("sqlite", Category::Binary),
    ("sqlite3", Category::Binary),
    ("sqlitedb", Category::Binary),
    ("sys", Category::Binary),
    ("vdi", Category::Binary),
    ("vhd", Category::Binary),
    ("vhdx", Category::Binary),
    ("vmdk", Category::Binary),
    ("asm", Category::Code),
    ("bat", Category::Code),
    ("c", Category::Code),
    ("cfg", Category::Code),
    ("cmake", Category::Code),
    ("cmd", Category::Code),
    ("conf", Category::Code),
    ("cpp", Category::Code),
    ("cs", Category::Code),
    ("css", Category::Code),
    ("cxx", Category::Code),
    ("dart", Category::Code),
    ("dockerfile", Category::Code),
    ("fs", Category::Code),
    ("go", Category::Code),
    ("gradle", Category::Code),
    ("groovy", Category::Code),
    ("h", Category::Code),
    ("hpp", Category::Code),
    ("hs", Category::Code),
    ("html", Category::Code),
    ("ini", Category::Code),
    ("java", Category::Code),
    ("js", Category::Code),
    ("json", Category::Code),
    ("jsx", Category::Code),
    ("kt", Category::Code),
    ("kts", Category::Code),
    ("less", Category::Code),
    ("lua", Category::Code),
    ("makefile", Category::Code),
    ("mjs", Category::Code),
    ("php", Category::Code),
    ("pl", Category::Code),
    ("ps1", Category::Code),
    ("py", Category::Code),
    ("r", Category::Code),
    ("rb", Category::Code),
    ("rs", Category::Code),
    ("sass", Category::Code),
    ("scala", Category::Code),
    ("scss", Category::Code),
    ("sh", Category::Code),
    ("sql", Category::Code),
    ("swift", Category::Code),
    ("toml", Category::Code),
    ("ts", Category::Code),
    ("tsx", Category::Code),
    ("xml", Category::Code),
    ("yaml", Category::Code),
    ("yml", Category::Code),
    ("bib", Category::Document),
    ("csv", Category::Document),
    ("djvu", Category::Document),
    ("doc", Category::Document),
    ("docx", Category::Document),
    ("epub", Category::Document),
    ("fb2", Category::Document),
    ("key", Category::Document),
    ("log", Category::Document),
    ("markdown", Category::Document),
    ("md", Category::Document),
    ("mdx", Category::Document),
    ("mobi", Category::Document),
    ("numbers", Category::Document),
    ("odp", Category::Document),
    ("ods", Category::Document),
    ("odt", Category::Document),
    ("pages", Category::Document),
    ("pdf", Category::Document),
    ("ppt", Category::Document),
    ("pptx", Category::Document),
    ("rtf", Category::Document),
    ("tex", Category::Document),
    ("tsv", Category::Document),
    ("txt", Category::Document),
    ("xls", Category::Document),
    ("xlsx", Category::Document),
    ("ai", Category::Image),
    ("bmp", Category::Image),
    ("eps", Category::Image),
    ("fig", Category::Image),
    ("gif", Category::Image),
    ("heic", Category::Image),
    ("heif", Category::Image),
    ("ico", Category::Image),
    ("indd", Category::Image),
    ("jpeg", Category::Image),
    ("jpg", Category::Image),
    ("png", Category::Image),
    ("psd", Category::Image),
    ("raw", Category::Image),
    ("sketch", Category::Image),
    ("svg", Category::Image),
    ("tif", Category::Image),
    ("tiff", Category::Image),
    ("webp", Category::Image),
    ("xcf", Category::Image),
    ("3gp", Category::Video),
    ("asf", Category::Video),
    ("avi", Category::Video),
    ("divx", Category::Video),
    ("flv", Category::Video),
    ("m2ts", Category::Video),
    ("m4v", Category::Video),
    ("mkv", Category::Video),
    ("mov", Category::Video),
    ("mp4", Category::Video),
    ("mpeg", Category::Video),
    ("mpg", Category::Video),
    ("mts", Category::Video),
    ("ogv", Category::Video),
    ("rm", Category::Video),
    ("rmvb", Category::Video),
    ("vob", Category::Video),
    ("webm", Category::Video),
    ("wmv", Category::Video),
];

/* ─────────────────────────── правила очистки v2 ────────────────────────────
 * План §2 / vision §I.7.1. Здесь только данные; движок — classify/rules.rs.
 * Все имена/компоненты — в нижнем регистре, движок сравнивает case-insensitive.
 */

/// Имена каталогов-мусора, ОДНОЗНАЧНЫЕ без контекста (точный матч имени).
/// Голые `build`/`dist`/`out`/`temp`/`tmp` сюда НЕ входят (ложные срабатывания) —
/// они контекст-зависимые, см. [`CONTEXT_DIR_RULES`] и известные пути.
pub const UNAMBIGUOUS_DIR_NAMES: &[(&str, CleanupReason)] = &[
    // Корзины ОС (в корне каждого диска Windows; `.trash` — задел под *nix).
    ("$recycle.bin", CleanupReason::RecycleBin),
    (".trash", CleanupReason::RecycleBin),
    // Прошлая установка Windows.
    ("windows.old", CleanupReason::WindowsOld),
    // Кэши инструментов, узнаваемые по одному имени.
    ("__pycache__", CleanupReason::BuildArtifact),
    (".pytest_cache", CleanupReason::BuildArtifact),
    (".sass-cache", CleanupReason::BuildArtifact),
    (".turbo", CleanupReason::BuildArtifact),
    (".ipynb_checkpoints", CleanupReason::BuildArtifact),
    (".vs", CleanupReason::BuildArtifact),
    ("bower_components", CleanupReason::PackageCache),
    // Кэши GPU/шейдеров (профили драйверов и приложений).
    ("dxcache", CleanupReason::GpuCache),
    ("glcache", CleanupReason::GpuCache),
    ("shadercache", CleanupReason::GpuCache),
    ("d3dscache", CleanupReason::GpuCache),
    ("nv_cache", CleanupReason::GpuCache),
    // Дампы падений Windows (%LOCALAPPDATA%\CrashDumps).
    ("crashdumps", CleanupReason::CrashDump),
];

/// Известные пути: путь узла ЗАКАНЧИВАЕТСЯ этой последовательностью компонентов.
pub const PATH_SUFFIX_RULES: &[(&[&str], CleanupReason)] = &[
    (&["appdata", "local", "temp"], CleanupReason::TempDir),
    (&["windows", "temp"], CleanupReason::TempDir),
    (
        &["appdata", "local", "pip", "cache"],
        CleanupReason::PackageCache,
    ),
    (
        &["appdata", "local", "npm-cache"],
        CleanupReason::PackageCache,
    ),
    (
        &["appdata", "local", "yarn", "cache"],
        CleanupReason::PackageCache,
    ),
    (&[".nuget", "packages"], CleanupReason::PackageCache),
    (&[".gradle", "caches"], CleanupReason::PackageCache),
];

/// Имена кэш-папок браузеров: срабатывают ТОЛЬКО при компоненте-вендоре в пути
/// (см. [`BROWSER_VENDOR_COMPONENTS`]) — голое `cache` где угодно не считается.
pub const BROWSER_CACHE_DIR_NAMES: &[&str] = &[
    "cache",
    "code cache",
    "gpucache",
    "cache_data",
    "cachestorage",
    "media cache",
    "cache2", // Firefox
];

/// Компоненты пути, указывающие на профиль браузера.
pub const BROWSER_VENDOR_COMPONENTS: &[&str] = &[
    "mozilla",
    "firefox",
    "google",
    "chrome",
    "chromium",
    "microsoft",
    "edge",
    "opera",
    "opera software",
    "bravesoftware",
    "vivaldi",
    "yandex",
    "yandexbrowser",
];

/// Контекст-зависимое правило: папка `name` — кандидат, только если среди её
/// СОСЕДЕЙ (детей родителя) есть маркер проекта. Маркер `*.ext` — по суффиксу.
pub struct ContextDirRule {
    pub name: &'static str,
    pub reason: CleanupReason,
    pub markers: &'static [&'static str],
}

/// Маркеры «рядом проект» для generic-папок сборки (build/dist/out).
pub const PROJECT_MARKERS: &[&str] = &[
    "package.json",
    "cmakelists.txt",
    "*.sln",
    "*.csproj",
    "pyproject.toml",
    "makefile",
    "cargo.toml",
    "build.gradle",
    "build.gradle.kts",
];

/// Маркеры python-проекта (для venv).
pub const PY_MARKERS: &[&str] = &["pyproject.toml", "requirements.txt", "setup.py"];

/// Контекст-зависимые папки (главное отличие v2 от v1).
pub const CONTEXT_DIR_RULES: &[ContextDirRule] = &[
    ContextDirRule {
        name: "node_modules",
        reason: CleanupReason::PackageCache,
        markers: &["package.json"],
    },
    ContextDirRule {
        name: "target",
        reason: CleanupReason::BuildArtifact,
        markers: &["cargo.toml"],
    },
    ContextDirRule {
        name: "build",
        reason: CleanupReason::BuildArtifact,
        markers: PROJECT_MARKERS,
    },
    ContextDirRule {
        name: "dist",
        reason: CleanupReason::BuildArtifact,
        markers: PROJECT_MARKERS,
    },
    ContextDirRule {
        name: "out",
        reason: CleanupReason::BuildArtifact,
        markers: PROJECT_MARKERS,
    },
    ContextDirRule {
        name: ".venv",
        reason: CleanupReason::PackageCache,
        markers: PY_MARKERS,
    },
    ContextDirRule {
        name: "venv",
        reason: CleanupReason::PackageCache,
        markers: PY_MARKERS,
    },
    ContextDirRule {
        name: ".gradle",
        reason: CleanupReason::BuildArtifact,
        markers: &[
            "build.gradle",
            "build.gradle.kts",
            "settings.gradle",
            "settings.gradle.kts",
        ],
    },
];

/// Расширения-времянки: (расширение_без_точки, причина).
pub const TEMP_FILE_EXTENSIONS: &[(&str, CleanupReason)] = &[
    ("tmp", CleanupReason::TempFile),
    ("temp", CleanupReason::TempFile),
    ("bak", CleanupReason::TempFile),
    ("old", CleanupReason::TempFile),
    ("dmp", CleanupReason::CrashDump),
    ("crdownload", CleanupReason::InterruptedDownload),
    ("part", CleanupReason::InterruptedDownload),
    ("download", CleanupReason::InterruptedDownload),
];

/// Расширения установщиков (для правила «установщик в Загрузках»; Windows-first).
pub const INSTALLER_EXTENSIONS: &[&str] = &["exe", "msi", "msix", "appx"];

/// Имена папки «Загрузки» (нижний регистр).
pub const DOWNLOADS_DIR_NAMES: &[&str] = &["downloads", "загрузки"];
