import { createContext, useContext } from 'react';

/** Во время видео-обучения подсвеченный элемент «выдвигается» (ui-spec §7.2). */
export const LIFT_SCALE: Record<string, number> = {
  timer: 1.15,
  duel: 1.04,
  board: 1.03,
  chips: 1.08,
  half: 1.1,
  dbl: 1.1,
  confirm: 1.06,
  help: 1.25,
  center: 1.07,
  ring: 1.07,
  stage: 1,
};

export const TourKeyContext = createContext<string | null>(null);

/** CSS-трансформация выдвижения для элемента data-tour=key (или пустая строка). */
export function useLift(...keys: string[]): string {
  const active = useContext(TourKeyContext);
  const hit = active && keys.includes(active) ? active : null;
  const k = hit ? (LIFT_SCALE[hit] ?? 1) : 1;
  return k === 1 ? '' : ` scale(${k}) translateY(-2px)`;
}

export const LIFT_TRANSITION = 'transform .35s cubic-bezier(.3,1.4,.5,1)';
