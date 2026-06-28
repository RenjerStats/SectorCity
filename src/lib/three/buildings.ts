/**
 * Уникальная геометрия зданий по категории файла (vision §II.2, доработка референса
 * `SectorCity_test_models/building-designs.md`).
 *
 * Идентичность категории несут ТРИ канала, не конфликтующих с несущими (площадь=
 * размер, высота=устаревание): цвет «короны»-крыши (яркий Okabe–Ito), форма короны/
 * сигнатуры и материал (матовый пластик · сталь · глянцевое «стекло»). Корпус —
 * графитовый (`BODY_TINT`), графит доминирует; отдельные детали могут нести свой цвет.
 *
 * Единое правило: **корпус (графит, RoundedBox) + СКРУГЛЁННАЯ корона сверху (цвет
 * категории) с уникальной деталью + сигнатура на фасаде**. Крыша у каждого типа своя
 * (полоски/ступени/бугорки/экран/насечка), но ВСЕГДА скруглённая — острых граней у
 * крыши нет (`RoundedBoxGeometry`, как у куполов-папок). Сигнатуры аддитивны и
 * устойчивы к двум ограничениям инстансинга:
 *   1) НЕравномерный масштаб `(footprintX, ageHeight, footprintZ)` — круги/сферы
 *      превратились бы в эллипсы, поэтому только рёбра/пазы/срез угла/поясок/ступени;
 *   2) envelope строго в единичном кубе `[-0.5,0.5]³` (низ −0.5 = пол; см. размещение
 *      в `city.ts` и якоря/highlight в `interaction.ts`). Выступы держим скромными.
 *
 * Каждый строитель возвращает `BuildingDef`: одну merge-геометрию С ГРУППАМИ (по группе
 * на материал) + параллельные массивы материалов и их «эталонных» цветов. Эталонные
 * цвета нужны `city.ts` для decor-фейда (`material.color = designed · f`), пока
 * per-instance цвет остаётся МНОЖИТЕЛЕМ состояния (highlight/cleanup), а не абсолютом.
 *
 * Все сабгео приводятся к non-indexed перед merge: `RoundedBoxGeometry` уже non-indexed,
 * `BoxGeometry` — indexed; смешивать нельзя (`mergeGeometries` упадёт).
 */
import {
  BoxGeometry,
  type BufferGeometry,
  Color,
  type Material,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Category } from "../ipc/contract";
import {
  BODY_TINT,
  CATEGORY_COLOR,
  GLASS_PANEL_COLOR,
  STEEL_COLOR,
} from "./palette";

/** Геометрия + материалы + эталонные цвета одного типа здания. */
export interface BuildingDef {
  /** Merge-геометрия с группами: группа `g` рисуется материалом `materials[g]`. */
  geometry: BufferGeometry;
  /** Материалы по группам (порядок = порядок групп в геометрии). */
  materials: Material[];
  /** Эталонный цвет каждого материала (для decor-фейда в `city.ts`). */
  designedColors: Color[];
}

// --- Примитивы в единичном envelope. Всё non-indexed (для merge). ---

/** Прямоугольный блок (острые грани), центр `(cx,cy,cz)`; non-indexed.
 *  Только для НЕ-кровельных деталей (пазы на фасаде, диагональная фаска). */
function box(
  w: number,
  h: number,
  d: number,
  cx: number,
  cy: number,
  cz: number,
): BufferGeometry {
  const g = new BoxGeometry(w, h, d).toNonIndexed();
  g.translate(cx, cy, cz);
  return g;
}

/**
 * Скруглённый блок (фаски Nothing), центр `(cx,cy,cz)`; non-indexed. Радиус
 * автоматически зажимается под самый тонкий размер (RoundedBoxGeometry требует
 * `radius < min(w,h,d)/2`), поэтому годится и для тонких кровельных деталей.
 */
