<script lang="ts">
  /**
   * Дефолтный контент footer на время первичной разметки диска (режим
   * `scanning`). Total заранее неизвестен → полоса индетерминантная (бегущая
   * штриховка), а правда — в счётчике (объекты · ГБ · пропущено).
   */
  import type { ScanProgress } from "../../ipc/contract";

  let { progress }: { progress: ScanProgress | null } = $props();

  function gb(bytes: number): string {
    return (bytes / 1e9).toFixed(2);
  }
</script>

<div class="map">
  <span class="label">РАЗМЕТКА ДИСКА</span>
  <div class="bar" role="progressbar" aria-label="Идёт разметка диска">
    <div class="stripe"></div>
  </div>
  <span class="stats">
    {#if progress}
      {progress.entries.toLocaleString("ru")} объектов · {gb(progress.bytes)} ГБ{#if progress.errors > 0}
        · пропущено {progress.errors}{/if}
    {:else}
      инициализация…
    {/if}
  </span>
</div>

<style>
  .map {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
  }
  .label {
    font-family: var(--font-label);
    letter-spacing: var(--track-caps);
    color: var(--text-2);
    white-space: nowrap;
  }
  .bar {
    position: relative;
    flex: 1 1 auto;
    height: 6px;
    min-width: 4rem;
    border-radius: var(--r-pill);
    background: var(--surface-2);
    overflow: hidden;
  }
  .stripe {
    position: absolute;
    inset: 0;
    width: 40%;
    border-radius: var(--r-pill);
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    animation: slide 1.2s var(--ease-in-out) infinite;
  }
  @keyframes slide {
    0% {
      transform: translateX(-110%);
    }
    100% {
      transform: translateX(310%);
    }
  }
  .stats {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--text-2);
    white-space: nowrap;
  }
</style>
