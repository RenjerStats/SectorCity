<script lang="ts">
  import { onMount } from "svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { createScene, type SceneHandle } from "../three/scene";
  import { buildCity } from "../three/city";
  import {
    getLevel,
    startScan,
    cancelScan,
    currentRoot,
  } from "../ipc/commands";
  import { appMode, scanProgress } from "../store/mode";
  import type { ScanProgress } from "../ipc/contract";

  // Этот компонент — ЕДИНСТВЕННЫЙ владелец 3D-сцены. Он монтирует canvas,
  // держит жизненный цикл сцены и наполняет её данными из IPC. Связь с
  // остальным DOM — через стор; сюда же он сам и пишет режим.
  let canvas: HTMLCanvasElement;
  let handle: SceneHandle | undefined;

  /** Топ-N зданий на уровень; хвост бэк сворачивает в «Прочее». */
  const TOP_N = 50;

  /** Грубое форматирование байтов в ГБ для панели прогресса. */
  function formatGB(bytes: number): string {
    return `${(bytes / 1e9).toFixed(2)} ГБ`;
  }

  onMount(() => {
    handle = createScene(canvas);

    // Стрим прогресса скана с бэка (троттлинг там же) → низкочастотный стор.
    let unlisten: UnlistenFn | undefined;
    listen<ScanProgress>("scan://progress", (e) => {
      scanProgress.set(e.payload);
      // Грубый флаг режима держим в актуальном «идёт скан» состоянии.
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
        const nodes = await getLevel(target, TOP_N, 1);
        if (handle) buildCity(handle.content, nodes);
        handle?.resetView();
        appMode.set({ kind: "idle", path: target });
      })
      .catch((err) => {
        // Вне Tauri (чистый `vite`) invoke недоступен — это ожидаемо.
        console.warn("стартовый уровень недоступен:", err);
        appMode.set({ kind: "idle", path: "" });
      });

    return () => {
      unlisten?.();
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
        const nodes = await getLevel(root, TOP_N, 1);
        if (handle) buildCity(handle.content, nodes);
        handle?.resetView();
        appMode.set({ kind: "idle", path: root });
      } else {
        // Отменён — оставляем прежний город, выходим из режима скана.
        appMode.set({ kind: "idle", path: "" });
      }
    } catch (err) {
      console.error("скан не удался:", err);
      appMode.set({ kind: "idle", path: "" });
    } finally {
      scanProgress.set(null);
    }
  }

  function cancel() {
    void cancelScan();
  }

  function resetView() {
    handle?.resetView();
  }

  let busy = $derived($appMode.kind === "scanning");
  let progress = $derived($scanProgress);
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
  {#if busy && progress && !progress.done}
    <div class="progress">
      Сканирую: {progress.entries.toLocaleString("ru")} объектов · {formatGB(
        progress.bytes,
      )}
      {#if progress.errors > 0}· пропущено {progress.errors}{/if}
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
</style>
