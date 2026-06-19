/** Форматирование величин для UI (тултип, панель прогресса, легенды). */

/** Человекочитаемый размер в байтах: Б/КБ/МБ/ГБ/ТБ (двоичные степени 1024). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const units = ["КБ", "МБ", "ГБ", "ТБ", "ПБ"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

/** Дата из unix-секунд в локальном формате (ru); 0/невалидное → прочерк. */
export function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleDateString("ru", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
