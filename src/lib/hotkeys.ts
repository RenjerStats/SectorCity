/**
 * Центральный обработчик горячих клавиш — ЕДИНСТВЕННЫЙ владелец клавиатуры.
 * Монтируется один раз (Hotkeys.svelte) на всё время жизни приложения.
 *
 * Раскладка утверждена пользователем (docs/SectorCity-vision.md, карта функций
 * §I.1–I.11). Держим стор-мост (§1): DOM/оверлейные сторы дёргаем напрямую,
 * а 3D/навигацию/действия над узлом — через `uiCommand` (исполняет Scene).
 *
 * Правила:
 *  - Одиночные клавиши (без Ctrl/Alt/Meta) НЕ срабатывают, когда фокус в текстовом
 *    поле (иначе буквы уходят в строку поиска) — см. `isTyping`.
 *  - Ctrl-комбинации работают всегда (это не ввод текста), кроме Ctrl+C, который
 *    при фокусе в поле — обычное копирование текста.
 *  - Esc — универсальный «шаг назад», стеком (см. ниже). Модалки/меню владеют
 *    своим Esc сами (Settings/Legend/CleanupConfirm/ContextMenu/Help), поэтому
 *    при любом открытом оверлее центральный Esc не вмешивается.
 */
import {
  dispatchCommand,
  contextMenuOpen,
  helpOpen,
  toggleHelp,
  legendOpen,
  toggleLegend,
  cleanupConfirmOpen,
  setCleanupConfirm,
  hiddenOpen,
  toggleHidden,
  requestSearchFocus,
} from "./store/ui";
import { settingsOpen, toggleSettings } from "./store/settings";
import {
  appMode,
  searchQuery,
  selectedNode,
  hiddenPaths,
  markedCount,
  toggleCategory,
  showAggregate,
  ALL_CATEGORIES,
} from "./store/mode";

/** Фокус сейчас в поле ввода (тогда одиночные буквы — это набор текста)? */
function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

/** Открыт ли какой-либо оверлей/меню, владеющий своим Esc. */
function anyOverlayOpen(): boolean {
  return (
    settingsOpen.get() ||
    legendOpen.get() ||
    cleanupConfirmOpen.get() ||
    contextMenuOpen.get() ||
    helpOpen.get() ||
    hiddenOpen.get()
  );
}

/** Ctrl+G — переключить режим «Сканер мусора». */
function toggleCleanup(): void {
  dispatchCommand(
    appMode.get().kind === "cleanup"
      ? { kind: "exitCleanup" }
      : { kind: "enterCleanup" },
  );
}

/** Esc-стек (сверху вниз): активные оверлеи закрывают себя сами; здесь —
 *  слои сцены. Возвращает true, если Esc обработан. */
function handleEscape(): boolean {
  if (anyOverlayOpen()) return true; // оверлей закроет себя своим Esc
  if (searchQuery.get().trim().length > 0) {
    searchQuery.set("");
    (document.activeElement as HTMLElement | null)?.blur();
    return true;
  }
  if (selectedNode.get()) {
    dispatchCommand({ kind: "deselect" });
    return true;
  }
  if (appMode.get().kind === "scanning") {
    dispatchCommand({ kind: "cancel" });
    return true;
  }
  if (appMode.get().kind === "cleanup") {
    dispatchCommand({ kind: "exitCleanup" });
    return true;
  }
  return false;
}

/** Код клавиши как ФИЗИЧЕСКАЯ позиция (`event.code`) — независимо от раскладки,
 *  поэтому хоткеи одинаково работают на латинице и на кириллице (ЙЦУКЕН). */
