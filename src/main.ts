import "./lib/styles/fonts.css"; // @font-face до токенов, что ссылаются на семейства
import "./lib/styles/tokens.css"; // токены — app.css и компоненты их читают
import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";

// Svelte 5: монтируем приложение императивно в #app.
const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
