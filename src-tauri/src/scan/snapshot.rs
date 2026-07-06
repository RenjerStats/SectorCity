//! Снимок дерева скана в SQLite (`rusqlite`).
//!
//! Назначение: быстрое переоткрытие без рескана. Храним один — последний —
//! снимок: дерево сериализуется плоско (арена + ссылка на родителя), при
//! загрузке восстанавливаются списки детей и индекс путей.
//!
//! Подмодуль `scan` намеренно: отсюда доступны приватные поля `TreeNode::depth`
//! и сборка `ScanTree` без расширения публичного API.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use super::{build_path_index, ScanTree, TreeNode};
use crate::ipc::contract::Category;

/// Строковый код категории для хранения в БД (стабилен, не зависит от serde).
fn category_to_str(c: Category) -> &'static str {
    match c {
        Category::Code => "code",
        Category::Document => "document",
        Category::Image => "image",
        Category::Video => "video",
        Category::Audio => "audio",
        Category::Archive => "archive",
        Category::Binary => "binary",
        Category::Other => "other",
    }
}

/// Обратный разбор кода категории; неизвестное → `Other` (терпимо к версиям БД).
fn category_from_str(s: &str) -> Category {
    match s {
        "code" => Category::Code,
        "document" => Category::Document,
        "image" => Category::Image,
        "video" => Category::Video,
        "audio" => Category::Audio,
        "archive" => Category::Archive,
        "binary" => Category::Binary,
        _ => Category::Other,
    }
}

/// Создать схему (идемпотентно).
fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS nodes (
            idx         INTEGER PRIMARY KEY,
            parent      INTEGER,
            path        TEXT    NOT NULL,
            name        TEXT    NOT NULL,
            is_dir      INTEGER NOT NULL,
            size        INTEGER NOT NULL,
            mtime       INTEGER NOT NULL,
            atime       INTEGER NOT NULL,
            child_count INTEGER NOT NULL,
            category    TEXT    NOT NULL,
            is_reparse  INTEGER NOT NULL,
            is_cleanup  INTEGER NOT NULL,
            is_locked   INTEGER NOT NULL DEFAULT 0,
            depth       INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(path);
        CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent);",
    )?;

    // Попытаться добавить колонку, если таблица была создана старой версией
    let _ = conn.execute(
        "ALTER TABLE nodes ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0",
        [],
    );

    Ok(())
}

/// Массив «индекс узла → индекс родителя» по спискам детей.
fn parents_of(tree: &ScanTree) -> Vec<Option<usize>> {
    let mut parents = vec![None; tree.nodes.len()];
    for (i, node) in tree.nodes.iter().enumerate() {
        for &child in &node.children {
            parents[child] = Some(i);
        }
    }
    parents
}

/// Записать дерево в снимок (перезаписывает прежний — храним только последний).
pub fn save(tree: &ScanTree, db_path: &Path) -> rusqlite::Result<()> {
    let mut conn = Connection::open(db_path)?;
    ensure_schema(&conn)?;

    let parents = parents_of(tree);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let tx = conn.transaction()?;
    tx.execute("DELETE FROM nodes", [])?;
    tx.execute("DELETE FROM meta", [])?;

    {
        let mut stmt = tx.prepare(
            "INSERT INTO nodes
                (idx, parent, path, name, is_dir, size, mtime, atime,
                 child_count, category, is_reparse, is_cleanup, is_locked, depth)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        )?;
        for (i, n) in tree.nodes.iter().enumerate() {
            let path = n.path.to_string_lossy().into_owned();
            stmt.execute(params![
                i as i64,
                parents[i].map(|p| p as i64),
                path,
                n.name,
                n.is_dir as i64,
                n.size as i64,
                n.mtime,
                n.atime,
                n.child_count as i64,
                category_to_str(n.category),
                n.is_reparse as i64,
                // Совместимость схемы v1: булев флаг. Причина не хранится —
                // производное поле, пересчитывается правилами при загрузке.
                n.cleanup.is_some() as i64,
                n.is_locked as i64,
                n.depth as i64,
            ])?;
        }

        let mut meta = tx.prepare("INSERT INTO meta (key, value) VALUES (?1, ?2)")?;
        meta.execute(params!["root", tree.root as i64])?;
        meta.execute(params!["error_count", tree.error_count as i64])?;
        meta.execute(params!["scanned_at", now])?;
        meta.execute(params!["schema_version", 1i64])?;
    }

    tx.commit()
}