function onKey(e: KeyboardEvent): void {
  const ctrl = e.ctrlKey || e.metaKey;
  const code = e.code;
  const isEnter = code === "Enter" || code === "NumpadEnter";

  if (code === "Escape") {
    handleEscape();
    return;
  }

  // ── Ctrl/Meta-комбинации (общепрограммные / опасные) ──────────────────────
  if (ctrl && !e.altKey) {
    switch (code) {
      case "KeyO": // Сканировать папку
        e.preventDefault();
        dispatchCommand({ kind: "scan" });
        return;
      case "KeyG": // Сканер мусора: вход/выход
        e.preventDefault();
        toggleCleanup();
        return;
      case "KeyF": // Фокус в поиск
        e.preventDefault();
        requestSearchFocus();
        return;
      case "Comma": // Настройки
        e.preventDefault();
        toggleSettings();
        return;
      case "KeyC": // Копировать путь активного узла (но не когда набираем текст)
        if (!isTyping()) {
          e.preventDefault();
          dispatchCommand({ kind: "nodeAction", action: "copyPath" });
        }
        return;
      default:
        if (isEnter) {
          // Ctrl+Enter — подтвердить снос (только в cleanup с пометками).
          if (appMode.get().kind === "cleanup" && markedCount.get() > 0) {
            e.preventDefault();
            setCleanupConfirm(true);
          }
        }
        return; // прочие Ctrl-комбо оставляем системе
    }
  }

  // Alt+← — на уровень вверх (единственная Alt-комбинация).
  if (e.altKey) {
    if (code === "ArrowLeft") {
      e.preventDefault();
      dispatchCommand({ kind: "up" });
    }
    return;
  }

  // ── Одиночные клавиши: только когда НЕ набираем текст ──────────────────────
  if (isTyping()) return;

  // Enter/Space на сфокусированной кнопке/ссылке — это её штатная активация, не
  // наш drill/свойства: не перехватываем (иначе ломаем клавиатурную навигацию UI).
  const ae = document.activeElement as HTMLElement | null;
  const onButton =
    !!ae &&
    (ae.tagName === "BUTTON" ||
      ae.tagName === "A" ||
      ae.getAttribute("role") === "button");
  if (onButton && (isEnter || code === "Space")) return;

  if (isEnter) {
    // Войти в наведённую папку.
    e.preventDefault();
    dispatchCommand({ kind: "nodeAction", action: "drill" });
    return;
  }

  switch (code) {
    case "Slash": // «/» — поиск; Shift+«/» = «?» — шпаргалка
      e.preventDefault();
      if (e.shiftKey) toggleHelp();
      else requestSearchFocus();
      return;
    case "F1": // Шпаргалка хоткеев
      e.preventDefault();
      toggleHelp();
      return;
    case "Backspace": // На уровень вверх
      e.preventDefault();
      dispatchCommand({ kind: "up" });
      return;
    case "Space": // Свойства (карточка наведённого)
      e.preventDefault();
      dispatchCommand({ kind: "nodeAction", action: "properties" });
      return;
    case "KeyR":
    case "Home": // Сбросить вид
      dispatchCommand({ kind: "reset" });
      return;
    case "KeyE": // Показать в проводнике
      dispatchCommand({ kind: "nodeAction", action: "reveal" });
      return;
    case "KeyL": // Легенда
      toggleLegend();
      return;
    case "KeyH": // Скрыть узел; Shift+H — панель скрытого (когда есть что вернуть)
      if (e.shiftKey) {
        if (hiddenPaths.get().length > 0) toggleHidden();
      } else {
        dispatchCommand({ kind: "nodeAction", action: "hide" });
      }
      return;
    case "KeyX": // Пометить/снять на снос — только в cleanup
      if (appMode.get().kind === "cleanup") {
        dispatchCommand({ kind: "nodeAction", action: "mark" });
      }
      return;
    case "Digit0":
    case "Numpad0": // Показывать «Мелочь» вкл/выкл
      showAggregate.set(!showAggregate.get());
      return;
  }

  // Цифры 1..8 (верхний ряд или numpad) — тумблеры категорий (порядок =
  // ALL_CATEGORIES / легенда §II.2). Матчим по коду → раскладка не важна.
  const digit =
    code.startsWith("Digit") || code.startsWith("Numpad")
      ? Number(code.slice(-1))
      : NaN;
  if (digit >= 1 && digit <= 8 && digit <= ALL_CATEGORIES.length) {
    toggleCategory(ALL_CATEGORIES[digit - 1]);
  }
}

/** Установить глобальный обработчик хоткеев. Возвращает функцию снятия. */
export function installHotkeys(): () => void {
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
