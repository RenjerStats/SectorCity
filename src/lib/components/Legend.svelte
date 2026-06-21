<script lang="ts">
  /**
   * Легенда кодирования (высота=устаревание, цвет=категория). Переехала в footer
   * (docs/SectorCity-vision.md, Приложение B) — горизонтальная компактная форма.
   * Презентационный компонент: читает только палитру.
   */
  import { CATEGORY_COLOR, CATEGORY_LABEL } from "../three/palette";
  import type { Category } from "../ipc/contract";

  const ORDER: Category[] = [
    "code",
    "document",
    "image",
    "video",
    "audio",
    "archive",
    "binary",
    "other",
  ];

  function hex(value: number): string {
    return "#" + value.toString(16).padStart(6, "0");
  }
</script>

<div class="legend">
  <div class="grp">
    <span class="cap">ВЫСОТА</span>
    <div class="hscale" aria-hidden="true">
      <span style="height:4px"></span>
      <span style="height:7px"></span>
      <span style="height:10px"></span>
      <span style="height:13px"></span>
      <span style="height:16px"></span>
    </div>
    <span class="hint">устаревание</span>
  </div>

  <span class="vsep"></span>

  <div class="grp cats">
    <span class="cap">КАТЕГОРИИ</span>
    {#each ORDER as cat (cat)}
      <span class="cat" title={CATEGORY_LABEL[cat]}>
        <span class="dot" style="background:{hex(CATEGORY_COLOR[cat])}"></span>
        <span class="name">{CATEGORY_LABEL[cat]}</span>
      </span>
    {/each}
  </div>
</div>

<style>
  .legend {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-width: 0;
    overflow: hidden;
    flex: 0 1 auto;
  }
  .grp {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }
  .cats {
    overflow: hidden;
  }
  .cap {
    font-family: var(--font-label);
    font-size: 0.62rem;
    letter-spacing: var(--track-caps);
    color: var(--text-muted);
    white-space: nowrap;
  }
  .hint {
    font-size: 0.68rem;
    color: var(--text-muted);
    white-space: nowrap;
  }
  /* Мини-шкала высоты: монохромные «дома» по нарастающей (высота = устаревание). */
  .hscale {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 16px;
  }
  .hscale span {
    width: 4px;
    border-radius: 1px 1px 0 0;
    background: linear-gradient(to top, var(--text-muted), var(--text-2));
  }
  .vsep {
    width: 1px;
    height: 16px;
    background: var(--hairline);
    flex-shrink: 0;
  }
  .cat {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .name {
    font-size: 0.68rem;
    color: var(--text-2);
  }
</style>
