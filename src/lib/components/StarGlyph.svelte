<script lang="ts">
  /**
   * Глиф-«полярная звезда» из точек — бренд-марка в dot-стилистике: компас в
   * углу сцены, прелоадер (пульсация точек) и пустые
   * состояния StatusOverlay. Северный луч акцентирован (`--accent`) — у карты
   * есть постоянный север (раскладка детерминирована).
   */
  let {
    size = 28,
    pulse = false,
  }: {
    /** Размер в px (квадрат). */
    size?: number;
    /** Пульсация точек (прелоадер «сканирую…/загружаю…»). */
    pulse?: boolean;
  } = $props();

  /** Точки глифа (x, y, r) в поле 24×24. Индекс 1 — вершина северного луча. */
  const DOTS: [number, number, number][] = [
    [12, 12, 1.7], // центр
    [12, 2.4, 1.5], // север (акцент)
    [12, 5.4, 1.1],
    [12, 8.4, 0.9],
    [12, 15.6, 0.9],
    [12, 18.6, 1.1],
    [12, 21.6, 1.2],
    [2.4, 12, 1.2],
    [5.4, 12, 1.1],
    [8.4, 12, 0.9],
    [15.6, 12, 0.9],
    [18.6, 12, 1.1],
    [21.6, 12, 1.2],
    [8.2, 8.2, 0.8],
    [15.8, 8.2, 0.8],
    [8.2, 15.8, 0.8],
    [15.8, 15.8, 0.8],
  ];
</script>

<svg
  class="star"
  class:pulse
  viewBox="0 0 24 24"
  width={size}
  height={size}
  aria-hidden="true"
>
  {#each DOTS as [x, y, r], i (i)}
    <circle cx={x} cy={y} {r} class:north={i === 1} style="--i:{i}" />
  {/each}
</svg>

<style>
  .star {
    display: block;
    color: var(--text-2);
    flex-shrink: 0;
  }
  circle {
    fill: currentColor;
  }
  .north {
    fill: var(--accent);
  }
  /* Пульсация точек со ступенчатой задержкой — «живой» прелоадер из точек. */
  .pulse circle {
    animation: dot-pulse 1.6s var(--ease-out, ease-in-out) infinite;
    animation-delay: calc(var(--i) * 70ms);
  }
  @keyframes dot-pulse {
    0%,
    100% {
      opacity: 0.3;
    }
    50% {
      opacity: 1;
    }
  }
</style>
