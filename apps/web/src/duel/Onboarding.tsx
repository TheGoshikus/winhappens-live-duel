import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { DEALERS } from './data';
import o from './onboarding.module.css';
import type { Layout } from './Stage';
import { VideoFill } from './Video';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Объединённый прямоугольник элементов [data-tour=key] относительно фрейма. */
export function measure(frame: HTMLElement | null, keys: string[]): Rect | null {
  if (!frame) return null;
  const base = frame.getBoundingClientRect();
  const rects = keys
    .map((k) => frame.querySelector(`[data-tour="${k}"]`)?.getBoundingClientRect())
    .filter((r): r is DOMRect => !!r && r.width > 0);
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.left));
  const y = Math.min(...rects.map((r) => r.top));
  const r = Math.max(...rects.map((r) => r.right));
  const b = Math.max(...rects.map((r) => r.bottom));
  return { x: x - base.left, y: y - base.top, w: r - x, h: b - y };
}

// ---------- 7.1 экран правил ----------

export function RulesOverlay({ onWatch, onSkip }: { onWatch: () => void; onSkip: () => void }) {
  const [a, b, c] = [DEALERS[11]!, DEALERS[0]!, DEALERS[1]!];
  return (
    <div className={`${o.layer} ${o.rules}`} role="dialog" aria-modal aria-labelledby="rules-title">
      <div className={o.trio} aria-hidden>
        <span className={o.mini}>
          <VideoFill tint={a.tint} label={null} />
        </span>
        <span className={`${o.mini} ${o.main}`}>
          <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', overflow: 'hidden' }}>
            <VideoFill tint={b.tint} label={null} />
          </span>
        </span>
        <span className={o.mini}>
          <VideoFill tint={c.tint} label={null} />
        </span>
      </div>
      <h1 id="rules-title" className={o.title}>
        Чёт или нечёт — один на один с крупье
      </h1>
      <div className={o.rule}>
        <span className={o.num}>1</span>
        <span>Ты и крупье тайно выбираете по числу 0–9</span>
      </div>
      <div className={o.rule}>
        <span className={o.num}>2</span>
        <span>
          Числа складываются. <b>Чётная сумма</b> — выигрываешь ты
        </span>
      </div>
      <div className={o.rule}>
        <span className={o.num}>3</span>
        <span>Победитель забирает обе ставки минус 10%</span>
      </div>
      <button type="button" className={o.cta} onClick={onWatch}>
        Смотреть видео-обучение · 36 сек
      </button>
      <button type="button" className={o.text} onClick={onSkip}>
        Я знаю правила
      </button>
    </div>
  );
}

// ---------- 7.2 видео-обучение ----------

export const TOUR_STEPS = [
  {
    keys: ['stage'],
    title: 'Кружки — это крупье',
    text: 'Каждый кружок — живой крупье. Свайпай влево и вправо, чтобы сменить стол.',
  },
  {
    keys: ['center'],
    round: true,
    title: 'Тап — полный экран',
    text: 'Нажми на центральный кружок, и видео откроется на весь экран.',
  },
  {
    keys: ['ring'],
    round: true,
    title: 'Белое кольцо — путь к взаимности',
    text: 'Каждый раунд с крупье заполняет кольцо. Сыграй 3 раунда — и она ответит взаимностью.',
  },
  {
    keys: ['timer'],
    title: 'Таймер раунда',
    text: 'Столько секунд осталось, чтобы сделать ставку.',
  },
  {
    keys: ['board'],
    title: 'Выбери число',
    text: 'Зелёные — чётные, красные — нечётные. Сумма твоего числа и числа крупье решает исход.',
  },
  {
    keys: ['chips'],
    title: 'Фишки — это ставка',
    text: 'Выбери номинал. Выбранная фишка приподнимается.',
  },
  { keys: ['half', 'dbl'], title: '½ и 2×', text: 'Быстро уменьшить вдвое или удвоить ставку.' },
  {
    keys: ['confirm'],
    title: 'Сделай ставку',
    text: 'Кнопка белеет, когда число выбрано. Нажми — фишка перелетит на поле.',
  },
  {
    keys: ['duel'],
    title: 'Итог раунда',
    text: 'Здесь откроются оба числа и сумма. Чётная — победа твоя.',
  },
  {
    keys: ['help'],
    round: true,
    title: 'Пересмотреть обучение',
    text: 'Кнопка «?» всегда запустит это видео снова.',
  },
] as const;