function rbox(
  w: number,
  h: number,
  d: number,
  cx: number,
  cy: number,
  cz: number,
  radius = 0.05,
): BufferGeometry {
  const r = Math.max(0.005, Math.min(radius, Math.min(w, h, d) * 0.45));
  const g = new RoundedBoxGeometry(w, h, d, 2, r);
  g.translate(cx, cy, cz);
  return g; // RoundedBoxGeometry уже non-indexed
}

/** Слить несколько сабгео одного материала в одну часть (без групп). */
function part(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged!;
}

// --- Материалы (4 типа). Цвет = «эталонный»; per-instance цвет домножает состояние. ---

function plastic(tint: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: tint,
    metalness: 0,
    roughness: 0.7,
  });
}
/** Корона = цвет категории. Без emissive: иначе per-instance dim/decor её не гасит. */
function crownMat(category: Category): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: CATEGORY_COLOR[category],
    metalness: 0,
    roughness: 0.5,
  });
}
/** Глянцевая «стеклянная» панель: почти-чёрная, низкая roughness, ловит env-map. */
function glass(): MeshPhysicalMaterial {
  return new MeshPhysicalMaterial({
    color: GLASS_PANEL_COLOR,
    metalness: 0,
    roughness: 0.06,
    envMapIntensity: 1.5,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
  });
}
function steel(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: STEEL_COLOR,
    metalness: 0.95,
    roughness: 0.3,
    envMapIntensity: 1.0,
  });
}
/**
 * Тёмный оттенок цвета категории — для ДЕТАЛЕЙ короны (полоски, ступени, бугорки),
 * чтобы они НЕ сливались с основной крышей. Контраст по тону: деталь читается как
 * рельеф/линия на цветной крыше (отзыв: одинаковый цвет «тонет в фоне»).
 */
function crownDarkColor(category: Category): number {
  return new Color(CATEGORY_COLOR[category]).multiplyScalar(0.42).getHex();
}
function crownDarkMat(category: Category): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: crownDarkColor(category),
    metalness: 0,
    roughness: 0.55,
  });
}
/**
 * Светлые графитовые акценты для деталей на ТЁМНОМ корпусе (швы-слои, рёбра): чуть
 * светлее графита, иначе тёмная деталь на тёмном корпусе не видна.
 */
const EDGE_COLOR = 0x5a5e66; // линия-слой/шов на фасаде (document·video)
const FIN_COLOR = 0x484c54; // вертикальные рёбра audio — светлее корпуса
const WOOD_COLOR = 0x86603a; // рамка-багет «фото» у image — тёплое дерево

// --- Общие размеры envelope ---
const TOP = 0.5; // верх envelope = верх короны
const BODY_TOP = 0.4; // верх корпуса по умолчанию (корона выше)
const GROOVE_PROUD = 1.008; // паз чуть шире фасада — читается тёмной линией

/** Корпус-графит (скруглённый) от низа −0.5 до `topY`. Тинт — в материале, не в гео. */
function bodyGeo(topY = BODY_TOP): BufferGeometry {
  const h = topY + 0.5;
  return rbox(1, h, 1, 0, -0.5 + h / 2, 0, 0.05);
}

/** Скруглённая плита-короны: база `[topY..midY]` нужного footprint. */
function crownSlab(topY: number, midY: number, footprint = 1): BufferGeometry {
  const h = midY - topY;
  return rbox(footprint, h, footprint, 0, topY + h / 2, 0, 0.04);
}

/** Собрать `BuildingDef` из (часть, материал, эталон-цвет) троек. */
function assemble(
  groups: { geo: BufferGeometry; mat: Material; color: number }[],
): BuildingDef {
  const geometry = mergeGeometries(
    groups.map((g) => g.geo),
    true,
  )!;
  for (const g of groups) g.geo.dispose();
  return {
    geometry,
    materials: groups.map((g) => g.mat),
    designedColors: groups.map((g) => new Color(g.color)),
  };
}

// --- Строители по категориям. Крыша у каждого скруглённая и со своей деталью. ---

