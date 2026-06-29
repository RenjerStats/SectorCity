/**
 * Действия над узлом ФС — петля «увидеть → действовать» (фаза 2, DoD).
 *
 * Эти команды НЕ читают/пишут наш снимок: они дёргают ОС напрямую через
 * `tauri-plugin-opener` (capability `opener:default` уже выдан, см.
 * `src-tauri/capabilities/default.json`). Поэтому здесь нет своих Rust-команд —
 * плагин предоставляет JS-API и собственные хендлеры.
 *
 * Удаление в корзину (`trash`) — фаза 3; здесь пока только безопасные действия
 * «только посмотреть» (показать в проводнике).
 */
import { revealItemInDir } from "@tauri-apps/plugin-opener";

/**
 * Показать узел в системном файловом менеджере (проводник Windows и т.п.).
 * Подсвечивает сам элемент в родительской папке. Безопасно: ничего не меняет.
 * Бросает, если путь недоступен — владелец заворачивает ошибку в UI.
 */
export function revealInExplorer(path: string): Promise<void> {
  return revealItemInDir(path);
}

/**
 * Скопировать путь узла в системный буфер обмена (vision §I.9/§I.10).
 * Использует Clipboard API webview (доступен в защищённом контексте Tauri) — без
 * отдельного плагина; на случай его отсутствия — фолбэк через скрытый `textarea`.
 * Бросает только при провале обоих способов — владелец заворачивает ошибку в UI.
 */
export async function copyPath(path: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(path);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = path;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
}
