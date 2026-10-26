import s from './duel.module.css';

/** Заглушка видеопотока крупье: градиент оттенка + штриховка + подпись. */
export function VideoFill({
  tint,
  label = 'видео-кружок',
}: {
  tint: string;
  label?: string | null;
}) {
  return (
    <div
      className={s.videoFill}
      style={{
        background: `repeating-linear-gradient(135deg, #ffffff0d 0 6px, transparent 6px 14px), radial-gradient(circle at 50% 35%, ${tint} 0%, ${tint}aa 45%, #0b1230 100%), #0b1230`,
      }}
    >
      {label}
    </div>
  );
}
