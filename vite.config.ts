import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// @tauri-apps/cli задаёт TAURI_DEV_HOST при работе по сети/на мобильных.
const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/ — настройки подогнаны под Tauri:
// фиксированный порт, отключённый clearScreen, игнор src-tauri в вотчере.
export default defineConfig({
  plugins: [svelte()],
  // Tauri сам выводит свои ошибки — не затираем консоль Vite.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Бэкенд Rust пересобирает cargo сам — фронтовый вотчер сюда не лезет.
      ignored: ["**/src-tauri/**"],
    },
  },
  // Прокидываем только переменные с префиксом, безопасные для фронта.
  envPrefix: ["VITE_", "TAURI_ENV_*"],
});
