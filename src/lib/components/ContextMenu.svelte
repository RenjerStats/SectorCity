<script lang="ts">
  /**
   * Контекстное меню ПКМ — единый носитель действий над узлом.
   * DOM-оверлей поверх 3D; данные (узел + позиция) приходят пропом из Scene
   * (через колбэк `onContext` слоя взаимодействия), действия — колбэками туда же.
   * Прямой связи raycaster ↔ DOM нет: Scene — посредник.
   *
   * Семантика разделена с ЛКМ: левая кнопка = drill/карточка (в режиме сканера
   * пометка — Ctrl+ЛКМ), правая = это меню. Для системных (`locked`) узлов
   * снос/пометка — disabled с
   * подписью-замком. У синтетического блока «Мелочь» (`aggregated`) реального пути
   * нет → доступны только «Открыть» и «Свойства».
   */
  import type { ScanNode } from "../ipc/contract";
  import Icon from "./Icon.svelte";

  interface Menu {
    node: ScanNode;
    drillTarget: ScanNode;
    x: number;
    y: number;
  }
  interface Props {
    menu: Menu;
    cleanup: boolean;
    marked: boolean;
    onOpen: (node: ScanNode) => void;
    onReveal: (path: string) => void;
    onCopyPath: (path: string) => void;
    onHide: (path: string) => void;
    onProperties: () => void;
    onMark: (node: ScanNode) => void;
    onClose: () => void;
  }
  let {
    menu,
    cleanup,
    marked,
    onOpen,
    onReveal,
    onCopyPath,
    onHide,
    onProperties,
    onMark,
    onClose,
  }: Props = $props();

  const node = $derived(menu.node);
  const target = $derived(menu.drillTarget);
  const isAgg = $derived(node.flags.includes("aggregated"));
  const isLocked = $derived(node.flags.includes("locked"));
  // Реальный путь ФС есть у всего, кроме синтетического блока «Мелочь».
  const hasRealPath = $derived(!isAgg);
  // «Открыть район» — когда цель-drill это папка/«Мелочь» (навигируемый контейнер).
  const canOpen = $derived(target.isDir || target.flags.includes("aggregated"));

  // Позиция: клампим к окну по измеренному размеру меню (не вылезает за край).
  let el = $state<HTMLDivElement | undefined>(undefined);
  let mw = $state(0);
  let mh = $state(0);
  const left = $derived(
    Math.max(8, Math.min(menu.x, window.innerWidth - mw - 8)),
  );
  const top = $derived(
    Math.max(8, Math.min(menu.y, window.innerHeight - mh - 8)),
  );

  /** Закрытие: Esc, прокрутка/ресайз, ЛКМ-«мимо» (ПКМ репозиционирует меню через
   *  Scene, поэтому правую кнопку в этом слушателе игнорируем). */
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }
  function onOutside(e: PointerEvent) {
    if (e.button === 2) return; // ПКМ → новое меню (Scene), не закрывать здесь
    if (el && e.target instanceof Node && el.contains(e.target)) return;
    onClose();
  }
  $effect(() => {
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onOutside, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("wheel", onClose);
    };
  });

  function act(fn: () => void) {
    fn();
    onClose();
  }
</script>

<div
  class="menu"
  role="menu"
  tabindex="-1"
  bind:this={el}
  bind:clientWidth={mw}
  bind:clientHeight={mh}
  style="left:{left}px; top:{top}px"
>
  <div class="title" title={node.path}>{node.name || node.path}</div>
  <div class="sep"></div>

  {#if canOpen}
    <button
      class="item"
      role="menuitem"
      onclick={() => act(() => onOpen(target))}
    >
      Открыть район
    </button>
  {/if}

  <button class="item" role="menuitem" onclick={() => act(onProperties)}>
    Свойства
  </button>

  {#if hasRealPath}
    <button
      class="item"
      role="menuitem"
      onclick={() => act(() => onReveal(node.path))}
    >
      Показать в проводнике
    </button>
    <button
      class="item"
      role="menuitem"
      onclick={() => act(() => onCopyPath(node.path))}
    >
      Копировать путь
    </button>
    <button
      class="item"
      role="menuitem"
      onclick={() => act(() => onHide(node.path))}
    >
      Скрыть
    </button>
  {/if}

  {#if cleanup && hasRealPath}
    <div class="sep"></div>
    {#if isLocked}
      <!-- Линейный SVG-замок вместо эмодзи: эмодзи цветной, выбивается из монохрома. -->
      <div class="item locked" role="menuitem" aria-disabled="true">
        <span class="lock"><Icon name="lock" size={13} /></span>
        Системный — снос заблокирован
      </div>
    {:else}
      <button
        class="item danger"
        role="menuitem"
        onclick={() => act(() => onMark(node))}
      >
        {marked ? "Снять метку сноса" : "Пометить на снос"}
      </button>
    {/if}
  {/if}
</div>

<style>
  .menu {
    position: fixed;
    z-index: 50;
    min-width: 200px;
    max-width: 320px;
    padding: var(--sp-1);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--elev-2);
    backdrop-filter: blur(var(--blur));
    font-size: 0.8125rem;
    color: var(--text);
    user-select: none;
  }
  .title {
    padding: var(--sp-1) var(--sp-2);
    color: var(--text-2);
    font-size: 0.75rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sep {
    height: 1px;
    margin: var(--sp-1) 0;
    background: var(--hairline);
  }
  .item {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    width: 100%;
    padding: var(--sp-2) var(--sp-2);
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  button.item:hover {
    background: var(--accent-soft);
  }
  .item.danger {
    color: var(--accent);
  }
  .item.locked {
    color: var(--text-muted);
    cursor: default;
  }
  .lock {
    display: inline-flex;
    align-items: center;
    margin-right: 0.35rem;
  }
</style>