/** `other` — гладкий монолит: корпус + ровная скруглённая корона (без детали). */
function makeOther(): BuildingDef {
  const crown = crownSlab(BODY_TOP, TOP);
  return assemble([
    { geo: bodyGeo(), mat: plastic(BODY_TINT.other), color: BODY_TINT.other },
    { geo: crown, mat: crownMat("other"), color: CATEGORY_COLOR.other },
  ]);
}

/** `code` — глянцевая полоса-«окно» на фасаде + крыша с тёмными полосками-«строками». */
function makeCode(): BuildingDef {
  const crownBase = crownSlab(BODY_TOP, 0.46);
  // 3 продольные полоски (строки кода) — ТЁМНЫЙ оттенок крыши (контраст, не сливаются).
  const stripes = part([
    rbox(0.16, 0.05, 0.9, -0.28, 0.475, 0, 0.02),
    rbox(0.16, 0.05, 0.9, 0.0, 0.475, 0, 0.02),
    rbox(0.16, 0.05, 0.9, 0.28, 0.475, 0, 0.02),
  ]);
  // Вертикальная глянцевая полоса-«окно» по центру переднего фасада (БЕЗ выступа-палки,
  // в пределах footprint): прежняя диагональная фаска угла торчала за габарит.
  const strip = rbox(0.34, 0.82, 0.05, 0, -0.04, 0.5, 0.02);
  return assemble([
    { geo: bodyGeo(), mat: plastic(BODY_TINT.code), color: BODY_TINT.code },
    { geo: crownBase, mat: crownMat("code"), color: CATEGORY_COLOR.code },
    { geo: stripes, mat: crownDarkMat("code"), color: crownDarkColor("code") },
    { geo: strip, mat: glass(), color: GLASS_PANEL_COLOR },
  ]);
}

/** `document` — тонкие горизонтальные пазы-слои; крыша со скруглённым «швом тетради». */
function makeDocument(): BuildingDef {
  // Подложка крыши — ТЁМНЫЙ оттенок (виден в зазоре-шве); поверх две ЯРКИЕ половинки.
  const base = crownSlab(BODY_TOP, 0.47);
  const halves = part([
    rbox(1, 0.03, 0.42, 0, 0.485, 0.235, 0.012),
    rbox(1, 0.03, 0.42, 0, 0.485, -0.235, 0.012),
  ]);
  // Линии-слои на фасаде — СВЕТЛЫЙ графит (тёмные тонули бы на тёмном корпусе).
  const grooves = part([
    box(GROOVE_PROUD, 0.02, GROOVE_PROUD, 0, -0.2, 0),
    box(GROOVE_PROUD, 0.02, GROOVE_PROUD, 0, 0.0, 0),
    box(GROOVE_PROUD, 0.02, GROOVE_PROUD, 0, 0.2, 0),
  ]);
  return assemble([
    {
      geo: bodyGeo(),
      mat: plastic(BODY_TINT.document),
      color: BODY_TINT.document,
    },
    {
      geo: base,
      mat: crownDarkMat("document"),
      color: crownDarkColor("document"),
    },
    { geo: halves, mat: crownMat("document"), color: CATEGORY_COLOR.document },
    { geo: grooves, mat: plastic(EDGE_COLOR), color: EDGE_COLOR },
  ]);
}

/**
 * `image` — «фото в рамке под стеклом»: на ПЕРЕДНЕМ фасаде висит обрамлённая
 * картина — зелёная скруглённая рамка-бордюр + глянцевое «стекло»-фото внутри. Посыл
 * «изображение» читается прямо (рамка с фото), и силуэт уводит от `binary` (у того
 * деталь на крыше, а не на стене). Крыша — простая зелёная корона.
 */
