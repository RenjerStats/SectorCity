//! Сканер ФС (фаза 1): обход через `jwalk` + агрегация снизу вверх в дерево.
//!
//! Это «Scanner» и «Aggregator» из потока `Scanner → Aggregator → Snapshot →
//! IPC → Layout → Renderer` (docs/SectorCity-tech.md §5). Здесь — только сбор
//! и свёртка в память; снимок в SQLite и отдача по уровням — отдельные фазы.
//!
//! Ключевые решения и накладки (см. docs):
//! - permission denied → пропускаем, считаем число ошибок (не валим скан);
//! - reparse points / junction → не следуем внутрь (защита от циклов), узел
//!   остаётся, помечается `is_reparse`, поддерево не раскрывается;
//! - длинные пути Windows → корень обходим с префиксом `\\?\`, в выдаче префикс
//!   срезаем, чтобы UI видел «человеческие» пути;
//! - агрегация: `size` папок — рекурсивная сумma потомков, `child_count` —
//!   число прямых детей.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use jwalk::WalkDir;
use tokio_util::sync::CancellationToken;

use crate::ipc::contract::{AggMode, AggSpec, Category, NodeFlag, ScanNode, ScanProgress};

pub mod snapshot;

/// Минимальный интервал между событиями прогресса (троттлинг, см. docs §5.4).
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Результат скана: завершён деревом либо отменён пользователем.
pub enum ScanOutcome {
    Completed(ScanTree),
    Cancelled,
}

/// Узел дерева скана в арене. Индексы детей ссылаются в `ScanTree::nodes`.
#[derive(Debug, Clone)]
pub struct TreeNode {
    pub path: PathBuf,
    pub name: String,
    pub is_dir: bool,
    /// Размер в байтах: для файлов — собственный, для папок после агрегации —
    /// рекурсивная сумма потомков.
    pub size: u64,
    /// Время модификации (unix-секунды). База высоты (устаревание).
    pub mtime: i64,
    /// Время доступа (unix-секунды). Уточнение, недостоверно на части ФС.
    pub atime: i64,
    /// Число прямых детей.
    pub child_count: u32,
    /// Категория содержимого (канал цвета). Для файлов — по расширению.
    pub category: Category,
    /// Узел — reparse point / junction: внутрь не спускались.
    pub is_reparse: bool,
    /// Папка — известный кэш/мусор (кандидат на очистку).
    pub is_cleanup: bool,
    /// Индексы прямых детей в арене (только для папок).
    pub children: Vec<usize>,
    /// Глубина от корня скана (корень = 0). Нужна для порядка агрегации.
    depth: usize,
}

/// Результат скана: арена узлов + корень + число ошибок доступа.
#[derive(Debug, Clone)]
pub struct ScanTree {
    pub nodes: Vec<TreeNode>,
    /// Индекс корневого узла в `nodes`.
    pub root: usize,
    /// Сколько входов пропущено из-за ошибок (permission denied и пр.).
    pub error_count: u64,
    /// Очищенный путь (строкой) → индекс узла. Для быстрых запросов уровня.
    by_path: HashMap<String, usize>,
}

impl ScanTree {
    /// Корневой узел дерева.
    pub fn root_node(&self) -> &TreeNode {
        &self.nodes[self.root]
    }

    /// Индекс узла по очищенному пути.
    pub fn index_of(&self, path: &str) -> Option<usize> {
        self.by_path.get(path).copied()
    }

