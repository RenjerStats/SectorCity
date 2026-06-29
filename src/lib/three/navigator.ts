/**
 * Бесшовная навигация по уровням (фаза 2, «Зум с превью» → «Бесшовная навигация»).
 *
 * Модель ZUI (Pad++/Piccolo): на сцене активный уровень + СТЕК декораций —
 *   - `active` — содержимое открытой папки: канонический (identity), кликабельный,
 *     с LOD;
 *   - `decorStack` — цепочка предков (родитель → дед → …), каждый рибейзнут
 *     подобием `G⁻¹` своей глубины (раздут, выглядывает по краям), притушен, без
 *     пикинга. Контекст держится ≥ `DECOR_KEEP_DEPTH` уровней вглубь и при drill,
 *     и при `up` — чтобы шов не рвался резким исчезновением окружения (план §1–§3).
 *
 * Почему дёшево по геометрии: d3-treemap детерминирован и scale-инвариантен, поэтому
 * превью района D внутри родителя СОВПАДАЕТ с раскладкой D как самостоятельного
 * уровня (см. `city.ts`). Drill — не перестройка, а «промоут превью в активный».
 *
 * Origin shift (floating origin). Каждый спуск — подразбиение прямоугольника, и
 * без нормировки активный уровень съёжился бы у нуля (поехали бы depth-buffer,
 * near/far, пороги LOD и контролов, калиброванные под канонический масштаб).
 * Решение: активный уровень ВСЕГДА строится канонически (identity), а камера после
 * каждого drill встаёт в одну и ту же каноническую позу `P`. «Сдвиг» прячется так:
 *   - размещение уровня в прямоугольник района — similarity `G(local)=s·local+C`;
 *   - в `onArrive` твина: новый active строится канонически (identity), старый
 *     active → decor получает `G⁻¹` (scale `1/s`, pos `−C/s`), камера = `P`.
 * Поскольку одну и ту же `G` применяли бы и к контенту, и к камере, картинка
 * пиксель-в-пиксель та же до и после — origin shift невидим (см. backlog).
 *
 * Это императивный 3D-слой: данные уровней (IPC `get_level`) подаёт владелец
 * (`Scene.svelte`), навигатор отвечает за геометрию, камеру и rebase. С DOM не
 * общается — мост пикинга кладёт в `content.userData` (см. `activeView`).
 */
import { type Group, Vector3 } from "three";
import { Easing } from "@tweenjs/tween.js";
import type { ScanNode } from "../ipc/contract";
import type { SceneHandle } from "./scene";
import { INITIAL_CAMERA_POS, INITIAL_TARGET } from "./home";
import {
  buildLevel,
  CITY_SPAN,
  createDomeFlight,
  PREVIEW_MAX_DEPTH,
  type CityView,
  type Level,
} from "./city";
import {
  composeChildInverse,
  composeForward,
  composeInverse,
  forwardG,
  identityTransform,
  inverseG,
  type LayerTransform,
  spanFromPlacement,
} from "./transform";

/**
 * Потолок числа хранимых декор-слоёв (план §5/§10, `N_max`). Слои сверх него
 * (самые дальние) уничтожаются на drill; на `up` дальний слой добирается заново
 * (этап 6). Контекста хотим ≥ `DECOR_KEEP_DEPTH` (3) — потолок чуть выше под
 * запас. Каждый слой — отдельная геометрия уровня, поэтому потолок ограничен
 * памятью/перфом (план §11).
 */
export const N_MAX = 4;

/**
 * Порог `S0` (план §5): пока кумулятивный масштаб слоя `S_k ≤ S0` — он «ещё крупный»,
 * держим полный бюджет. Каждое удвоение `S_k` сверх `S0` (ещё «октава» зума-наружу)
 * срезает один уровень LOD.
 */
