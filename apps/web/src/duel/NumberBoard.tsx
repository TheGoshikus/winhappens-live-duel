import { Chip } from './Chip';
import s from './duel.module.css';
import { LIFT_TRANSITION, useLift } from './lift';
import { isEven, roundOf } from './logic';
import { useDuel } from './store';

interface BoardProps {
  /** Подписи ЧЁТ/НЕЧЁТ — только в онбординге. */
  showParity?: boolean;
  /** Фишка ещё в полёте — не рисовать её на плитке. */
  flying?: boolean;
  desktop?: boolean;
}

/** Поле 0–9, 5×2 (ui-spec §3.3). */
export function NumberBoard({ showParity, flying, desktop }: BoardProps) {
  const { state, dispatch } = useDuel();
  const r = roundOf(state, state.dealer);
  const locked = r.phase !== 'pick';
  const lift = useLift('board');
  return (
    <>
      <div className={s.boardLabel}>
        <span className={s.caps}>Твоё число · 0–9</span>
        {r.pick !== null && (
          <span className={s.caps} style={{ color: '#fff' }}>
            {r.pick}
          </span>
        )}
      </div>
      <div
        className={s.board}
        data-tour="board"
        style={{
          height: desktop ? 180 : 104,
          gap: desktop ? 10 : 6,
          transform: lift || undefined,
          transition: LIFT_TRANSITION,
        }}
      >
        {Array.from({ length: 10 }, (_, n) => {
          const sel = r.pick === n;
          const placed = sel && locked && !flying;
          const color = isEven(n) ? 'var(--even)' : 'var(--odd)';
          return (
            <button
              key={n}
              type="button"
              data-tile={n}
              className={`${s.tile} ${sel ? s.tileSel : ''} ${locked && !sel ? s.tileOff : ''}`}
              onClick={() => dispatch({ type: 'pick', n })}
              disabled={locked}
              aria-pressed={sel}
              aria-label={`Число ${n}, ${isEven(n) ? 'чёт' : 'нечёт'}`}
            >
              <span
                className={`${s.digit} ${placed ? s.digitCorner : ''}`}
                style={{
                  color: sel && !placed ? (isEven(n) ? '#12a86a' : '#e0435c') : color,
                  fontSize: placed ? (desktop ? 18 : 13) : desktop ? 38 : 24,
                }}
              >
                {n}
              </span>
              {showParity && !placed && (
                <span className={s.parity} style={{ color }}>
                  {isEven(n) ? 'ЧЁТ' : 'НЕЧЁТ'}
                </span>
              )}
              {placed && <Chip value={r.stake} size={desktop ? 56 : 34} />}
            </button>
          );
        })}
      </div>
    </>
  );
}
