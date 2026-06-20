import { defineConfig } from "vitest/config";

/**
 * Тесты ядра нового UX (математика origin shift + графика уровней/LOD).
 * Окружение `node`: Three.js-математика (матрицы/векторы/raycast по матрицам)
 * работает headless, без WebGL/DOM. Поэтому тестируемые модули (`transform`,
 * `city`, `navigator`) НЕ должны тянуть `scene.ts` (WebGLRenderer/MapControls) —
 * каноническая поза камеры вынесена в `home.ts` именно ради этого.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
