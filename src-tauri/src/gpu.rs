//! Форс дискретной GPU через реестр Windows.
//!
//! На ноутбуках с переключаемой графикой WebGL-контекст WebView2 по умолчанию
//! часто садится на встроенную iGPU. `powerPreference: "high-performance"` во
//! фронте (`scene.ts`) — лишь подсказка; надёжный форс на уровне ОС — запись
//! графического предпочтения приложения в
//! `HKCU\Software\Microsoft\DirectX\UserGpuPreferences` (программный аналог
//! «Параметры → Система → Дисплей → Графика → приложение → Высокая
//! производительность»). Ключ per-exe; дочерние процессы WebView2 наследуют
//! выбор адаптера.
//!
//! Пишем через `reg.exe` (без новой зависимости), в HKCU (без прав админа),
//! идемпотентно (пере-запись только при отличии) и в фоновом потоке, чтобы не
//! задерживать показ окна.

/// Значение предпочтения: `2` = High performance (дискретная GPU).
#[cfg(windows)]
const DESIRED_PREFERENCE: &str = "GpuPreference=2;";

/// Ветка реестра с графическими предпочтениями приложений (per-user).
#[cfg(windows)]
const GPU_PREFS_KEY: &str = r"HKCU\Software\Microsoft\DirectX\UserGpuPreferences";

/// Записать (если ещё не выставлено) предпочтение «дискретная GPU» для текущего
/// exe. No-op вне Windows. Ошибки не фатальны — только лог.
#[cfg(windows)]
pub fn ensure_high_performance_gpu() {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    /// `CREATE_NO_WINDOW` — чтобы `reg.exe` не мигнул консольным окном.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().into_owned(),
        Err(e) => {
            tracing::warn!(error = %e, "GPU-преференс: не удалось получить путь exe");
            return;
        }
    };

    // Уже выставлено нужное значение? Не переписываем на каждом старте.
    if let Ok(out) = Command::new("reg")
        .args(["query", GPU_PREFS_KEY, "/v", &exe])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        if out.status.success() && String::from_utf8_lossy(&out.stdout).contains(DESIRED_PREFERENCE)
        {
            tracing::debug!("GPU-преференс уже выставлен (High performance)");
            return;
        }
    }

    match Command::new("reg")
        .args([
            "add",
            GPU_PREFS_KEY,
            "/v",
            &exe,
            "/t",
            "REG_SZ",
            "/d",
            DESIRED_PREFERENCE,
            "/f",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
    {
        Ok(s) if s.success() => {
            tracing::info!(%exe, "GPU-преференс: High performance записан в реестр");
        }
        Ok(s) => tracing::warn!(code = ?s.code(), "GPU-преференс: reg add вернул ошибку"),
        Err(e) => tracing::warn!(error = %e, "GPU-преференс: reg add не запустился"),
    }
}

#[cfg(not(windows))]
pub fn ensure_high_performance_gpu() {}
