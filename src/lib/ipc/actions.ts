/**
 * Действия над узлом ФС, которые дёргают ОС напрямую через `tauri-plugin-opener`
 * вместо чтения/записи снимка — поэтому здесь нет своих Rust-команд.
 */
import { revealItemInDir } from "@tauri-apps/plugin-opener";

/** Показать узел в системном файловом менеджере, подсветив его в папке.
 *  Бросает, если путь недоступен — владелец заворачивает ошибку в UI. */
export function revealInExplorer(path: string): Promise<void> {
  return revealItemInDir(path);
}

/** Скопировать путь узла в буфер обмена; при недоступности Clipboard API —
 *  фолбэк через скрытый `textarea` (`execCommand("copy")`). */
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
