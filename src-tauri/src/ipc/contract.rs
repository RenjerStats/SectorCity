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
    /// Узел заблокирован для удаления (системный файл/папка).
    Locked,
    /// Синтетический узел «Мелочь (N элементов)» — честная сумма хвоста (файлы и
    /// папки мельче порога). Навигируем: путь `{уровень}::<other>` раскрывает хвост.
    Aggregated,
}

/// Причина, по которой узел признан кандидатом на очистку. Определяет
/// уверенность и текст-объяснение.
/// ВАЖНО: зеркало TS-типа `CleanupReason` (src/lib/ipc/contract.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CleanupReason {
    /// Кэш пакетного менеджера (node_modules при package.json, pip/npm/nuget/gradle).
    PackageCache,
    /// Артефакты сборки (target при Cargo.toml, build/dist/out при маркере проекта).
    BuildArtifact,
    /// Кэш браузера (…\Cache / Code Cache под профилем известного браузера).
    BrowserCache,
    /// Кэш шейдеров/GPU (DXCache, GLCache, ShaderCache).
    GpuCache,
    /// Известная папка времянок (AppData\Local\Temp, Windows\Temp).
    TempDir,
    /// Файл-времянка по расширению (.tmp/.bak/.old/~*).
    TempFile,
    /// Прерванная загрузка (.crdownload/.part/.download).
    InterruptedDownload,
    /// Дамп падения (.dmp, папка CrashDumps).
    CrashDump,
    /// Корзина ОС ($Recycle.Bin, .Trash).
    RecycleBin,
    /// Windows.old — прошлая установка Windows.
    WindowsOld,
    /// Установщик, залежавшийся в «Загрузках» (.exe/.msi в Downloads).
    InstallerInDownloads,
    /// Пустая папка.
    EmptyDir,
    /// Крупный и давно не тронутый файл (эвристика, строго Review).
    StaleLarge,
}

/// Уверенность правила: `Safe` — можно сносить смело, `Likely` — почти наверняка
/// мусор, `Review` — требует взгляда пользователя.
/// ВАЖНО: зеркало TS-типа `Confidence` (src/lib/ipc/contract.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Safe,
    Likely,
    Review,
}

/// Тройка «правило → уверенность» на узле-кандидате. Сериализуется только когда
/// есть (`Option` на `ScanNode`) — payload не раздувается.
/// ВАЖНО: зеркало TS-типа `CleanupInfo` (src/lib/ipc/contract.ts).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupInfo {
    pub reason: CleanupReason,
    pub confidence: Confidence,
}

/// Группа кандидатов одной причины по поддереву — ответ `list_cleanup`.
/// ВАЖНО: зеркало TS-типа `CleanupGroup` (src/lib/ipc/contract.ts).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupGroup {
    pub reason: CleanupReason,
    pub confidence: Confidence,
    /// Число кандидатов причины в поддереве (вложенные не задваиваются).
    pub count: u64,
    /// Суммарный объём кандидатов причины (байты).
    pub bytes: u64,
    /// Крупнейшие N кандидатов причины (для списка в панели); остальные — лениво
    /// через `cleanup_paths`.
    pub top_items: Vec<ScanNode>,
}

/// Лёгкая ссылка на кандидата (для массовой пометки причины целиком).
/// ВАЖНО: зеркало TS-типа `CleanupItemRef` (src/lib/ipc/contract.ts).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupItemRef {
    pub path: String,
    pub size: u64,
    /// Время модификации (unix-секунды) — для фильтра давности при пометке.
    pub mtime: i64,
}

/// Параметры агрегации «Прочее», приходят от UI в `get_level`.
/// ВАЖНО: зеркало TS-типа `AggSpec` (src/lib/ipc/contract.ts).
///
/// Порог — ВСЕГДА относительный (доля объёма уровня): узел сворачивается, если его
/// размер меньше `fraction` от суммы уровня. Детерминированно и независимо от ракурса
/// камеры; применяется ОДИНАКОВО на каждом уровне, включая вложенные превью (у каждой
/// папки — свой масштаб). Поэтому блок «Мелочь» в превью купола и после drill в него
/// совпадает по построению.
///
/// Сворачиваются И файлы, И папки мельче порога (свёрнутая папка остаётся доступной
/// через навигируемый блок «Прочее»). `top_n_cap` — страховочный потолок числа узлов
/// в head на уровень (перфо), не основной контрол: лишняя мелочь поверх потолка тоже
/// уходит в «Прочее». 0 — без потолка.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AggSpec {
    /// Доля площади уровня (0.0–1.0): порог агрегации (footprint). Фронт выводит её
    /// из бюджета пикселей по размеру канваса.
    pub fraction: f32,
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
    /// Битовая маска категорий ФАЙЛОВ, присутствующих в поддереве узла: для файла —
    /// бит его собственной категории; для папки — объединение по всем потомкам; для
    /// блока «Мелочь» — объединение свёрнутого хвоста. Порядок битов = порядок
    /// `ALL_CATEGORIES` на фронте (`code`=бит 0 … `other`=бит 7), см. `category_bit`.
    /// Питает структурный фильтр по категориям: папку/«Мелочь», в которой нет ни
    /// одной выбранной категории, фронт убирает из раскладки (не водить пользователя
    /// по заведомо пустым районам).
    pub category_mask: u8,
    pub flags: Vec<NodeFlag>,
    /// Кандидатура на очистку: (причина, уверенность). `None` — не кандидат;
    /// не сериализуется, когда пусто (payload не раздувается). Флаг
    /// `CleanupCandidate` в `flags` дублируется для обратной совместимости фронта.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleanup: Option<CleanupInfo>,
    /// Превью детей (вложенный treemap, +1 уровень). Заполняется ТОЛЬКО при
    /// `get_level(depth > 1)` и только для папок (рекурсивно при `depth > 2`);
    /// иначе пусто. Пустой вектор не сериализуется — payload не раздувается
    /// на листьях и при `depth = 1`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<ScanNode>,
}

/// Ответ `current_root`: корень текущего дерева с учётом фоновой загрузки снимка.
/// ВАЖНО: зеркало TS-типа `CurrentRoot` (src/lib/ipc/contract.ts).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentRoot {
    /// Снимок ещё читается из SQLite в фоне: корня пока нет, но он МОЖЕТ появиться —
    /// фронт ждёт события `snapshot://ready`, а не стартует на демо-городе.
    pub loading: bool,
    /// Корень дерева (загруженного снимка или последнего скана); `None`, если
    /// дерева нет (и не будет, когда `loading == false`).
    pub root: Option<String>,
}

/// Результат удаления помеченных файлов в Корзину.
/// ВАЖНО: зеркало TS-типа `DeleteResult` (src/lib/ipc/contract.ts).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    /// Пути, успешно перемещённые в корзину.
    pub deleted: Vec<String>,
    /// Суммарный объём освобождённого места в байтах.
    pub freed: u64,
    /// Пути, которые не удалось удалить.
    pub failed: Vec<String>,
}