    /// Дети уровня `path` с агрегацией мелочи и превью на `depth` уровней вниз.
    ///
    /// Критерий «мелочи» задаёт [`AggSpec`] (относительный по доле объёма папки или
    /// абсолютный по байтам, см. контракт). Мелкие ФАЙЛЫ сворачиваются в
    /// синтетический узел «Прочее» честной суммарной площади (флаг `Aggregated`);
    /// папки никогда не сворачиваются (остаются навигируемыми районами).
    ///
    /// При `depth > 1` каждый дочерний РАЙОН (папка) дополнительно получает превью
    /// своих детей — вложенный treemap ещё на уровень вниз (ТЗ §3, «очертания до
    /// открытия»); рекурсия идёт до `depth == 1`. Наружу уходит «текущий уровень +
    /// превью», уже агрегированный по хвосту на каждом уровне (docs §IPC, §5.7).
    pub fn level(&self, path: &str, agg: &AggSpec, depth: u32) -> Vec<ScanNode> {
        let Some(idx) = self.index_of(path) else {
            return Vec::new();
        };
        // `current = true` только для запрошенного уровня: абсолютный порог живёт
        // лишь здесь, превью уходят в относительный фолбэк (см. `is_small`).
        self.children_of(idx, agg, depth, true)
    }

    /// Дети узла `idx` (крупные + «Прочее»); папки при `depth > 1` несут превью.
    /// `current` — это запрошенный уровень (для семантики абсолютного режима).
    fn children_of(&self, idx: usize, agg: &AggSpec, depth: u32, current: bool) -> Vec<ScanNode> {
        let parent_size = self.nodes[idx].size;
        let mut kids = self.nodes[idx].children.clone();
        kids.sort_by(|&a, &b| self.nodes[b].size.cmp(&self.nodes[a].size));

        // Папки всегда в head; мелкие файлы и файлы поверх потолка перфо — в tail.
        let cap = agg.top_n_cap as usize;
        let mut head: Vec<usize> = Vec::new();
        let mut tail: Vec<usize> = Vec::new();
        let mut file_head = 0usize;
        for &k in &kids {
            if self.nodes[k].is_dir {
                head.push(k);
            } else if self.is_small(k, parent_size, agg, current) || (cap > 0 && file_head >= cap) {
                tail.push(k);
            } else {
                head.push(k);
                file_head += 1;
            }
        }

        let mut out: Vec<ScanNode> = head
            .iter()
            .map(|&k| self.node_with_preview(k, agg, depth))
            .collect();
        if !tail.is_empty() {
            out.push(self.aggregate_tail(idx, &tail));
        }
        out
    }

    /// Файл `idx` — «мелочь» по текущему [`AggSpec`]? Папки сюда не передаются.
    /// Относительный режим (и фолбэк превью абсолютного) сравнивает долю объёма
    /// родителя; абсолютный на запрошенном уровне — точные байты.
    fn is_small(&self, idx: usize, parent_size: u64, agg: &AggSpec, current: bool) -> bool {
        let size = self.nodes[idx].size;
        let relative =
            || parent_size > 0 && (size as f64) < f64::from(agg.fraction) * parent_size as f64;
        match agg.mode {
            AggMode::Relative => relative(),
            AggMode::Absolute if current => size < agg.min_bytes,
            // Превью в абсолютном режиме чистятся относительным фолбэком.
            AggMode::Absolute => relative(),
        }
    }

    /// Узел `idx` в контракт; при `depth > 1` для непустой папки — с превью детей.
    fn node_with_preview(&self, idx: usize, agg: &AggSpec, depth: u32) -> ScanNode {
        let mut node = self.to_contract(idx);
        if depth > 1 && self.nodes[idx].is_dir && !self.nodes[idx].children.is_empty() {
            // Превью — не запрошенный уровень (current = false): абсолютный порог
            // сюда не проникает, действует относительный фолбэк.
            node.children = self.children_of(idx, agg, depth - 1, false);
        }
        node
    }

