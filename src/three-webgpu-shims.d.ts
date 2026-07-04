/**
 * Ambient-типы для WebGPU/TSL-веток three r184.
 *
 * Причина: three НЕ поставляет `.d.ts` для сборок `three/webgpu` и `three/tsl`
 * (см. `build/three.webgpu.js` — чистый JS), а `@types/three` покрывает только
 * основной модуль `three`. Без этих деклараций `svelte-check`/`tsc` не находят
 * модули (экспериментальный рендер + спайк не собираются).
 *
 * Объявляем ПОДМНОЖЕСТВО API, которое реально используем. TSL-графы принципиально
 * динамические (ноды перегружают операторы) — их типизируем как `TSLNode`
 * (структурный `any` с цепочечными методами), это честнее «строгой лжи». Ядро
 * (`Scene`, `Camera` и т.п.) берём из настоящих типов `three` через `export *`.
 */

declare module "three/webgpu" {
  export * from "three";
  import type { Scene, Camera, Texture } from "three";
  import { MeshBasicMaterial, MeshStandardMaterial } from "three";
  import type { TSLNode } from "three/tsl";

  export interface WebGPURendererParameters {
    canvas?: HTMLCanvasElement;
    antialias?: boolean;
    /** Форсировать WebGL2-фолбэк (диагностика/сравнение). */
    forceWebGL?: boolean;
    powerPreference?: "low-power" | "high-performance";
    alpha?: boolean;
  }

  /** Бэкенд рендера: у WebGPU-пути выставлен `isWebGPUBackend`. */
  export interface RendererBackend {
    isWebGPUBackend?: boolean;
    isWebGLBackend?: boolean;
  }

  export class WebGPURenderer {
    constructor(parameters?: WebGPURendererParameters);
    readonly domElement: HTMLCanvasElement;
    readonly backend: RendererBackend;
    readonly isWebGPURenderer: boolean;
    toneMapping: number;
    toneMappingExposure: number;
    outputColorSpace: string;
    shadowMap: { enabled: boolean; type: number };
    /** Асинхронная инициализация адаптера/устройства — ОБЯЗАТЕЛЬНА до рендера. */
    init(): Promise<void>;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    setPixelRatio(value: number): void;
    getPixelRatio(): number;
    setAnimationLoop(callback: ((time: number) => void) | null): void;
    setClearColor(color: number, alpha?: number): void;
    render(scene: Scene, camera: Camera): void;
    renderAsync(scene: Scene, camera: Camera): Promise<void>;
    compileAsync(scene: Scene, camera: Camera): Promise<void>;
    hasFeatureAsync(name: string): Promise<boolean>;
    /** Флаги автоочистки буферов перед `render()` (как у WebGLRenderer). Нужны
     *  гибридному конвейеру: второй прямой проход поверх готового кадра требует
     *  `autoClearColor=false` (грузить цвет, не смывать). */
    autoClear: boolean;
    autoClearColor: boolean;
    autoClearDepth: boolean;
    autoClearStencil: boolean;
    dispose(): void;
  }

  /**
   * Node-вариант standard-материала: обычный `MeshStandardMaterial` + TSL-слоты.
   * Используем `backdropNode` — подмена «просвечивающего» фона (LightsNode
   * заменяет им totalDiffuse), официальный приём мороза без transmission
   * (пример webgpu_backdrop_area).
   */
  export class MeshStandardNodeMaterial extends MeshStandardMaterial {
    backdropNode: TSLNode | null;
    backdropAlphaNode: TSLNode | null;
    /** Эмиссия TSL-узлом (свечение поверх освещения) — полуотражающий пол. */
    emissiveNode: TSLNode | null;
    colorNode: TSLNode | null;
  }

  /** Node-вариант unlit-материала. `colorNode` — подмена базового цвета TSL-узлом
   *  (идеальное зеркало: `colorNode = reflector()`, офиц. пример webgpu_reflection). */
  export class MeshBasicNodeMaterial extends MeshBasicMaterial {
    colorNode: TSLNode | null;
    /** Прозрачность TSL-узлом. */
    opacityNode: TSLNode | null;
  }

  /**
   * WebGPU-совместимый PMREM (в отличие от ядрового из "three", он знает про
   * async-инициализацию бэкенда — `fromScene` вызывать ПОСЛЕ `renderer.init()`).
   * Явно объявлен здесь, чтобы перекрыть ядровый тип из `export * from "three"`
   * (тот требует WebGLRenderer в конструкторе).
   */
  export class PMREMGenerator {
    constructor(renderer: WebGPURenderer);
    fromScene(
      scene: Scene,
      sigma?: number,
      near?: number,
      far?: number,
    ): { texture: Texture; dispose(): void };
    dispose(): void;
  }

