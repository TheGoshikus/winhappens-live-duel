import { createContext, useContext, useEffect, useRef } from 'react';
import type { Dealer } from '../duel/data';
import s from '../duel/duel.module.css';
import { VideoFill } from '../duel/Video';
import type { LiveMedia } from './room';

/** Видео текущего стола: одна подписка на крупье, её используют кружок и полный экран. */
export const LiveMediaContext = createContext<{ dealerId: string | null; media: LiveMedia }>({
  dealerId: null,
  media: { video: null, audio: null, status: 'idle' },
});

function TrackVideo({ track }: { track: MediaStreamTrack }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = new MediaStream([track]);
    void el.play().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [track]);
  return (
    <video
      ref={ref}
      className={s.videoFill}
      style={{ width: '100%', height: '100%', objectFit: 'cover', padding: 0 }}
      autoPlay
      muted
      playsInline
      data-live-video
    />
  );
}

/** Звук крупье — только в полноэкранном режиме (открыт тапом, autoplay разрешён). */
export function TrackAudio({ track }: { track: MediaStreamTrack | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    el.srcObject = new MediaStream([track]);
    void el.play().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [track]);
  return <audio ref={ref} autoPlay />;
}

/** Видео крупье: живой поток для текущего стола в эфире, иначе заглушка. */
export function DealerVideo({ dealer, label }: { dealer: Dealer; label?: string | null }) {
  const { dealerId, media } = useContext(LiveMediaContext);
  if (dealer.live && dealer.id === dealerId && media.video)
    return <TrackVideo track={media.video} />;
  const pending = dealer.live && dealer.id === dealerId && media.status === 'connecting';
  return (
    <VideoFill
      tint={dealer.tint}
      label={pending ? 'подключение…' : label === undefined ? 'видео-кружок' : label}
    />
  );
}

export const useLiveMedia = () => useContext(LiveMediaContext);
