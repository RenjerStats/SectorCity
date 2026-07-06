//! Движок правил очистки: тройка **(правило, уверенность, объяснение)**.
//!
//! Работает ПОСТ-ПРОХОДОМ по готовому [`ScanTree`] (не в колбэке jwalk):
//! соседи узла уже в арене, поэтому контекст-зависимые правила (`node_modules`
//! при `package.json` рядом) — дешёвый lookup. Дедуп вложенности встроен в
//! обход: внутрь уже помеченного кандидата не спускаемся, объём не задваивается.
//!
//! Тексты-объяснения причин живут на фронте — бэк отдаёт только
//! `(reason, confidence)`.

use std::path::Path;

use crate::ipc::contract::{CleanupReason, Confidence};
use crate::scan::ScanTree;

use super::data;
use super::is_stale_large_file;

/// Уверенность причины — статическая таблица «reason → confidence».
pub fn confidence_of(reason: CleanupReason) -> Confidence {
    use CleanupReason as R;
    match reason {
        // Кэши пересоздаются сами — сносить смело.
        R::PackageCache | R::BrowserCache | R::GpuCache | R::TempDir | R::CrashDump => {
            Confidence::Safe
        }
        // Почти наверняка мусор, но снос стоит времени пересборки/потери остатка.
        R::BuildArtifact | R::TempFile | R::InterruptedDownload | R::RecycleBin | R::EmptyDir => {
            Confidence::Likely
        }
        // Только по решению пользователя.
        R::WindowsOld | R::InstallerInDownloads | R::StaleLarge => Confidence::Review,
    }
}

/// Пометить кандидатов на очистку по всему дереву (перезаписывает прежние
/// пометки). `now` — unix-секунды «сейчас» (для эвристики давности).
///
/// Дедуп вложенности: DFS от корня, внутрь помеченного не спускаемся — кэш в
/// кэше не даёт второго кандидата, объём группы честен. Сам корень скана не
/// помечаем (снести корень = снести весь обзор — бессмысленно как «кандидат»).
pub fn apply_cleanup(tree: &mut ScanTree, now: i64) {
    for n in tree.nodes.iter_mut() {
        n.cleanup = None;
    }
    // (узел, родитель): корень идёт без родителя и правилами не проверяется.
    let mut stack: Vec<(usize, Option<usize>)> = vec![(tree.root, None)];
    while let Some((idx, parent)) = stack.pop() {
        if let Some(p) = parent {
            if let Some(reason) = decide(tree, idx, p, now) {
                tree.nodes[idx].cleanup = Some(reason);
                continue; // дедуп: поддерево кандидата не размечаем
            }
        }
        for &c in &tree.nodes[idx].children {
            stack.push((c, Some(idx)));
        }
    }
}

/// Причина для одного узла (или `None`). Порядок проверок — от специфичных к
/// эвристикам. Reparse points пропускаем (это ссылка, не содержимое); замок
/// (`is_locked`) кандидатуру НЕ снимает — UI показывает замок, снос блокирует
/// `delete_to_trash`.
fn decide(tree: &ScanTree, idx: usize, parent: usize, now: i64) -> Option<CleanupReason> {
    let n = &tree.nodes[idx];
    if n.is_reparse {
        return None;
    }
    let name = n.name.to_ascii_lowercase();

    if n.is_dir {
        // 1) Однозначные имена (корзина, __pycache__, DXCache, Windows.old…).
        if let Some(&(_, reason)) = data::UNAMBIGUOUS_DIR_NAMES.iter().find(|(m, _)| *m == name) {
            return Some(reason);
        }
        // 2) Известные пути (суффикс-матч компонентов: AppData\Local\Temp…).
        if let Some(reason) = match_path_suffix(&n.path) {
            return Some(reason);
        }
        // 3) Кэш браузера: имя кэш-папки + компонент-вендор в пути.
        if data::BROWSER_CACHE_DIR_NAMES.contains(&name.as_str()) && has_vendor_component(&n.path) {
            return Some(CleanupReason::BrowserCache);
        }
        // 4) Контекст-зависимые (node_modules/target/build/dist/out/venv):
        //    только при маркере проекта среди соседей (детей родителя).
        for rule in data::CONTEXT_DIR_RULES {
            if rule.name == name && has_sibling_marker(tree, parent, rule.markers) {
                return Some(rule.reason);
            }
        }
        // 5) Пустая папка (после свёртки размеров: нет детей и нет массы).
        if n.children.is_empty() && n.size == 0 {
            return Some(CleanupReason::EmptyDir);
        }
        None
    } else {
        // 1) Времянки по имени/расширению.
        if name.starts_with('~') {
            return Some(CleanupReason::TempFile);
        }
        if let Some(ext) = name.rsplit('.').next().filter(|e| *e != name.as_str()) {
            if let Some(&(_, reason)) = data::TEMP_FILE_EXTENSIONS.iter().find(|(e, _)| *e == ext) {
                return Some(reason);
            }
            // 2) Установщик в «Загрузках» (родитель — Downloads).
            if data::INSTALLER_EXTENSIONS.contains(&ext) {
                let parent_name = tree.nodes[parent].name.to_ascii_lowercase();
                if data::DOWNLOADS_DIR_NAMES.contains(&parent_name.as_str()) {
                    return Some(CleanupReason::InstallerInDownloads);
                }
            }
        }
        // 3) «Крупный и старый» — остаётся, но строго Review.
        if is_stale_large_file(n.size, n.mtime, now) {
            return Some(CleanupReason::StaleLarge);
        }
        None
    }
}