export const STEP_MS = 3_600;
const PAD = 8;

interface TourProps {
  frame: RefObject<HTMLElement>;
  layout: Layout;
  /** Текущий шаг наружу — для «выдвижения» элемента (TourKeyContext). */
  onStep: (key: string | null) => void;
  onClose: (completed: boolean) => void;
}

/**
 * Автоплей по шагам. Таймер шага живёт в обработчиках start/next/pause (setTimeout + rAF),
 * а не в эффекте рендера: пауза замораживает и таймер, и заполнение сегмента.
 */
export function Tour({ frame, layout, onStep, onClose }: TourProps) {
  const [step, setStep] = useState(0);
  const [play, setPlay] = useState(true);
  const [rect, setRect] = useState<Rect | null>(null);
  const [fill, setFill] = useState({ frac: 0, ms: 0 });
  const timer = useRef<number | undefined>(undefined);
  const startedAt = useRef(0);
  const elapsed = useRef(0);
  const stepRef = useRef(0);
  const goRef = useRef<(i: number) => void>(() => {});

  const finish = useCallback(
    (completed: boolean) => {
      window.clearTimeout(timer.current);
      onStep(null);
      onClose(completed);
    },
    [onClose, onStep],
  );

  const measureStep = useCallback(
    (i: number) => {
      const keys = [...TOUR_STEPS[i]!.keys];
      setRect(measure(frame.current, keys));
      // После «выдвижения» (.35s) элемент чуть больше — перемеряем.
      window.setTimeout(() => stepRef.current === i && setRect(measure(frame.current, keys)), 380);
    },
    [frame],
  );

  const run = useCallback((i: number, from: number) => {
    window.clearTimeout(timer.current);
    elapsed.current = from;
    startedAt.current = performance.now();
    setFill({ frac: from / STEP_MS, ms: 0 });
    requestAnimationFrame(() =>
      requestAnimationFrame(() => setFill({ frac: 1, ms: STEP_MS - from })),
    );
    timer.current = window.setTimeout(() => goRef.current(i + 1), STEP_MS - from);
  }, []);

  const go = useCallback(
    (i: number) => {
      if (i >= TOUR_STEPS.length) return finish(true);
      stepRef.current = i;
      setStep(i);
      setPlay(true);
      onStep(TOUR_STEPS[i]!.keys[0]);
      requestAnimationFrame(() => measureStep(i));
      run(i, 0);
    },
    [finish, measureStep, onStep, run],
  );
  goRef.current = go;

  const togglePause = () => {
    if (play) {
      window.clearTimeout(timer.current);
      elapsed.current = Math.min(STEP_MS, elapsed.current + performance.now() - startedAt.current);
      setFill({ frac: elapsed.current / STEP_MS, ms: 0 });
      setPlay(false);
    } else {
      setPlay(true);
      run(stepRef.current, elapsed.current);
    }
  };

  // Старт — один раз при монтировании; дальше шаги ведут обработчики.
  useEffect(() => {
    goRef.current(0);
    return () => window.clearTimeout(timer.current);
  }, []);

  useLayoutEffect(() => {
    const onResize = () => measureStep(stepRef.current);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measureStep]);

  const s = TOUR_STEPS[step]!;
  const frameH = frame.current?.clientHeight ?? 844;
  const frameW = frame.current?.clientWidth ?? 390;
  const round = 'round' in s && s.round;
  const spot = rect && {
    left: rect.x - PAD,
    top: rect.y - PAD,
    width: rect.w + PAD * 2,
    height: rect.h + PAD * 2,
    borderRadius: round ? '50%' : 16,
  };
  // Карточка: над элементом, если он ниже середины экрана, иначе под ним; на десктопе — справа.
  let card: React.CSSProperties = { top: '50%' };
  if (rect) {
    const CARD_W = 340;
    const GAP = PAD + 24;
    const vertical = (): React.CSSProperties =>
      rect.y + rect.h / 2 < frameH / 2
        ? { top: Math.min(rect.y + rect.h + PAD + 16, frameH - 190) }
        : { top: Math.max(110, rect.y - PAD - 16 - 150) };
    if (layout === 'desktop') {
      const top = Math.max(100, Math.min(rect.y, frameH - 220));
      const right = rect.x + rect.w + GAP;
      const left = rect.x - GAP - CARD_W;
      card =
        right + CARD_W + 16 <= frameW
          ? { left: right, right: 'auto', width: CARD_W, top }
          : left >= 16
            ? { left, right: 'auto', width: CARD_W, top }
            : {
                ...vertical(),
                left: Math.max(16, Math.min(rect.x, frameW - CARD_W - 16)),
                right: 'auto',
                width: CARD_W,
              };
    } else {
      card = vertical();
    }
  }

  return (
    <div
      className={`${o.layer} ${o.tour}`}
      onClick={() => go(stepRef.current + 1)}
      role="dialog"
      aria-label="Видео-обучение"
    >
      {spot ? (
        <div className={o.spot} style={spot} />
      ) : (
        <div className={o.spot} style={{ inset: '50%' }} />
      )}
      <div
        className={o.top}
        style={layout === 'desktop' ? { top: 12 } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={o.segments} aria-hidden>
          {TOUR_STEPS.map((_, i) => (
            <span key={i} className={o.segment}>
              <span
                style={{
                  width: i < step ? '100%' : i > step ? '0%' : `${fill.frac * 100}%`,
                  transition: i === step && fill.ms ? `width ${fill.ms}ms linear` : 'none',
                }}
              />
            </span>
          ))}
        </div>
        <div className={o.bar}>
          <span
            className="caps"
            style={{ flex: 1, fontSize: 10, fontWeight: 800, letterSpacing: 1, color: '#C8CDDA' }}
          >
            ВИДЕО-ОБУЧЕНИЕ · {step + 1}/{TOUR_STEPS.length}
          </span>
          <button
            type="button"
            className={o.iconBtn}
            onClick={togglePause}
            aria-label={play ? 'Пауза' : 'Продолжить'}
          >
            {play ? 'II' : '▶'}
          </button>
          <button
            type="button"
            className={o.iconBtn}
            onClick={() => finish(false)}
            aria-label="Закрыть обучение"
          >
            ✕
          </button>
        </div>
      </div>
      <div className={o.card} style={card} aria-live="polite">
        <h3>{s.title}</h3>
        <p>{s.text}</p>
        <span className={o.tapNext}>Тап — дальше</span>
      </div>
    </div>
  );
}

// ---------- 7.3 экран с подписями ----------

const LABELS: { n: number; keys: string[]; text: string }[] = [
  { n: 1, keys: ['stage'], text: 'Кружки-крупье' },
  { n: 2, keys: ['center'], text: 'Тап по кружку — полный экран' },
  { n: 3, keys: ['ring'], text: 'Белое кольцо — прогресс до взаимности' },
  { n: 4, keys: ['timer'], text: 'Таймер' },
  { n: 5, keys: ['duel'], text: 'Полоса дуэли' },
  { n: 6, keys: ['board'], text: 'Поле чисел' },
  { n: 7, keys: ['chips'], text: 'Фишки (в режиме взаимности — предметы)' },
  { n: 8, keys: ['half', 'dbl'], text: '½ и 2×' },
  { n: 9, keys: ['confirm'], text: 'Кнопка ставки' },
  { n: 10, keys: ['help'], text: '«?» — обучение и справка' },
];

/** Маркер ставится в угол элемента; у некоторых сдвинут, чтобы не наезжать на соседние. */
const MARKER_AT: Record<number, (r: Rect) => { x: number; y: number }> = {
  1: (r) => ({ x: r.x + 14, y: r.y + 52 }),
  2: (r) => ({ x: r.x + r.w * 0.5, y: r.y + r.h * 0.5 }),
  3: (r) => ({ x: r.x + r.w * 0.85, y: r.y + r.h * 0.12 }),
  4: (r) => ({ x: r.x, y: r.y + r.h }),
  10: (r) => ({ x: r.x, y: r.y + r.h }),
};

export function LabelsOverlay({
  frame,
  onClose,
}: {
  frame: RefObject<HTMLElement>;
  onClose: () => void;
}) {
  const [rects, setRects] = useState<Record<number, Rect | null>>({});
  const [legend, setLegend] = useState(true);
  useLayoutEffect(() => {
    const update = () =>
      setRects(Object.fromEntries(LABELS.map((l) => [l.n, measure(frame.current, l.keys)])));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [frame]);
  return (
    <div
      className={`${o.layer} ${o.labels}`}
      onClick={() => setLegend((v) => !v)}
      role="dialog"
      aria-label="Все кнопки"
    >
      {LABELS.map((l) => {
        const r = rects[l.n];
        if (!r) return null;
        const at = (MARKER_AT[l.n] ?? ((q: Rect) => ({ x: q.x, y: q.y })))(r);
        return (
          <span key={l.n} className={o.marker} style={{ left: at.x, top: at.y }} aria-hidden>
            {l.n}
          </span>
        );
      })}
      {legend && (
        <div className={o.legend} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <b style={{ fontSize: 15 }}>Все кнопки</b>
            <button type="button" className={o.iconBtn} onClick={onClose} aria-label="Закрыть">
              ✕
            </button>
          </div>
          <ol>
            {LABELS.map((l) => (
              <li key={l.n}>
                <b>{l.n}</b>
                {l.text}
              </li>
            ))}
          </ol>
          <div style={{ fontSize: 11, color: '#9CA3B8', marginTop: 8 }}>
            Тап по экрану — скрыть легенду
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- 7.4 чек-лист «Первые шаги» ----------

export interface ChecklistState {
  tourDone: boolean;
  deposited: boolean;
  played: boolean;
}

export function Checklist({
  st,
  onTour,
  onClose,
}: {
  st: ChecklistState;
  onTour: () => void;
  onClose: () => void;
}) {
  const steps = [
    { text: 'Подтвердить возраст', done: true },
    { text: 'Проверить камеру и микрофон', done: true },
    { text: 'Пройти обучение — 30 секунд', done: st.tourDone },
    { text: 'Пополнить баланс — от 10 фишек', done: st.deposited },
    { text: 'Сыграть первый раунд', done: st.played },
  ];
  const done = steps.filter((s) => s.done).length;
  const active = steps.findIndex((s) => !s.done);
  const len = 2 * Math.PI * 38;
  return (
    <div className={`${o.layer} ${o.sheetLayer}`} onClick={onClose}>
      <div
        className={o.sheet}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        aria-labelledby="steps-title"
      >
        <div className={o.sheetHead}>
          <svg width="88" height="88" viewBox="0 0 88 88" aria-hidden>
            <circle cx="44" cy="44" r="38" fill="none" stroke="#FFFFFF1A" strokeWidth="6" />
            <circle
              cx="44"
              cy="44"
              r="38"
              fill="none"
              stroke="#4F8BFF"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${(done / steps.length) * len} ${len}`}
              transform="rotate(-90 44 44)"
              style={{ transition: 'stroke-dasharray .6s' }}
            />
            <text
              x="44"
              y="50"
              textAnchor="middle"
              fill="#fff"
              fontSize="18"
              fontWeight="800"
              fontFamily="Manrope"
            >
              {done}/{steps.length}
            </text>
          </svg>
          <div>
            <h2 id="steps-title" style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>
              Первые шаги
            </h2>
            <div style={{ color: '#C8CDDA', fontSize: 14, marginTop: 4 }}>
              Пять шагов до первого раунда
            </div>
          </div>
        </div>
        <ol className={o.steps}>
          {steps.map((s, i) => (
            <li
              key={s.text}
              className={`${o.step} ${i === active ? o.stepActive : ''} ${s.done ? o.stepDone : ''}`}
            >
              <span
                className={o.mark}
                style={
                  s.done
                    ? { background: '#3DDC97', color: '#0A0E1A' }
                    : i === active
                      ? { background: '#4F8BFF' }
                      : undefined
                }
              >
                {s.done ? '✓' : i + 1}
              </span>
              {s.text}
            </li>
          ))}
        </ol>
        {st.tourDone ? (
          <button type="button" className={o.cta} onClick={onClose}>
            Играть
          </button>
        ) : (
          <button type="button" className={o.cta} onClick={onTour}>
            Пройти обучение · 30 сек
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- меню «?» ----------

export type HelpChoice = 'random' | 'tour' | 'labels' | 'checklist' | 'rules';

export function HelpMenu({
  onPick,
  onClose,
}: {
  onPick: (c: HelpChoice) => void;
  onClose: () => void;
}) {
  const items: [HelpChoice, string][] = [
    ['random', 'Случайный стол'],
    ['tour', 'Видео-обучение · 36 сек'],
    ['labels', 'Все кнопки'],
    ['checklist', 'Первые шаги'],
    ['rules', 'Правила'],
  ];
  return (
    <div className={`${o.layer} ${o.sheetLayer}`} onClick={onClose}>
      <div
        className={o.sheet}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        aria-label="Помощь"
      >
        {items.map(([k, label]) => (
          <button key={k} type="button" className={o.menuItem} onClick={() => onPick(k)}>
            {label} <span aria-hidden>›</span>
          </button>
        ))}
        <button type="button" className={o.text} onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  );
}