function makeImage(): BuildingDef {
  const crown = crownSlab(BODY_TOP, TOP); // плоская зелёная корона (канал категории)
  // Рамка-багет на +z: 4 ТОНКИХ бруска одинаковой толщины `t` по всем сторонам (в
  // unit-пространстве; в мире останется лёгкая разница из-за неравномерного масштаба
  // здания X=размер / Y=возраст — это неустранимо при инстансинге, но тонкая рамка
  // делает её почти незаметной).
  const t = 0.05;
  const frame = part([
    rbox(0.8, t, 0.05, 0, 0.295, 0.5, 0.018), // верх
    rbox(0.8, t, 0.05, 0, -0.415, 0.5, 0.018), // низ
    rbox(t, 0.76, 0.05, -0.375, -0.06, 0.5, 0.018), // лево
    rbox(t, 0.76, 0.05, 0.375, -0.06, 0.5, 0.018), // право
  ]);
  // Само «фото» под стеклом — глянцевая панель внутри рамки (чуть менее выступает).
  const photo = rbox(0.7, 0.66, 0.04, 0, -0.06, 0.5, 0.03);
  return assemble([
    {
      geo: bodyGeo(),
      mat: plastic(BODY_TINT.image),
      color: BODY_TINT.image,
    },
    { geo: crown, mat: crownMat("image"), color: CATEGORY_COLOR.image },
    { geo: frame, mat: plastic(WOOD_COLOR), color: WOOD_COLOR }, // рамка — дерево
    { geo: photo, mat: glass(), color: GLASS_PANEL_COLOR },
  ]);
}

/** `video` — крыша-зиккурат: ступени ЧЕРЕДУЮТ яркий/тёмный тон (контраст) + сегмент-пазы. */
function makeVideo(): BuildingDef {
  // Ступени 1 и 3 — яркие, средняя — тёмный оттенок: бандинг читается и сверху.
  const bright = part([
    rbox(1.0, 0.1, 1.0, 0, 0.25, 0, 0.04),
    rbox(0.42, 0.1, 0.42, 0, 0.45, 0, 0.04),
  ]);
  const dark = rbox(0.7, 0.1, 0.7, 0, 0.35, 0, 0.04);
  const grooves = part([
    box(GROOVE_PROUD, 0.035, GROOVE_PROUD, 0, -0.27, 0),
    box(GROOVE_PROUD, 0.035, GROOVE_PROUD, 0, -0.02, 0),
  ]);
  return assemble([
    {
      geo: bodyGeo(0.2),
      mat: plastic(BODY_TINT.video),
      color: BODY_TINT.video,
    },
    { geo: bright, mat: crownMat("video"), color: CATEGORY_COLOR.video },
    { geo: dark, mat: crownDarkMat("video"), color: crownDarkColor("video") },
    { geo: grooves, mat: plastic(EDGE_COLOR), color: EDGE_COLOR },
  ]);
}

/** `audio` — вертикальные рёбра по ВСЕМ сторонам + стальной поясок; крыша-эквалайзер. */
function makeAudio(): BuildingDef {
  // Рёбра-диффузоры на ВСЕХ четырёх фасадах — отдельной СВЕТЛОЙ массой (видны на графите).
  const ks = [-2, -1, 0, 1, 2];
  const finGeos: BufferGeometry[] = [];
  for (const k of ks) {
    finGeos.push(rbox(0.07, 0.74, 0.05, k * 0.18, -0.03, 0.5, 0.02)); // перёд (+z)
    finGeos.push(rbox(0.07, 0.74, 0.05, k * 0.18, -0.03, -0.5, 0.02)); // зад (−z)
    finGeos.push(rbox(0.05, 0.74, 0.07, 0.5, -0.03, k * 0.18, 0.02)); // право (+x)
    finGeos.push(rbox(0.05, 0.74, 0.07, -0.5, -0.03, k * 0.18, 0.02)); // лево (−x)
  }
  const fins = part(finGeos);
  // Корона: скруглённая плита (яркая) + ряд ТЁМНЫХ бугорков (эквалайзер) разной высоты.
  // Бугорки растут от верха плиты (0.42), макс. высота 0.08 → не выходят за envelope.
  const hs = [0.04, 0.07, 0.05, 0.08, 0.04];
  const bumps = part(
    hs.map((bh, k) =>
      rbox(0.12, bh, 0.12, (k - 2) * 0.18, 0.42 + bh / 2, 0, 0.04),
    ),
  );
  const band = rbox(1.04, 0.08, 1.04, 0, -0.4, 0, 0.04); // хром-ободок у цоколя
  return assemble([
    { geo: bodyGeo(), mat: plastic(BODY_TINT.audio), color: BODY_TINT.audio },
    { geo: fins, mat: plastic(FIN_COLOR), color: FIN_COLOR },
    {
      geo: crownSlab(0.36, 0.42),
      mat: crownMat("audio"),
      color: CATEGORY_COLOR.audio,
    },
    { geo: bumps, mat: crownDarkMat("audio"), color: crownDarkColor("audio") },
    { geo: band, mat: steel(), color: STEEL_COLOR },
  ]);
}