const DECOR_S0 = 1.5;
/**
 * Порог `S_drop` (план §5): за ним слой практически вне кадра (в центре — активный,
 * слой раздут ×`S_k`) → бюджет 0 (контур). Дальше он же — кандидат на дроп (§6).
 */
const DECOR_S_DROP = 7;

/**
 * Зум-зависимый LOD-бюджет декор-слоя по его `S_k` (план §5):
 * `b = clamp(PREVIEW_MAX_DEPTH − floor(log2(S_k/S0)), 0, PREVIEW_MAX_DEPTH)`, плюс
 * жёсткий ноль за `S_drop`. Привязка к `S_k`, а не к индексу: серия СЛАБЫХ drill'ов
 * (s≈1, S_k≈1) держит много слоёв на полном бюджете, один СИЛЬНЫЙ (малый s, большой
 * S_k) быстро срезает дальние — они и так ушли из кадра. Базовая схема §4 (по индексу)
 * — частный случай при «среднем» s.
 */
export function budgetFromS(S: number): number {
  if (S > DECOR_S_DROP) return 0;
  const cut = Math.floor(Math.log2(Math.max(S, DECOR_S0) / DECOR_S0));
  return Math.max(0, Math.min(PREVIEW_MAX_DEPTH, PREVIEW_MAX_DEPTH - cut));
}

/** Затемнение БЛИЖНЕГО слоя (`S≤S0`): заметно темнее активного (1.0) — L1 читается
 *  как «контекст вокруг», а не как продолжение открытой папки. Полный цвет (1.0)
 *  держит только активный. Это же — амплитуда видимого fade-out на drill (1.0→0.6). */
const DECOR_DIM_NEAR = 0.6;
/** Порог затемнения самого дальнего видимого слоя (на `S_drop`): тёмный, но НЕ чёрный
 *  — слои не уходят в чистый фон (за `S_drop` они всё равно дропаются, бюджет 0). */
const DECOR_DIM_FAR = 0.3;
/** Длительность кросс-фейда градиента/появления дальнего слоя (план §10). */
const DECOR_FADE_MS = 250;

/**
 * Множитель затемнения декор-слоя по его `S_k` (план §7.1): `DECOR_DIM_NEAR` у близких
 * (`S≤S0`) — чуть темнее активного, КВАДРАТИЧНЫЙ fade-out к порогу `DECOR_DIM_FAR` на
 * `S_drop` (медленно у ближних, быстрее к дальним; в чёрный не уходит). Это ЦЕЛЬ;
 * показанное значение навигатор ведёт к ней кросс-фейдом (`updateFade`).
 */
export function colorFactorFromS(S: number): number {
  if (S <= DECOR_S0) return DECOR_DIM_NEAR;
  const t = Math.min(1, (S - DECOR_S0) / (DECOR_S_DROP - DECOR_S0));
  return DECOR_DIM_NEAR - (DECOR_DIM_NEAR - DECOR_DIM_FAR) * t * t;
}

/** Декор-слой стека: уровень + накопленный трансформ-подобие, его `S_k` и бюджет
 *  LOD (этап 2+). От `decorStack[0]` (ближайший родитель) к дальним предкам. */
interface DecorLayer {
  level: Level;
  transform: LayerTransform;
  /** Кумулятивный масштаб `S_k = transform.scale` (план §3.2): во сколько раз
   *  контент слоя показан крупнее активного. Мера «удалённости на задний план». */
  S: number;
  /** Глубина LOD, до которой слой несёт реальную застройку (план §4/§5). */
  budget: number;
  /** ПОКАЗАННЫЙ множитель затемнения (план §7.1); ведётся кросс-фейдом к
   *  `colorFactorFromS(S)`. На свопе НЕ трогается — отсюда инвариант кадра (§7). */
  dimShown: number;
}

/** Снимок стека для диагностики/тестов: активный путь + декор-слои (ближний→дальний). */
export interface NavInspect {
  activePath: string | null;
  decor: { path: string; S: number; budget: number; dim: number }[];
}

