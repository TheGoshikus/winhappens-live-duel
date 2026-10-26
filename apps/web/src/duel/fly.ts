import { useCallback, useState, type RefObject } from 'react';

export interface Fly {
  value: number;
  x: number;
  y: number;
  size: number;
}

/**
 * Перелёт фишки из ряда на плитку числа (ui-spec §3.5): измеряем оба прямоугольника относительно
 * фрейма, рисуем фишку в исходной точке и через 2 rAF двигаем её в центр плитки.
 */
export function useFlyingChip(frame: RefObject<HTMLElement>, targetSize: number) {
  const [fly, setFly] = useState<Fly | null>(null);

  const launch = useCallback(
    (sourceSelector: string, tile: number, value: number) => {
      const root = frame.current;
      const src = root?.querySelector(sourceSelector);
      const dst = root?.querySelector(`[data-tile="${tile}"]`);
      if (!root || !src || !dst) return; // без измерений — статичная фишка на плитке
      const base = root.getBoundingClientRect();
      const a = src.getBoundingClientRect();
      const b = dst.getBoundingClientRect();
      setFly({ value, x: a.left - base.left, y: a.top - base.top, size: a.width });
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          setFly({
            value,
            x: b.left - base.left + (b.width - targetSize) / 2,
            y: b.top - base.top + (b.height - targetSize) / 2,
            size: targetSize,
          }),
        ),
      );
    },
    [frame, targetSize],
  );

  return { fly, launch, land: useCallback(() => setFly(null), []) };
}
