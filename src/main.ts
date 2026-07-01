import "./lib/styles/fonts.css"; // @font-face до токенов, что ссылаются на семейства
import "./lib/styles/tokens.css"; // токены — app.css и компоненты их читают
import "./lib/styles/themes.css"; // темы (§II.11): переопределения семантики по data-theme
import "./app.css";
import { theme, applyTheme } from "./lib/store/settings";
import { mount } from "svelte";

// Активная тема живёт на :root через data-theme; блок [data-theme] в themes.css
// переопределяет семантические токены (структурные — из tokens.css). Тема берётся
// из стора настроек (localStorage или дефолт) и применяется до монтирования, чтобы
// не мелькала нестилизованная тема. Переключается из окна настроек (шестерёнка).
applyTheme(theme.get());
import App from "./App.svelte";

// Svelte 5: монтируем приложение императивно в #app.
const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
