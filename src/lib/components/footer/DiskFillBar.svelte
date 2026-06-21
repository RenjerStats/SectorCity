<script lang="ts">
  /**
   * Дефолтный контент footer в обычном режиме: сегментная полоса «заполнения»
   * текущего уровня по категориям + итог и путь. Цвета сегментов = цвета
   * категорий из палитры (тот же канал, что и крыши/легенда).
   *
   * Это пример того, что footer — не только текст: компактная инфографика «из
   * чего состоит уровень». Данные берёт из стора `levelSummary` (пишет Scene).
   */
  import type { Category } from "../../ipc/contract";
  import type { LevelSummary } from "../../store/ui";
  import { CATEGORY_COLOR, CATEGORY_LABEL } from "../../three/palette";

  let { summary }: { summary: LevelSummary | null } = $props();

  function hex(n: number): string {
    return "#" + n.toString(16).padStart(6, "0");
  }
  function gb(bytes: number): string {
    return (bytes / 1e9).toFixed(1);
  }

  /** Сегменты в порядке убывания доли; пустые категории отброшены. */
  let segments = $derived.by(() => {
    if (!summary || summary.totalBytes <= 0) return [];
    const entries = Object.entries(summary.byCategory) as [Category, number][];
    return entries
      .filter(([, bytes]) => bytes > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, bytes]) => ({
        cat,
        pct: (bytes / summary.totalBytes) * 100,
        color: hex(CATEGORY_COLOR[cat]),
        label: CATEGORY_LABEL[cat],
        gb: gb(bytes),
      }));
  });
</script>

<div class="fill">
  {#if summary && summary.totalBytes > 0}
    <span class="total">{gb(summary.totalBytes)} ГБ</span>
    <div class="bar" aria-label="Заполнение уровня по категориям">
      {#each segments as s (s.cat)}
        <div
          class="seg"
          style="width:{s.pct}%; background:{s.color}"
          title="{s.label}: {s.gb} ГБ ({s.pct.toFixed(0)}%)"
        ></div>
      {/each}
    </div>
    <span class="path" title={summary.path}>{summary.path || "—"}</span>
  {:else}
    <span class="empty">Нет данных уровня</span>
  {/if}
</div>

<style>
  .fill {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
  }
  .total {
    font-family: var(--font-label);
    letter-spacing: 0.04em;
    color: var(--text);
    white-space: nowrap;
  }
  .bar {
    display: flex;
    flex: 1 1 auto;
    min-width: 4rem;
    height: 8px;
    border-radius: var(--r-pill);
    overflow: hidden;
    background: var(--surface-2);
  }
  .seg {
    height: 100%;
    min-width: 1px;
  }
  .seg + .seg {
    border-left: 1px solid var(--bg);
  }
  .path {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 28vw;
    direction: rtl; /* при обрезке прячем НАЧАЛО пути, хвост виден */
    text-align: left;
  }
  .empty {
    color: var(--text-muted);
  }
</style>
