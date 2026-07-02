/**
 * Построение «города» одного уровня как самостоятельной `Group` (vision §II.3:
 * папки — стеклянные купола, детализация по глубине вместо дистанционного LOD).
 *
 * Уровень строится КАНОНИЧЕСКИ: squarified-treemap (`d3-hierarchy`) в прямо-
 * угольнике аспекта своего владельца (нормированном так, что бо́льшая сторона =
 * `CITY_SPAN`), сцентрированный около начала координат. squarify scale-инвариантен
 * ТОЛЬКО при нулевом padding, поэтому партицию считаем без padding, а зазоры/дороги
 * наносим косметически — долей размера (`applyCosmeticGaps`); иначе абсолютный
 * padding на разном масштабе менял бы форму/ориентацию папок при drill (squarify
 * жадный, и его вход искажался разной долей padding). Тогда превью района =
 * равномерно уменьшенная копия этого же района «как самостоятельного уровня». Это
 * и делает drill дешёвым: размещение
 * уровня в прямоугольник района — честная similarity `G(local)=s·local+C`
 * (см. `navigator.ts`), а промоут «купол → активный уровень» — пиксель-в-пиксель
 * по домикам (анимируется только снятие стекла, §II.3.6).
 *
 * Координаты d3 → мир — ТОЛЬКО через `layoutToWorld` (docs §5.6).
 *
 * Сущности рендера (vision §II.3):
 *   - «здание» = файл/лист: высота=устаревание (mtime), цвет=категория;
 *   - «папка» = постамент: плита-основание (`RoundedBox`), которая И обводит папку
 *     («поребрик» чуть шире содержимого), И служит ПОЛОМ — содержимое папки стоит
 *     на её верхней грани, поэтому ничего не тонет в плите. У прямого ребёнка (+1)
 *     поверх плиты ещё полуматовый стеклянный купол. Плита металлическая на +1/+2 и
 *     матовая на +3 (детализация по глубине).
 *
 * Постаменты СТЕКАЮТСЯ: плита вложенной папки стоит на полу родителя, её содержимое
 * — на её верхней грани. Так плита +2 не тонет в плите +1 (был баг: рамку +2 не
 * видно — она проваливалась в металлическое основание +1).
 *
 * Детализация по ГЛУБИНЕ, не по расстоянию до камеры (§II.3.2 — заменяет прежний
 * гистерезис `NEAR_ENTER`/`NEAR_EXIT`): прямые дети текущей папки (+1) — купола с
 * настоящими домиками; папки внутри них (+2/+3) — постаменты с застройкой. Облик
 * папки не «дышит» от движения камеры. `updateLOD` поэтому пуст (оставлен для
 * совместимости API: навигатор/тесты зовут его покадрово).
 *
 * Высоты вложенных превью (+1) масштабируются footprint-scale района
 * (`s_D = max(w,d)/CITY_SPAN`): при промоуте в активный уровень превью и активный
 * совпадают по высотам, «иголок» из рассогласования масштабов нет.
 *
 * Контакт с DOM — нет: это императивный 3D-слой. Уровнями владеет `navigator.ts`.
 */