/// Загрузить дерево из снимка. Восстанавливает списки детей и индекс путей.
pub fn load(db_path: &Path) -> rusqlite::Result<ScanTree> {
    let conn = Connection::open(db_path)?;
    ensure_schema(&conn)?;

    let root: i64 = conn
        .query_row("SELECT value FROM meta WHERE key = 'root'", [], |r| {
            r.get::<_, String>(0)
        })?
        .parse()
        .unwrap_or(0);
    let error_count: u64 = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'error_count'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|s: String| s.parse().ok())
        .unwrap_or(0);

    // Загружаем узлы по возрастанию idx, чтобы заполнить арену по месту.
    let mut stmt = conn.prepare(
        "SELECT idx, parent, path, name, is_dir, size, mtime, atime,
                child_count, category, is_reparse, is_cleanup, is_locked, depth
         FROM nodes ORDER BY idx",
    )?;

    struct Row {
        parent: Option<usize>,
        node: TreeNode,
    }
    let rows = stmt.query_map([], |r| {
        let parent: Option<i64> = r.get(1)?;
        let category: String = r.get(9)?;
        Ok(Row {
            parent: parent.map(|p| p as usize),
            node: TreeNode {
                path: std::path::PathBuf::from(r.get::<_, String>(2)?),
                name: r.get(3)?,
                is_dir: r.get::<_, i64>(4)? != 0,
                size: r.get::<_, i64>(5)? as u64,
                mtime: r.get(6)?,
                atime: r.get(7)?,
                child_count: r.get::<_, i64>(8)? as u32,
                category: category_from_str(&category),
                cat_mask: 0, // производное поле — пересчитаем после связки детей
                is_reparse: r.get::<_, i64>(10)? != 0,
                // Колонка is_cleanup (11) игнорируется: причины очистки —
                // производное, пересчитываем движком правил после связки детей.
                cleanup: None,
                is_locked: r.get::<_, i64>(12)? != 0,
                children: Vec::new(),
                depth: r.get::<_, i64>(13)? as usize,
            },
        })
    })?;

    let mut nodes: Vec<TreeNode> = Vec::new();
    let mut parents: Vec<Option<usize>> = Vec::new();
    for row in rows {
        let row = row?;
        nodes.push(row.node);
        parents.push(row.parent);
    }

    // Восстановить списки детей в порядке idx (детерминированно).
    for (i, parent) in parents.iter().enumerate() {
        if let Some(p) = parent {
            if *p < nodes.len() {
                nodes[*p].children.push(i);
            }
        }
    }

    // Маску категорий в БД не храним (производное) — пересчитываем снизу вверх.
    super::compute_category_masks(&mut nodes, &parents);

    let by_path = build_path_index(&nodes);
    let mut tree = ScanTree {
        nodes,
        root: root as usize,
        error_count,
        by_path,
    };

    // Причины очистки — производное: пересчитываем движком правил, как и
    // при свежем скане. Снимок остаётся совместим со старой схемой.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    crate::classify::apply_cleanup(&mut tree, now);

    Ok(tree)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::scan_root;

    fn temp_db(tag: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("sectorcity-snap-{tag}-{nanos}.sqlite"))
    }

    fn temp_tree(tag: &str) -> (std::path::PathBuf, ScanTree) {
        use std::fs;
        use std::io::Write;
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("sectorcity-snaproot-{tag}-{nanos}"));
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::File::create(root.join("a.bin"))
            .unwrap()
            .write_all(&[0u8; 100])
            .unwrap();
        fs::File::create(sub.join("b.bin"))
            .unwrap()
            .write_all(&[0u8; 50])
            .unwrap();
        let tree = scan_root(&root).unwrap();
        (root, tree)
    }

    #[test]
    fn round_trip_preserves_tree() {
        let (root_dir, tree) = temp_tree("rt");
        let db = temp_db("rt");

        save(&tree, &db).unwrap();
        let loaded = load(&db).unwrap();

        assert_eq!(loaded.nodes.len(), tree.nodes.len());
        assert_eq!(loaded.error_count, tree.error_count);
        // Корень: тот же размер (свёртка) и тот же путь.
        assert_eq!(loaded.root_node().size, tree.root_node().size);
        assert_eq!(loaded.root_node().path, tree.root_node().path);
        // Маска категорий — производная, в БД не хранится: проверяем пересчёт.
        assert_eq!(
            loaded.root_node().cat_mask,
            tree.root_node().cat_mask,
            "маска категорий восстановлена при загрузке снимка"
        );
        // Запрос уровня из загруженного дерева совпадает по количеству детей.
        let root_path = tree.root_node().path.to_string_lossy().into_owned();
        // Без агрегации (fraction = 0, без потолка) — сравниваем «сырые» уровни.
        let spec = crate::ipc::contract::AggSpec {
            fraction: 0.0,
            top_n_cap: 0,
        };
        assert_eq!(
            loaded.level(&root_path, &spec, 1).len(),
            tree.level(&root_path, &spec, 1).len()
        );

        std::fs::remove_file(&db).ok();
        std::fs::remove_dir_all(&root_dir).ok();
    }
}
