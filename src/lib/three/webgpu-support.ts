/**
 * Пробинг доступности WebGPU (для экспериментального уровня графики).
 *
 * Зачем отдельно от рендера: смена уровня на «экспериментальный» требует РЕМОУНТА
 * сцены на `WebGPURenderer` (нельзя переключить бэкенд на живом canvas), а его
 * инициализация асинхронна и может провалиться (WebGPU выключен во WebView2, нет
 * адаптера, софт-рендер). Поэтому ДО попытки пересоздать сцену спрашиваем движок:
 * есть ли `navigator.gpu` и отдаёт ли он адаптер. При провале UI откатывается на
 * `maximal` и показывает причину — без чёрного экрана.
 *
 * `navigator.gpu` типизируем локально (пакет `@webgpu/types` не установлен, тянуть
 * его ради пробы адаптера незачем).
 */

/** Минимальная форма WebGPU API, которой нам достаточно для пробы. */
interface MinimalGpuAdapterInfo {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}
interface MinimalGpuAdapter {
  readonly info?: MinimalGpuAdapterInfo;
  requestAdapterInfo?: () => Promise<MinimalGpuAdapterInfo>;
}
interface MinimalGpu {
  requestAdapter: (opts?: {
    powerPreference?: "low-power" | "high-performance";
  }) => Promise<MinimalGpuAdapter | null>;
}

function getGpu(): MinimalGpu | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { gpu?: MinimalGpu }).gpu;
}

/** Быстрая синхронная проверка: присутствует ли WebGPU в среде вообще. Годится
 *  для гейта в настройках (показывать ли пункт), не для решения «рендерить». */
export function webGpuPresent(): boolean {
  return getGpu() !== undefined;
}

/** Результат пробинга WebGPU. */
export interface WebGpuCapability {
  /** Можно ли пытаться поднять `WebGPURenderer`. */
  supported: boolean;
  /** Человекочитаемая причина недоступности (для тоста/лога), если `!supported`. */
  reason?: string;
  /** Имя адаптера (GPU), если удалось получить, — диагностика iGPU/dGPU. */
  adapterName?: string;
}

/** Собрать имя адаптера из полей `info` (какие есть — тем и ограничимся). */
function adapterLabel(
  info: MinimalGpuAdapterInfo | undefined,
): string | undefined {
  if (!info) return undefined;
  const parts = [info.vendor, info.architecture, info.device, info.description]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s);
  return parts.length ? Array.from(new Set(parts)).join(" · ") : undefined;
}

/**
 * Асинхронно проверить WebGPU: наличие `navigator.gpu` + реальный адаптер.
 * `high-performance` просит дискретную GPU (на ноутбуках с переключаемой графикой);
 * получить адаптер, впрочем, — ещё не гарантия, что WebView2 отдаст именно dGPU,
 * но имя адаптера это покажет.
 */
export async function probeWebGpu(): Promise<WebGpuCapability> {
  const gpu = getGpu();
  if (!gpu) {
    return {
      supported: false,
      reason:
        "navigator.gpu отсутствует — WebGPU не включён во WebView2 (нужны флаги) или недоступен в среде",
    };
  }
  try {
    const adapter = await gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) {
      return {
        supported: false,
        reason: "requestAdapter вернул null — нет доступного GPU-адаптера",
      };
    }
    let info = adapter.info;
    if (!info && adapter.requestAdapterInfo) {
      try {
        info = await adapter.requestAdapterInfo();
      } catch {
        /* info необязателен */
      }
    }
    return { supported: true, adapterName: adapterLabel(info) };
  } catch (err) {
    return {
      supported: false,
      reason: `requestAdapter упал: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