/** Мост пикинга: активный уровень для слоя взаимодействия (либо `null`). */
export function activeView(content: Group): CityView | null {
  return (content.userData.activeView as CityView | undefined) ?? null;
}

/** Можно ли сейчас пикать (false во время твина зума — чтобы не ловить хвосты). */
export function isInteractive(content: Group): boolean {
  return content.userData.interactive === true;
}

/** Управление навигацией для владельца сцены. */
export interface CityNavigator {
  /** Сбросить мир к единственному активному уровню (старт/после скана/прыжок). */
  reset(nodes: ScanNode[], path: string): void;
  /**
   * Пересобрать активный уровень новыми `nodes` НА МЕСТЕ: тот же путь и span,
   * камера и декор-родитель не трогаются (смена порога агрегатора — это перерас-
   * кладка текущего уровня, а не навигация). `nodes` должны быть детьми того же
   * активного пути. Если активного уровня нет — no-op.
   */
  rebuildActive(nodes: ScanNode[]): void;
  /** Бесшовный drill в район `node`; `childNodes` = `get_level(node.path)`. */
  drill(node: ScanNode, childNodes: ScanNode[], ms: number): Promise<void>;
  /** Можно ли бесшовно подняться к `parentPath` (это ближайший декор-родитель). */
  canUp(parentPath: string): boolean;
  /** Бесшовный подъём к родителю (промоут ближайшего декора в активный). */
  up(ms: number): Promise<void>;
  /**
   * Путь уровня, ЧЕЙ РОДИТЕЛЬ стоит дочитать дальним декор-слоем (план §6), если в
   * стеке есть место (< `N_MAX`). Это самый дальний удерживаемый слой (или активный,
   * если стек пуст). Владелец берёт родителя этого пути из крошек и зовёт
   * `appendFarAncestor`. `null` — буфер полон либо мира нет.
   */
  farthestHeldPath(): string | null;
  /**
   * Дочитать дальний декор-слой `parentPath` (предок самого дальнего из стека),
   * построив его из `parentNodes` и пристыковав ПОДОБИЕМ к цепочке (план §6). Нужен,
   * чтобы после `up` восстановить запас контекста, срезанный лимитом `N_MAX` при
   * глубоком drill. No-op (false), если места нет либо `parentNodes` не содержат
   * текущий дальний уровень как район.
   */
  appendFarAncestor(parentPath: string, parentNodes: ScanNode[]): boolean;
  /** Покадрово: LOD активного уровня по позиции камеры. */
  updateLOD(): void;
  /**
   * Покадрово: кросс-фейд затемнения декор-слоёв к их `colorFactorFromS(S)` (план
   * §7.1). `dtMs` — время кадра. Меняет только ПОКАЗАННЫЙ dim (не на свопе), поэтому
   * не рвёт инвариант кадра (§7). No-op, если декора нет / всё уже сошлось.
   */
  updateFade(dtMs: number): void;
  /**
   * Подсветка-фильтр: применить предикат к активному уровню и запомнить его —
   * навигатор переприменяет его при каждой смене активного (drill/up/reset), так
   * что фильтр «переживает» навигацию. `null` — снять подсветку.
   */
  applyHighlight(match: ((node: ScanNode) => boolean) | null): void;
  /**
   * Облик режима «Сканер мусора» (vision §I.7). `view ≠ null` — включить «вид
   * очистки» на активном уровне (кандидаты ярко, прочее в тень, помеченные —
   * красным); `null` — выключить и вернуть подсветку-фильтр. Как и подсветка,
   * переживает навигацию: переприменяется при каждой смене активного уровня.
   */
  setCleanup(
    view: {
      isMarked: (node: ScanNode) => boolean;
      isCandidate: (node: ScanNode) => boolean;
    } | null,
  ): void;
  /** Снимок стека (активный + декор-слои) для диагностики/тестов. */
  inspect(): NavInspect;
  /** Освободить все уровни. */
  dispose(): void;
}

