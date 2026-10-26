import { DEALERS } from './data';
import s from './duel.module.css';
import { LIFT_TRANSITION, useLift } from './lift';
import { isEven, roundOf } from './logic';
import { useDuel } from './store';

/** Вы · ЧЁТ — VS / сумма — НЕЧЁТ · крупье (ui-spec §3.2). */
export function DuelStrip({ height = 44 }: { height?: number }) {
  const { state } = useDuel();
  const r = roundOf(state, state.dealer);
  const revealed = r.phase === 'reveal' || r.phase === 'done';
  const lift = useLift('duel');
  const sum = revealed ? r.pick! + r.dealerPick! : null;
  const big = height > 44;
  return (
    <div
      className={s.duel}
      data-tour="duel"
      style={{
        height,
        transform: lift || undefined,
        transition: LIFT_TRANSITION,
        fontSize: big ? 15 : undefined,
      }}
    >
      <span
        className={s.duelNum}
        style={{ background: '#00C853', width: big ? 34 : 26, height: big ? 34 : 26 }}
      >
        {r.phase === 'pick' ? (r.pick ?? '?') : r.pick}
      </span>
      <span>
        Вы · <span style={{ color: 'var(--even)' }}>ЧЁТ</span>
      </span>
      <span
        className={s.duelMid}
        style={{
          color: sum === null ? 'var(--text-muted)' : isEven(sum) ? 'var(--even)' : 'var(--odd)',
        }}
      >
        {sum === null ? 'VS' : `${sum} · ${isEven(sum) ? 'ЧЁТ' : 'НЕЧЁТ'}`}
      </span>
      <span>
        <span style={{ color: 'var(--odd)' }}>НЕЧЁТ</span> · {DEALERS[state.dealer]!.name}
      </span>
      <span
        className={s.duelNum}
        style={{ background: '#FF4D6A', width: big ? 34 : 26, height: big ? 34 : 26 }}
      >
        {revealed ? r.dealerPick : '?'}
      </span>
    </div>
  );
}