/**
 * `archive` — «запечатанный кофр»: сильно скруглённый корпус + крыша-крышка В ПРЕДЕЛАХ
 * площади (не нависает за footprint) + стальная ОБВЯЗКА (пояс + ремень через верх +
 * пряжка-замок спереди) — читается «запечатанность» (как стянутый ремнями ящик).
 */
function makeArchive(): BuildingDef {
  const body = rbox(1, 0.9, 1, 0, -0.05, 0, 0.12); // сильнее скруглён (кофр)
  const lid = crownSlab(BODY_TOP, 0.47, 1.0); // крышка ровно по площади (без нависания)
  // Стальная обвязка: поясок-«талия» + вертикальный ремень (перёд → верх → зад) + пряжка.
  const steelParts = part([
    rbox(1.03, 0.12, 1.03, 0, -0.12, 0, 0.05), // пояс
    rbox(0.18, 0.92, 0.04, 0, -0.04, 0.5, 0.02), // ремень: перёд
    rbox(0.18, 0.92, 0.04, 0, -0.04, -0.5, 0.02), // ремень: зад
    rbox(0.18, 0.05, 1.0, 0, 0.47, 0, 0.02), // ремень: через верх крышки
    rbox(0.26, 0.16, 0.06, 0, -0.12, 0.52, 0.03), // пряжка-замок спереди
  ]);
  return assemble([
    { geo: body, mat: plastic(BODY_TINT.archive), color: BODY_TINT.archive },
    { geo: lid, mat: crownMat("archive"), color: CATEGORY_COLOR.archive },
    { geo: steelParts, mat: steel(), color: STEEL_COLOR },
  ]);
}

/** `binary` — крыша-кристалл: скруглённая фасция + стальная крышка + глянцевый центр. */
function makeBinary(): BuildingDef {
  const crown = crownSlab(0.3, 0.4); // синяя скруглённая фасция
  const lid = rbox(0.62, 0.07, 0.62, 0, 0.43, 0, 0.04); // теплораспред. крышка (сталь)
  const die = rbox(0.3, 0.04, 0.3, 0, 0.48, 0, 0.018); // зеркальный кристалл по центру
  return assemble([
    {
      geo: bodyGeo(0.3),
      mat: plastic(BODY_TINT.binary),
      color: BODY_TINT.binary,
    },
    { geo: crown, mat: crownMat("binary"), color: CATEGORY_COLOR.binary },
    { geo: lid, mat: steel(), color: STEEL_COLOR },
    { geo: die, mat: glass(), color: GLASS_PANEL_COLOR },
  ]);
}

const BUILDERS: Record<Category, () => BuildingDef> = {
  other: makeOther,
  code: makeCode,
  document: makeDocument,
  image: makeImage,
  video: makeVideo,
  audio: makeAudio,
  archive: makeArchive,
  binary: makeBinary,
};

/**
 * Построить уникальный `BuildingDef` для категории. Владелец (`city.ts`) кладёт
 * геометрию+материалы в `InstancedMesh` и обязан вызвать `dispose` геометрии и
 * каждого материала на смене уровня (tech §5.5; `disposeGroup` уже умеет массив).
 */
export function makeBuildingDef(category: Category): BuildingDef {
  return BUILDERS[category]();
}