  /**
   * Node-конвейер постобработки WebGPU (бывш. `PostProcessing`, переименован в
   * r181+). `outputNode` — корневой TSL-узел графа эффектов; `render()` синхронный
   * (команды очередятся на устройстве), вызывать после `await renderer.init()`.
   */
  export class RenderPipeline {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(renderer: WebGPURenderer, outputNode?: any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outputNode: any;
    needsUpdate: boolean;
    render(): void;
    dispose(): void;
  }
}

declare module "three/tsl" {
  /** Узел TSL-графа: операторы/сэмплинг возвращают такой же узел (структурно). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type TSLNode = any;
  export const positionWorld: TSLNode;
  export const uniform: (value: any, type?: string) => TSLNode;
  /** Пасс сцены → узел с доступом к цвету/глубине/нормалям (через MRT). */
  export const pass: (scene: unknown, camera: unknown) => TSLNode;
  export const mrt: (outputs: Record<string, TSLNode>) => TSLNode;
  export const output: TSLNode;
  export const normalView: TSLNode;
  export const transformedNormalView: TSLNode;
  /** Диффузный (альбедо) цвет материала — MRT-канал для композита SSGI. */
  export const diffuseColor: TSLNode;
  /** Экранный вектор движения фрагмента — MRT-канал, нужен TRAA-денойзу. */
  export const velocity: TSLNode;
  /** Сложение узлов (`a.add(b)` в функциональной форме). */
  export const add: (...nodes: TSLNode[]) => TSLNode;
  export const vec3: (...args: unknown[]) => TSLNode;
  export const vec4: (...args: unknown[]) => TSLNode;
  /** Обёртка TSL-функции: тело строит граф, вызов `Fn(...)()` даёт узел. */
  export const Fn: (body: () => TSLNode) => () => TSLNode;
  /** Условный discard фрагмента (внутри тела `Fn`). */
  export const Discard: (cond?: TSLNode) => TSLNode;
  export const float: (v: number | TSLNode) => TSLNode;
  export const color: (v: number | TSLNode) => TSLNode;
  /** UV текущего фрагмента в экранном пространстве [0..1]. */
  export const screenUV: TSLNode;
  /** View-space позиция фрагмента (z отрицательный к камере). */
  export const positionView: TSLNode;
  /** Перспективная depth [0..1] → view-space Z (отрицательный). */
  export const perspectiveDepthToViewZ: (
    depth: TSLNode,
    near: TSLNode,
    far: TSLNode,
  ) => TSLNode;
  /** Униформы near/far активной камеры (обновляются рендером). */
  export const cameraNear: TSLNode;
  export const cameraFar: TSLNode;
  /**
   * Разделяемая копия текущего фреймбуфера (одна на кадр): то, что уже нарисовано
   * до прозрачного объекта, сэмплирующего её. Основа мороза-через-backdrop.
   */
  export const viewportSharedTexture: (...args: unknown[]) => TSLNode;
  /** Чтение vertex-атрибута геометрии по имени (например, сила отражения пола). */
  export const attribute: (name: string, type?: string) => TSLNode;
  /**
   * Плоское зеркало: текстурный узел с рендером сцены из отражённой камеры.
   * `node.target` (Object3D) задаёт плоскость — добавить дитём к мешу зеркала.
   */
  export const reflector: (parameters?: {
    resolutionScale?: number;
    generateMipmaps?: boolean;
    bounces?: boolean;
    depth?: boolean;
    samples?: number;
  }) => TSLNode;
}

declare module "three/examples/jsm/tsl/display/hashBlur.js" {
  import type { TSLNode } from "three/tsl";
  /** Однопроходный стохастический блюр текстурного узла (радиус в UV экрана). */
  export const hashBlur: (
    textureNode: TSLNode,
    bluramount?: TSLNode,
    options?: { repeats?: TSLNode; premultipliedAlpha?: boolean },
  ) => TSLNode;
}

declare module "three/examples/jsm/tsl/display/BloomNode.js" {
  import type { TSLNode } from "three/tsl";
  export const bloom: (
    node: TSLNode,
    strength?: number,
    radius?: number,
    threshold?: number,
  ) => TSLNode;
}
declare module "three/examples/jsm/tsl/display/GTAONode.js" {
  import type { TSLNode } from "three/tsl";
  export const ao: (
    depthNode: TSLNode,
    normalNode: TSLNode,
    camera: unknown,
  ) => TSLNode;
}
declare module "three/examples/jsm/tsl/display/SSGINode.js" {
  import type { TSLNode } from "three/tsl";
  export const ssgi: (
    beautyNode: TSLNode,
    depthNode: TSLNode,
    normalNode: TSLNode,
    camera: unknown,
  ) => TSLNode;
}
declare module "three/examples/jsm/tsl/display/TRAANode.js" {
  import type { TSLNode } from "three/tsl";
  /** Temporal reprojection AA — денойзит темпоральный SSGI, требует velocity+depth. */
  export const traa: (
    beautyNode: TSLNode,
    depthNode: TSLNode,
    velocityNode: TSLNode,
    camera: unknown,
  ) => TSLNode;
}
declare module "three/examples/jsm/tsl/display/DepthOfFieldNode.js" {
  import type { TSLNode } from "three/tsl";
  export const dof: (
    node: TSLNode,
    viewZNode: TSLNode,
    focusDistance?: number,
    focalLength?: number,
    bokehScale?: number,
  ) => TSLNode;
}
