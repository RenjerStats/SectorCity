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
use std::time::{SystemTime, UNIX_EPOCH};

use jwalk::WalkDir;

use crate::ipc::contract::{Category, NodeFlag, ScanNode};

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

    /// Дети узла `path`, отсортированные по размеру (убывание), с tail-агрегацией:
    /// первые `top_n` отдаются как есть, хвост сворачивается в синтетический узел
    /// «Прочее» с честной суммой площади (флаг `Aggregated`). `top_n == 0` —
    /// без агрегации, отдать всех детей.
    ///
    /// Наружу уходит только текущий уровень (см. docs §IPC) — превью +depth
    /// добавим отдельным куском (фаза 2).
    pub fn level(&self, path: &str, top_n: usize) -> Vec<ScanNode> {
        let Some(idx) = self.index_of(path) else {
            return Vec::new();
        };
        let mut kids = self.nodes[idx].children.clone();
        kids.sort_by(|&a, &b| self.nodes[b].size.cmp(&self.nodes[a].size));

        if top_n == 0 || kids.len() <= top_n {
            return kids.into_iter().map(|k| self.to_contract(k)).collect();
        }

        let (head, tail) = kids.split_at(top_n);
        let mut out: Vec<ScanNode> = head.iter().map(|&k| self.to_contract(k)).collect();

        // Свернуть хвост в «Прочее»: площадь = честная сумма, высоту кодируем
        // самым старым mtime хвоста (устаревание «вверх»).
        let mut sum = 0u64;
        let mut oldest = i64::MAX;
        for &k in tail {
            let n = &self.nodes[k];
            sum += n.size;
            oldest = oldest.min(n.mtime);
        }
        let count = tail.len() as u32;
        out.push(ScanNode {
            // Синтетический путь: не навигируется (узел агрегированный).
            path: format!("{path}::<other>"),
            name: "Прочее".to_string(),
            is_dir: false,
            size: sum,
            mtime: if oldest == i64::MAX { 0 } else { oldest },
            atime: if oldest == i64::MAX { 0 } else { oldest },
            child_count: count,
            category: Category::Other,
            flags: vec![NodeFlag::Aggregated],
        });
        out
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

/// Просканировать `root`, собрать дерево и свернуть размеры снизу вверх.
///
/// Возвращает ошибку только если сам корень недоступен; ошибки на отдельных
/// входах внутри — пропускаются и считаются в `error_count`.
pub fn scan_root(root: impl AsRef<Path>) -> std::io::Result<ScanTree> {
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

    for entry in walker {
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
        let is_cleanup = is_dir && crate::classify::is_cleanup_dir(&name);

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
        return Ok(ScanTree {
            nodes,
            root: 0,
            error_count: errors.load(Ordering::Relaxed),
            by_path,
        });
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
    Ok(ScanTree {
        nodes,
        root: root_idx,
        error_count: errors.load(Ordering::Relaxed),
        by_path,
    })
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
}
