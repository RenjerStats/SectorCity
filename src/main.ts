import "./lib/styles/fonts.css"; // @font-face должен идти до токенов, что ссылаются на семейства
import "./lib/styles/tokens.css";
import "./lib/styles/themes.css";
import "./app.css";
import { theme, applyTheme } from "./lib/store/settings";
import { mount } from "svelte";

// Применяем тему до монтирования, иначе на старте мелькнёт нестилизованный DOM.
applyTheme(theme.get());
import App from "./App.svelte";

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
