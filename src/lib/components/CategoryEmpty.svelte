<script lang="ts">
  /**
   * Плашка «Нет файлов выбранных категорий на этом уровне».
   * Показывается по центру сцены, когда применен фильтр категорий
   * и в текущем уровне не осталось подходящих узлов для показа.
   */
  import { categoryFilterEmpty, resetCategories } from "../store/mode";

  let empty = $derived($categoryFilterEmpty);
</script>

{#if empty}
  <div class="empty-container">
    <div class="empty-card">
      <h2 class="title">Категории скрыты</h2>
      <p class="description">
        На текущем уровне нет файлов выбранных категорий.
      </p>
      <button class="action-btn" onclick={resetCategories}>Показать все</button>
    </div>
  </div>
{/if}

<style>
  .empty-container {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    padding: 2rem;
  }
  .empty-card {
    pointer-events: auto;
    width: 100%;
    max-width: 320px;
    background: var(--overlay);
    backdrop-filter: blur(var(--blur));
    -webkit-backdrop-filter: blur(var(--blur));
    border: 1px solid var(--border);
    border-radius: var(--r-card);
    padding: 1.5rem;
    box-shadow: var(--elev-2);
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.85rem;
    animation: fadeIn var(--motion-base) var(--ease-out);
  }
  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(6px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  .title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 1.25rem;
    letter-spacing: var(--track-caps);
    color: var(--text);
  }
  .description {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.4;
    color: var(--text-2);
  }
  .action-btn {
    font-family: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--accent-fg);
    background: var(--accent);
    border: none;
    border-radius: var(--r-pill);
    padding: 0.4rem 1rem;
    cursor: pointer;
    transition:
      background var(--motion-micro) var(--ease-out),
      transform var(--motion-micro) var(--ease-out);
  }
  .action-btn:hover {
    background: var(--accent-hover);
  }
  .action-btn:active {
    transform: scale(0.98);
  }
</style>