/// Путь заканчивается последовательностью компонентов одного из известных
/// правил? Сравнение компонентов — в нижнем регистре.
fn match_path_suffix(path: &Path) -> Option<CleanupReason> {
    let comps: Vec<String> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_ascii_lowercase())
        .collect();
    for &(suffix, reason) in data::PATH_SUFFIX_RULES {
        if comps.len() >= suffix.len()
            && comps[comps.len() - suffix.len()..]
                .iter()
                .zip(suffix)
                .all(|(a, b)| a == b)
        {
            return Some(reason);
        }
    }
    None
}

/// Есть ли в пути компонент-вендор браузера (Mozilla/Google/…)?
fn has_vendor_component(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy().to_ascii_lowercase();
        data::BROWSER_VENDOR_COMPONENTS.contains(&s.as_str())
    })
}

/// Есть ли среди детей `parent` маркер из списка? Маркер `*.ext` — по суффиксу
/// имени, остальное — точное совпадение (в нижнем регистре).
fn has_sibling_marker(tree: &ScanTree, parent: usize, markers: &[&str]) -> bool {
    tree.nodes[parent].children.iter().any(|&c| {
        let name = tree.nodes[c].name.to_ascii_lowercase();
        markers.iter().any(|m| {
            if let Some(ext) = m.strip_prefix("*.") {
                name.ends_with(&format!(".{ext}"))
            } else {
                name == *m
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::scan_root;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("sectorcity-rules-{tag}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(path: &Path, bytes: usize) {
        use std::io::Write;
        let mut f = fs::File::create(path).unwrap();
        f.write_all(&vec![0u8; bytes]).unwrap();
    }

    /// Причина кандидата по имени узла (хелпер для читаемых ассертов).
    fn reason_of(tree: &ScanTree, name: &str) -> Option<CleanupReason> {
        tree.nodes
            .iter()
            .find(|n| n.name == name)
            .and_then(|n| n.cleanup)
    }

    #[test]
    fn node_modules_requires_package_json_sibling() {
        let root = temp_dir("ctx");
        // Проект с package.json → node_modules кандидат.
        let proj = root.join("proj");
        fs::create_dir_all(proj.join("node_modules")).unwrap();
        write_file(&proj.join("package.json"), 10);
        write_file(&proj.join("node_modules").join("a.js"), 10);
        // «Просто папка» node_modules без маркера — НЕ кандидат.
        let stray = root.join("stray");
        fs::create_dir_all(stray.join("node_modules")).unwrap();
        write_file(&stray.join("node_modules").join("b.js"), 10);

        let tree = scan_root(&root).unwrap(); // scan_root уже зовёт apply_cleanup
        let candidates: Vec<&crate::scan::TreeNode> = tree
            .nodes
            .iter()
            .filter(|n| n.name == "node_modules")
            .collect();
        assert_eq!(candidates.len(), 2);
        let with_marker = candidates
            .iter()
            .find(|n| n.path.starts_with(&proj))
            .unwrap();
        let without = candidates
            .iter()
            .find(|n| n.path.starts_with(&stray))
            .unwrap();
        assert_eq!(with_marker.cleanup, Some(CleanupReason::PackageCache));
        assert_eq!(without.cleanup, None, "без package.json рядом — не мусор");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn bare_build_dirs_need_project_marker() {
        let root = temp_dir("bare");
        // build с CMakeLists.txt рядом → кандидат; голый dist — нет.
        let a = root.join("a");
        fs::create_dir_all(a.join("build")).unwrap();
        write_file(&a.join("CMakeLists.txt"), 10);
        write_file(&a.join("build").join("x.o"), 10);
        let b = root.join("b");
        fs::create_dir_all(b.join("dist")).unwrap();
        write_file(&b.join("dist").join("y.txt"), 10);

        let tree = scan_root(&root).unwrap();
        assert_eq!(
            reason_of(&tree, "build"),
            Some(CleanupReason::BuildArtifact)
        );
        assert_eq!(
            reason_of(&tree, "dist"),
            None,
            "dist без маркера — не мусор"
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn temp_extensions_and_interrupted_downloads() {
        let root = temp_dir("ext");
        write_file(&root.join("report.bak"), 10);
        write_file(&root.join("movie.mkv.part"), 10);
        write_file(&root.join("setup.crdownload"), 10);
        write_file(&root.join("~lock.docx"), 10);
        write_file(&root.join("app.dmp"), 10);
        write_file(&root.join("normal.txt"), 10);

        let tree = scan_root(&root).unwrap();
        assert_eq!(
            reason_of(&tree, "report.bak"),
            Some(CleanupReason::TempFile)
        );
        assert_eq!(
            reason_of(&tree, "movie.mkv.part"),
            Some(CleanupReason::InterruptedDownload)
        );
        assert_eq!(
            reason_of(&tree, "setup.crdownload"),
            Some(CleanupReason::InterruptedDownload)
        );
        assert_eq!(
            reason_of(&tree, "~lock.docx"),
            Some(CleanupReason::TempFile)
        );
        assert_eq!(reason_of(&tree, "app.dmp"), Some(CleanupReason::CrashDump));
        assert_eq!(reason_of(&tree, "normal.txt"), None);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn installer_in_downloads_only() {
        let root = temp_dir("dl");
        let dl = root.join("Downloads");
        fs::create_dir_all(&dl).unwrap();
        write_file(&dl.join("setup.exe"), 10);
        write_file(&root.join("tool.exe"), 10); // вне Downloads — не кандидат

        let tree = scan_root(&root).unwrap();
        assert_eq!(
            reason_of(&tree, "setup.exe"),
            Some(CleanupReason::InstallerInDownloads)
        );
        assert_eq!(reason_of(&tree, "tool.exe"), None);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn empty_dir_detected() {
        let root = temp_dir("empty");
        fs::create_dir_all(root.join("hollow")).unwrap();
        let full = root.join("full");
        fs::create_dir_all(&full).unwrap();
        write_file(&full.join("f.txt"), 10);

        let tree = scan_root(&root).unwrap();
        assert_eq!(reason_of(&tree, "hollow"), Some(CleanupReason::EmptyDir));
        assert_eq!(reason_of(&tree, "full"), None);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn nested_candidates_dedupe() {
        // Внутри помеченного кандидата вложенные кандидаты НЕ размечаются:
        // node_modules (кандидат) содержит .cache-подобную структуру — она
        // остаётся без пометки (объём не задваивается).
        let root = temp_dir("dedupe");
        let proj = root.join("proj");
        let nm = proj.join("node_modules");
        fs::create_dir_all(nm.join("__pycache__")).unwrap();
        write_file(&proj.join("package.json"), 10);
        write_file(&nm.join("__pycache__").join("m.pyc"), 10);

        let tree = scan_root(&root).unwrap();
        assert_eq!(
            reason_of(&tree, "node_modules"),
            Some(CleanupReason::PackageCache)
        );
        assert_eq!(
            reason_of(&tree, "__pycache__"),
            None,
            "вложенный кандидат не задваивается"
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn known_path_suffix_and_browser_cache() {
        let root = temp_dir("paths");
        // …\AppData\Local\Temp → TempDir.
        let temp = root.join("AppData").join("Local").join("Temp");
        fs::create_dir_all(&temp).unwrap();
        write_file(&temp.join("junk.bin"), 10);
        // …\Google\Chrome\…\Cache → BrowserCache (вендор в пути).
        let cache = root
            .join("Google")
            .join("Chrome")
            .join("User Data")
            .join("Default")
            .join("Cache");
        fs::create_dir_all(&cache).unwrap();
        write_file(&cache.join("blob"), 10);
        // Голая папка Cache без вендора — НЕ кандидат.
        let plain = root.join("myapp").join("Cache");
        fs::create_dir_all(&plain).unwrap();
        write_file(&plain.join("data"), 10);

        let tree = scan_root(&root).unwrap();
        let temp_node = tree
            .nodes
            .iter()
            .find(|n| n.path == temp)
            .expect("узел Temp");
        assert_eq!(temp_node.cleanup, Some(CleanupReason::TempDir));
        let cache_node = tree.nodes.iter().find(|n| n.path == cache).unwrap();
        assert_eq!(cache_node.cleanup, Some(CleanupReason::BrowserCache));
        let plain_node = tree.nodes.iter().find(|n| n.path == plain).unwrap();
        assert_eq!(plain_node.cleanup, None, "Cache без вендора — не мусор");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn confidence_table_is_total() {
        // Каждой причине назначена уверенность (матч исчерпывающий — компилятор
        // это гарантирует); здесь фиксируем ключевые пары как контракт.
        assert_eq!(confidence_of(CleanupReason::PackageCache), Confidence::Safe);
        assert_eq!(
            confidence_of(CleanupReason::BuildArtifact),
            Confidence::Likely
        );
        assert_eq!(confidence_of(CleanupReason::StaleLarge), Confidence::Review);
        assert_eq!(confidence_of(CleanupReason::WindowsOld), Confidence::Review);
    }
}
