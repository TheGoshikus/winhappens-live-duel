import s from './duel.module.css';
import { fmtMoney } from './logic';
import { useDuel } from './store';

const secLeft = (iso: string, now: number) =>
  Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000));

/** Экран смены после сессии: 15 с на решение (Дальше / Остаться ×2 / Противоположный пол / Выйти). */
export function ShiftOverlay({ onWallet }: { onWallet: () => void }) {
  const { state, shift, decideShift, pauseShift, now } = useDuel();
  if (!shift) return null;
  const d = state.dealers.find((x) => x.id === shift.dealerId);
  const sec = secLeft(shift.deadline, now);
  const chose = shift.myChoice;
  const stay = fmtMoney(Number(shift.stayStake));
  return (
    <div
      className={`${s.overlay} ${s.dimmed}`}
      role="dialog"
      aria-modal
      aria-labelledby="shift-title"
      data-shift
    >
      <span className={s.caps} style={{ textAlign: 'center' }}>
        Сессия завершена · решение за <b data-shift-timer>{sec}</b> с
        {shift.paused ? ' · пауза на пополнение' : ''}
      </span>
      <h2 id="shift-title" className={s.sheetTitle} style={{ textAlign: 'center' }}>
        Что дальше?
      </h2>
      {chose ? (
        <p className={s.sheetText} style={{ textAlign: 'center' }}>
          {chose === 'stay'
            ? 'Ждём ответа крупье…'
            : chose === 'exit'
              ? 'Возвращаемся в ленту…'
              : 'Ищем следующий стол…'}
        </p>
      ) : (
        <>
          <p className={s.sheetText} style={{ textAlign: 'center' }}>
            Ставка была {fmtMoney(Number(shift.stake))}. Остаться за столом{' '}
            {d ? `«${d.name}»` : 'крупье'} — новая сессия со ставкой {stay}
            {shift.stayStreak > 0 ? ` (подряд: ${shift.stayStreak})` : ''}.
          </p>
          <div className={s.shiftGrid}>
            <button type="button" className={s.pillCta} onClick={() => decideShift('next')}>
              Дальше
            </button>
            <button
              type="button"
              className={s.shiftBtn}
              disabled={!shift.canStay}
              onClick={() => decideShift('stay')}
            >
              Остаться ×2 · {stay}
            </button>
            <button type="button" className={s.shiftBtn} onClick={() => decideShift('opposite')}>
              Противоположный пол
            </button>
          </div>
          {!shift.canStay && !shift.paused && (
            <button
              type="button"
              className={s.textBtn}
              onClick={() => {
                void pauseShift();
                onWallet();
              }}
            >
              Пополнить и остаться
            </button>
          )}
          <button type="button" className={s.textBtn} onClick={() => decideShift('exit')}>
            Выйти
          </button>
        </>
      )}
    </div>
  );
}

/** «Ищем стол…» поверх сцены, пока заявка ждёт свободную крупье. */
export function MatchBanner() {
  const { match, cancelMatch } = useDuel();
  if (!match) return null;
  return (
    <div className={s.matchBanner} role="status" data-match>
      <span className={s.liveDot} />
      {match.status === 'offered' ? 'Крупье принимает игру…' : 'Ищем свободный стол…'} ·{' '}
      {fmtMoney(Number(match.stake))}
      <button type="button" onClick={() => void cancelMatch()}>
        Отмена
      </button>
    </div>
  );
}