    /// Свернуть хвост детей узла `parent` в синтетический узел «Прочее»: площадь =
    /// честная сумма, высоту кодируем самым старым mtime хвоста (устаревание «вверх»).
    fn aggregate_tail(&self, parent: usize, tail: &[usize]) -> ScanNode {
        let mut sum = 0u64;
        let mut oldest = i64::MAX;
        for &k in tail {
            let n = &self.nodes[k];
            sum += n.size;
            oldest = oldest.min(n.mtime);
        }
        let parent_path = self.nodes[parent].path.to_string_lossy();
        ScanNode {
            // Синтетический путь: не навигируется (узел агрегированный).
            path: format!("{parent_path}::<other>"),
            name: "Прочее".to_string(),
            is_dir: false,
            size: sum,
            mtime: if oldest == i64::MAX { 0 } else { oldest },
            atime: if oldest == i64::MAX { 0 } else { oldest },
            child_count: tail.len() as u32,
            category: Category::Other,
            flags: vec![NodeFlag::Aggregated],
            children: Vec::new(),
        }
    }

    /// Перевести узел арены в контракт IPC (`ScanNode`).
    /// Категория и флаги берутся из результата классификации при скане.
    pub fn to_contract(&self, idx: usize) -> ScanNode {
        let n = &self.nodes[idx];
        let mut flags = Vec::new();
        if n.is_reparse {
            flags.push(NodeFlag::ReparsePoint);
        }
        if n.is_cleanup {
            flags.push(NodeFlag::CleanupCandidate);
        }
        ScanNode {
            path: n.path.to_string_lossy().into_owned(),
            name: n.name.clone(),
            is_dir: n.is_dir,
            size: n.size,
            mtime: n.mtime,
            atime: n.atime,
            child_count: n.child_count,
            category: n.category,
            flags,
            // Превью заполняет `node_with_preview` при depth > 1; здесь — пусто.
            children: Vec::new(),
        }
    }
}

