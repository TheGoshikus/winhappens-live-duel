import { chipColor } from './data';
import s from './duel.module.css';

interface ChipProps {
  value: number;
  size: number;
  selected?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  /** Для измерения при перелёте фишки. */
  dataChip?: number;
}

/** Фишка казино: край с насечками, внутренний круг с пунктиром, номинал (ui-spec §3.4). */
export function Chip({ value, size, selected, onClick, disabled, dataChip }: ChipProps) {
  const color = chipColor(value);
  const style = {
    width: size,
    height: size,
    background: `repeating-conic-gradient(${color} 0 30deg, #F4F1EA 30deg 45deg)`,
  };
  const inner = (
    <span
      className={s.chipInner}
      style={{ background: color, fontSize: Math.max(9, Math.round(size * 0.3)) }}
    >
      {value}
    </span>
  );
  const cls = `${s.chip} ${selected ? s.chipSel : ''}`;
  if (!onClick) {
    return (
      <span className={cls} style={style} aria-hidden>
        {inner}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cls}
      style={style}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={`Фишка ${value}`}
      data-chip={dataChip}
    >
      {inner}
    </button>
  );
}
