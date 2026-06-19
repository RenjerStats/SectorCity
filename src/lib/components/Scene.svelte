<script lang="ts">
  import { onMount } from "svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import { createScene, type SceneHandle } from "../three/scene";
  import { buildCity } from "../three/city";
  import { getLevel, startScan } from "../ipc/commands";
  import { appMode } from "../store/mode";

  // Этот компонент — ЕДИНСТВЕННЫЙ владелец 3D-сцены. Он монтирует canvas,
  // держит жизненный цикл сцены и наполняет её данными из IPC. Связь с
  // остальным DOM — через стор; сюда же он сам и пишет режим.
  let canvas: HTMLCanvasElement;
  let handle: SceneHandle | undefined;

  /** Топ-N зданий на уровень; хвост бэк сворачивает в «Прочее». */
  const TOP_N = 50;

  onMount(() => {
    handle = createScene(canvas);

    // Сквозной поток фазы 0: тянем мок-уровень из Rust и строим из него
    // боксы (не из хардкода). Корень пустой → бэк отдаёт мок верхнего уровня.
    appMode.set({ kind: "scanning", progress: 0 });
    getLevel("", TOP_N, 1)
      .then((nodes) => {
        if (handle) buildCity(handle.content, nodes);
        appMode.set({ kind: "idle", path: "" });
      })
      .catch((err) => {
        // Вне Tauri (чистый `vite`) invoke недоступен — это ожидаемо.
        console.warn("get_level недоступен:", err);
        appMode.set({ kind: "idle", path: "" });
      });

    return () => {
      handle?.dispose();
      handle = undefined;
    };
  });

  /** Выбрать папку → реальный скан → отрисовать её верхний уровень. */
  async function scanFolder() {
    const root = await open({ directory: true, multiple: false });
    if (typeof root !== "string") return; // отмена диалога

    // Прогресс пока бинарный (0→готово): стрим событий — следующий кусок.
    appMode.set({ kind: "scanning", progress: 0 });
    try {
      await startScan(root);
      const nodes = await getLevel(root, TOP_N, 1);
      if (handle) buildCity(handle.content, nodes);
      handle?.resetView();
      appMode.set({ kind: "idle", path: root });
    } catch (err) {
      console.error("скан не удался:", err);
      appMode.set({ kind: "idle", path: "" });
    }
  }

  function resetView() {
    handle?.resetView();
  }

  let busy = $derived($appMode.kind === "scanning");
</script>

<div class="scene">
  <canvas bind:this={canvas}></canvas>
  <div class="controls">
    <button onclick={scanFolder} disabled={busy}>
      {busy ? "Сканирую…" : "Сканировать папку"}
    </button>
    <button onclick={resetView}>Сбросить вид</button>
  </div>
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
</style>
