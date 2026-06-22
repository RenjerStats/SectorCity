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

/// Суффикс синтетического пути блока «Прочее»: `{уровень}::<other>`. Путь
/// НАВИГИРУЕМ — `level` по нему раскрывает хвост соответствующего набора обратно в
/// самостоятельный уровень (рекурсивно, см. `resolve_level_set`).
const OTHER_SUFFIX: &str = "::<other>";

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
    /// Маска категорий ФАЙЛОВ в поддереве (объединение снизу вверх): файл — свой
    /// бит, папка — объединение детей. Производная; считается после связки дерева
    /// (`compute_category_masks`) и не хранится в снимке (восстанавливается при
    /// загрузке). Питает структурный фильтр по категориям (см. `category_bit`).
    pub cat_mask: u8,
    /// Узел — reparse point / junction: внутрь не спускались.
    pub is_reparse: bool,
    /// Папка — известный кэш/мусор (кандидат на очистку).
    pub is_cleanup: bool,
    /// Узел заблокирован для удаления (системный).
    pub is_locked: bool,
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

    /// Удалить узел по пути, убрать его и потомков из индекса, и скорректировать размеры родителей.
    pub fn delete_node(&mut self, path: &str) -> Option<u64> {
        let idx = self.by_path.get(path).copied()?;
        let node_size = self.nodes[idx].size;

        // 1. Убираем сам узел и всех потомков из индекса путей
        self.remove_descendants_from_index(idx);

        // 2. Найдём родителя и уберём узел из его списка детей
        let parent_path = std::path::Path::new(path).parent()?;
        let parent_path_str = parent_path.to_string_lossy();

        if let Some(&parent_idx) = self.by_path.get(parent_path_str.as_ref()) {
            self.nodes[parent_idx].children.retain(|&c| c != idx);

            // 3. Скорректируем размеры родителей вверх до корня
            let mut curr = Some(parent_idx);
            while let Some(curr_idx) = curr {
                let node = &mut self.nodes[curr_idx];
                node.size = node.size.saturating_sub(node_size);

                let p_path = node.path.parent();
                curr = p_path.and_then(|p| self.by_path.get(p.to_string_lossy().as_ref()).copied());
            }
        }

        Some(node_size)
    }

    fn remove_descendants_from_index(&mut self, idx: usize) {
        let path_str = self.nodes[idx].path.to_string_lossy().into_owned();
        self.by_path.remove(&path_str);

        // Клонируем список детей для обхода
        let kids = self.nodes[idx].children.clone();
        for child_idx in kids {
            self.remove_descendants_from_index(child_idx);
        }
    }

    /// Уровень `path` с агрегацией мелочи и превью на `depth` уровней вниз.
    ///
    /// Критерий «мелочи» задаёт [`AggSpec`] (относительный по доле ПЛОЩАДИ уровня
    /// = доле свёрнутого объёма / абсолютный по байтам, см. контракт). И файлы, И
    /// папки мельче порога сворачиваются в синтетический узел «Прочее» честной
    /// суммарной площади (флаг `Aggregated`). «Прочее» НАВИГИРУЕМО: его путь —
    /// `{path}::<other>`, и `level` по нему раскрывает хвост обратно в уровень (там
    /// мелочь уже крупна относительно суммы хвоста — см. `resolve_level_set`).
    ///
    /// При `depth > 1` каждый дочерний РАЙОН (папка) дополнительно получает превью
    /// своих детей — вложенный treemap ещё на уровень вниз (ТЗ §3, «очертания до
    /// открытия»); рекурсия идёт до `depth == 1`. Наружу уходит «текущий уровень +
    /// превью», уже агрегированный по хвосту на каждом уровне (docs §IPC, §5.7).
    pub fn level(&self, path: &str, agg: &AggSpec, depth: u32) -> Vec<ScanNode> {
        let Some(set) = self.resolve_level_set(path, agg) else {
            return Vec::new();
        };
        let total = self.sum_sizes(&set);
        // `current = true` только для запрошенного уровня: абсолютный порог живёт
        // лишь здесь, превью уходят в относительный фолбэк (см. `is_small`).
        self.layout_set(path, &set, total, agg, depth, true)
    }

    /// Набор узлов, образующих уровень `path`:
    /// - обычный путь → прямые дети узла;
    /// - синтетический `…::<other>` → ХВОСТ родительского набора (рекурсивно).
    ///
    /// Раскрытие «Прочее» детерминировано: тот же `split_head_tail`, что построил
    /// блок на родительском уровне, даёт тот же хвост. Завершимость рекурсии — за
    /// инвариантом `split_head_tail` (набор не уходит в хвост целиком).
    fn resolve_level_set(&self, path: &str, agg: &AggSpec) -> Option<Vec<usize>> {
        if let Some(base) = path.strip_suffix(OTHER_SUFFIX) {
            let parent = self.resolve_level_set(base, agg)?;
            let total = self.sum_sizes(&parent);
            let (_head, tail) = self.split_head_tail(&parent, total, agg, true);
            Some(tail)
        } else {
            let idx = self.index_of(path)?;
            Some(self.nodes[idx].children.clone())
        }
    }

    /// Сумма размеров набора (площадь уровня = знаменатель относительного порога).
    fn sum_sizes(&self, set: &[usize]) -> u64 {
        set.iter().map(|&i| self.nodes[i].size).sum()
    }

    /// Разбить набор на head (крупные — здания/районы) и tail (мелочь → «Прочее»).
    /// Сортировка по размеру убыв.; критерий мелочи — `is_small` (И файлы, И папки);
    /// `top_n_cap` — страховочный потолок числа узлов в head (перфо, 0 — без потолка).
    ///
    /// ИНВАРИАНТ ЗАВЕРШИМОСТИ: набор НЕ может уйти в tail целиком. Если всё мельче
    /// порога относительно суммы набора, крупнейшие (до `cap`, иначе все) поднимаются
    /// в head — иначе drill «Прочее» вернул бы тот же набор (вечный цикл навигации).
    fn split_head_tail(
        &self,
        set: &[usize],
        total: u64,
        agg: &AggSpec,
        current: bool,
    ) -> (Vec<usize>, Vec<usize>) {
        let mut items = set.to_vec();
        items.sort_by(|&a, &b| self.nodes[b].size.cmp(&self.nodes[a].size));

        let cap = agg.top_n_cap as usize;
        let mut head: Vec<usize> = Vec::new();
        let mut tail: Vec<usize> = Vec::new();
        for k in items {
            let over_cap = cap > 0 && head.len() >= cap;
            if self.is_small(k, total, agg, current) || over_cap {
                tail.push(k);
            } else {
                head.push(k);
            }
        }
        if head.is_empty() && !tail.is_empty() {
            // tail отсортирован по убыванию → поднимаем крупнейшие. Хвост после
            // этого строго меньше исходного набора → рекурсия «Прочее» завершима.
            let promote = if cap > 0 {
                cap.min(tail.len())
            } else {
                tail.len()
            };
            head.extend(tail.drain(0..promote));
        }
        (head, tail)
    }

    /// Разложить набор `set` (с суммой `total`) в уровень: head → узлы (папки при
    /// `depth > 1` несут превью), хвост → один синтетический «Прочее». `level_path` —
    /// путь текущего уровня (синтетический путь «Прочее» = `{level_path}::<other>`).
    /// `current` — это запрошенный уровень (для семантики абсолютного режима).
    fn layout_set(
        &self,
        level_path: &str,
        set: &[usize],
        total: u64,
        agg: &AggSpec,
        depth: u32,
        current: bool,
    ) -> Vec<ScanNode> {
        let (head, tail) = self.split_head_tail(set, total, agg, current);
        let mut out: Vec<ScanNode> = head
            .iter()
            .map(|&k| self.node_with_preview(k, agg, depth))
            .collect();
        if !tail.is_empty() {
            out.push(self.aggregate_tail(level_path, &tail, agg, depth));
        }
        out
    }

    /// Узел `idx` — «мелочь» по текущему [`AggSpec`]? Применяется и к файлам, и к
    /// папкам (мелкая папка сворачивается, оставаясь доступной через навигируемый
    /// блок «Прочее»). Относительный режим (и фолбэк превью абсолютного) сравнивает
    /// долю площади уровня (`total` — сумма набора); абсолютный на запрошенном
    /// уровне — точные байты свёрнутого размера.
    fn is_small(&self, idx: usize, total: u64, agg: &AggSpec, current: bool) -> bool {
        let size = self.nodes[idx].size;
        let relative = || total > 0 && (size as f64) < f64::from(agg.fraction) * total as f64;
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
            let set = self.nodes[idx].children.clone();
            let total = self.nodes[idx].size;
            let level_path = node.path.clone();
            // Превью — не запрошенный уровень (current = false): абсолютный порог
            // сюда не проникает, действует относительный фолбэк.
            node.children = self.layout_set(&level_path, &set, total, agg, depth - 1, false);
        }
        node
    }

    /// Свернуть хвост `tail` уровня `level_path` в синтетический узел «Прочее»:
    /// площадь = честная сумма, высоту кодируем самым старым mtime (устаревание
    /// «вверх»). Хвост может содержать и файлы, и папки. Узел НАВИГИРУЕМ: путь —
    /// `{level_path}::<other>`, `level` по нему раскрывает этот же хвост.
    ///
    /// При `depth > 1` «Прочее» несёт ПРЕВЬЮ своего хвоста — ту же раскладку, что
    /// даст drill в него (`level` на уровень ниже). Так блок становится размещённым
    /// кварталом-районом (а не плоским зданием), и промоут превью→активный при зуме
    /// внутрь пиксель-в-пиксель — навигатор драйвит «Прочее» как обычный район.
    fn aggregate_tail(
        &self,
        level_path: &str,
        tail: &[usize],
        agg: &AggSpec,
        depth: u32,
    ) -> ScanNode {
        let mut sum = 0u64;
        let mut oldest = i64::MAX;
        // Маска блока «Мелочь» — объединение масок свёрнутого хвоста: так фильтр по
        // категориям знает, есть ли внутри блока хоть одна выбранная категория.
        let mut cat_mask = 0u8;
        for &k in tail {
            let n = &self.nodes[k];
            sum += n.size;
            oldest = oldest.min(n.mtime);
            cat_mask |= n.cat_mask;
        }
        let other_path = format!("{level_path}{OTHER_SUFFIX}");
        // Превью хвоста (на уровень ниже): тот же `split_head_tail` по тому же
        // набору/сумме → совпадает с активным уровнем после drill (current здесь
        // false → абсолютный порог в превью не лезет, как и у обычных районов).
        let children = if depth > 1 {
            self.layout_set(&other_path, tail, sum, agg, depth - 1, false)
        } else {
            Vec::new()
        };
        ScanNode {
            path: other_path,
            name: "Мелочь".to_string(),
            is_dir: false,
            size: sum,
            mtime: if oldest == i64::MAX { 0 } else { oldest },
            atime: if oldest == i64::MAX { 0 } else { oldest },
            child_count: tail.len() as u32,
            category: Category::Other,
            category_mask: cat_mask,
            flags: vec![NodeFlag::Aggregated],
            children,
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
        if n.is_locked {
            flags.push(NodeFlag::Locked);
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
            category_mask: n.cat_mask,
            flags,
            // Превью заполняет `node_with_preview` при depth > 1; здесь — пусто.
            children: Vec::new(),
        }
    }
}

