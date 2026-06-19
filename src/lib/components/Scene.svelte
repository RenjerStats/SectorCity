<script lang="ts">
  import { onMount } from "svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { Vector3 } from "three";
  import { createScene, type SceneHandle } from "../three/scene";
  import { buildCity } from "../three/city";
  import {
    setupInteraction,
    type InteractionController,
  } from "../three/interaction";
  import { CATEGORY_LABEL } from "../three/palette";
  import { formatSize, formatDate } from "../format";
  import {
    getLevel,
    startScan,
    cancelScan,
    currentRoot,
  } from "../ipc/commands";
  import {
    appMode,
    scanProgress,
    hoveredNode,
    breadcrumbs,
  } from "../store/mode";
  import type { ScanNode, ScanProgress } from "../ipc/contract";

  // Этот компонент — ЕДИНСТВЕННЫЙ владелец 3D-сцены. Он монтирует canvas,
  // держит жизненный цикл сцены и наполняет её данными из IPC. Связь с
  // остальным DOM — через стор; высокочастотную позицию тултипа пишем в DOM
  // императивно (в обход реактивности), контент тултипа — реактивно из стора.
  let canvas: HTMLCanvasElement;
  let handle: SceneHandle | undefined;
  let interaction: InteractionController | undefined;
  let tooltipEl = $state<HTMLDivElement | undefined>(undefined);

  /** Топ-N зданий на уровень; хвост бэк сворачивает в «Прочее». */
  const TOP_N = 50;
  /** Длительность зума камеры при drill (docs: ~500 мс). */
  const DRILL_MS = 500;

  /** Грубое форматирование байтов в ГБ для панели прогресса. */
  function formatGB(bytes: number): string {
    return `${(bytes / 1e9).toFixed(2)} ГБ`;
  }

  /** Имя уровня из пути для крошки (последний сегмент, или сам путь). */
  function crumbName(path: string): string {
    if (!path) return "Демо";
    const seg = path.split(/[/\\]/).filter(Boolean);
    return seg.length > 0 ? seg[seg.length - 1] : path;
  }

  /** Построить уровень `path` в сцене и сбросить наведение/обзор. */
  async function showLevel(path: string): Promise<void> {
    const nodes = await getLevel(path, TOP_N, 1);
    if (handle) buildCity(handle.content, nodes);
    interaction?.clearHover();
    handle?.resetView();
  }

  onMount(() => {
    handle = createScene(canvas);

    // Взаимодействие: наведение → стор (контент тултипа), клик по району → drill.
    interaction = setupInteraction(handle, {
      onHover: (node) => hoveredNode.set(node),
      onDrill: (node, center) => void drill(node, center),
    });

    // Позицию тултипа обновляем покадрово императивно (вне реконсиляции Svelte).
    const offFrame = handle.onFrame(() => {
      if (!tooltipEl || !handle || !interaction) return;
      const anchor = interaction.hoverAnchor();
      if (!anchor) return;
      const s = handle.worldToScreen(anchor);
      tooltipEl.style.transform = `translate(-50%, -100%) translate(${s.x}px, ${s.y}px)`;
      tooltipEl.style.opacity = s.visible ? "1" : "0";
    });

    // Стрим прогресса скана с бэка (троттлинг там же) → низкочастотный стор.
    let unlisten: UnlistenFn | undefined;
    listen<ScanProgress>("scan://progress", (e) => {
      scanProgress.set(e.payload);
      if (!e.payload.done) {
        appMode.set({ kind: "scanning", progress: 0 });
      }
    })
      .then((un) => (unlisten = un))
      .catch(() => {
        // Вне Tauri событий нет — ожидаемо в чистом vite.
      });

    // Старт: если есть снимок прошлого скана — поднимаем его без рескана,
    // иначе показываем мок верхнего уровня (корень "" → бэк отдаёт мок).
    appMode.set({ kind: "scanning", progress: 0 });
    currentRoot()
      .then(async (root) => {
        const target = root ?? "";
        await showLevel(target);
        breadcrumbs.set([{ path: target, name: crumbName(target) }]);
        appMode.set({ kind: "idle", path: target });
      })
      .catch((err) => {
        console.warn("стартовый уровень недоступен:", err);
        appMode.set({ kind: "idle", path: "" });
      });

    return () => {
      offFrame();
      unlisten?.();
      interaction?.dispose();
      handle?.dispose();
      handle = undefined;
    };
  });

  /** Выбрать папку → реальный скан со стримом прогресса → верхний уровень. */
  async function scanFolder() {
    const root = await open({ directory: true, multiple: false });
    if (typeof root !== "string") return; // отмена диалога

    appMode.set({ kind: "scanning", progress: 0 });
    scanProgress.set({
      entries: 0,
      bytes: 0,
      errors: 0,
      done: false,
      cancelled: false,
    });
    try {
      const completed = await startScan(root);
      if (completed) {
        await showLevel(root);
        breadcrumbs.set([{ path: root, name: crumbName(root) }]);
        appMode.set({ kind: "idle", path: root });
      } else {
        appMode.set({ kind: "idle", path: "" }); // отменён — прежний город остаётся
      }
    } catch (err) {
      console.error("скан не удался:", err);
      appMode.set({ kind: "idle", path: "" });
    } finally {
      scanProgress.set(null);
    }
  }

  /** Клик по району: зум камеры к нему, затем коммит нового уровня + крошка. */
  async function drill(node: ScanNode, center: Vector3) {
    if ($appMode.kind === "zooming" || !handle) return;
    const from = $appMode.kind === "idle" ? $appMode.path : "";
    appMode.set({ kind: "zooming", from, to: node.path });
    hoveredNode.set(null);

    // Зум камеры «внутрь» района (вид свернётся в новый город по прилёте).
    const camPos = new Vector3(center.x, 70, center.z + 90);
    await handle.flyTo(camPos, center, DRILL_MS);

    await showLevel(node.path);
    breadcrumbs.set([
      ...$breadcrumbs,
      { path: node.path, name: node.name || crumbName(node.path) },
    ]);
    appMode.set({ kind: "idle", path: node.path });
  }

  /** Перейти к крошке по индексу (срезает стек, перестраивает уровень). */
  async function goToCrumb(index: number) {
    if ($appMode.kind === "zooming") return;
    const crumb = $breadcrumbs[index];
    if (!crumb || index === $breadcrumbs.length - 1) return;
    appMode.set({ kind: "zooming", from: "", to: crumb.path });
    hoveredNode.set(null);
    await showLevel(crumb.path);
    breadcrumbs.set($breadcrumbs.slice(0, index + 1));
    appMode.set({ kind: "idle", path: crumb.path });
  }

  function cancel() {
    void cancelScan();
  }
  function resetView() {
    handle?.resetView();
  }

  let busy = $derived($appMode.kind === "scanning");
  let zooming = $derived($appMode.kind === "zooming");
  let progress = $derived($scanProgress);
  let hovered = $derived($hoveredNode);
  let crumbs = $derived($breadcrumbs);
