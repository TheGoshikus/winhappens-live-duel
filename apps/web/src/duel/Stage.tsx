import { useRef, type PointerEvent } from 'react';
import { ROUNDS_TO_RECIPROCITY } from './data';
import s from './duel.module.css';
import { LIFT_TRANSITION, useLift } from './lift';
import { badge, caption, fmtSec, roundOf, timerOf } from './logic';
import { useDuel } from './store';
import { DealerVideo } from '../live/media';

export type Layout = 'mobile' | 'desktop';

const SIZES = {
  mobile: { center: 236, near: 110, far: 80, step: 170, gap: 20 },
  mobileItems: { center: 184, near: 92, far: 70, step: 150, gap: 20 },
  desktop: { center: 360, near: 190, far: 130, step: 330, gap: 40 },
};
const RING_LEN = 301.6;
const BADGE_BG = { live: '#FFE14D', win: '#3DDC97', loss: '#FF6B81' } as const;

interface StageProps {
  layout: Layout;
  onHelp: () => void;
}

/** Сцена с каруселью видео-кружков крупье (ui-spec §3.1). */
export function Stage({ layout, onHelp }: StageProps) {
  const { state, dispatch, now } = useDuel();
  const down = useRef<{ x: number; t: EventTarget | null } | null>(null);
  const items = state.mode[state.dealer] === 'items';
  const sz = layout === 'desktop' ? SIZES.desktop : items ? SIZES.mobileItems : SIZES.mobile;
  const d = state.dealers[state.dealer]!;
  const timer = timerOf(state, now);
  const liftTimer = useLift('timer');
  const liftHelp = useLift('help');
  const liftCenter = useLift('center', 'ring');
  const playing = Object.entries(state.rounds).filter(
    ([, r]) => r.phase !== 'pick' && r.phase !== 'done',
  ).length;
  const n = state.dealers.length;

  const onDown = (e: PointerEvent) => {
    down.current = { x: e.clientX, t: e.target };
  };
  const onUp = (e: PointerEvent) => {
    const start = down.current;
    down.current = null;
    if (!start) return;
    const dx = e.clientX - start.x;
    if (Math.abs(dx) > 40) {
      dispatch({ type: 'step', dir: dx < 0 ? 1 : -1, now: Date.now() });
      return;
    }
    if (Math.abs(dx) >= 8) return;
    const el = (start.t as HTMLElement | null)?.closest<HTMLElement>('[data-dealer]');
    if (!el) return;
    const idx = Number(el.dataset.dealer);
    if (idx === state.dealer) dispatch({ type: 'full', open: true });
    else dispatch({ type: 'select', dealer: idx, now: Date.now() });
  };

  return (
    <div
      className={s.stage}
      data-tour="stage"
      style={{
        background: `radial-gradient(circle at 50% 42%, ${d.tint}55, transparent 62%), var(--bg-app)`,
      }}
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerCancel={() => (down.current = null)}
    >
      <div className={s.pill} style={{ left: 10 }}>
        <span className={s.liveDot} /> {d.live ? 'LIVE' : 'ДЕМО'} · {d.scene}
      </div>
      <div
        className={`${s.pill} ${s.timer}`}
        data-tour="timer"
        style={{
          right: 10,
          color: timer.open ? '#4F8BFF' : '#fff',
          transform: liftTimer || undefined,
          transition: LIFT_TRANSITION,
        }}
        aria-label={timer.open ? 'Осталось секунд на ставку' : 'До следующей фазы'}
      >
        {fmtSec(timer.sec)}
      </div>
      <div className={s.hint}>
        ← свайп · {playing > 0 ? `в игре столов: ${playing}` : 'листай крупье'} →
      </div>
      <button
        type="button"
        className={s.help}
        data-tour="help"
        style={{ transform: liftHelp || undefined, transition: LIFT_TRANSITION }}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={onHelp}
        aria-label="Помощь и обучение"
      >
        ?
      </button>

      {[-2, -1, 0, 1, 2].map((off) => {
        const idx = (state.dealer + off + n * 2) % n;
        const dealer = state.dealers[idx]!;
        const abs = Math.abs(off);
        const size = abs === 0 ? sz.center : abs === 1 ? sz.near : sz.far;
        const x = abs === 0 ? 0 : abs === 1 ? sz.step : sz.step + (sz.near + sz.far) / 2 + sz.gap;
        const opacity = dealer.busy ? 0.25 : abs === 0 ? 1 : abs === 1 ? 0.55 : 0.3;
        const r = roundOf(state, idx);
        const b = abs > 0 ? badge(state, idx) : null;
        const center = abs === 0;
        const full = r.count >= ROUNDS_TO_RECIPROCITY;
        const mode = state.mode[idx] === 'items';
        return (
          <div
            key={idx}
            className={s.circle}
            data-dealer={idx}
            data-tour={center ? 'center' : undefined}
            style={{
              left: `calc(50% + ${Math.sign(off) * x}px)`,
              width: size,
              height: size,
              opacity,
              zIndex: 2 - abs,
              transform: `translate(-50%, -50%)${center ? liftCenter : ''}`,
              cursor: dealer.busy ? 'default' : 'pointer',
            }}
            role="button"
            aria-label={
              center
                ? `${dealer.name}: открыть видео на весь экран`
                : `Перейти к крупье ${dealer.name}`
            }
          >
            <div className={s.video}>
              <DealerVideo
                dealer={dealer}
                label={center ? (dealer.live ? 'в эфире' : 'видео-кружок') : null}
              />
            </div>
            {center && (
              <svg
                className={`${s.ring} ${full ? s.ringFull : ''}`}
                viewBox="0 0 100 100"
                data-tour="ring"
                aria-hidden
              >
                <circle cx="50" cy="50" r="48" fill="none" stroke="#FFFFFF22" strokeWidth="2" />
                <circle
                  cx="50"
                  cy="50"
                  r="48"
                  fill="none"
                  stroke="#FFFFFF"
                  strokeWidth="3"
                  strokeLinecap={r.count > 0 ? 'round' : 'butt'}
                  strokeDasharray={`${(Math.min(r.count, ROUNDS_TO_RECIPROCITY) / ROUNDS_TO_RECIPROCITY) * RING_LEN} ${RING_LEN}`}
                />
              </svg>
            )}
            {b && (
              <span className={s.badge} style={{ background: BADGE_BG[b.kind] }}>
                {b.text}
              </span>
            )}
            {abs < 2 && (
              <span className={s.name} style={{ color: center && mode ? '#FFE14D' : '#fff' }}>
                {center
                  ? `${dealer.name} · ${mode || full ? 'взаимность открыта' : `${r.count}/${ROUNDS_TO_RECIPROCITY} до взаимности`}`
                  : dealer.busy
                    ? `${dealer.name} · занята`
                    : dealer.name}
              </span>
            )}
          </div>
        );
      })}

      <button
        type="button"
        className={s.arrow}
        style={{ left: 8 }}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={() => dispatch({ type: 'step', dir: -1, now: Date.now() })}
        aria-label="Предыдущий крупье"
      >
        ‹
      </button>
      <button
        type="button"
        className={s.arrow}
        style={{ right: 8 }}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={() => dispatch({ type: 'step', dir: 1, now: Date.now() })}
        aria-label="Следующий крупье"
      >
        ›
      </button>

      <div
        className={s.caption}
        style={layout === 'desktop' ? { fontSize: 46, bottom: 20 } : undefined}
        aria-live="polite"
      >
        {caption(state)}
      </div>
    </div>
  );
}
