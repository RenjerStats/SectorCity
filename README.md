# SectorCity

Desktop-приложение для визуализации занятого места на диске. Метафора «город
в городе»: **здание = файл, район = папка** (рекурсивно). Кодирование строго
один канал на переменную: площадь основания = размер, высота = устаревание,
цвет = категория. Без ИИ — только правила/эвристики. Раскладка детерминированная.

> Проектная документация — в [`docs/`](docs/). Архитектурные решения там
> зафиксированы; отступать без согласования нельзя. Рабочее имя в части
> документов — «TerraForm Drive» (это тот же проект).

## Стек

- **Backend:** Rust + Tauri v2 · `jwalk` · `rayon` · `rusqlite` · `serde` ·
  `tokio`/`tokio-util` · `thiserror`/`anyhow` · `tracing`; плагины `dialog`, `opener`.
- **Frontend:** TypeScript + Vite + Svelte · `three` (`InstancedMesh`) ·
  `d3-hierarchy` · `@tauri-apps/api` · `@tweenjs/tween.js` · `MapControls` · `nanostores`.

**Несущий принцип:** императивный 3D-мир (Three.js) и декларативный DOM-мир
(Svelte) общаются **только через стор `nanostores`** — единый источник правды.

## Структура

```
SectorCity/
├─ docs/                     # ТЗ, тех-архитектура, backlog
├─ index.html
├─ src/                      # фронтенд (TypeScript + Svelte)
│  ├─ main.ts                # точка входа, mount Svelte
│  ├─ App.svelte
│  └─ lib/
│     ├─ ipc/                # contract.ts (зеркало Rust) + обёртки invoke
│     ├─ store/              # машина режимов (nanostores) — стор-мост
│     ├─ three/              # 3D-слой: layoutToWorld, рендер (далее)
│     └─ components/         # Svelte-обвязка: toolbar, tooltip, …
└─ src-tauri/                # бэкенд (Rust + Tauri v2)
   ├─ Cargo.toml
   ├─ tauri.conf.json
   ├─ capabilities/          # разрешения плагинов
   └─ src/
      ├─ main.rs / lib.rs
      ├─ error.rs            # AppError (thiserror)
      └─ ipc/                # contract.rs (зеркало TS) + commands.rs
```

## Разработка

Требования: Node 20+, pnpm (через `corepack`), Rust (stable), системный WebView2.

```bash
corepack pnpm install        # фронтовые зависимости
pnpm tauri dev               # запуск приложения (первая сборка Rust — долгая)
```

Полезное:

```bash
pnpm check:once              # svelte-check (типы фронта)
pnpm format                  # prettier
cargo fmt   --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
cargo test  --manifest-path src-tauri/Cargo.toml
```

> Статус: каркас инициализирован (фаза 0). IPC-команды — заглушки с
> зафиксированными сигнатурами; Scanner/Aggregator/Snapshot — следующие фазы.