</script>

<div class="scene">
  <canvas bind:this={canvas}></canvas>

  <div class="controls">
    {#if busy}
      <button onclick={cancel}>Отменить скан</button>
    {:else}
      <button onclick={scanFolder}>Сканировать папку</button>
    {/if}
    <button onclick={resetView}>Сбросить вид</button>
  </div>

  {#if crumbs.length > 0 && !busy}
    <nav class="crumbs" aria-label="Навигация по уровням">
      {#each crumbs as crumb, i (crumb.path)}
        {#if i > 0}<span class="sep">›</span>{/if}
        <button
          class="crumb"
          class:current={i === crumbs.length - 1}
          disabled={i === crumbs.length - 1 || zooming}
          onclick={() => goToCrumb(i)}
        >
          {crumb.name}
        </button>
      {/each}
    </nav>
  {/if}

  {#if busy && progress && !progress.done}
    <div class="progress">
      Сканирую: {progress.entries.toLocaleString("ru")} объектов · {formatGB(
        progress.bytes,
      )}
      {#if progress.errors > 0}· пропущено {progress.errors}{/if}
    </div>
  {/if}

  {#if hovered}
    <div class="tooltip" bind:this={tooltipEl}>
      <strong class="name">{hovered.name}</strong>
      <div class="row">
        <span class="size">{formatSize(hovered.size)}</span>
        <span class="cat">{CATEGORY_LABEL[hovered.category]}</span>
      </div>
      <div class="muted">изменён {formatDate(hovered.mtime)}</div>
      {#if hovered.isDir}
        <div class="muted">
          {hovered.childCount.toLocaleString("ru")} элементов
        </div>
      {/if}
      <div class="path">{hovered.path}</div>
    </div>
  {/if}
</div>

<style>
  .scene {
    position: absolute;
    inset: 0;
    z-index: 0;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  .controls {
    position: absolute;
    top: 1rem;
    right: 1rem;
    display: flex;
    gap: 0.5rem;
  }
  .controls button {
    padding: 0.4rem 0.8rem;
    font: inherit;
    color: var(--fg, #e6e6e6);
    background: rgba(30, 32, 38, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 0.4rem;
    cursor: pointer;
  }
  .controls button:hover:not(:disabled) {
    background: rgba(45, 48, 56, 0.95);
  }
  .controls button:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .crumbs {
    position: absolute;
    top: 1rem;
    left: 1rem;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    max-width: 70vw;
    flex-wrap: wrap;
    padding: 0.35rem 0.6rem;
    background: rgba(30, 32, 38, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 0.4rem;
  }
  .crumb {
    font: inherit;
    font-size: 0.85rem;
    color: var(--accent, #4f9dff);
    background: none;
    border: none;
    padding: 0.1rem 0.2rem;
    cursor: pointer;
  }
  .crumb.current {
    color: var(--fg, #e6e6e6);
    cursor: default;
  }
  .crumb:disabled {
    cursor: default;
  }
  .crumb:not(:disabled):hover {
    text-decoration: underline;
  }
  .sep {
    color: var(--muted, #8b929c);
    font-size: 0.85rem;
  }

  .progress {
    position: absolute;
    left: 50%;
    bottom: 1.5rem;
    transform: translateX(-50%);
    padding: 0.5rem 1rem;
    font-size: 0.9rem;
    color: var(--fg, #e6e6e6);
    background: rgba(30, 32, 38, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 0.4rem;
    white-space: nowrap;
  }

  .tooltip {
    position: absolute;
    top: 0;
    left: 0;
    /* Позиция и видимость ставятся императивно (см. onFrame); до первого
       кадра прячем, чтобы не мигнуть в углу. */
    opacity: 0;
    pointer-events: none;
    min-width: 12rem;
    max-width: 22rem;
    padding: 0.5rem 0.7rem;
    background: rgba(20, 22, 27, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 0.4rem;
    font-size: 0.85rem;
    line-height: 1.35;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
    transition: opacity 0.1s;
  }
  .tooltip .name {
    display: block;
    word-break: break-all;
  }
  .tooltip .row {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    margin-top: 0.15rem;
  }
  .tooltip .cat {
    color: var(--muted, #8b929c);
  }
  .tooltip .muted {
    color: var(--muted, #8b929c);
  }
  .tooltip .path {
    margin-top: 0.25rem;
    color: var(--muted, #8b929c);
    font-size: 0.75rem;
    word-break: break-all;
  }
</style>