export function createNavigator(handle: SceneHandle): CityNavigator {
  const content = handle.content;
  let active: Level | null = null;
  // Стек декораций: ближайший родитель — `decorStack[0]`, дальше предки.
  let decorStack: DecorLayer[] = [];
  // Текущий предикат подсветки-фильтра; переприменяется при смене активного.
  let currentMatch: ((node: ScanNode) => boolean) | null = null;
  // Облик сканера мусора (если включён); тоже переживает навигацию.
  let cleanupView: {
    isMarked: (node: ScanNode) => boolean;
    isCandidate: (node: ScanNode) => boolean;
  } | null = null;
  // Span каждого посещённого уровня (path → прямоугольник): нужен, чтобы дочитать на
  // `up` дальний слой С ТЕМ ЖЕ аспектом, с каким он строился активным (иначе treemap
  // дал бы другую раскладку → рассинхрон с удерживаемым ребёнком). Предок дочита —
  // всегда посещённый (drill идёт по одному уровню), так что его span здесь есть.
  let levelSpans = new Map<string, { w: number; d: number }>();

  /** Применить облик к уровню: подсветка-фильтр, поверх неё — вид очистки (если он
   *  включён). Зовётся при каждой смене активного уровня (reset/rebuild/drill/up). */
  function applyAppearance(level: Level): void {
    level.setHighlight(currentMatch);
    if (cleanupView) level.setCleanup(cleanupView);
  }

  function setActiveView(level: Level | null): void {
    content.userData.activeView = level ? level.view : null;
  }
  function setInteractive(on: boolean): void {
    content.userData.interactive = on;
  }

  function disposeLevel(level: Level): void {
    content.remove(level.group);
    level.dispose();
  }

  /** Применить трансформ-подобие слоя к его группе (scale + position). */
  function applyLayerTransform(group: Group, t: LayerTransform): void {
    group.scale.setScalar(t.scale);
    group.position.copy(t.position);
  }

  /** Пересчитать и применить LOD-бюджеты всех декор-слоёв (после любого сдвига стека:
   *  drill/up меняют `S`/позицию слоёв). Бюджет — по `S_k` (план §4/§5, обратимое
   *  скрытие без ребилда). «Слоёный пирог» плит (верх плиты дрилл-района L1 на полу
   *  активного, дальше ступенями вниз, план §8) теперь даёт сам трансформ-подобие
   *  слоя: `G⁻¹` с `cy = contentFloor` опускает каждый слой на нужную высоту, плита
   *  стоит на каноническом месте (`setDecor` её больше не репозиционирует). */
  function applyDecorBudgets(): void {
    for (const layer of decorStack) {
      const b = budgetFromS(layer.S);
      layer.budget = b;
      layer.level.setDecorBudget(b);
    }
  }

  /** Держать видимой РОВНО ОДНУ землю-«пол» — у самого дальнего уровня стопки. Его
   *  `G⁻¹`-рибейз кладёт землю под низ всего «слоёного пирога», поэтому плиты дедов
   *  не уходят под землю активного (план §8). Это бесшовно: дальняя земля — та же
   *  корневая, отъезжающая вместе с камерой тем же подобием. У активного земля видна
   *  только когда стопки нет (он сам — дно). Зовётся после любого сдвига стека. */
  function updateGround(): void {
    if (!active) return;
    active.setGroundShown(decorStack.length === 0);
    const last = decorStack.length - 1;
    decorStack.forEach((layer, i) => layer.level.setGroundShown(i === last));
  }

  /** Снести весь стек декораций (drop всех слоёв). */
  function clearDecor(): void {
    for (const layer of decorStack) disposeLevel(layer.level);
    decorStack = [];
  }

  function reset(nodes: ScanNode[], path: string): void {
    if (active) disposeLevel(active);
    clearDecor();
    levelSpans = new Map(); // новый корень/прыжок — прежние span'ы недействительны
    // Корень/прыжок: квадратный канонический холст.
    const span = { w: CITY_SPAN, d: CITY_SPAN };
    levelSpans.set(path, span);
    active = buildLevel(nodes, span, path);
    content.add(active.group);
    applyAppearance(active); // фильтр + вид очистки переживают пересборку уровня
    setActiveView(active);
    updateGround(); // стек пуст — землю даёт сам активный
    setInteractive(true);
    handle.placeCamera(INITIAL_CAMERA_POS, INITIAL_TARGET);
  }

  function rebuildActive(nodes: ScanNode[]): void {
    if (!active) return;
    const { path, span } = active;
    // Активный уровень всегда в identity (origin shift), поэтому пересборка с тем
    // же span сохраняет геометрию под камерой; декор-родитель остаётся как есть
    // (его превью данного района и так скрыто, см. drill → setDecor).
    disposeLevel(active);
    active = buildLevel(nodes, span, path);
    content.add(active.group);
    applyAppearance(active); // подсветка + вид очистки переживают пересборку
    setActiveView(active);
    updateGround(); // новый активный: землю показываем по состоянию стопки
  }

  async function drill(
    node: ScanNode,
    childNodes: ScanNode[],
    ms: number,
  ): Promise<void> {
    if (!active) return;
    const g = active.childPlacement(node.path);
    if (!g) {
      // Узел не район текущего активного уровня — деградируем в обычную пересборку.
      reset(childNodes, node.path);
      return;
    }
    const fromActive = active;

    // Камера летит к `G(P)`: вид «внутрь» района; превью уточняется LOD по пути.
    const camTo = forwardG(INITIAL_CAMERA_POS, g);
    const tgtTo = forwardG(INITIAL_TARGET, g);

    // Цель затемнения периметра = облик будущего L1 (бывший активный, `S = 1/s`).
    // Его и ведём ЗА ВЕСЬ зум: на свопе периметр уже на месте, хвостового фейда нет.
    const targetDim = colorFactorFromS(1 / g.s);
    // Снять купол раскрываемого района в отдельный меш и анимировать его уход вверх
    // синхронно с зумом (vision §II.3.6) — вместо «прыжка» исчезновения на свопе.
    const enterDome = fromActive.extractDome(node.path);
    enterDome?.setProgress(0);

    // Новый активный строим ЗАРАНЕЕ (переиспользуем на свопе) — нужны снимки его
    // куполов +1, чтобы дочерние папки «надевали» купола (опускались) синхронно с
    // зумом, а не появлялись мгновенно на свопе («из ниоткуда»). Купола-«рой» кладём
    // в кадр раскрываемого района (подобие `G`: scale `g.s`, центр `C`), поэтому они
    // садятся ровно на постаменты детей и на свопе совпадают с реальными куполами
    // `next` (origin shift: G-кадр из camTo = identity из P, см. шапку).
    const childSpan = spanFromPlacement(g);
    levelSpans.set(node.path, childSpan); // для возможного дочита на `up` (§6)
    const next = buildLevel(childNodes, childSpan, node.path);
    const childDomes = createDomeFlight(
      next.childDomeDescriptors(),
      g.s,
      new Vector3(g.cx, g.cy, g.cz),
    );
    childDomes.setProgress(1); // старт: подняты и растворены (как было «пусто»)
    content.add(childDomes.group);

    setInteractive(false);
    await handle.flyTo(
      camTo,
      tgtTo,
      ms,
      () => {
        // origin shift в кадре завершения (см. шапку): следующий render нормирован.
        content.add(next.group); // канонически, identity
        applyAppearance(next); // фильтр + вид очистки переживают drill

        // Весь существующий стек получает `G⁻¹` сверху (раздувается ещё на ×1/s).
        for (const layer of decorStack) {
          layer.transform = composeInverse(g, layer.transform);
          layer.S = layer.transform.scale;
          applyLayerTransform(layer.level.group, layer.transform);
        }

        // Старый активный → новый `decorStack[0]` в `G⁻¹` (раздут, по краям). Силуэт
        // самого района `node` скрываем — иначе он накрыл бы новый активный уровень.
        const t0 = composeInverse(g, identityTransform());
        applyLayerTransform(fromActive.group, t0);
        fromActive.setHighlight(null); // декор — нейтральный контекст, без подсветки
        // setHighlight выше вернул базовые per-instance цвета (снял `setEnterDim`), а
        // здесь ставим итоговый декор-облик. Затемнение уже доведено до `targetDim` ЗА
        // время зума (`onProgress`), поэтому на свопе пиксель тот же — хвостового фейда
        // нет (раньше L1 рождался с 1.0 и темнел уже ПОСЛЕ прилёта).
        fromActive.setDecor(node.path, budgetFromS(t0.scale), targetDim);
        decorStack.unshift({
          level: fromActive,
          transform: t0,
          S: t0.scale,
          budget: budgetFromS(t0.scale),
          dimShown: targetDim, // уже на цели — `updateFade` тут ничего не доводит
        });
        enterDome?.dispose(); // купол уже снят анимацией; убрать временный меш
        childDomes.dispose(); // купола детей сели; дальше их несёт реальный `next`

        // Дроп: слои за `S_drop` (бюджет 0 → уже ничего не рисуют, дроп невидим) и за
        // потолком `N_MAX` (память). S монотонна по глубине → режем хвост. На `up`
        // дальний слой добираем заново (§6).
        while (
          decorStack.length > 0 &&
          (decorStack.length > N_MAX ||
            decorStack[decorStack.length - 1].S > DECOR_S_DROP)
        ) {
          const dropped = decorStack.pop()!;
          disposeLevel(dropped.level);
        }

        // Стек сдвинулся вглубь — пересчитать LOD-бюджеты (§4/§5). Вертикальную стопку
        // плит даёт сам рибейз-подобие слоёв (`cy`), отдельный подиум не нужен (§8).
        applyDecorBudgets();

        active = next;
        setActiveView(active);
        // Землю показываем у самого дальнего слоя (дно пирога, §8). ВАЖНО: после
        // `active = next` — иначе скрыли бы землю не у того уровня (а у нового — нет).
        updateGround();
        handle.placeCamera(INITIAL_CAMERA_POS, INITIAL_TARGET);
        setInteractive(true);
      },
      (p) => {
        // Сопутствующие анимации drill — на том же отрезке, что и зум: периметр
        // плавно уходит в декор-цвет (раскрываемое поддерево остаётся ярким), купол
        // раскрываемого района уезжает вверх и тает, а купола дочерних папок
        // «надеваются» — опускаются на свои постаменты (зеркало `enterDome`).
        const e = Easing.Cubic.InOut(p);
        fromActive.setEnterDim(node.path, 1 + (targetDim - 1) * e);
        enterDome?.setProgress(p);
        childDomes.setProgress(1 - p);
      },
    );
  }

  function canUp(parentPath: string): boolean {
    return decorStack.length > 0 && decorStack[0].level.path === parentPath;
  }

  async function up(ms: number): Promise<void> {
    if (!active || decorStack.length === 0) return;
    const parent = decorStack[0].level;
    const child = active;
    const g = parent.childPlacement(child.path);
    if (!g) {
      // Несогласованность — деградируем: оставляем родителя как есть нельзя без
      // данных, поэтому просто промоутим без анимации.
      reset([], parent.path);
      return;
    }

    // Камера отъезжает к `G⁻¹(P)`: родитель (декор, раздут) кадрируется целиком.
    const camTo = inverseG(INITIAL_CAMERA_POS, g);
    const tgtTo = inverseG(INITIAL_TARGET, g);

    // Зеркало drill: родитель (декор) ЗА ВЕСЬ зум разгорается до активного облика,
    // а купол покидаемого района «надевается» обратно — опускается сверху и проявля-
    // ется (vision §II.3.6). Стартовое затемнение родителя — его текущий показанный
    // dim; купол стартует снятым (`setProgress(1)`) и садится к концу отрезка.
    const parentDimStart = decorStack[0].dimShown;
    const upDome = parent.extractDome(child.path);
    upDome?.setProgress(1);

    // Зеркало drill: собственные купола +1 уходящего уровня «снимаются» — поднимаются
    // и тают синхронно с отъездом камеры (в кадре активного, identity), вместо
    // мгновенного исчезновения на свопе. Реальные купола прячем, анимирует «рой».
    const childDomes = createDomeFlight(
      child.childDomeDescriptors(),
      1,
      new Vector3(0, 0, 0),
    );
    childDomes.setProgress(0); // старт: на месте, непрозрачны
    child.setChildDomesShown(false);
    content.add(childDomes.group);

    setInteractive(false);
    await handle.flyTo(
      camTo,
      tgtTo,
      ms,
      () => {
        // Уходящий активный (центр кадра) убираем — его место займёт превью в родителе.
        childDomes.dispose(); // купола сняты анимацией; убрать временный «рой»
        disposeLevel(child);

        // Весь стек получает `G` сверху (ровно обратное drill). Ближайший декор при
        // этом возвращается в identity → промоутим его в активный уровень.
        for (const layer of decorStack) {
          layer.transform = composeForward(g, layer.transform);
          layer.S = layer.transform.scale;
        }
        decorStack.shift(); // снимаем бывший decorStack[0] (теперь identity)

        // Родитель (декор) → активный: identity + полный облик.
        parent.group.position.set(0, 0, 0);
        parent.group.scale.setScalar(1);
        parent.setActive(); // вернёт белый материал и покажет настоящий купол района
        upDome?.dispose(); // временный «надеваемый» купол больше не нужен
        applyAppearance(parent); // фильтр + вид очистки переживают подъём

        // Оставшиеся декор-слои репозиционируем по их forward-рибейзнутым трансформам.
        for (const layer of decorStack) {
          applyLayerTransform(layer.level.group, layer.transform);
        }

        // Стек поднялся на уровень — бюджеты выросли (скрытые инстансы возвращаются, §4).
        // Стопку плит пересчитывать вручную не нужно: её несёт рибейз-подобие слоёв (§8).
        applyDecorBudgets();

        active = parent;
        setActiveView(active);
        // Землю — по новому дну стопки. ВАЖНО: после `active = parent` (иначе тронули бы
        // уходящего ребёнка, а у нового активного земля осталась бы видимой).
        updateGround();
        handle.placeCamera(INITIAL_CAMERA_POS, INITIAL_TARGET);
        setInteractive(true);
        // Если глубина просела ниже `N_MAX` (лимит срезал дальние при глубоком drill),
        // владелец дочитывает дальний слой через `farthestHeldPath`/`appendFarAncestor`.
      },
      (p) => {
        // Сопутствующие анимации up — на отрезке зума: родитель разгорается из декора
        // в активный облик, купол покидаемого района опускается на место и проявляется,
        // а собственные купола уходящего уровня «снимаются» — уезжают вверх и тают.
        const e = Easing.Cubic.InOut(p);
        parent.setDecorDim(parentDimStart + (1 - parentDimStart) * e);
        upDome?.setProgress(1 - p);
        childDomes.setProgress(p);
      },
    );
  }

  function farthestHeldPath(): string | null {
    if (!active || decorStack.length >= N_MAX) return null;
    return decorStack.length > 0
      ? decorStack[decorStack.length - 1].level.path
      : active.path;
  }

  function appendFarAncestor(
    parentPath: string,
    parentNodes: ScanNode[],
  ): boolean {
    if (!active || decorStack.length >= N_MAX) return false;
    // Ребёнок, к которому пристыковываем предка: самый дальний слой (или активный).
    const childLevel =
      decorStack.length > 0 ? decorStack[decorStack.length - 1].level : active;
    const childTransform =
      decorStack.length > 0
        ? decorStack[decorStack.length - 1].transform
        : identityTransform();

    // Строим предка с ТЕМ ЖЕ span, с каким он был активным (детерминизм раскладки).
    const span = levelSpans.get(parentPath) ?? { w: CITY_SPAN, d: CITY_SPAN };
    const gp = buildLevel(parentNodes, span, parentPath);
    const g = gp.childPlacement(childLevel.path);
    if (!g) {
      gp.dispose(); // данные не содержат удерживаемого ребёнка как район — отказ
      return false;
    }

    // T_parent = T_child ∘ g⁻¹ (план §6): продолжаем цепочку «ещё крупнее, дальше».
    const t = composeChildInverse(g, childTransform);
    const budget = budgetFromS(t.scale); // зум-зависимый бюджет по его `S_k` (§5)
    content.add(gp.group);
    applyLayerTransform(gp.group, t);
    gp.setHighlight(null); // декор — нейтральный контекст
    // Силуэт ребёнка скрыт (его рисует свой слой), сразу со срезанным LOD-бюджетом (§4).
    // Появляется из фона (dim=0) — `updateFade` проявит до `colorFactorFromS(S)` (§6/§7).
    gp.setDecor(childLevel.path, budget, 0);
    decorStack.push({
      level: gp,
      transform: t,
      S: t.scale,
      budget,
      dimShown: 0,
    });
    // Бюджеты выше по стеку не изменились (guard в setDecorBudget), пересчёт дёшев;
    // стопку плит несёт рибейз-подобие нового слоя (`cy`, §8).
    applyDecorBudgets();
    updateGround(); // дочитанный слой стал самым дальним — землю показываем у него
    return true;
  }

  function updateLOD(): void {
    active?.view.updateLOD(handle.camera);
  }

  function updateFade(dtMs: number): void {
    if (decorStack.length === 0) return;
    // Доля полного диапазона затемнения за кадр (фейд ~DECOR_FADE_MS на весь путь).
    const step = DECOR_FADE_MS > 0 ? dtMs / DECOR_FADE_MS : 1;
    for (const layer of decorStack) {
      const target = colorFactorFromS(layer.S);
      if (layer.dimShown === target) continue;
      const d = target - layer.dimShown;
      layer.dimShown =
        Math.abs(d) <= step ? target : layer.dimShown + Math.sign(d) * step;
      layer.level.setDecorDim(layer.dimShown);
    }
  }

  function applyHighlight(match: ((node: ScanNode) => boolean) | null): void {
    currentMatch = match;
    if (active) applyAppearance(active); // фильтр под видом очистки (если он включён)
  }

  function setCleanup(
    view: {
      isMarked: (node: ScanNode) => boolean;
      isCandidate: (node: ScanNode) => boolean;
    } | null,
  ): void {
    cleanupView = view;
    if (!active) return;
    if (view) active.setCleanup(view);
    else {
      active.setCleanup(null); // снять красный/дим
      active.setHighlight(currentMatch); // вернуть подсветку-фильтр
    }
  }

  function inspect(): NavInspect {
    return {
      activePath: active?.path ?? null,
      decor: decorStack.map((l) => ({
        path: l.level.path,
        S: l.S,
        budget: l.budget,
        dim: l.dimShown,
      })),
    };
  }

  function dispose(): void {
    if (active) disposeLevel(active);
    clearDecor();
    active = null;
    setActiveView(null);
    setInteractive(false);
  }

  return {
    reset,
    rebuildActive,
    drill,
    canUp,
    up,
    farthestHeldPath,
    appendFarAncestor,
    updateLOD,
    updateFade,
    applyHighlight,
    setCleanup,
    inspect,
    dispose,
  };
}
