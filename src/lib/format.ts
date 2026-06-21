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

/**
 * Те же части размера по отдельности: число и единица. Раньше нужно было для
 * разнесения по шрифтам (в латинском «Nothing» не было кириллицы для «ГБ»);
 * теперь dot-шрифт Ndot77 покрывает кириллицу, но раздельные части всё ещё
 * удобны, если число и единицу нужно стилизовать по-разному.
 */
export function formatSizeParts(bytes: number): { value: string; unit: string } {
  const s = formatSize(bytes);
  const i = s.lastIndexOf(" ");
  return i === -1
    ? { value: s, unit: "" }
    : { value: s.slice(0, i), unit: s.slice(i + 1) };
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
