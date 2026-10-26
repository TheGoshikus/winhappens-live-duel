import { Chip } from './Chip';
import { CHIPS, DEALERS, ITEMS, chipColor } from './data';
import s from './duel.module.css';
import { LIFT_TRANSITION, useLift } from './lift';
import {
  canConfirm,
  costCents,
  ctaLabel,
  fmtMoney,
  payoutCents,
  roundOf,
  stakeFeeCents,
} from './logic';
import { useDuel } from './store';

/** Ряд фишек + сводка ставки (обычный режим). */
export function ChipsRow({ size = 44, summary = true }: { size?: number; summary?: boolean }) {
  const { state, dispatch } = useDuel();
  const picking = roundOf(state, state.dealer).phase === 'pick';
  const lift = useLift('chips');
  return (
    <div
      className={s.chipsRow}
      data-tour="chips"
      style={{ transform: lift || undefined, transition: LIFT_TRANSITION }}
    >
      {CHIPS.map((c) => (
        <Chip
          key={c.value}
          value={c.value}
          size={size}
          dataChip={c.value}
          selected={state.chip === c.value && state.stake === c.value}
          disabled={!picking || costCents(c.value) > state.balance}
          onClick={() => dispatch({ type: 'chip', value: c.value })}
        />
      ))}
      {summary && (
        <div className={s.summary}>
          <span>
            Ставка <b style={{ fontFamily: 'var(--font-mono)' }}>{state.stake}</b>
          </span>
          <span style={{ color: 'var(--even)' }}>
            Выигрыш{' '}
            <b style={{ fontFamily: 'var(--font-mono)' }}>{fmtMoney(payoutCents(state.stake))}</b>
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
            сбор {fmtMoney(stakeFeeCents(state.stake))}
          </span>
        </div>
      )}
    </div>
  );
}

/** Режим «Крупье отвечает взаимностью»: предметы вместо фишек (ui-spec §5). */
export function ItemsBlock() {
  const { state, dispatch } = useDuel();
  const picking = roundOf(state, state.dealer).phase === 'pick';
  const removed = state.removed[state.dealer] ?? [];
  const lift = useLift('chips');
  return (
    <div
      data-tour="chips"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        transform: lift || undefined,
        transition: LIFT_TRANSITION,
      }}
    >
      <div className={s.informer}>
        <b>{DEALERS[state.dealer]!.name}</b> отвечает взаимностью и даёт тебе возможность снять с
        неё
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span className={s.caps}>
          Что снять? ·{' '}
          {removed.length ? `снято ${removed.length}/${ITEMS.length}` : 'ставка под предметом'}
        </span>
        <span className={s.caps}>
          Твоя ставка <span style={{ color: '#fff' }}>{state.stake}</span>
        </span>
      </div>
      <div className={s.itemsRow} role="radiogroup" aria-label="Предмет">
        {ITEMS.map((it) => {
          const off = removed.includes(it.id);
          const sel = state.item === it.id;
          return (
            <button
              key={it.id}
              type="button"
              role="radio"
              aria-checked={sel}
              data-item={it.id}
              className={`${s.item} ${sel ? s.itemSel : ''} ${off ? s.itemOff : ''}`}
              disabled={off || !picking}
              onClick={() => dispatch({ type: 'item', id: it.id })}
              aria-label={`${it.name}, ставка ${it.price}${off ? ', снято' : ''}`}
            >
              <span className={s.itemCircle}>{it.emoji}</span>
              {off ? (
                <span>снято</span>
              ) : (
                <span className={s.price}>
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: '50%',
                      background: chipColor(it.price),
                      border: '1px dashed #fff8',
                    }}
                  />
                  {it.price}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** [½] [CTA] [2×] (ui-spec §3.6). */
export function ActionsRow({ onConfirm }: { onConfirm: () => void }) {
  const { state, dispatch } = useDuel();
  const r = roundOf(state, state.dealer);
  const picking = r.phase === 'pick';
  const items = state.mode[state.dealer] === 'items';
  const liftHalf = useLift('half', 'dbl');
  const liftCta = useLift('confirm');
  const enabled = r.phase === 'done' || canConfirm(state);
  return (
    <div className={s.actions}>
      <button
        type="button"
        className={s.square}
        data-tour="half"
        style={{ transform: liftHalf || undefined }}
        disabled={!picking || items}
        onClick={() => dispatch({ type: 'half' })}
        aria-label="Уменьшить ставку вдвое"
      >
        ½
      </button>
      <button
        type="button"
        className={s.cta}
        data-tour="confirm"
        style={{ transform: liftCta || undefined }}
        disabled={!enabled}
        onClick={() =>
          r.phase === 'done' ? dispatch({ type: 'nextRound', now: Date.now() }) : onConfirm()
        }
      >
        {ctaLabel(state)}
      </button>
      <button
        type="button"
        className={s.square}
        data-tour="dbl"
        style={{ transform: liftHalf || undefined }}
        disabled={!picking || items}
        onClick={() => dispatch({ type: 'double' })}
        aria-label="Удвоить ставку"
      >
        2×
      </button>
    </div>
  );
}

export function BottomPanel({ onConfirm }: { onConfirm: () => void }) {
  const { state } = useDuel();
  return (
    <div className={s.panel}>
      {state.mode[state.dealer] === 'items' ? <ItemsBlock /> : <ChipsRow />}
      <ActionsRow onConfirm={onConfirm} />
    </div>
  );
}

export { LIFT_TRANSITION };
