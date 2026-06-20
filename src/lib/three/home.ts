/**
 * Каноническая («домашняя») поза камеры `P` — обзор канонического города под
 * лёгким наклоном. После каждого drill/up активный уровень всегда канонический
 * (origin shift, см. `navigator.ts`), поэтому поза камеры — константа.
 *
 * Вынесено в отдельный модуль, чтобы навигатор и тесты не тянули `scene.ts`
 * (там `WebGLRenderer`/`MapControls`, требующие DOM/WebGL).
 */
import { Vector3 } from "three";

export const INITIAL_CAMERA_POS = new Vector3(0, 140, 180);
export const INITIAL_TARGET = new Vector3(0, 0, 0);
