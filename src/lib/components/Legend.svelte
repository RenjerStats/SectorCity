<script lang="ts">
  import { CATEGORY_COLOR, CATEGORY_LABEL } from "../three/palette";
  import type { Category } from "../ipc/contract";

  const CATEGORY_ORDER: Category[] = [
    "code",
    "document",
    "image",
    "video",
    "audio",
    "archive",
    "binary",
    "other",
  ];

  function formatColor(value: number): string {
    return "#" + value.toString(16).padStart(6, "0");
  }
</script>

<div class="legend-panel">
  <div class="legend-section">
    <div class="legend-title">Высота — устаревание</div>
    <div class="height-scale">
      <div class="height-bars">
        <div class="height-bar" style="height: 6px;"></div>
        <div class="height-bar" style="height: 12px;"></div>
        <div class="height-bar" style="height: 18px;"></div>
        <div class="height-bar" style="height: 24px;"></div>
        <div class="height-bar" style="height: 30px;"></div>
      </div>
      <div class="scale-labels">
        <span class="scale-label">недавно изменён</span>
        <span class="scale-label">давно не менялся</span>
      </div>
    </div>
  </div>

  <div class="legend-divider"></div>

  <div class="legend-section">
    <div class="legend-title">Цвет — категория</div>
    <div class="categories-grid">
      {#each CATEGORY_ORDER as cat}
        <div class="category-item">
          <span
            class="swatch"
            style="background-color: {formatColor(CATEGORY_COLOR[cat])}"
          ></span>
          <span class="category-name">{CATEGORY_LABEL[cat]}</span>
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .legend-panel {
    position: absolute;
    right: 1rem;
    bottom: 1rem;
    z-index: 10;
    pointer-events: none;
    width: 220px;
    background: rgba(14, 15, 19, 0.85);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 0.5rem;
    padding: 0.75rem 1rem;
    font-family: inherit;
    font-size: 0.8rem;
    color: var(--fg, #e6e8eb);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .legend-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .legend-title {
    font-weight: 600;
    color: var(--fg, #e6e8eb);
    opacity: 0.9;
    font-size: 0.8rem;
    letter-spacing: 0.02em;
  }

  .height-scale {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .height-bars {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    height: 32px;
    padding: 0 4px;
  }

  .height-bar {
    width: 15%;
    background: linear-gradient(
      to top,
      rgba(79, 157, 255, 0.2),
      rgba(79, 157, 255, 0.8)
    );
    border-radius: 1px;
    border-top: 1px solid rgba(79, 157, 255, 0.9);
  }

  .scale-labels {
    display: flex;
    justify-content: space-between;
    font-size: 0.7rem;
    color: var(--muted, #8b929c);
    line-height: 1.2;
  }

  .scale-label {
    max-width: 48%;
    white-space: normal;
  }

  .scale-label:last-child {
    text-align: right;
  }

  .legend-divider {
    height: 1px;
    background: rgba(255, 255, 255, 0.08);
  }

  .categories-grid {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .category-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
    box-shadow: 0 0 2px rgba(0, 0, 0, 0.5);
  }

  .category-name {
    color: var(--fg, #e6e8eb);
    opacity: 0.85;
    font-size: 0.75rem;
  }
</style>
