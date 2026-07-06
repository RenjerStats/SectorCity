# SectorCity

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Desktop-приложение для визуализации занятого места на диске. Метафора «город
в городе»: **здание = файл, район = папка** (рекурсивно). Кодирование строго
один канал на переменную: площадь основания = размер, высота = устаревание,
цвет = категория. Без ИИ — только правила/эвристики. Раскладка детерминированная.

## Установка

Скачайте установщик для Windows (x64) — `SectorCity_x64-setup.exe` — и запустите.

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

## Лицензия

[MIT](LICENSE)
