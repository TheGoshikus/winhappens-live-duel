import { useRef } from 'react';
import { BottomPanel } from './BottomPanel';
import { Chip } from './Chip';
import s from './duel.module.css';
import { DuelStrip } from './DuelStrip';
import { useFlyingChip } from './fly';
import { canConfirm, fmtMoney, roundOf } from './logic';
import { NumberBoard } from './NumberBoard';
import { FullscreenVideo, OfferModal } from './Overlays';
import { Stage } from './Stage';
import { useDuel } from './store';

interface Props {
  onHelp: () => void;
  showParity?: boolean;
  frameRef?: React.RefObject<HTMLDivElement>;
  children?: React.ReactNode;
}

/** Мобильный игровой экран 390×844 (ui-spec §3, блок 5a). */
export function MobileGame({ onHelp, showParity, frameRef, children }: Props) {
  const { state, confirm } = useDuel();
  const own = useRef<HTMLDivElement>(null);
  const frame = frameRef ?? own;
  const { fly, launch, land } = useFlyingChip(frame, 34);

  const onConfirm = () => {
    const r = roundOf(state, state.dealer);
    if (!canConfirm(state) || r.pick === null) return;
    const src =
      state.mode[state.dealer] === 'items'
        ? `[data-item="${state.item}"]`
        : `[data-chip="${state.chip}"]`;
    launch(src, r.pick, state.stake);
    confirm();
  };

  return (
    <div className={s.app} ref={frame}>
      <div className={s.statusBar}>
        <span className={s.logo}>Win!</span>
        <span className={s.balance} aria-label="Баланс">
          ◎ {fmtMoney(state.balance)}
        </span>
      </div>
      <Stage layout="mobile" onHelp={onHelp} />
      <DuelStrip />
      <NumberBoard showParity={showParity ?? false} flying={!!fly} />
      <BottomPanel onConfirm={onConfirm} />
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