/// Перевести `SystemTime` в unix-секунды; до-эпошные/ошибочные → 0.
fn to_unix(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Узел — reparse point (symlink/junction/mount point)?
#[cfg(windows)]
fn is_reparse_point(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    /// `FILE_ATTRIBUTE_REPARSE_POINT` из winnt.h.
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

/// На не-Windows reparse-аналог — симлинк (junction'ов нет).
#[cfg(not(windows))]
fn is_reparse_point(meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

/// Дать корню скана префикс `\\?\` для доступа к длинным путям Windows.
/// Только для абсолютных путей без уже имеющегося UNC/префикса.
#[cfg(windows)]
fn with_long_path_prefix(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if s.starts_with(r"\\") || !p.is_absolute() {
        p.to_path_buf()
    } else {
        PathBuf::from(format!(r"\\?\{s}"))
    }
}

#[cfg(not(windows))]
fn with_long_path_prefix(p: &Path) -> PathBuf {
    p.to_path_buf()
}

/// Срезать служебный префикс `\\?\` из пути перед отдачей наружу.
#[cfg(windows)]
fn strip_long_path_prefix(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

#[cfg(not(windows))]
fn strip_long_path_prefix(p: &Path) -> PathBuf {
    p.to_path_buf()
}

/// Состояние, протаскиваемое jwalk через обход (счётчик ошибок).
type WalkState = Arc<AtomicU64>;

/// Просканировать `root` без отмены и без прогресса (удобная обёртка для тестов).
///
/// Возвращает ошибку только если сам корень недоступен; ошибки на отдельных
/// входах внутри — пропускаются и считаются в `error_count`.
#[cfg(test)]
pub fn scan_root(root: impl AsRef<Path>) -> std::io::Result<ScanTree> {
    match scan_with(root, &CancellationToken::new(), |_| {})? {
        ScanOutcome::Completed(tree) => Ok(tree),
        // Токен не отменяется → ветка недостижима, но возвращаем пустое дерево
        // вместо паники на всякий случай.
        ScanOutcome::Cancelled => unreachable!("scan_root: токен не отменяется"),
    }
}

/// Просканировать `root` с поддержкой отмены и стримом прогресса.
///
/// `cancel` проверяется покадрово по входам — при отмене обход прекращается и
/// возвращается `ScanOutcome::Cancelled` (дерево не достраивается). `on_progress`
/// вызывается не чаще, чем раз в [`PROGRESS_INTERVAL`].
pub fn scan_with(
    root: impl AsRef<Path>,
    cancel: &CancellationToken,
    mut on_progress: impl FnMut(ScanProgress),
) -> std::io::Result<ScanOutcome> {
    let root = root.as_ref();
    // Корень должен существовать — иначе скан бессмыслен.
    let root_meta = std::fs::metadata(root)?;

    let walk_root = with_long_path_prefix(root);
    let errors: WalkState = Arc::new(AtomicU64::new(0));

    // `process_read_dir` вызывается для каждой прочитанной директории: тут мы
    // (1) считаем ошибки чтения детей, (2) гасим спуск в reparse points.
    let walker = WalkDir::new(&walk_root)
        .skip_hidden(false)
        .follow_links(false)
        .process_read_dir({
            let errors = Arc::clone(&errors);
            move |_depth, _path, _state, children| {
                for child in children.iter_mut() {
                    match child {
                        Ok(entry) => {
                            // Не спускаться внутрь reparse points (junction →
                            // циклы). Сам узел остаётся в выдаче.
                            if entry.file_type().is_dir() {
                                if let Ok(meta) = entry.metadata() {
                                    if is_reparse_point(&meta) {
                                        entry.read_children_path = None;
                                    }
                                }
                            }
                        }
                        Err(_) => {
                            errors.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
            }
        });

    // Пасс 1: собрать узлы в арену, запомнить путь → индекс.
    let mut nodes: Vec<TreeNode> = Vec::new();
    let mut index: HashMap<PathBuf, usize> = HashMap::new();

    // Счётчики для стрима прогресса (троттлинг по времени).
    let mut bytes_seen: u64 = 0;
    let mut last_emit = Instant::now();

    // «Сейчас» в unix-секундах — один раз на скан (эвристика «давность» очистки).
    let now = to_unix(SystemTime::now());

    for entry in walker {
        // Отмена проверяется на каждом входе — обход прекращается немедленно.
        if cancel.is_cancelled() {
            return Ok(ScanOutcome::Cancelled);
        }

        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                errors.fetch_add(1, Ordering::Relaxed);
                continue;
            }
        };

        let raw_path = entry.path();
        // Метаданные могут быть недоступны (гонки, права) — пропускаем вход.
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => {
                errors.fetch_add(1, Ordering::Relaxed);
                continue;
            }
        };

        let is_dir = meta.is_dir();
        let is_reparse = is_reparse_point(&meta);
        let mtime = meta.modified().map(to_unix).unwrap_or(0);
        let atime = meta.accessed().map(to_unix).unwrap_or(mtime);
        // Размер: только у файлов; папки наберут массу при агрегации.
        let size = if is_dir { 0 } else { meta.len() };

        let clean_path = strip_long_path_prefix(&raw_path);
        let name = clean_path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            // У корня диска (напр. `C:\`) нет file_name — берём весь путь.
            .unwrap_or_else(|| clean_path.to_string_lossy().into_owned());

        let category = crate::classify::classify(&clean_path, is_dir);
        // Кандидат на очистку: для папок — известный кэш/мусор по имени; для
        // файлов — эвристика «крупный и давно не трогался» (P1, фаза 2).
        let is_cleanup = if is_dir {
            crate::classify::is_cleanup_dir(&name)
        } else {
            crate::classify::is_stale_large_file(size, mtime, now)
        };

        let depth = entry.depth();
        index.insert(raw_path.clone(), nodes.len());
        nodes.push(TreeNode {
            path: clean_path,
            name,
            is_dir,
            size,
            mtime,
            atime,
            child_count: 0,
            category,
            is_reparse,
            is_cleanup,
            children: Vec::new(),
            depth,
        });

        // Стрим прогресса с троттлингом, чтобы не топить UI (см. docs §5.4).
        bytes_seen += size;
        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            on_progress(ScanProgress {
                entries: nodes.len() as u64,
                bytes: bytes_seen,
                errors: errors.load(Ordering::Relaxed),
                done: false,
                cancelled: false,
            });
            last_emit = Instant::now();
        }
    }

    // Может оказаться пустым только если корень-файл не дал записи — но корень
    // всегда первый вход jwalk. Подстрахуемся минимальным деревом из корня.
    if nodes.is_empty() {
        let mtime = root_meta.modified().map(to_unix).unwrap_or(0);
        let clean_root = strip_long_path_prefix(root);
        let category = crate::classify::classify(&clean_root, root_meta.is_dir());
        nodes.push(TreeNode {
            path: clean_root,
            name: root.to_string_lossy().into_owned(),
            is_dir: root_meta.is_dir(),
            size: if root_meta.is_dir() {
                0
            } else {
                root_meta.len()
            },
            mtime,
            atime: root_meta.accessed().map(to_unix).unwrap_or(mtime),
            child_count: 0,
            category,
            is_reparse: is_reparse_point(&root_meta),
            is_cleanup: false,
            children: Vec::new(),
            depth: 0,
        });
        let by_path = build_path_index(&nodes);
        return Ok(ScanOutcome::Completed(ScanTree {
            nodes,
            root: 0,
            error_count: errors.load(Ordering::Relaxed),
            by_path,
        }));
    }

    // Пасс 2: связать детей с родителями по пути (parent всегда уже в индексе).
    // Работаем с очищенными путями нельзя — индекс по сырым; родитель ребёнка —
    // это `raw_path.parent()`, но мы храним индекс по сырым путям. Поэтому
    // повторно пройдём по сырым путям через сам индекс.
    let mut parents: Vec<Option<usize>> = vec![None; nodes.len()];
    // Снимем сырые пути из индекса в массив idx → raw_path для родительского
    // поиска (index хранит raw → idx).
    let mut raw_paths: Vec<PathBuf> = vec![PathBuf::new(); nodes.len()];
    for (raw, &idx) in &index {
        raw_paths[idx] = raw.clone();
    }
    for i in 0..nodes.len() {
        if let Some(parent_raw) = raw_paths[i].parent() {
            if let Some(&pi) = index.get(parent_raw) {
                if pi != i {
                    nodes[pi].children.push(i);
                    parents[i] = Some(pi);
                }
            }
        }
    }
    for n in nodes.iter_mut() {
        n.child_count = n.children.len() as u32;
    }

    // Пасс 3: агрегация размеров снизу вверх. Обрабатываем по убыванию глубины,
    // чтобы дети были учтены раньше родителя; каждый узел вливает свой размер в
    // родителя.
    let mut order: Vec<usize> = (0..nodes.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(nodes[i].depth));
    for &i in &order {
        let size = nodes[i].size;
        if let Some(pi) = parents[i] {
            nodes[pi].size += size;
        }
    }

    // Корень — узел с глубиной 0 (он же первый вход jwalk).
    let root_idx = parents.iter().position(|p| p.is_none()).unwrap_or(0);

    let by_path = build_path_index(&nodes);
    Ok(ScanOutcome::Completed(ScanTree {
        nodes,
        root: root_idx,
        error_count: errors.load(Ordering::Relaxed),
        by_path,
    }))
}

/// Индекс «очищенный путь → индекс узла» по арене.
fn build_path_index(nodes: &[TreeNode]) -> HashMap<String, usize> {
    nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.path.to_string_lossy().into_owned(), i))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    /// Уникальная временная директория под тест (без внешних крейтов).
    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("sectorcity-{tag}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(path: &Path, bytes: usize) {
        let mut f = fs::File::create(path).unwrap();
        f.write_all(&vec![0u8; bytes]).unwrap();
    }

    /// Относительный режим без порога (fraction = 0 → ничего не сворачивается),
    /// `cap` — потолок числа файлов на уровень (0 = без потолка). Удобно для
    /// тестов раскладки/превью и для воспроизведения старой top-N-агрегации.
    fn agg(cap: u32) -> AggSpec {
        AggSpec {
            mode: AggMode::Relative,
            fraction: 0.0,
            min_bytes: 0,
            top_n_cap: cap,
        }
    }

    #[test]
    fn aggregates_sizes_bottom_up() {
        let root = temp_dir("agg");
        // root/a.bin = 100, root/sub/b.bin = 50, root/sub/c.bin = 25
        write_file(&root.join("a.bin"), 100);
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        write_file(&sub.join("b.bin"), 50);
        write_file(&sub.join("c.bin"), 25);

        let tree = scan_root(&root).unwrap();
        let r = tree.root_node();
        assert_eq!(r.size, 175, "корень = сумма всех файлов");
        assert!(r.is_dir);
        // Прямых детей у корня двое: a.bin и sub.
        assert_eq!(r.child_count, 2);

        // Найти узел sub и проверить его свёртку и счётчик.
        let sub_node = tree
            .nodes
            .iter()
            .find(|n| n.name == "sub")
            .expect("узел sub");
        assert_eq!(sub_node.size, 75);
        assert_eq!(sub_node.child_count, 2);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn level_preview_depth_populates_only_at_depth_2() {
        let root = temp_dir("preview");
        // root/a.bin = 100 (файл), root/sub/{b=50, c=25} (папка с двумя детьми).
        write_file(&root.join("a.bin"), 100);
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        write_file(&sub.join("b.bin"), 50);
        write_file(&sub.join("c.bin"), 25);

        let tree = scan_root(&root).unwrap();
        let root_path = tree.root_node().path.to_string_lossy().into_owned();

        // depth = 1: превью нет даже у папки.
        let flat = tree.level(&root_path, &agg(0), 1);
        let sub_flat = flat
            .iter()
            .find(|n| n.name == "sub")
            .expect("sub в depth=1");
        assert!(
            sub_flat.children.is_empty(),
            "depth=1 не должен нести превью детей"
        );

        // depth = 2: папка sub несёт превью своих детей (b.bin, c.bin); файл a.bin — нет.
        let nested = tree.level(&root_path, &agg(0), 2);
        let sub_nested = nested
            .iter()
            .find(|n| n.name == "sub")
            .expect("sub в depth=2");
        assert_eq!(sub_nested.children.len(), 2, "превью детей sub");
        // Превью отсортировано по размеру: b (50) раньше c (25).
        assert_eq!(sub_nested.children[0].name, "b.bin");
        assert_eq!(sub_nested.children[1].name, "c.bin");
        // Дети превью сами превью не несут (рекурсия остановилась на depth=1).
        assert!(sub_nested.children[0].children.is_empty());

        let a_nested = nested.iter().find(|n| n.name == "a.bin").expect("a.bin");
        assert!(a_nested.children.is_empty(), "у файла превью нет");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn level_cap_aggregates_into_other() {
        let root = temp_dir("tail");
        // Четыре файла разного размера; потолок cap = 2 → два крупнейших + «Прочее».
        write_file(&root.join("big1.bin"), 100);
        write_file(&root.join("big2.bin"), 80);
        write_file(&root.join("small1.bin"), 10);
        write_file(&root.join("small2.bin"), 5);

        let tree = scan_root(&root).unwrap();
        let root_path = tree.root_node().path.to_string_lossy().into_owned();

        let level = tree.level(&root_path, &agg(2), 1);
        assert_eq!(level.len(), 3, "2 крупнейших + «Прочее»");
        assert_eq!(level[0].name, "big1.bin");
        assert_eq!(level[1].name, "big2.bin");

        let other = &level[2];
        assert!(other.flags.contains(&NodeFlag::Aggregated));
        assert_eq!(other.size, 15, "честная сумма хвоста");
        assert_eq!(other.child_count, 2);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn level_relative_threshold_collapses_small_files_only() {
        let root = temp_dir("relative");
        // Корень = 1000 байт: один большой файл 900 (90%), мелочь и одна папка.
        write_file(&root.join("big.bin"), 900);
        write_file(&root.join("mid.bin"), 60); // 6% — крупнее порога 5%
        write_file(&root.join("tiny1.bin"), 25); // 2.5% — в «Прочее»
        write_file(&root.join("tiny2.bin"), 15); // 1.5% — в «Прочее»
        let sub = root.join("sub"); // папка-кроха никогда не сворачивается
        fs::create_dir_all(&sub).unwrap();

        let tree = scan_root(&root).unwrap();
        let root_path = tree.root_node().path.to_string_lossy().into_owned();

        // Порог 5% от объёма папки (0.05), без потолка перфо.
        let spec = AggSpec {
            mode: AggMode::Relative,
            fraction: 0.05,
            min_bytes: 0,
            top_n_cap: 0,
        };
        let level = tree.level(&root_path, &spec, 1);

        // Видим big, mid, пустую папку sub и «Прочее» (tiny1 + tiny2).
        assert!(level.iter().any(|n| n.name == "big.bin"));
        assert!(level.iter().any(|n| n.name == "mid.bin"));
        assert!(level.iter().any(|n| n.name == "sub" && n.is_dir));
        assert!(
            !level.iter().any(|n| n.name == "tiny1.bin"),
            "мелочь не видна отдельно"
        );

        let other = level
            .iter()
            .find(|n| n.flags.contains(&NodeFlag::Aggregated))
            .expect("узел «Прочее»");
        assert_eq!(other.size, 40, "честная сумма tiny1 + tiny2");
        assert_eq!(other.child_count, 2);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn level_absolute_threshold_only_current_level() {
        let root = temp_dir("absolute");
        // root/keep.bin = 500; root/drop.bin = 50; root/sub/inner.bin = 50.
        // Абсолютный порог 100 байт: на текущем уровне drop.bin сворачивается,
        // а inner.bin (внутри sub, превью) НЕ должен сворачиваться абсолютным
        // порогом — иначе у мелкой папки выкосило бы всё.
        write_file(&root.join("keep.bin"), 500);
        write_file(&root.join("drop.bin"), 50);
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        write_file(&sub.join("inner.bin"), 50);

        let tree = scan_root(&root).unwrap();
        let root_path = tree.root_node().path.to_string_lossy().into_owned();

        let spec = AggSpec {
            mode: AggMode::Absolute,
            fraction: 0.0, // относительный фолбэк превью выключен → inner виден
            min_bytes: 100,
            top_n_cap: 0,
        };
        let level = tree.level(&root_path, &spec, 2);

        // Текущий уровень: keep.bin виден, drop.bin (50 < 100) → «Прочее».
        assert!(level.iter().any(|n| n.name == "keep.bin"));
        assert!(!level.iter().any(|n| n.name == "drop.bin"));
        assert!(level
            .iter()
            .any(|n| n.flags.contains(&NodeFlag::Aggregated)));

        // Превью sub: inner.bin (50 байт) виден, абсолютный порог сюда не дошёл.
        let sub_node = level.iter().find(|n| n.name == "sub").expect("узел sub");
        assert!(
            sub_node.children.iter().any(|c| c.name == "inner.bin"),
            "абсолютный порог не должен сворачивать содержимое дочерней папки"
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn single_file_root() {
        let dir = temp_dir("file");
        let file = dir.join("solo.bin");
        write_file(&file, 42);

        let tree = scan_root(&file).unwrap();
        assert_eq!(tree.root_node().size, 42);
        assert!(!tree.root_node().is_dir);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_root_errors() {
        let missing = std::env::temp_dir().join("sectorcity-nope-zzz-does-not-exist");
        assert!(scan_root(&missing).is_err());
    }

    #[test]
    fn cancellation_stops_scan() {
        let root = temp_dir("cancel");
        write_file(&root.join("a.bin"), 10);

        // Уже отменённый токен → обход прекращается на первом же входе.
        let token = CancellationToken::new();
        token.cancel();
        let outcome = scan_with(&root, &token, |_| {}).unwrap();
        assert!(matches!(outcome, ScanOutcome::Cancelled));

        fs::remove_dir_all(&root).ok();
    }
}