/// Бит категории в маске `TreeNode::cat_mask` / `ScanNode::category_mask`.
///
/// ВАЖНО: порядок битов — зеркало `ALL_CATEGORIES` на фронте
/// (`src/lib/store/mode.ts`): `code`=0, `document`=1, …, `other`=7. Фронт строит
/// маску выбранных категорий в этом же порядке и пересекает её с `category_mask`.
/// Менять порядок — синхронно в обоих местах (есть тест `category_bits_are_stable`).
pub(crate) fn category_bit(c: Category) -> u8 {
    match c {
        Category::Code => 1 << 0,
        Category::Document => 1 << 1,
        Category::Image => 1 << 2,
        Category::Video => 1 << 3,
        Category::Audio => 1 << 4,
        Category::Archive => 1 << 5,
        Category::Binary => 1 << 6,
        Category::Other => 1 << 7,
    }
}

/// Посчитать `cat_mask` для всей арены снизу вверх: файл → собственный бит
/// категории, папка → объединение масок детей. `parents[i]` — индекс родителя `i`
/// (или `None` у корня). Обход по убыванию глубины гарантирует, что ребёнок учтён
/// раньше родителя. Общая точка для свежего скана и загрузки снимка (производное
/// поле в БД не храним).
fn compute_category_masks(nodes: &mut [TreeNode], parents: &[Option<usize>]) {
    for n in nodes.iter_mut() {
        n.cat_mask = if n.is_dir {
            0
        } else {
            category_bit(n.category)
        };
    }
    let mut order: Vec<usize> = (0..nodes.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(nodes[i].depth));
    for i in order {
        let mask = nodes[i].cat_mask;
        if let Some(pi) = parents[i] {
            nodes[pi].cat_mask |= mask;
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
        let is_locked = crate::classify::is_locked_path(&clean_path, &name)
            || crate::classify::is_system_by_attrs(&meta);

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
            cat_mask: 0, // считается снизу вверх после связки дерева (пасс 3)
            is_reparse,
            is_cleanup,
            is_locked,
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
        let name = root.to_string_lossy().into_owned();
        let is_locked = crate::classify::is_locked_path(&clean_root, &name)
            || crate::classify::is_system_by_attrs(&root_meta);
        nodes.push(TreeNode {
            path: clean_root,
            name,
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
            // Одиночный корень: эта ветка минует пасс 3 — маску ставим сразу.
            cat_mask: if root_meta.is_dir() {
                0
            } else {
                category_bit(category)
            },
            is_reparse: is_reparse_point(&root_meta),
            is_cleanup: false,
            is_locked,
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

    // Маска категорий — тем же обходом снизу вверх (после связки родителей).
    compute_category_masks(&mut nodes, &parents);

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
    fn level_relative_threshold_folds_small_files_and_folders() {
        let root = temp_dir("relative");
        // Корень: большой файл, средний файл, мелочь-файлы и МЕЛКАЯ ПАПКА (тоже
        // сворачивается по порогу — это (б): районы-крохи уходят в «Прочее»).
        write_file(&root.join("big.bin"), 900); // ~88% — район-доминанта
        write_file(&root.join("mid.bin"), 60); // ~6% — крупнее порога 5%
        write_file(&root.join("tiny1.bin"), 25); // ~2.5% → «Прочее»
        write_file(&root.join("tiny2.bin"), 15); // ~1.5% → «Прочее»
        let small_sub = root.join("smallsub"); // папка-кроха → «Прочее»
        fs::create_dir_all(&small_sub).unwrap();
        write_file(&small_sub.join("s.bin"), 20); // ~2% → «Прочее»

        let tree = scan_root(&root).unwrap();
        let root_path = tree.root_node().path.to_string_lossy().into_owned();

        // total = 900+60+25+15+20 = 1020; порог 5% (= 51 байт).
        let spec = AggSpec {
            mode: AggMode::Relative,
            fraction: 0.05,
            min_bytes: 0,
            top_n_cap: 0,
        };
        let level = tree.level(&root_path, &spec, 1);

        // Видим big и mid; мелкие файлы И мелкая папка свёрнуты в «Прочее».
        assert!(level.iter().any(|n| n.name == "big.bin"));
        assert!(level.iter().any(|n| n.name == "mid.bin"));
        assert!(
            !level.iter().any(|n| n.name == "smallsub"),
            "мелкая папка свёрнута в «Прочее»"
        );
        assert!(
            !level.iter().any(|n| n.name == "tiny1.bin"),
            "мелочь не видна отдельно"
        );

        let other = level
            .iter()
            .find(|n| n.flags.contains(&NodeFlag::Aggregated))
            .expect("узел «Прочее»");
        assert_eq!(other.size, 60, "честная сумма tiny1 + tiny2 + smallsub");
        assert_eq!(other.child_count, 3);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn other_block_is_navigable_into_its_tail() {
        let root = temp_dir("other-nav");
        // Один гигант + три мелких файла → они в «Прочее»; навигация В «Прочее»
        // раскрывает их как самостоятельные здания (относительно суммы хвоста они
        // уже крупные → второго уровня «Прочее» нет).
        write_file(&root.join("big.bin"), 900);
        write_file(&root.join("a.bin"), 20);
        write_file(&root.join("b.bin"), 18);
        write_file(&root.join("c.bin"), 16);
        let tree = scan_root(&root).unwrap();
        let root_path = tree.root_node().path.to_string_lossy().into_owned();
        let spec = AggSpec {
            mode: AggMode::Relative,
            fraction: 0.05,
            min_bytes: 0,
            top_n_cap: 0,
        };

        let level = tree.level(&root_path, &spec, 1);
        let other = level
            .iter()
            .find(|n| n.flags.contains(&NodeFlag::Aggregated))
            .expect("узел «Прочее»");
        assert_eq!(other.child_count, 3);
        assert!(
            other.path.ends_with("::<other>"),
            "путь «Прочее» навигируемый"
        );

        let inner = tree.level(&other.path, &spec, 1);
        assert_eq!(inner.len(), 3, "хвост раскрылся в три отдельных здания");
        assert!(inner.iter().any(|n| n.name == "a.bin"));
        assert!(
            !inner
                .iter()
                .any(|n| n.flags.contains(&NodeFlag::Aggregated)),
            "внутри «Прочее» второго блока «Прочее» нет"
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn other_block_carries_preview_matching_its_drill() {
        // «Прочее» при depth>=2 — размещённый квартал: несёт превью своего хвоста,
        // совпадающее с раскладкой drill'а внутрь (промоут превью→активный «г»).
        let root = temp_dir("other-preview");
        write_file(&root.join("big.bin"), 900);
        write_file(&root.join("a.bin"), 30);
        write_file(&root.join("b.bin"), 22);
        write_file(&root.join("c.bin"), 14);
        let tree = scan_root(&root).unwrap();
        let root_path = tree.root_node().path.to_string_lossy().into_owned();
        let spec = AggSpec {
            mode: AggMode::Relative,
            fraction: 0.05,
            min_bytes: 0,
            top_n_cap: 0,
        };

        let level = tree.level(&root_path, &spec, 2);
        let other = level
            .iter()
            .find(|n| n.flags.contains(&NodeFlag::Aggregated))
            .expect("узел «Прочее»");
        // Превью непусто → фронт распознаёт «Прочее» как район-квартал (не здание).
        assert!(
            !other.children.is_empty(),
            "«Прочее» при depth=2 несёт превью хвоста"
        );

        // Превью совпадает с верхним уровнем drill'а в «Прочее» (имена + порядок) —
        // гарант пиксель-в-пиксель промоута при бесшовном зуме внутрь.
        let drilled = tree.level(&other.path, &spec, 2);
        let preview_names: Vec<&str> = other.children.iter().map(|c| c.name.as_str()).collect();
        let drilled_names: Vec<&str> = drilled.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(preview_names, drilled_names);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn other_navigation_terminates_when_all_equal() {
        let root = temp_dir("other-equal");
        // Гигант + пять ОДИНАКОВЫХ мелких файлов. При высоком пороге даже внутри
        // хвоста каждый из пяти равных мельче порога → без гаранта прогресса drill
        // «Прочее» вернул бы тот же набор (вечный цикл). Проверяем, что хвост строго
        // уменьшается (крупнейшие поднимаются в head по `top_n_cap`).
        write_file(&root.join("big.bin"), 1000);
        for i in 0..5 {
            write_file(&root.join(format!("e{i}.bin")), 10);
        }
        let tree = scan_root(&root).unwrap();
        let root_path = tree.root_node().path.to_string_lossy().into_owned();
        let spec = AggSpec {
            mode: AggMode::Relative,
            fraction: 0.40, // агрессивный порог
            min_bytes: 0,
            top_n_cap: 2, // поднимаем по 2 крупнейших → прогресс гарантирован
        };

        let level = tree.level(&root_path, &spec, 1);
        let other = level
            .iter()
            .find(|n| n.flags.contains(&NodeFlag::Aggregated))
            .expect("узел «Прочее»");
        assert_eq!(other.child_count, 5, "пять равных мелких → «Прочее»");

        // Drill «Прочее»: head пуст (все равны и мельче порога) → гарант поднимает
        // top_n_cap=2 крупнейших, остальные → хвост СТРОГО меньше (прогресс).
        let inner = tree.level(&other.path, &spec, 1);
        assert!(
            inner
                .iter()
                .any(|n| !n.flags.contains(&NodeFlag::Aggregated)),
            "крупнейшие подняты в head — есть отдельные здания"
        );
        let inner_other = inner
            .iter()
            .find(|n| n.flags.contains(&NodeFlag::Aggregated))
            .expect("остаток снова в «Прочее»");
        assert!(
            inner_other.child_count < other.child_count,
            "хвост строго уменьшился ({} < {})",
            inner_other.child_count,
            other.child_count
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn level_absolute_threshold_only_current_level() {
        let root = temp_dir("absolute");
        // root/keep.bin=500; root/drop.bin=50; root/sub/{inner.bin=50, inner_big.bin=400}.
        // Абсолютный порог 100 байт: на текущем уровне drop.bin (50<100) свора-
        // чивается; sub (свёрнуто 450>100) выживает районом. inner.bin (50, внутри
        // sub, превью) НЕ должен сворачиваться абсолютным порогом — иначе у папки
        // выкосило бы содержимое; там работает относительный фолбэк (fraction=0).
        write_file(&root.join("keep.bin"), 500);
        write_file(&root.join("drop.bin"), 50);
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        write_file(&sub.join("inner.bin"), 50);
        write_file(&sub.join("inner_big.bin"), 400);

        let tree = scan_root(&root).unwrap();
        let root_path = tree.root_node().path.to_string_lossy().into_owned();

        let spec = AggSpec {
            mode: AggMode::Absolute,
            fraction: 0.0, // относительный фолбэк превью выключен → inner виден
            min_bytes: 100,
            top_n_cap: 0,
        };
        let level = tree.level(&root_path, &spec, 2);

        // Текущий уровень: keep.bin и район sub видны, drop.bin (50 < 100) → «Прочее».
        assert!(level.iter().any(|n| n.name == "keep.bin"));
        assert!(!level.iter().any(|n| n.name == "drop.bin"));
        assert!(level
            .iter()
            .any(|n| n.flags.contains(&NodeFlag::Aggregated)));

        // Превью sub: inner.bin (50 байт) виден, абсолютный порог сюда не дошёл.
        let sub_node = level
            .iter()
            .find(|n| n.name == "sub")
            .expect("район sub выжил (450 > 100)");
        assert!(
            sub_node.children.iter().any(|c| c.name == "inner.bin"),
            "абсолютный порог не должен сворачивать содержимое дочерней папки"
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn category_bits_are_stable() {
        // Порядок битов — контракт с фронтом (`ALL_CATEGORIES`). Менять синхронно.
        assert_eq!(category_bit(Category::Code), 1 << 0);
        assert_eq!(category_bit(Category::Document), 1 << 1);
        assert_eq!(category_bit(Category::Image), 1 << 2);
        assert_eq!(category_bit(Category::Video), 1 << 3);
        assert_eq!(category_bit(Category::Audio), 1 << 4);
        assert_eq!(category_bit(Category::Archive), 1 << 5);
        assert_eq!(category_bit(Category::Binary), 1 << 6);
        assert_eq!(category_bit(Category::Other), 1 << 7);
    }

    #[test]
    fn folder_mask_unions_descendant_file_categories() {
        let root = temp_dir("mask");
        write_file(&root.join("a.mp4"), 10);
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        write_file(&sub.join("b.txt"), 10);

        let tree = scan_root(&root).unwrap();
        let a = tree.nodes.iter().find(|n| n.name == "a.mp4").unwrap();
        let b = tree.nodes.iter().find(|n| n.name == "b.txt").unwrap();
        let sub_node = tree.nodes.iter().find(|n| n.name == "sub").unwrap();

        // Файл — ровно один бит своей категории; папка — объединение детей.
        assert_eq!(a.cat_mask, category_bit(a.category));
        assert_eq!(
            sub_node.cat_mask, b.cat_mask,
            "папка = маска единственного файла"
        );
        assert_eq!(
            tree.root_node().cat_mask,
            a.cat_mask | b.cat_mask,
            "корень = объединение всех файлов поддерева"
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn aggregate_mask_unions_tail_categories() {
        let root = temp_dir("aggmask");
        // big остаётся зданием, два мелких файла сворачиваются в «Мелочь».
        write_file(&root.join("big.mp4"), 900);
        write_file(&root.join("a.txt"), 20);
        write_file(&root.join("b.jpg"), 18);

        let tree = scan_root(&root).unwrap();
        let root_path = tree.root_node().path.to_string_lossy().into_owned();
        let spec = AggSpec {
            mode: AggMode::Relative,
            fraction: 0.05,
            min_bytes: 0,
            top_n_cap: 0,
        };
        let level = tree.level(&root_path, &spec, 1);
        let other = level
            .iter()
            .find(|n| n.flags.contains(&NodeFlag::Aggregated))
            .expect("блок «Мелочь»");

        let a = tree.nodes.iter().find(|n| n.name == "a.txt").unwrap();
        let b = tree.nodes.iter().find(|n| n.name == "b.jpg").unwrap();
        assert_eq!(
            other.category_mask,
            a.cat_mask | b.cat_mask,
            "маска «Мелочи» = объединение свёрнутого хвоста"
        );
        assert_eq!(
            other.name, "Мелочь",
            "блок-агрегат переименован (не «Прочее»)"
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