import {
  type Camera,
  CircleGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import type { Category, ScanNode } from "../ipc/contract";
import {
  AGGREGATE_COLOR,
  CLEANUP_MARK_COLOR,
  DOME_RING_COLOR,
  GLASS_COLOR,
  GLASS_ROUGHNESS,
  GROUND_COLOR,
} from "./palette";
import { makeBuildingDef } from "./buildings";
import { layoutToWorld, type TreemapRect } from "./layoutToWorld";
import { quality } from "./quality";

/** Каноническая сторона уровня-владельца (мировые единицы): бо́льшая сторона. */
export const CITY_SPAN = 200;
/**
 * Зазоры наносятся КОСМЕТИЧЕСКИ — долей от размера прямоугольника, ПОСЛЕ squarify
 * (`applyCosmeticGaps`), а не через padding d3. Почему: squarify scale-инвариантен
 * только при НУЛЕВОМ padding, а абсолютный padding d3 запекается во вход алгоритма
 * (`positionNode`) и на разном масштабе (превью района ↔ он же как активный уровень
 * после drill) даёт разный аспект → разные жадные решения → папки меняли форму/
 * ориентацию при drill. Партицию считаем с нулевым padding (одна на любом масштабе),
 * зазор — ужатием прямоугольника к ЦЕНТРУ на долю (аспект сохраняется → партиция
 * цела).
 *
 * Доля ОДНА на всех уровнях (и внутри куполов) — НЕ зависит от LOD-глубины. Это
 * делает drill чистым зумом: содержимое папки имеет тот же относительный зазор и
 * как превью под стеклом (+2), и как активный уровень (+1), поэтому при входе оно
 * не «переразъезжается» (раньше +2 был плотным `0.03`, а на drill становился `0.11`
 * → дома ужимались, освобождая «дороги»). Дороги-бордюры упразднены окончательно
 * (vision §II.4, ревизия): носитель dot-приёма — земля целиком (`buildGroundDots`),
 * разделение блоков несут постаменты и стекло. Значение ниже — ЕДИНСТВЕННЫЙ
 * регулятор плотности: плотнее/просторнее — крутить только его.
 */
const GAP_FRAC = 0.06; // единая доля-зазор между соседями на любой глубине
const DOT_R = 0.55; // базовый радиус точки, мир
const GROUND_APRON = 3; // во сколько раз земля больше города
const GROUND_EDGE_COLOR = 0x080808; // = --bg: к нему гаснут земля и сетка у краёв
const APRON_STEP = 6; // шаг сетки-поля вокруг города
const APRON_DOT_ALPHA = 0.12; // базовая яркость точки поля (до угасания)
/**
 * Внешний отступ содержимого от рамки контейнера — доля размера (роль прежнего
 * `DISTRICT_PAD`). Это и рим/«крыша» района, и у +1 — обязательный зазор застройка↔
 * стекло купола (с запасом над `DOME_FOOTPRINT_INSET`, иначе домики у стенки не
 * размываются transmission'ом и протыкают стекло, ломая буфер глубины, §II.3.7).
 */
const CONTENT_MARGIN_FRAC = 0.05;
/** Диапазон высоты здания (устаревание), мировые единицы. */
const MIN_HEIGHT = 4;
const MAX_HEIGHT = 70;
/** Горизонт «устаревания»: возраст, при котором высота упирается в максимум. */
const MAX_AGE_SECONDS = 3 * 365 * 24 * 3600; // ~3 года
/** Минимальное значение площади, чтобы нулевые узлы не вырождались в точку. */
const MIN_VALUE = 1;
/** Множитель затемнения несовпадающих с фильтром/поиском узлов (подсветка). */
export const DIM_FACTOR = 0.12;

/**
 * Тинт-множители уверенности кандидата в режиме очистки (план §2.3): кандидат
 * подкрашивается уверенностью правила — Safe к `--safe` (зелёный), Likely к
 * `--stale` (амбер), Review — нейтральный (без тинта). Значения светлее токенов
 * DOM: per-instance цвет — МНОЖИТЕЛЬ поверх материалов, тёмный тинт гасил бы
 * здание вместо подкраски.
 */
const CONFIDENCE_TINT: Record<string, number> = {
  safe: 0x7fd4a8,
  likely: 0xe8c07a,
};
/** Переиспользуемый Color для тинта (без аллокаций в перекраске уровня). */
const TINT_SCRATCH = new Color();

/**
 * Высота базовой плиты-постамента папки (мир). Плита — это И обводка-«поребрик»
 * (footprint чуть больше содержимого), И ПОЛ: содержимое папки ставится на её
 * верх, поэтому ничего не тонет в плите (vision §II.3.1). У +1 — фикс `RING_HEIGHT`
 * (как исторический металлический ободок); у вложенных папок высота масштабируется
 * footprint-scale (мелкая папка — пропорционально тоньше постамент), с полом
 * `BASE_MIN_HEIGHT`, иначе её плита тонула бы в плите родителя.
 */
export const RING_HEIGHT = 2.2;
const BASE_MIN_HEIGHT = 0.6; // пол высоты постамента вложенной папки
/** Вынос постамента +1 наружу за грань купола — «поребрик» выступает из-под стекла. */
const RING_RIM = 1.0;
/**
 * Купол охватывает свою застройку с запасом-«воздухом» сверху (§II.3.5: высота
 * самого купола — производная, величину НЕ кодирует). Footprint купола слегка
 * утоплен внутрь плиты-постамента, чтобы он выступал «поребриком».
 */
const DOME_AIR = 8; // запас над самым высоким домиком (зазор «застройка↔стекло»)
const DOME_MIN_HEIGHT = 9; // минимальная высота купола (тощие папки читаемы)
const DOME_FOOTPRINT_INSET = 0.8; // насколько footprint купола уже плиты района
/** Скруглённый стеклянный куб: радиус скругления на единичном боксе. Число
 *  сегментов скругления берём из активного уровня графики (`quality.active`). */
const DOME_ROUND_RADIUS = 0.06;
/** Непрозрачность дешёвого купола (минимальный уровень, без transmission): стекло
 *  полупрозрачно, чтобы застройка внутри просвечивала (нет «мороза»-преломления). */
const CHEAP_DOME_OPACITY = 0.3;
/**
 * Анимация снятия купола при drill (и обратного «надевания» при up, §II.3.6):
 * купол раскрываемого района уезжает вверх ЗА ВЕСЬ отрезок зума (`extractDome`), но
 * РАСТВОРЯЕТСЯ быстрее — полностью прозрачен уже к `DOME_FADE_END` (середине), чтобы
 * стекло не «висело» полупрозрачным до конца зума. Кривые «не сухие» (нелинейные):
 * подъём — easeOutCubic (резвый старт, мягкое замедление), растворение — smoothstep
 * на отрезке `[DOME_FADE_START, DOME_FADE_END]` (держит стекло читаемым в начале,
 * затем быстро в ноль).
 */
const DOME_LIFT_FACTOR = 1.1; // подъём на 110 % собственной высоты купола
const DOME_FADE_START = 0.2; // доля отрезка, после которой стекло начинает таять
const DOME_FADE_END = 0.5; // доля отрезка, к которой стекло полностью прозрачно

/**
 * Срез глубины превью (d3-глубина уровня): контейнеры до этой глубины несут
 * реальную застройку. Реальное содержимое до +2, маркеры-постаменты — на +3 (для
 * этого фронт запрашивает `get_level(depth = 3)`).
 */
export const PREVIEW_MAX_DEPTH = 3;

/** Притушенный серый материал декора (контекст-родитель). */
const DECOR_GRAY = 0.35;

/** Прямоугольник-владелец уровня (мировые единицы), задаёт аспект раскладки. */
export interface LevelSpan {
  w: number;
  d: number;
}

/** Размещение дочернего района: similarity `G(local)=s·local+C` (C=(cx,cy,cz)). */
export interface Placement {
  /** Равномерный масштаб (footprint района / канонический размах). */
  s: number;
  /** Центр прямоугольника района в координатах ЭТОГО уровня (X/Z). */
  cx: number;
  cz: number;
  /**
   * Y-отметка пола содержимого района (верх его плиты-постамента) в координатах
   * ЭТОГО уровня = `C.y`. Делает drill бесшовным по вертикали: активный (пол `y=0`)
   * под `G` встаёт ровно на превью (сидящее на плите на высоте `cy`), а декор под
   * `G⁻¹` уходит на стопку плит вниз (слоёный пирог, план §8). См. `transform.ts`.
   */
  cy: number;
  /** Размеры прямоугольника района (для канонического span дочернего уровня). */
  w: number;
  d: number;
}

/** Обёртка датума для d3-иерархии: либо синтетический корень, либо узел. */
interface TreeDatum {
  node?: ScanNode;
  children?: TreeDatum[];
}

/** Разрешение пикинга: что под курсором и что drill'ить кликом. */
export interface PickInfo {
  /** Узел под курсором (для тултипа/обводки). */
  node: ScanNode;
  /** Цель drill при клике (для вложенного содержимого — родительский район). */
  drillTarget: ScanNode;
}

/**
 * Текущий город уровня (мост для пикинга). DOM сюда не заглядывает.
 */
export interface CityView {
  /**
   * Покадровый хук (оставлен для совместимости API). Детализация задаётся ГЛУБИНОЙ,
   * не расстоянием (§II.3.2), поэтому здесь делать нечего — облик статичен.
   */
  updateLOD(camera: Camera): void;
  /** Меши, по которым идёт raycast (купола-папки + здания-файлы). */
  pickMeshes(): InstancedMesh[];
  /** Разрешить попадание (меш+инстанс) в узел/цель-drill, либо `null`. */
  resolvePick(mesh: Object3D, instanceId: number): PickInfo | null;
  /**
   * Является ли инстанс САМОСТОЯТЕЛЬНОЙ целью пикинга. Вложенное превью-содержимое
   * (+1 домики под куполом папки) — декоративное: с ним не взаимодействуют
   * поштучно, курсор должен упираться в купол папки, а не в домики под стеклом.
   * Такие инстансы «прозрачны» для raycast — луч проходит сквозь них к куполу/плите
   * (клик по ним и так вёл drill в родительскую папку). Купола/плиты/файлы верхнего
   * уровня — обычные цели (`true`).
   */
  isPickTarget(mesh: Object3D, instanceId: number): boolean;
}

/**
 * Анимируемый «снятый» купол (план/vision §II.3.6): отдельный полупрозрачный меш,
 * замещающий инстанс купола района на время твина зума. Навигатор гонит `setProgress`
 * синхронно с камерой (`0` — купол на месте/непрозрачен, `1` — снят вверх/прозрачен),
 * а по прилёте зовёт `dispose`. См. `Level.extractDome`.
 */
export interface DrillDome {
  /** `0` — купол сидит на месте и непрозрачен; `1` — поднят и растворён. */
  setProgress(p: number): void;
  /** Убрать временный меш и освободить его geometry/material. */
  dispose(): void;
}

/**
 * Геометрия одного купола +1 для анимируемого «роя» (`createDomeFlight`): чистое
 * подобие (scale+translate, без вращений) в координатах своего уровня. Снимок матрицы
 * `domeReal[j]` через `Level.childDomeDescriptors` — навигатор по нему синтезирует
 * временные купола детей и гонит их «надевание»/«снятие» синхронно с зумом.
 */
export interface DomeDescriptor {
  sx: number;
  sy: number;
  sz: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Анимируемый «рой» куполов (план/vision §II.3.6) — расширение `DrillDome` на
 * НЕСКОЛЬКО куполов сразу: домики дочерних папок при drill «надевают» купола
 * (опускаются), а при up — «снимают» (поднимаются). Живёт в своей `group`, которую
 * навигатор кладёт в `content` и трансформирует подобием района (drill — кадр района
 * `G`, up — identity уходящего уровня).
 */
export interface DomeFlight extends DrillDome {
  /** Контейнер временных куполов; навигатор задаёт его scale/position (similarity). */
  readonly group: Group;
}

/**
 * Уровень города — самостоятельная `Group` с канонической раскладкой. Размещение
 * в мир (в прямоугольник района родителя) задаётся трансформом группы извне
 * (`navigator.ts`). Активный уровень рисуется полностью и кликабелен; декор —
 * притушен, без пикинга (`setDecor`).
 */
export interface Level {
  /** Контейнер уровня; навигатор задаёт его scale/position (similarity). */
  readonly group: Group;
  /** Путь корня этого уровня (для крошек/идентификации). */
  readonly path: string;
  /** Прямоугольник, в котором построен уровень — чтобы пересобрать его на месте
   *  (смена порога агрегатора) с тем же масштабом, не трогая камеру. */
  readonly span: LevelSpan;
  /** Мост пикинга активного уровня. */
  readonly view: CityView;
  /** Размещение дочернего района по пути (канонический фрейм уровня), либо `null`. */
  childPlacement(path: string): Placement | null;
  /**
   * Переключить облик: декор (притушено, без пикинга). `excludePath` — район,
   * ставший активным уровнем: его КУПОЛ и вся ЗАСТРОЙКА скрываются (их несёт активный
   * уровень — иначе после `G⁻¹` они накрыли бы его, был баг «после drill вся папка —
   * один блок»), но его ПЛИТА-постамент ОСТаётся: на неё «садится» активный уровень
   * (слоёный пирог, план §8). Плита стоит на своём каноническом месте — нужный
   * вертикальный сдвиг даёт трансформ-подобие группы (`G⁻¹` с `cy`, см. `transform.ts`),
   * репозиционировать плиту вручную больше не нужно. `budget` — LOD-бюджет глубины
   * (план §4): инстансы глубиной d3 > `budget` скрываются; по умолчанию полный
   * (`PREVIEW_MAX_DEPTH`). `dim` — начальный множитель затемнения (§7.1; по умолчанию
   * `DECOR_GRAY`).
   */
  setDecor(excludePath?: string, budget?: number, dim?: number): void;
  /**
   * Сменить LOD-бюджет уже-декорного уровня без пересборки (план §4): при drill/up
   * слой меняет позицию в стеке `k`, и его бюджет `b_k` пересчитывается — это
   * обратимое скрытие/возврат инстансов по `d3depth`. No-op вне декор-облика.
   */
  setDecorBudget(budget: number): void;
  /**
   * Покадрово сменить множитель затемнения декора (план §7.1): `1` — полный цвет,
   * ниже — плавно в фон. Только перекраска material'ов (без матриц) — для кросс-фейда
   * градиента по `S_k`. No-op вне декор-облика.
   */
  setDecorDim(dim: number): void;
  /**
   * Показать/скрыть землю-«пол» этого уровня (план §8). Навигатор держит видимой
   * РОВНО ОДНУ землю — у самого дальнего уровня стопки: его `G⁻¹`-рибейз кладёт её
   * под низ всего «слоёного пирога», поэтому плиты не ныряют под землю активного.
   * Бесшовно: дальняя земля рибейзится тем же подобием, что и камера. `applyActive`/
   * `applyDecor` ставят дефолт (активный — видна, декор — нет), навигатор переопределяет.
   */
  setGroundShown(visible: boolean): void;
  /** Переключить облик: активный (полный рендер + пикинг). */
  setActive(): void;
  /**
   * Снять купол района `path` в отдельный анимируемый меш (план/vision §II.3.6):
   * инстанс купола в общем меше скрывается, возвращается ручка `DrillDome`, чей
   * `setProgress` навигатор гонит синхронно с твином зума (купол уезжает вверх и
   * тает), а по прилёте — `dispose`. `null`, если у района нет купола (не прямой
   * ребёнок +1). Меш живёт в `group` уровня, поэтому корректно следует за его
   * трансформом-подобием (и в активном, и в декор-облике).
   */
  extractDome(path: string): DrillDome | null;
  /**
   * Снимки геометрии всех куполов +1 этого уровня (`DomeDescriptor`, в координатах
   * уровня). Навигатор по ним синтезирует анимируемый «рой» (`createDomeFlight`):
   * при drill купола дочерних папок будущего активного уровня «надеваются», при up —
   * собственные купола уходящего уровня «снимаются». Папки без купола (не +1) опущены.
   */
  childDomeDescriptors(): DomeDescriptor[];
  /**
   * Показать/скрыть РЕАЛЬНЫЕ инстансы куполов +1 (не трогая плиты/застройку). Нужно на
   * up: пока «рой» (`createDomeFlight`) анимирует снятие куполов уходящего уровня, его
   * настоящие купола прячем, иначе они дублировали бы анимируемые. No-op без куполов.
   */
  setChildDomesShown(shown: boolean): void;
  /**
   * Затемнение «на входе» (drill): за время зума периметр уровня плавно уходит в
   * декор-цвет (`factor`: `1` — полный цвет, ниже — к фону), а раскрываемое поддерево
   * `excludePath` ОСТаётся ярким (его подхватит новый активный уровень — без «прыжка»
   * яркости в центре кадра). Только per-instance цвет (без матриц); на свопе владелец
   * возвращает базовые цвета и ставит итоговый декор-облик. No-op-безопасно вне зума.
   * `match`/`cleanup` — текущий облик режима: периметр гаснет как МОДО-цвет × factor,
   * поэтому совпадения поиска / метки очистки не «сбрасываются» во время анимации.
   */
  setEnterDim(
    excludePath: string,
    factor: number,
    match: ((node: ScanNode) => boolean) | null,
    cleanup: {
      isMarked: (node: ScanNode) => boolean;
      isCandidate: (node: ScanNode) => boolean;
    } | null,
  ): void;
  /**
   * Подсветка-фильтр (vision §I.4б): несовпадающие с предикатом узлы гасятся
   * домножением per-instance цвета на `DIM_FACTOR`, совпадающие остаются в полном
   * цвете → «сцена в тень, совпадения светятся». `null` — снять подсветку. Канал
   * цвета не подменяется, только притеняется (палитра категорий сохраняется).
   */
  setHighlight(match: ((node: ScanNode) => boolean) | null): void;
  /**
   * Облик режима «Сканер мусора» (vision §I.7). При `view ≠ null` сцена уходит в
   * «вид очистки»: не-кандидаты приглушаются (×`DIM_FACTOR`), кандидаты
   * (флаг `cleanupCandidate`) — в полном цвете, помеченные на снос (`isMarked`) —
   * перекрашены в красный акцент `CLEANUP_MARK_COLOR`. `null` — выйти из вида
   * (владелец затем восстанавливает подсветку-фильтр через `setHighlight`).
   */
  setCleanup(
    view: {
      isMarked: (node: ScanNode) => boolean;
      isCandidate: (node: ScanNode) => boolean;
    } | null,
  ): void;
  /** Освободить GPU-ресурсы (geometry/material всех мешей). */
  dispose(): void;
}

/** Накопитель папки-района при раскладке (до постройки мешей). */
interface DistrictAcc {
  node: ScanNode;
  rect: TreemapRect;
  /** footprint-scale района: max(w,d)/CITY_SPAN (масштаб вложенных высот). */
  footprintScale: number;
  /** d3-глубина в раскладке уровня (1 = прямой ребёнок текущей папки). */
  d3depth: number;
  /** Индекс БЛИЖАЙШЕГО объемлющего района в `districts` (для стопки/декора), либо `null`. */
  parentIdx: number | null;
  /** Индекс района d3-глубины 1 (цель drill за один шаг); для самого +1 — он сам. */
  topIdx: number;
  /** Высота плиты-постамента этой папки (мир). */
  baseHeight: number;
  /** Низ плиты-постамента (мир): пол родителя (`contentFloor` предка) или 0 у +1. */
  floorY: number;
  /** Верх плиты = пол для содержимого ЭТОЙ папки (`floorY + baseHeight`). */
  contentFloor: number;
  /** Самая высокая абсолютная отметка содержимого+плиты поддерева (для высоты купола). */
  maxTopY: number;
}

/** Накопитель здания при раскладке. */
interface BuildingAcc {
  node: ScanNode;
  rect: TreemapRect;
  height: number;
  /** Индекс БЛИЖАЙШЕГО купола-владельца в `districts` (вложенный домик), либо `null` (файл верхнего уровня). */
  districtIdx: number | null;
  /** Индекс купола d3-глубины 1 (цель drill), либо `null` (файл верхнего уровня). */
  topDistrictIdx: number | null;
}

/** Контейнер = папка ИЛИ блок-агрегат «Мелочь» (навигируемый купол). */
function isContainer(node: ScanNode): boolean {
  return node.isDir || node.flags.includes("aggregated");
}

/** Минимум, что нужно `applyCosmeticGaps` от d3-узла (мутирует прямоугольник). */
interface RectNode {
  depth: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  children?: RectNode[];
}

/**
 * Косметические зазоры ПОСЛЕ squarify (см. шапку и `GAP_FRAC_*`): рекурсивно
 * сверху вниз, IN PLACE переписывает `x0/y0/x1/y1`. Для каждого контейнера:
 *   1) содержимое отступает от рамки на `CONTENT_MARGIN_FRAC` (рим/«крыша», зазор
 *      под стекло купола) — подобие frame → контент-область (sx == sy, аспекты
 *      равны, т.к. все шаги — подобия);
 *   2) каждый сосед ужимается к своему центру на долю-зазор по глубине (дорога у
 *      +1, плотно глубже) — это тоже подобие, аспект цел → партиция squarify не
 *      трогается.
 * Поскольку ВСЕ преобразования — подобия, превью района попиксельно совпадает с
 * ним же как активным уровнем, уменьшенным `G` (drill бесшовен, навигатор).
 *
 * `frame` — ИСХОДНЫЙ (нулевой-padding) прямоугольник узла, в котором его дети были
 * затайлены squarify; передаётся явно, т.к. собственный rect узла к моменту
 * обработки уже ужат родителем.
 */
function applyCosmeticGaps(node: RectNode, frame: RectNode): void {
  const kids = node.children;
  if (!kids || kids.length === 0) return;

  // Контент-область узла: его (уже ужатый) rect, отступив рим долей размера.
  const w = node.x1 - node.x0;
  const h = node.y1 - node.y0;
  const cx0 = node.x0 + w * CONTENT_MARGIN_FRAC;
  const cy0 = node.y0 + h * CONTENT_MARGIN_FRAC;
  const cx1 = node.x1 - w * CONTENT_MARGIN_FRAC;
  const cy1 = node.y1 - h * CONTENT_MARGIN_FRAC;
  // Подобие frame → контент-область (sx == sy: аспекты равны).
  const sx = (cx1 - cx0) / (frame.x1 - frame.x0);
  const sy = (cy1 - cy0) / (frame.y1 - frame.y0);

  for (const c of kids) {
    // Исходный (нулевой-padding) rect ребёнка — запомнить ДО перезаписи: станет
    // frame для его собственной рекурсии (его дети затайлены именно в нём).
    const ox0 = c.x0;
    const oy0 = c.y0;
    const ox1 = c.x1;
    const oy1 = c.y1;
    // Отобразить в контент-область родителя.
    const nx0 = cx0 + (ox0 - frame.x0) * sx;
    const ny0 = cy0 + (oy0 - frame.y0) * sy;
    const nx1 = cx0 + (ox1 - frame.x0) * sx;
    const ny1 = cy0 + (oy1 - frame.y0) * sy;
    // Зазор между соседями: ужать к центру единой долей (аспект сохраняется).
    // Доля одна на любой глубине → drill бесшовен (см. шапку `GAP_FRAC`).
    const gx = (nx1 - nx0) * (GAP_FRAC / 2);
    const gy = (ny1 - ny0) * (GAP_FRAC / 2);
    c.x0 = nx0 + gx;
    c.y0 = ny0 + gy;
    c.x1 = nx1 - gx;
    c.y1 = ny1 - gy;
    applyCosmeticGaps(c, {
      depth: c.depth,
      x0: ox0,
      y0: oy0,
      x1: ox1,
      y1: oy1,
    });
  }
}

/**
 * Вложенная squarified-раскладка уровня в прямоугольнике `span` (аспект владельца,
 * нормированный к CITY_SPAN). Строит настоящую d3-иерархию из `ScanNode.children`
 * (превью), классифицирует узлы по глубине и возвращает накопители куполов и
 * зданий с прямоугольниками в координатах раскладки (y вниз), сцентрированными
 * около начала координат.
 */
function layoutNested(
  nodes: ScanNode[],
  span: LevelSpan,
  nowSeconds: number,
): { districts: DistrictAcc[]; buildings: BuildingAcc[] } {
  // Раскладку обрезаем на `PREVIEW_MAX_DEPTH`: контейнеры до среза несут реальную
  // застройку, а контейнеры-ЛИСТЬЯ на срезе (детей в раскладку не тянем) станут
  // куполами-«теплицами» с серыми кубами. `depth`: дети текущей папки приходят
  // как 1, их дети — 2 и т.д. Данные глубже среза должен прислать `get_level`
  // (иначе у узла пустой `children` → он и так лист-«теплица»).
  const toDatum = (node: ScanNode, depth: number): TreeDatum => {
    const kids = node.children;
    return kids && kids.length > 0 && depth < PREVIEW_MAX_DEPTH
      ? { node, children: kids.map((k) => toDatum(k, depth + 1)) }
      : { node };
  };
  const rootDatum: TreeDatum = { children: nodes.map((n) => toDatum(n, 1)) };

  const root = hierarchy<TreeDatum>(rootDatum, (d) => d.children).sum((d) =>
    // Значение только у листьев; d3 сворачивает площади районов вверх сам.
    d.children && d.children.length > 0
      ? 0
      : Math.max(d.node ? d.node.size : 0, MIN_VALUE),
  );

  // treemap() добавляет x0/y0/x1/y1 — итерируем именно прямоугольный результат.
  // Партицию считаем БЕЗ padding (по умолчанию у d3 он нулевой): squarify тогда
  // scale-инвариантен → превью района = он же как активный уровень, уменьшенный
  // подобием (drill не меняет форм). Зазоры/дороги/рим — косметически, ПОСЛЕ.
  const laidOut = treemap<TreeDatum>()
    .tile(treemapSquarify)
    .size([span.w, span.d])(root);
  applyCosmeticGaps(laidOut, laidOut);

  const halfW = span.w / 2;
  const halfD = span.d / 2;
  const center = (d: { x0: number; y0: number; x1: number; y1: number }) => ({
    x0: d.x0 - halfW,
    y0: d.y0 - halfD,
    x1: d.x1 - halfW,
    y1: d.y1 - halfD,
  });

  const districts: DistrictAcc[] = [];
  const buildings: BuildingAcc[] = [];
  const districtIdxByNode = new Map<ScanNode, number>();

  /** Индекс ближайшего объемлющего купола (по уже занесённым предкам), либо `null`. */
  const nearestContainerIdx = (
    d: { ancestors(): { data: { node?: ScanNode } }[] },
    self: unknown,
  ): number | null => {
    for (const a of d.ancestors()) {
      if (a === self) continue; // сам узел — не предок
      const an = a.data.node;
      if (an && districtIdxByNode.has(an)) return districtIdxByNode.get(an)!;
    }
    return null;
  };

  // descendants(): pre-order (родитель раньше детей) — район заводим до его
  // вложенного содержимого, чтобы те нашли индекс владельца и его footprint-scale.
  for (const d of laidOut.descendants()) {
    const node = d.data.node;
    if (!node) continue; // синтетический корень
    const rect = center(d);
    const c = layoutToWorld(rect, 0);
    const footprintScale = Math.max(c.width, c.depth) / CITY_SPAN;

    if (isContainer(node)) {
      const parentIdx = nearestContainerIdx(d, d);
      const idx = districts.length;
      districtIdxByNode.set(node, idx);
      const topIdx =
        d.depth === 1
          ? idx
          : parentIdx !== null
            ? districts[parentIdx].topIdx
            : idx;
      // Высота плиты-постамента: фикс у +1, масштабируется footprint-scale у вложенных
      // (с полом). `floorY`/`contentFloor` досчитаем стопкой сверху вниз ниже.
      const baseHeight =
        d.depth === 1
          ? RING_HEIGHT
          : Math.max(BASE_MIN_HEIGHT, RING_HEIGHT * footprintScale);
      districts.push({
        node,
        rect,
        footprintScale,
        d3depth: d.depth,
        parentIdx,
        topIdx,
        baseHeight,
        floorY: 0,
        contentFloor: 0,
        maxTopY: 0,
      });
    } else {
      // Лист-файл: здание верхнего уровня (+0) или вложенный домик (внутри района).
      const districtIdx = nearestContainerIdx(d, d);
      const scale =
        districtIdx !== null ? districts[districtIdx].footprintScale : 1;
      const topDistrictIdx =
        districtIdx !== null ? districts[districtIdx].topIdx : null;
      const height = heightFromMtime(node.mtime, nowSeconds) * scale;
      buildings.push({ node, rect, height, districtIdx, topDistrictIdx });
    }
  }

  // Стопка постаментов СВЕРХУ ВНИЗ (по возрастанию d3-глубины): плита папки стоит на
  // полу родителя (`contentFloor` предка), а её верх — пол для её содержимого. Так
  // вложенная плита не тонет в плите родителя.
  const byDepthAsc = districts
    .map((_, i) => i)
    .sort((a, b) => districts[a].d3depth - districts[b].d3depth);
  for (const i of byDepthAsc) {
    const d = districts[i];
    d.floorY = d.parentIdx !== null ? districts[d.parentIdx].contentFloor : 0;
    d.contentFloor = d.floorY + d.baseHeight;
    d.maxTopY = d.contentFloor; // пустой постамент достаёт хотя бы до своего верха
  }

  // Высшая отметка содержимого каждого района: домики поднимают «свой» район,
  // затем снизу вверх (по убыванию глубины) поддеревья поднимают предков. Нужна для
  // высоты купола +1 (он обязан накрыть всё поднятое содержимое).
  for (const b of buildings) {
    if (b.districtIdx !== null) {
      const d = districts[b.districtIdx];
      d.maxTopY = Math.max(d.maxTopY, d.contentFloor + b.height);
    }
  }
  const byDepthDesc = districts
    .map((_, i) => i)
    .sort((a, b) => districts[b].d3depth - districts[a].d3depth);
  for (const i of byDepthDesc) {
    const d = districts[i];
    if (d.parentIdx !== null) {
      districts[d.parentIdx].maxTopY = Math.max(
        districts[d.parentIdx].maxTopY,
        d.maxTopY,
      );
    }
  }

  return { districts, buildings };
}

/**
 * Высота стеклянного купола +1: накрывает самую высокую отметку поднятого содержимого
 * (`maxTopY`, абсолютная от земли) с запасом-«воздухом». Воздух и минимум
 * масштабируются footprint-scale (мелкие купола — пропорционально меньший зазор,
 * иначе абсолютный `DOME_AIR` превращал бы их в тонкие шпили).
 */
function domeHeight(d: DistrictAcc): number {
  const s = Math.min(1, d.footprintScale);
  return Math.max(DOME_MIN_HEIGHT * s, d.maxTopY + DOME_AIR * s);
}

/** Высота из устаревания: чем старше mtime, тем выше (канал «устаревание»). */
function heightFromMtime(mtime: number, nowSeconds: number): number {
  const age = Math.max(0, nowSeconds - mtime);
  const t = Math.min(1, age / MAX_AGE_SECONDS);
  return MIN_HEIGHT + t * (MAX_HEIGHT - MIN_HEIGHT);
}

/** Вырожденная матрица (scale=0): инстанс не рисуется и не ловится raycast. */
const ZERO_MATRIX = new Matrix4().makeScale(0, 0, 0);

/**
 * Базовый цвет металлического ободка-основания купола. Обычная папка → нейтральный
 * металл; блок «Мелочь» (`aggregated`) несёт цвет-агрегат, чтобы читаться как
 * «объединённая мелочь», а не обычная папка. Стекло купола всегда нейтрально
 * (§II.3.5) — категорийный тинт допустим только здесь, на основании.
 */
function ringBaseColor(node: ScanNode): number {
  return node.flags.includes("aggregated") ? AGGREGATE_COLOR : DOME_RING_COLOR;
}

/**
 * Итоговый per-instance ЦВЕТ узла по текущему облику режима — ЕДИНЫЙ источник для
 * `setHighlight`/`setCleanup` и для затемнения-входа `setEnterDim`. Благодаря общему
 * источнику периметр во время drill-анимации гаснет, СОХРАНЯЯ облик режима (совпадения
 * поиска / метки очистки), а не «возвращается» в категорийный цвет.
 *
 * `base` — базовый множитель меша (здание — `0xffffff`, купол — стекло, плита — цвет
 * района). `cleanup` важнее подсветки (вид очистки рисуется поверх). Пишет в `out`
 * (переиспользуемый `Color`) и возвращает его.
 */
function modeColorInto(
  out: Color,
  base: number,
  node: ScanNode,
  match: ((n: ScanNode) => boolean) | null,
  cleanup: {
    isMarked: (n: ScanNode) => boolean;
    isCandidate: (n: ScanNode) => boolean;
  } | null,
): Color {
  if (cleanup) {
    if (cleanup.isMarked(node)) return out.set(CLEANUP_MARK_COLOR);
    out.set(base);
    if (!cleanup.isCandidate(node)) return out.multiplyScalar(DIM_FACTOR);
    // Кандидат: подкраска уверенностью правила (Safe/Likely; Review — нейтрально).
    const tint = node.cleanup && CONFIDENCE_TINT[node.cleanup.confidence];
    if (tint !== undefined && tint !== 0) out.multiply(TINT_SCRATCH.set(tint));
    return out;
  }
  out.set(base);
  if (match && !match(node)) out.multiplyScalar(DIM_FACTOR);
  return out;
}

/** Единичный скруглённый куб купола — общий для инстанс-меша и анимируемых «роёв».
 *  Число сегментов скругления — из активного уровня графики. */
function makeRoundedUnitCube(): RoundedBoxGeometry {
  return new RoundedBoxGeometry(
    1,
    1,
    1,
    quality.active.roundSegments,
    DOME_ROUND_RADIUS,
  );
}

/** Единичный скруглённый куб купола — общий для инстанс-меша и анимируемых «роёв». */
function makeDomeGeometry(): RoundedBoxGeometry {
  return makeRoundedUnitCube();
}

/**
 * Материал стеклянного купола. На `frostedGlass=true` (оптимальный/максимальный) —
 * настоящее матовое стекло (§II.3.7): `transmission` + `roughness` морозят прошедший
 * свет (требует env-map, см. `scene.ts`); `flight=false` даёт `depthWrite:true`
 * (купол-vs-купол пофрагментно), цвет per-instance. На `frostedGlass=false`
 * (минимальный) — ДЕШЁВАЯ полупрозрачность (`MeshLambertMaterial` + opacity), без
 * второго прохода transmission: застройка просто просвечивает сквозь стекло.
 *
 * Возвращаемый тип — объединение: оба класса несут `.color`/`.opacity`, чего
 * достаточно вызывающим (`applyDomeProgress`, decor-dim, per-instance тинт).
 */
function makeDomeMaterial(
  flight: boolean,
): MeshPhysicalMaterial | MeshLambertMaterial {
  if (quality.active.frostedGlass) {
    const mat = new MeshPhysicalMaterial({
      metalness: 0,
      roughness: GLASS_ROUGHNESS,
      transmission: 1,
      thickness: 6,
      ior: 1.45,
      transparent: true,
      depthWrite: !flight,
    });
    if (flight) mat.color.set(GLASS_COLOR);
    return mat;
  }
  // Дешёвое «стекло»: полупрозрачный Lambert, без transmission (нет второго прохода
  // сцены). depthWrite:false — прозрачный меш не режет глубину; порядок купол-vs-
  // купол не разрешается пофрагментно (мелкие артефакты допустимы на этом уровне).
  const mat = new MeshLambertMaterial({
    transparent: true,
    opacity: CHEAP_DOME_OPACITY,
    depthWrite: false,
  });
  if (flight) mat.color.set(GLASS_COLOR);
  return mat;
}

/**
 * Материал плиты-постамента папки. На PBR — металл (+1/+2) либо матовый PBR (+3),
 * читаемые за счёт отражений env-map. На минимальном уровне — дешёвый Lambert без
 * металла (per-instance цвет-район сохраняется). `metal` различает +1/+2 vs +3.
 */
function makeBaseMaterial(
  metal: boolean,
): MeshStandardMaterial | MeshLambertMaterial {
  if (!quality.active.pbr) return new MeshLambertMaterial();
  return metal
    ? new MeshStandardMaterial({ metalness: 0.9, roughness: 0.35 })
    : new MeshStandardMaterial({ metalness: 0, roughness: 0.6 });
}

/**
 * Кадр анимации одного «снятого» купола по прогрессу `prog` (`0` — на месте/непрозрачен,
 * `1` — поднят на `liftBy` и растворён). Подъём — easeOutCubic (резвый старт, мягкое
 * замедление), растворение — smoothstep на хвосте отрезка (стекло читаемо, затем плавно
 * в ноль). Навигатор кормит `prog` (или `1−prog`) синхронно с зумом — отсюда «надевание»
 * (drill) и «снятие» (up) — это одна кривая в разные стороны.
 */
function applyDomeProgress(
  mesh: Mesh,
  mat: MeshPhysicalMaterial | MeshLambertMaterial,
  baseY: number,
  liftBy: number,
  prog: number,
): void {
  const t = prog < 0 ? 0 : prog > 1 ? 1 : prog;
  mesh.position.y = baseY + liftBy * (1 - (1 - t) ** 3); // easeOutCubic-подъём
  mat.opacity = domeOpacity(t);
}

/**
 * Прозрачность купола по прогрессу `t∈[0,1]` (`0` — непрозрачен, к `DOME_FADE_END` —
 * полностью прозрачен): smoothstep на отрезке `[DOME_FADE_START, DOME_FADE_END]`,
 * дальше держится на нуле. Растворение быстрее самого подъёма (см. шапку `DOME_*`).
 */
function domeOpacity(t: number): number {
  return (
    1 - smoothstep01((t - DOME_FADE_START) / (DOME_FADE_END - DOME_FADE_START))
  );
}

/**
 * Синтезировать анимируемый «рой» куполов из снимков `descs` (план/vision §II.3.6):
 * отдельные полупрозрачные меши в собственной `group`, которую навигатор размещает
 * подобием (`scale`/`position`) — кадром района при drill (купола детей «надеваются»
 * в кадре раскрываемого района) либо identity при up (купола уходящего уровня
 * «снимаются»). `setProgress` гонит все купола разом (та же кривая, что у `extractDome`),
 * `dispose` снимает группу с родителя и освобождает GPU-ресурсы.
 */
export function createDomeFlight(
  descs: DomeDescriptor[],
  scale: number,
  position: Vector3,
): DomeFlight {
  const group = new Group();
  group.scale.setScalar(scale);
  group.position.copy(position);
  if (descs.length === 0) {
    return {
      group,
      setProgress() {},
      dispose() {
        group.parent?.remove(group);
      },
    };
  }
  // Один InstancedMesh на весь рой (а не меш на купол): все купола едут по одной кривой,
  // прозрачность общая (`material.opacity`), различается лишь подъём по Y — это идеально
  // ложится на инстансинг (1 draw call, 1 дорогой transmission-материал вместо N).
  const geometry = makeDomeGeometry();
  const material = makeDomeMaterial(true);
  const mesh = new InstancedMesh(geometry, material, descs.length);
  mesh.renderOrder = 3; // поверх непрозрачных, как и обычный купол
  mesh.frustumCulled = false; // инстансы едут вверх — bbox не пересоберём покадрово
  group.add(mesh);

  const dummy = new Object3D();
  const liftBy = descs.map((d) => d.sy * DOME_LIFT_FACTOR);
  const writeMatrices = (rise: number): void => {
    descs.forEach((d, i) => {
      dummy.position.set(d.x, d.y + liftBy[i] * rise, d.z);
      dummy.scale.set(d.sx, d.sy, d.sz);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };

  return {
    group,
    setProgress(prog) {
      const t = prog < 0 ? 0 : prog > 1 ? 1 : prog;
      writeMatrices(1 - (1 - t) ** 3); // easeOutCubic-подъём (как у extractDome)
      material.opacity = domeOpacity(t); // общий для роя — все тают одной кривой
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      group.clear();
      group.parent?.remove(group);
    },
  };
}

/**
 * Построить уровень `nodes` в собственной `Group` (канонически, в прямоугольнике
 * `span`). Группа создаётся в identity — размещение в мир задаёт навигатор.
 *
 * Меши уровня:
 *   - `buildGroups`  — файлы: ПО ОДНОМУ InstancedMesh на категорию (уникальная
 *                      геометрия+материалы зданий, см. `buildings.ts`);
 *   - `domeMesh`     — матовые стеклянные купола папок +1 (transmission, §II.3.7);
 *   - `baseMesh`     — металлические плиты-постаменты папок +1/+2;
 *   - `baseMatteMesh`— матовые плиты-постаменты папок +3 (детализация по глубине).
 */
export function buildLevel(
  nodes: ScanNode[],
  span: LevelSpan,
  path: string,
): Level {
  const group = new Group();

  const nowSeconds = Math.floor(Date.now() / 1000);
  const { districts, buildings } = layoutNested(nodes, span, nowSeconds);

  // Земля — большой матовый «апрон» вокруг города с радиальным угасанием цвета к
  // краям.
  const ground = makeFadedGround(span);
  group.add(ground);
  // Dot-grid земли (vision §II.4) — регулярная мировая сетка точек по всему апрону,
  // включая площадь под городом (в зазорах между зданиями читается как «текстура
  // земли»). Без бордюров-дорог. Видимость зеркалит землю (см. setGroundShown).
  const groundDots = buildGroundDots(span);
  group.add(groundDots);

  const dummy = new Object3D();
  const color = new Color();

  // Карта «путь района → размещение» (для drill/up) и «путь → индекс купола»
  // (для исключения купола, ставшего активным уровнем, в декоре).
  const placements = new Map<string, Placement>();
  const districtIndexByPath = new Map<string, number>();

  // --- Здания: файлы верхнего уровня + вложенные домики (+1, внутри куполов).
  // По одному InstancedMesh на КАТЕГОРИЮ — уникальная геометрия+материалы зданий
  // живут в `buildings.ts`. Per-instance цвет здесь — МНОЖИТЕЛЬ состояния
  // (highlight/cleanup/затемнение-входа), а НЕ абсолютный цвет: базовые цвета
  // (графит-корпус, цветная корона, сталь/глянец) держат материалы группы. Decor-фейд
  // множит `material.color` на эталонный `designed`-цвет (см. dimBuilding ниже).
  interface BuildItem {
    b: BuildingAcc;
    /** d3-глубина здания: вложенный домик — глубина владельца +1; файл верхнего — 1. */
    depth: number;
  }
  interface BuildGroup {
    mesh: InstancedMesh;
    /** Локальный индекс инстанса в меше = позиция в `items`/`real`/`pick`. */
    items: BuildItem[];
    real: Matrix4[];
    pick: PickInfo[];
    /** Эталонные цвета материалов группы (по группам геометрии) — для decor-фейда. */
    designed: Color[];
  }
  const buildGroups: BuildGroup[] = [];
  const buildGroupByMesh = new Map<InstancedMesh, BuildGroup>();

  if (buildings.length > 0) {
    // Разложить здания по категориям, сохранив исходный порядок (детерминизм раскладки).
    const byCat = new Map<Category, BuildingAcc[]>();
    for (const b of buildings) {
      const arr = byCat.get(b.node.category);
      if (arr) arr.push(b);
      else byCat.set(b.node.category, [b]);
    }
    for (const [cat, list] of byCat) {
      const def = makeBuildingDef(cat);
      const mesh = new InstancedMesh(def.geometry, def.materials, list.length);
      const items: BuildItem[] = [];
      const real: Matrix4[] = [];
      const pick: PickInfo[] = [];
      list.forEach((b, i) => {
        const box = layoutToWorld(b.rect, b.height);
        // Домик стоит на ПОЛУ своей папки (верх её плиты-постамента), не на земле —
        // иначе провалился бы в плиту. Файл верхнего уровня сидит на земле (floor=0).
        const floor =
          b.districtIdx !== null ? districts[b.districtIdx].contentFloor : 0;
        dummy.position.set(box.centerX, floor + box.height / 2, box.centerZ);
        dummy.scale.set(box.width, box.height, box.depth);
        dummy.updateMatrix();
        real[i] = dummy.matrix.clone();
        mesh.setMatrixAt(i, dummy.matrix);
        // Внутри папки клик ведёт в РОДИТЕЛЬСКИЙ район (как и клик по плите);
        // файл верхнего уровня — это select (drillTarget = он сам, не папка).
        const drillTarget =
          b.districtIdx !== null ? districts[b.districtIdx].node : b.node;
        pick[i] = { node: b.node, drillTarget };
        items[i] = {
          b,
          depth:
            b.districtIdx !== null ? districts[b.districtIdx].d3depth + 1 : 1,
        };
      });
      mesh.instanceMatrix.needsUpdate = true;
      const g: BuildGroup = {
        mesh,
        items,
        real,
        pick,
        designed: def.designedColors,
      };
      buildGroups.push(g);
      buildGroupByMesh.set(mesh, g);
      group.add(mesh);
    }
  }

  // --- Облик папок: каждая папка — плита-постамент (И обводка, И пол под содержимым).
  //   - +1 (прямой ребёнок уровня): плита-постамент + матовый стеклянный купол сверху;
  //   - вложенные папки +2/+3: только плита-постамент (без стекла — z-fighting нет).
  // Материал плиты: МЕТАЛЛ на +1/+2 (`baseMesh`), МАТОВЫЙ на +3 (`baseMatteMesh`) —
  // глубинная детализация. Плиты непрозрачны → opaque-проход → морозятся стеклом +1.
  // dome/base/baseMatte индексируются районом `j` (неподходящие вырождены ZERO_MATRIX).
  // Пикинг любого из них → район `j`.
  const districtPick: (PickInfo | null)[] = [];
  let domeMesh: InstancedMesh | null = null;
  let baseMesh: InstancedMesh | null = null;
  let baseMatteMesh: InstancedMesh | null = null;
  const domeReal: Matrix4[] = [];
  const baseReal: Matrix4[] = [];
  const baseMatteReal: Matrix4[] = [];

  /** Папка отрисована металлической плитой (+1/+2) против матовой (+3). */
  const isMetalBase = (d: DistrictAcc): boolean => d.d3depth <= 2;

  if (districts.length > 0) {
    // +1 стекло — НАСТОЯЩЕЕ матовое (`transmission`, вариант (б) из §II.3.7):
    // дешёвый `transparent+opacity` физически НЕ размывает содержимое (только гасит
    // альфой). `transmission` преломляет фон, `roughness` размывает его по мипам
    // transmission-таргета → «мороз». Требует env-map (см. scene.ts). Тинт держим
    // per-instance (GLASS_COLOR), material.color белый. depthWrite:true (в
    // `makeDomeMaterial(false)`) решает купол-vs-купол пофрагментно (иначе порядок
    // буфера красил бы дальние поверх ближних при повороте камеры); просвечивание
    // держится тем, что домики внутри попадают в transmission-буфер ДО купола.
    domeMesh = new InstancedMesh(
      makeDomeGeometry(),
      makeDomeMaterial(false),
      districts.length,
    );
    domeMesh.renderOrder = 2; // после непрозрачных (здания/плиты)
    // Плита-постамент: тот же скруглённый куб, что и купол (совпадение кривизны
    // углов). Металл (+1/+2) виден за счёт отражений env-map (см. scene.ts); на
    // минимальном уровне — дешёвый матовый Lambert (см. makeBaseMaterial).
    baseMesh = new InstancedMesh(
      makeRoundedUnitCube(),
      makeBaseMaterial(true),
      districts.length,
    );
    // Матовая плита вложенных папок +3 (без металлики) — глубинная детализация.
    baseMatteMesh = new InstancedMesh(
      makeRoundedUnitCube(),
      makeBaseMaterial(false),
      districts.length,
    );

    districts.forEach((d, j) => {
      const full = layoutToWorld(d.rect, 0); // footprint района целиком (под плиту)

      // Плита-постамент: у +1 footprint утоплен и расширен поребриком (как раньше
      // металлический ободок); у вложенных — ровно по footprint района (его край
      // обводит застройку, которая отступила внутрь на CONTENT_MARGIN_FRAC).
      let baseW: number;
      let baseD: number;
      if (d.d3depth === 1) {
        const dw = Math.max(1, full.width - DOME_FOOTPRINT_INSET * 2);
        const dd = Math.max(1, full.depth - DOME_FOOTPRINT_INSET * 2);
        baseW = dw + RING_RIM * 2;
        baseD = dd + RING_RIM * 2;

        // Стеклянный купол: накрывает поднятое содержимое (footprint утоплен).
        const h = domeHeight(d);
        dummy.position.set(full.centerX, h / 2, full.centerZ);
        dummy.scale.set(dw, h, dd);
        dummy.updateMatrix();
        domeReal[j] = dummy.matrix.clone();
        domeMesh!.setMatrixAt(j, dummy.matrix);
        domeMesh!.setColorAt(j, color.set(GLASS_COLOR));
      } else {
        baseW = full.width;
        baseD = full.depth;
        domeReal[j] = ZERO_MATRIX;
        domeMesh!.setMatrixAt(j, ZERO_MATRIX);
      }

      // Сама плита: стоит на `floorY` (полу родителя), высотой `baseHeight`.
      dummy.position.set(
        full.centerX,
        d.floorY + d.baseHeight / 2,
        full.centerZ,
      );
      dummy.scale.set(baseW, d.baseHeight, baseD);
      dummy.updateMatrix();
      const baseMat = dummy.matrix.clone();
      if (isMetalBase(d)) {
        baseReal[j] = baseMat;
        baseMesh!.setMatrixAt(j, baseMat);
        baseMatteReal[j] = ZERO_MATRIX;
        baseMatteMesh!.setMatrixAt(j, ZERO_MATRIX);
      } else {
        baseMatteReal[j] = baseMat;
        baseMatteMesh!.setMatrixAt(j, baseMat);
        baseReal[j] = ZERO_MATRIX;
        baseMesh!.setMatrixAt(j, ZERO_MATRIX);
      }
      // Цвет плиты держим на ОБОИХ мешах (paintAll красит все j независимо от облика).
      baseMesh!.setColorAt(j, color.set(ringBaseColor(d.node)));
      baseMatteMesh!.setColorAt(j, color.set(ringBaseColor(d.node)));

      // Пикинг папки: за один шаг ходим только на уровень глубже (§II.3.7) →
      // drill всегда в район d3-глубины 1 (для самого +1 это он сам).
      const drillTarget = districts[d.topIdx].node;
      districtPick[j] = { node: d.node, drillTarget };
      districtIndexByPath.set(d.node.path, j);
      // childPlacement только для прямых детей текущего уровня (d3-глубина 1).
      if (d.d3depth === 1) {
        placements.set(d.node.path, {
          s: Math.max(full.width, full.depth) / CITY_SPAN,
          cx: full.centerX,
          // Пол содержимого района = верх его плиты-постамента: под `G` активный
          // (пол 0) садится сюда → drill бесшовен по Y (decor уезжает вниз, план §8).
          cy: d.contentFloor,
          cz: full.centerZ,
          w: full.width,
          d: full.depth,
        });
      }
    });
    domeMesh.instanceMatrix.needsUpdate = true;
    baseMesh.instanceMatrix.needsUpdate = true;
    baseMatteMesh.instanceMatrix.needsUpdate = true;
    if (domeMesh.instanceColor) domeMesh.instanceColor.needsUpdate = true;
    if (baseMesh.instanceColor) baseMesh.instanceColor.needsUpdate = true;
    if (baseMatteMesh.instanceColor)
      baseMatteMesh.instanceColor.needsUpdate = true;
    group.add(baseMesh);
    group.add(baseMatteMesh);
    group.add(domeMesh);
  }

  // Облик: декор притушен, активный — полный. `excludedIdx` — район, ставший
  // активным уровнем (его купол/застройка в декоре скрыты). `decorBudget` — LOD-срез
  // по глубине (план §4): в декоре инстансы глубже бюджета скрыты, в активном — полный.
  let isDecor = false;
  let excludedIdx: number | null = null;
  let decorBudget = PREVIEW_MAX_DEPTH;
  // Множитель затемнения декора (план §7.1): 1 — полный цвет (неотличим от активного),
  // ниже — плавно в фон. Навигатор гонит его покадрово по `S_k` (градиент + кросс-фейд).
  let decorDim = DECOR_GRAY;

  /** Принадлежит ли район `j` исключённому поддереву (сам район +1 или всё под ним). */
  const districtExcluded = (j: number): boolean =>
    excludedIdx !== null &&
    (j === excludedIdx || districts[j].topIdx === excludedIdx);

  const view: CityView = {
    updateLOD() {
      // Детализация по глубине статична (§II.3.2) — покадрово делать нечего.
    },
    pickMeshes() {
      if (isDecor) return []; // декор не кликабелен (docs: формы без raycast)
      const out: InstancedMesh[] = [];
      // Сначала здания (по категориям), затем контейнеры — порядок стабилен (тесты
      // берут контейнеры с конца). Зданий несколько мешей (по одному на категорию).
      for (const g of buildGroups) out.push(g.mesh);
      if (domeMesh) out.push(domeMesh); // +1 купола
      if (baseMesh) out.push(baseMesh); // плиты-постаменты +1/+2
      if (baseMatteMesh) out.push(baseMatteMesh); // плиты-постаменты +3
      return out;
    },
    resolvePick(mesh, instanceId) {
      const bg = buildGroupByMesh.get(mesh as InstancedMesh);
      if (bg) return bg.pick[instanceId] ?? null;
      if (mesh === domeMesh || mesh === baseMesh || mesh === baseMatteMesh)
        return districtPick[instanceId] ?? null;
      return null;
    },
    isPickTarget(mesh, instanceId) {
      const bg = buildGroupByMesh.get(mesh as InstancedMesh);
      if (bg) {
        // Вложенный превью-домик (`districtIdx !== null`) — не самостоятельная
        // цель: пропускаем, чтобы луч дошёл до купола/плиты его папки.
        const it = bg.items[instanceId];
        return !!it && it.b.districtIdx === null;
      }
      return true; // купола/плиты — обычные цели пикинга
    },
  };

  /** Затемнить общий material меша до фактора `f` (per-instance цвета сохраняются):
   *  `f=1` — полный цвет, ниже — к фону. Фейд декора — через этот множитель, без
   *  прозрачности (план §7.1: «плавно к серому/в фон», а не alpha). */
  function dimMesh(mesh: InstancedMesh, f: number): void {
    const mat = mesh.material as MeshStandardMaterial | MeshLambertMaterial;
    mat.color.setRGB(f, f, f);
  }
  /** Вернуть общий material меша к белому (per-instance цвет = итоговый). */
  function whiten(mesh: InstancedMesh): void {
    const mat = mesh.material as MeshStandardMaterial | MeshLambertMaterial;
    mat.color.setRGB(1, 1, 1);
  }
  /**
   * Decor-фейд здания: у категорийного меша цвет держат МАТЕРИАЛЫ групп (графит/
   * корона/сталь/глянец), а per-instance цвет — множитель состояния. Поэтому фейд
   * декора множит цвет КАЖДОГО под-материала на его эталон `designed[g]·f` (а не
   * `setRGB(f,f,f)`, как у одноматериальных контейнеров). `f=1` — эталонные цвета.
   */
  function dimBuilding(g: BuildGroup, f: number): void {
    const mats = g.mesh.material as Material[];
    for (let i = 0; i < mats.length; i++) {
      (mats[i] as MeshStandardMaterial).color
        .copy(g.designed[i])
        .multiplyScalar(f);
    }
  }
  /** Применить текущий `decorDim` ко всем мешам (только цвет, без матриц) — для
   *  покадрового кросс-фейда декора (дёшево, матрицы не трогаем). */
  function recolorDecor(): void {
    for (const g of buildGroups) dimBuilding(g, decorDim);
    if (domeMesh) dimMesh(domeMesh, decorDim);
    if (baseMesh) dimMesh(baseMesh, decorDim);
    if (baseMatteMesh) dimMesh(baseMatteMesh, decorDim);
  }

  /** Привести инстансы в декор-облик: притушено, исключённое поддерево скрыто. */
  function applyDecor(): void {
    ground.visible = false;
    groundDots.visible = false;

    for (const g of buildGroups) {
      g.items.forEach((it, i) => {
        // Скрыто, если в исключённом поддереве ЛИБО глубже LOD-бюджета (§4).
        const hide =
          (it.b.topDistrictIdx !== null &&
            it.b.topDistrictIdx === excludedIdx) ||
          it.depth > decorBudget;
        g.mesh.setMatrixAt(i, hide ? ZERO_MATRIX : g.real[i]);
      });
      g.mesh.instanceMatrix.needsUpdate = true;
      dimBuilding(g, decorDim);
    }
    if (domeMesh && baseMesh && baseMatteMesh) {
      // Вырожденные по облику инстансы и так = ZERO (domeReal/baseReal/baseMatteReal).
      districts.forEach((d, j) => {
        // Сам дрилл-район (план §8): купол и застройку скрываем (их несёт активный
        // уровень), но ПЛИТУ-постамент оставляем на её каноническом месте — на неё
        // «садится» активный. Нужный вертикальный сдвиг (плита уходит на стопку вниз,
        // верх — на пол активного) даёт трансформ группы (`G⁻¹` с `cy`), репозициони-
        // ровать плиту вручную не нужно. d3-глубина исключённого = 1 → плита металл-
        // ческая (`baseReal`; `baseMatteReal[j]` и так ZERO).
        if (j === excludedIdx) {
          domeMesh!.setMatrixAt(j, ZERO_MATRIX);
          baseMatteMesh!.setMatrixAt(j, ZERO_MATRIX);
          baseMesh!.setMatrixAt(j, baseReal[j]);
          return;
        }
        // Остальное исключённое поддерево (под дрилл-районом) скрыто целиком; плюс
        // LOD-срез: район глубже бюджета тоже скрыт (§4, обратимо).
        const hide = districtExcluded(j) || d.d3depth > decorBudget;
        domeMesh!.setMatrixAt(j, hide ? ZERO_MATRIX : domeReal[j]);
        baseMesh!.setMatrixAt(j, hide ? ZERO_MATRIX : baseReal[j]);
        baseMatteMesh!.setMatrixAt(j, hide ? ZERO_MATRIX : baseMatteReal[j]);
      });
      domeMesh.instanceMatrix.needsUpdate = true;
      baseMesh.instanceMatrix.needsUpdate = true;
      baseMatteMesh.instanceMatrix.needsUpdate = true;
      dimMesh(domeMesh, decorDim);
      dimMesh(baseMesh, decorDim);
      dimMesh(baseMatteMesh, decorDim);
    }
  }

  /** Вернуть активный облик: всё видимо, материал плотный/белый, пикинг доступен. */
  function applyActive(): void {
    ground.visible = true;
    groundDots.visible = true;

    for (const g of buildGroups) {
      g.items.forEach((_, i) => g.mesh.setMatrixAt(i, g.real[i]));
      g.mesh.instanceMatrix.needsUpdate = true;
      dimBuilding(g, 1); // вернуть эталонные цвета материалов групп
    }
    if (domeMesh && baseMesh && baseMatteMesh) {
      districts.forEach((_, j) => {
        domeMesh!.setMatrixAt(j, domeReal[j]);
        baseMesh!.setMatrixAt(j, baseReal[j]);
        baseMatteMesh!.setMatrixAt(j, baseMatteReal[j]);
      });
      domeMesh.instanceMatrix.needsUpdate = true;
      baseMesh.instanceMatrix.needsUpdate = true;
      baseMatteMesh.instanceMatrix.needsUpdate = true;
      whiten(domeMesh);
      whiten(baseMesh);
      whiten(baseMatteMesh);
    }
  }

  /** Снять купол района `path` в отдельный анимируемый меш (см. Level.extractDome). */
  function extractDome(p: string): DrillDome | null {
    if (!domeMesh) return null;
    const j = districtIndexByPath.get(p);
    if (j === undefined) return null;
    const e = domeReal[j].elements;
    const sy = e[5];
    if (sy === 0) return null; // район не +1 — купола нет

    // Спрятать инстанс купола в общем меше — его место займёт отдельный меш.
    domeMesh.setMatrixAt(j, ZERO_MATRIX);
    domeMesh.instanceMatrix.needsUpdate = true;

    // Отдельный полупрозрачный купол (материал/геометрия — общие, см. makeDome*).
    const mat = makeDomeMaterial(true);
    const mesh = new Mesh(makeDomeGeometry(), mat);
    // domeReal[j] — чистое подобие (scale+translate, без вращений): берём прямо из
    // элементов матрицы, не раскладывая её.
    mesh.scale.set(e[0], sy, e[10]);
    const baseY = e[13];
    mesh.position.set(e[12], baseY, e[14]);
    mesh.renderOrder = 3; // поверх непрозрачных, как и обычный купол
    group.add(mesh);
    const liftBy = sy * DOME_LIFT_FACTOR;

    return {
      setProgress(prog) {
        applyDomeProgress(mesh, mat, baseY, liftBy, prog);
      },
      dispose() {
        group.remove(mesh);
        mesh.geometry.dispose();
        mat.dispose();
      },
    };
  }

  /** Снимки геометрии куполов +1 уровня (см. Level.childDomeDescriptors). */
  function childDomeDescriptors(): DomeDescriptor[] {
    const out: DomeDescriptor[] = [];
    if (!domeMesh) return out;
    districts.forEach((d, j) => {
      if (d.d3depth !== 1) return;
      const e = domeReal[j].elements;
      if (e[5] === 0) return; // район без купола (не +1)
      out.push({ sx: e[0], sy: e[5], sz: e[10], x: e[12], y: e[13], z: e[14] });
    });
    return out;
  }

  /** Показать/скрыть реальные купола +1 (см. Level.setChildDomesShown). */
  function setChildDomesShown(shown: boolean): void {
    if (!domeMesh) return;
    districts.forEach((d, j) => {
      if (d.d3depth !== 1 || domeReal[j].elements[5] === 0) return;
      domeMesh!.setMatrixAt(j, shown ? domeReal[j] : ZERO_MATRIX);
    });
    domeMesh.instanceMatrix.needsUpdate = true;
  }

  /** Затемнение периметра «на входе» (drill), кроме раскрываемого поддерева — см.
   *  Level.setEnterDim. Только per-instance цвет, без матриц. Периметр гаснет как
   *  МОДО-цвет узла × factor (`modeColorInto` — тот же источник, что и setHighlight/
   *  setCleanup), поэтому во время зума облик режима СОХРАНЯЕТСЯ (совпадения/метки не
   *  «сбрасываются» в категорийный цвет). `match`/`cleanup` — текущий облик режима. */
  function setEnterDim(
    excludePath: string,
    factor: number,
    match: ((n: ScanNode) => boolean) | null,
    cleanup: {
      isMarked: (n: ScanNode) => boolean;
      isCandidate: (n: ScanNode) => boolean;
    } | null,
  ): void {
    const exIdx = districtIndexByPath.get(excludePath) ?? null;
    for (const g of buildGroups) {
      g.items.forEach((it, i) => {
        // Раскрываемое поддерево остаётся ярким (его подхватит новый активный).
        if (it.b.topDistrictIdx !== null && it.b.topDistrictIdx === exIdx)
          return;
        // Модо-цвет × factor: периметр гаснет, но облик режима сохраняется.
        modeColorInto(color, 0xffffff, it.b.node, match, cleanup);
        g.mesh.setColorAt(i, color.multiplyScalar(factor));
      });
      if (g.mesh.instanceColor) g.mesh.instanceColor.needsUpdate = true;
    }
    if (domeMesh && baseMesh && baseMatteMesh) {
      districts.forEach((d, j) => {
        if (j === exIdx || d.topIdx === exIdx) return;
        const ring = ringBaseColor(d.node);
        domeMesh!.setColorAt(
          j,
          modeColorInto(
            color,
            GLASS_COLOR,
            d.node,
            match,
            cleanup,
          ).multiplyScalar(factor),
        );
        baseMesh!.setColorAt(
          j,
          modeColorInto(color, ring, d.node, match, cleanup).multiplyScalar(
            factor,
          ),
        );
        baseMatteMesh!.setColorAt(
          j,
          modeColorInto(color, ring, d.node, match, cleanup).multiplyScalar(
            factor,
          ),
        );
      });
      if (domeMesh.instanceColor) domeMesh.instanceColor.needsUpdate = true;
      if (baseMesh.instanceColor) baseMesh.instanceColor.needsUpdate = true;
      if (baseMatteMesh.instanceColor)
        baseMatteMesh.instanceColor.needsUpdate = true;
    }
  }

  return {
    group,
    path,
    span,
    view,
    extractDome,
    childDomeDescriptors,
    setChildDomesShown,
    setEnterDim,
    childPlacement(p) {
      return placements.get(p) ?? null;
    },
    setDecor(excludePath, budget = PREVIEW_MAX_DEPTH, dim = DECOR_GRAY) {
      isDecor = true;
      excludedIdx =
        (excludePath !== undefined
          ? districtIndexByPath.get(excludePath)
          : undefined) ?? null;
      decorBudget = budget;
      decorDim = dim;
      applyDecor();
    },
    setDecorBudget(budget) {
      if (!isDecor || budget === decorBudget) return;
      decorBudget = budget;
      applyDecor();
    },
    setDecorDim(dim) {
      if (!isDecor || dim === decorDim) return;
      decorDim = dim;
      recolorDecor(); // только цвет, без матриц — дёшево покадрово
    },
    setGroundShown(visible) {
      ground.visible = visible;
      groundDots.visible = visible;
    },
    setActive() {
      if (!isDecor) return;
      isDecor = false;
      excludedIdx = null;
      decorBudget = PREVIEW_MAX_DEPTH;
      decorDim = DECOR_GRAY;
      applyActive();
    },
    setHighlight(match) {
      paintAll((node, base) => modeColorInto(color, base, node, match, null));
    },
    setCleanup(cleanup) {
      paintAll((node, base) => modeColorInto(color, base, node, null, cleanup));
    },
    dispose() {
      disposeGroup(group);
    },
  };

  /**
   * Перекрасить per-instance цвета всех мешей по правилу `paint(node, baseColor)`.
   * База: ЗДАНИЯ — белый `0xffffff` (per-instance цвет здания = МНОЖИТЕЛЬ состояния
   * поверх материалов категории: highlight/cleanup гасят/красят домножением); купол —
   * нейтральное стекло; ободок/плита — цвет района (абсолют). Купол/ободок/заглушки
   * одного района красятся согласованно (узел района).
   */
  function paintAll(paint: (node: ScanNode, base: number) => Color): void {
    for (const g of buildGroups) {
      g.items.forEach((it, i) => {
        g.mesh.setColorAt(i, paint(it.b.node, 0xffffff));
      });
      if (g.mesh.instanceColor) g.mesh.instanceColor.needsUpdate = true;
    }
    if (domeMesh && baseMesh && baseMatteMesh) {
      // Цвет держим на ВСЕХ инстансах обоих плит-мешей (на случай смены глубины/
      // декора): купол — стекло, плиты — цвет района.
      districts.forEach((d, j) => {
        domeMesh!.setColorAt(j, paint(d.node, GLASS_COLOR));
        baseMesh!.setColorAt(j, paint(d.node, ringBaseColor(d.node)));
        baseMatteMesh!.setColorAt(j, paint(d.node, ringBaseColor(d.node)));
      });
      if (domeMesh.instanceColor) domeMesh.instanceColor.needsUpdate = true;
      if (baseMesh.instanceColor) baseMesh.instanceColor.needsUpdate = true;
      if (baseMatteMesh.instanceColor)
        baseMatteMesh.instanceColor.needsUpdate = true;
    }
  }
}

/** clamp+smoothstep на [0,1] — мягкая интерполяция для радиального угасания. */
function smoothstep01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** Радиальное «t» угасания земли/сетки: 0 в центре города, 1 — к краю апрона. */
function groundFade(x: number, z: number, half: number): number {
  const r = Math.min(1, Math.hypot(x, z) / half);
  return smoothstep01((r - 0.35) / 0.6);
}

/**
 * Земля-«апрон»: большой матовый план вокруг города (×GROUND_APRON), цвет
 * радиально гаснет к краям из `GROUND_COLOR` в `GROUND_EDGE_COLOR` (=--bg) через
 * vertex-colors — у города нет «парящего» острого края, он тает в фон.
 */
function makeFadedGround(span: LevelSpan): Mesh {
  const S = Math.max(span.w, span.d) * GROUND_APRON;
  const geo = new PlaneGeometry(S, S, 48, 48);
  const base = new Color(GROUND_COLOR);
  const edge = new Color(GROUND_EDGE_COLOR);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const half = S / 2;
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    // План ещё не повёрнут: локальные (x,y) → мировые (x,z) после rotateX(-90°).
    const t = groundFade(pos.getX(i), pos.getY(i), half);
    c.copy(base).lerp(edge, t);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new Float32BufferAttribute(colors, 3));
  const ground = new Mesh(geo, new MeshLambertMaterial({ vertexColors: true }));
  ground.rotation.x = -Math.PI / 2; // в плоскость XZ
  ground.position.y = -0.3; // чуть ниже основания зданий и подиума
  return ground;
}

/** Одна точка дороги: позиция (мир XZ), масштаб и «яркость» (смешение с белым). */
interface DotSpec {
  x: number;
  z: number;
  scale: number;
  alpha: number;
}

/**
 * Dot-grid земли (vision §II.4): регулярная мировая сетка точек по ВСЕМУ апрону,
 * включая площадь под городом (в зазорах между зданиями читается как «текстура
 * земли», под домами скрыта их непрозрачностью). Яркость точки — bright в центре,
 * радиально гаснет к краям (та же кривая `groundFade`, что и у самой земли), поэтому
 * сетка тает в фон вместе с апроном. Дорог-бордюров нет (vision §II.4, ревизия):
 * разделение блоков несут постаменты и стекло куполов.
 */
function buildGroundDots(span: LevelSpan): InstancedMesh {
  const dots: DotSpec[] = [];
  const half = (Math.max(span.w, span.d) * GROUND_APRON) / 2;
  for (let x = -half; x <= half; x += APRON_STEP) {
    for (let z = -half; z <= half; z += APRON_STEP) {
      // groundFade: 0 в центре → 1 к краю; яркость точки — обратная (ярче в центре).
      const fade = 1 - groundFade(x, z, half);
      if (fade <= 0.02) continue; // у самого края точки невидимы — не создаём
      dots.push({ x, z, scale: 1, alpha: APRON_DOT_ALPHA * fade });
    }
  }
  return makeDotMesh(dots, span);
}

/**
 * Собрать слой точек в один `InstancedMesh` (общий код дорог и dot-grid земли).
 * Точка — плоский кружок (`CircleGeometry` в XY), кладём в XZ поворотом и масштабируем
 * под «яркость»/угол на матрице инстанса. Цвет = локальный цвет земли (с тем же
 * радиальным угасанием) → подмешан к белому на «яркость» точки, так далёкие точки
 * тают вместе с землёй.
 */
function makeDotMesh(dots: DotSpec[], span: LevelSpan): InstancedMesh {
  const half = (Math.max(span.w, span.d) * GROUND_APRON) / 2;
  const mesh = new InstancedMesh(
    new CircleGeometry(DOT_R, 10),
    new MeshBasicMaterial(),
    dots.length,
  );
  const dummy = new Object3D();
  const base = new Color(GROUND_COLOR);
  const edge = new Color(GROUND_EDGE_COLOR);
  const white = new Color(0xffffff);
  const col = new Color();
  for (let i = 0; i < dots.length; i++) {
    const d = dots[i];
    dummy.position.set(d.x, 0.02, d.z); // чуть выше земли — без z-fight
    dummy.rotation.set(-Math.PI / 2, 0, 0);
    dummy.scale.setScalar(d.scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    col
      .copy(base)
      .lerp(edge, groundFade(d.x, d.z, half))
      .lerp(white, d.alpha);
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false; // апрон широкий — не отсекать целиком по bbox
  return mesh;
}

/** Освободить GPU-ресурсы группы (geometry/material/текстуры) и очистить её. */
function disposeGroup(group: Group): void {
  const disposeMat = (m: Material): void => {
    const tex = (m as MeshLambertMaterial).map;
    if (tex) tex.dispose(); // текстура земли (dot-grid)
    m.dispose();
  };
  for (const child of [...group.children]) {
    group.remove(child);
    if (child instanceof InstancedMesh || child instanceof Mesh) {
      child.geometry.dispose();
      const mat = child.material;
      if (Array.isArray(mat)) mat.forEach(disposeMat);
      else disposeMat(mat);
    }
  }
}
