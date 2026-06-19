# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Статус проекта

На текущий момент репозиторий содержит **только проектную документацию** (`docs/`), кода ещё нет. Перед написанием кода читай `docs/` — там зафиксированы архитектурные решения, отступать от которых нельзя без явного согласования. Имя проекта — **SectorCity** (в части документов фигурирует старое рабочее имя «TerraForm Drive» — это тот же проект).

Документы (на русском):
- `docs/SectorCity-tz.md` — ТЗ: цель, метафора, принципы читаемости, контракт данных, риски.
- `docs/SectorCity-tech.md` — техническая архитектура: финальный стек, зафиксированные развилки (A–I), типичные накладки и решения.
- `docs/SectorCity-backlog.md` — backlog по фазам 0–3 (8 недель, Windows-first), каждый «кусочек» = одна ветка/PR.

## Что это за приложение

Desktop-приложение для визуализации занятого места на диске. Метафора «город в городе»: **здание = файл, район = папка** (рекурсивно). Кодирование строго один канал на переменную:
- **площадь основания** = размер (честный масштаб, без искажений; мелочь схлопывается в блок «Прочее (N файлов)» честной суммарной площади);
- **высота** = устаревание (база — `mtime`; `atime` только как уточнение при достоверности);
- **цвет** = категория содержимого (colorblind-safe палитра), не размер.

Навигация — один уровень за раз + плавный зум камеры с превью на +1 уровень. ИИ нет — только правила/эвристики. Раскладка детерминированная (повторный скан даёт ту же геометрию → пространственная память).

## Стек (зафиксирован)

**Backend (Rust + Tauri v2):** `jwalk` (параллельный скан ФС) · `rayon` (агрегация) · `rusqlite` (снимок ФС/diff) · `serde`/`serde_json` (IPC, запас — `rmp-serde`/`bincode`) · `tokio`/`tokio-util` (`CancellationToken` для отмены скана) · `thiserror`/`anyhow` · `tracing`; плагины `tauri-plugin-dialog`, `tauri-plugin-opener`; `trash`, `blake3` (фаза 3).

**Frontend (TypeScript + Vite + Svelte):** `three` (рендер через `InstancedMesh`) · `d3-hierarchy` (squarified-treemap, импортировать модульно, не весь `d3`) · `@tauri-apps/api` (IPC) · `@tweenjs/tween.js` (анимация камеры) · `MapControls` из `three/examples` · `nanostores` (стор-мост) · машина режимов на discriminated union (без XState). Опц.: `troika-three-text`, `three-mesh-bvh`, `postprocessing`.

## Несущий архитектурный принцип

Сосуществуют **императивный 3D-мир** (Three.js: цикл рендера, `InstancedMesh`, raycaster) и **декларативный DOM-мир** (Svelte: тулбар, крошки, тултипы, меню, легенды). **Они НИКОГДА не дёргают друг друга напрямую — общаются только через единый стор `nanostores` (single source of truth).** Прямая связь raycaster↔DOM запрещена (спагетти + гонки).

Поток: `Scanner → Aggregator → Snapshot(SQLite) → IPC(Tauri) → Layout → Renderer`, сбоку `Classifier` и `Interaction`.

Правило частоты, критичное для перфоманса:
- **Низкочастотное** (что выбрано, какой режим, контент тултипа) → реактивно через стор.
- **Высокочастотное** (позиция оверлея покадрово) → императивно через `ref`/прямую запись в DOM, **в обход реконсиляции фреймворка**. Писать позицию в реактивный стор каждый кадр нельзя — это смерть производительности.

## Машина режимов

Discriminated union на TS + явные переходы (гарды на уровне типов отсекают гонки, напр. `DRILL` во время `zooming`):
```ts
type AppMode =
  | { kind: 'scanning'; progress: number }
  | { kind: 'idle'; path: string }
  | { kind: 'hovering'; path: string; hoveredId: NodeId }
  | { kind: 'selected'; path: string; selectedId: NodeId }
  | { kind: 'zooming'; from: string; to: string };
```

## Контракт данных и IPC

`ScanNode { path, name, is_dir, size: u64 (для папок — свёрнутая сумма), mtime, atime: i64, child_count: u32, category: enum, flags: [...] }`. Держать Rust struct ↔ TS type в синхроне.

IPC-команды Tauri: `start_scan(root)` (стрим прогресса, пишет снимок) · `get_level(path, top_n, depth)` (дети + превью +1 уровень, tail-агрегация в «Прочее») · `get_node_detail(path)` (полная правда для тултипа) · `search(query)`. Наружу уходит **только текущий уровень + превью**, уже агрегированные по хвосту — так нейтрализуется граница сериализации и раздувание payload.

## Ключевые накладки (решения уже приняты — см. docs/SectorCity-tech.md §5)

- **Обводка hover:** один отдельный `highlight-mesh` (рёбра/увеличенный бокс), трансформ = матрице наведённого инстанса. `OutlinePass`/`postprocessing` НЕ работают для одного инстанса `InstancedMesh`.
- **Picking:** CPU raycast с rAF-троттлингом (~30–60/с). BVH/GPU-picking — только при перфо-проблемах.
- **Окно над зданием:** ручная проекция мировой точки в пиксели (`vector.project(camera)`), DOM-оверлей. Не рисовать текст в WebGL.
- **Утечки GPU при drill:** на смене уровня явно `geometry.dispose()`/`material.dispose()`/`texture.dispose()`.
- **Координаты d3↔Three:** один модуль `layoutToWorld()` (treemap-x→world-x, treemap-y→world-z, размер→footprint, устаревание→world-y/высота).
- **Прогресс скана:** батчить/троттлить (≤ раз/100 мс), иначе топит UI.
- **ФС-нюансы Windows:** не следовать reparse points/junction (циклы); длинные пути через префикс `\\?\`; permission denied — пропускать и считать число ошибок.

## Тулинг и команды

Форматтеры/линтеры (по backlog фаза 0): Rust — `rustfmt` + `clippy`; фронт — `prettier` + `svelte-check`. Тесты — `cargo test` (бэк) / `vitest` (фронт). Конкретные команды появятся после инициализации проекта Tauri (`create-tauri-app`, шаблон Svelte + TS + Vite) — обнови этот раздел, когда они будут.

> Из глобальных инструкций пользователя: префиксуй команды `rtk` (token-killer), даже в цепочках с `&&`. Большие скачивания/установки и долгую (>5 мин) компиляцию не запускай сам — проси пользователя.
