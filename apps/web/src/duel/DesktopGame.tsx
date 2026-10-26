import { useRef, type ReactNode, type RefObject } from 'react';
import { ChipsRow, ItemsBlock } from './BottomPanel';
import { Chip } from './Chip';
import d from './desktop.module.css';
import s from './duel.module.css';
import { DuelStrip } from './DuelStrip';
import { useFlyingChip } from './fly';
import { useLift } from './lift';
import { canConfirm, ctaLabel, roundOf, winAmount } from './logic';
import { NumberBoard } from './NumberBoard';
import { FullscreenVideo, OfferModal } from './Overlays';
import { Stage } from './Stage';
import { useDuel } from './store';

interface Props {
  onHelp: () => void;
  showParity?: boolean;
  frameRef?: RefObject<HTMLDivElement>;
  children?: ReactNode;
}

/** Десктоп 1440×900: сайдбар ставки + сцена (ui-spec §8, блок 4c). */
export function DesktopGame({ onHelp, showParity, frameRef, children }: Props) {
  const { state, dispatch, confirm } = useDuel();
  const own = useRef<HTMLDivElement>(null);
  const frame = frameRef ?? own;
  const { fly, launch, land } = useFlyingChip(frame, 56);
  const r = roundOf(state, state.dealer);
  const picking = r.phase === 'pick';
  const items = state.mode[state.dealer] === 'items';
  const liftHalf = useLift('half', 'dbl');
  const liftCta = useLift('confirm');

  const onCta = () => {
    if (r.phase === 'done') return dispatch({ type: 'nextRound', now: Date.now() });
    if (!canConfirm(state) || r.pick === null) return;
    launch(
      items ? `[data-item="${state.item}"]` : `[data-chip="${state.chip}"]`,
      r.pick,
      state.stake,
    );
    confirm();
  };

  const recent = state.history.slice(-8);
  return (
    <div className={d.app} ref={frame}>
      <aside className={d.side}>
        <div className={d.brand}>
          <b>Win!</b>
          <span
            className="caps"
            style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, color: '#9CA3B8' }}
          >
            LIVE DUEL
          </span>
        </div>
        <div className={d.balance} aria-label="Баланс">
          ◎ {state.balance}
        </div>
        <div className={d.tabs} role="tablist">
          <button type="button" role="tab" aria-selected className={`${d.tab} ${d.tabOn}`}>
            Ручная
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={false}
            className={d.tab}
            disabled
            title="Скоро"
          >
            Авто
          </button>
        </div>

        <div>
          <div className={s.caps} style={{ marginBottom: 6 }}>
            Сумма ставки
          </div>
          <div className={d.amount}>
            <output>{state.stake}</output>
            <button
              type="button"
              className={d.mini}
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
              className={d.mini}
              data-tour="dbl"
              style={{ transform: liftHalf || undefined }}
              disabled={!picking || items}
              onClick={() => dispatch({ type: 'double' })}
              aria-label="Удвоить ставку"
            >
              2×
            </button>
          </div>
        </div>

        <div>
          <div className={s.caps} style={{ marginBottom: 8 }}>
            {items ? 'Предмет · ставка под ним' : 'Фишки · размер ставки'}
          </div>
          {items ? <ItemsBlock /> : <ChipsRow size={46} summary={false} />}
        </div>

        <div className={d.summary}>
          <div>
            <span>Ставка на {r.pick ?? '—'}</span>
            <b>{picking ? state.stake : r.stake}</b>
          </div>
          <div style={{ color: 'var(--even)' }}>
            <span>Выигрыш</span>
            <b>{winAmount(picking ? state.stake : r.stake)}</b>
          </div>
        </div>

        <button
          type="button"
          className={d.cta}
          data-tour="confirm"
          style={{ transform: liftCta || undefined }}
          disabled={!(r.phase === 'done' || canConfirm(state))}
          onClick={onCta}
        >
          {ctaLabel(state)}
        </button>

        <div>
          <div className={s.caps} style={{ marginBottom: 8 }}>
            Последние раунды
          </div>
          <div className={d.recent}>
            {Array.from({ length: 8 }, (_, i) => {
              const h = recent[i];
              return (
                <span
                  key={i}
                  className={d.sq}
                  style={h ? { background: h.won ? '#3DDC97' : '#FF6B81' } : undefined}
                  title={h ? (h.won ? `+${h.amount}` : `−${h.amount}`) : undefined}
                >
                  {h ? (h.won ? `+${h.amount}` : `−${h.amount}`) : ''}
                </span>
              );
            })}
          </div>
        </div>
      </aside>

      <main className={d.main}>
        <Stage layout="desktop" onHelp={onHelp} />
        <DuelStrip height={56} />
        <NumberBoard showParity={showParity ?? false} flying={!!fly} desktop />
      </main>

      {fly && (
        <div
          className={s.flying}
          style={{ left: fly.x, top: fly.y, width: fly.size, height: fly.size }}
          onTransitionEnd={land}
        >
          <Chip value={fly.value} size={fly.size} />
        </div>
      )}
      <FullscreenVideo />
      <OfferModal />
      {children}
    </div>
  );
}
