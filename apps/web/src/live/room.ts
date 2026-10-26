import { roomAccessSchema } from '@winhappens/shared';
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import { useEffect, useState } from 'react';
import { api } from './api';

export interface LiveMedia {
  video: MediaStreamTrack | null;
  audio: MediaStreamTrack | null;
  status: 'idle' | 'connecting' | 'live' | 'error';
}

const IDLE: LiveMedia = { video: null, audio: null, status: 'idle' };

/**
 * Подписка на видео крупье: токен зрителя из core → комната LiveKit → треки крупье.
 * dealerId = null — ничего не подключаем (демо-стол).
 */
export function useDealerMedia(dealerId: string | null): LiveMedia {
  const [media, setMedia] = useState<LiveMedia>(IDLE);

  useEffect(() => {
    if (!dealerId) {
      setMedia(IDLE);
      return;
    }
    let cancelled = false;
    const room = new Room({ adaptiveStream: true });
    setMedia({ ...IDLE, status: 'connecting' });

    const update = () => {
      if (cancelled) return;
      const owner = room.remoteParticipants.get(dealerId);
      const pick = (source: Track.Source) =>
        (owner?.getTrackPublication(source)?.track as RemoteTrack | undefined)?.mediaStreamTrack ??
        null;
      setMedia({
        video: pick(Track.Source.Camera),
        audio: pick(Track.Source.Microphone),
        status: 'live',
      });
    };
    room
      .on(RoomEvent.TrackSubscribed, update)
      .on(RoomEvent.TrackUnsubscribed, update)
      .on(RoomEvent.ParticipantDisconnected, update)
      .on(RoomEvent.Disconnected, () => !cancelled && setMedia({ ...IDLE, status: 'error' }));

    api<unknown>(`/dealers/${dealerId}/watch`, { method: 'POST' })
      .then((raw) => {
        const access = roomAccessSchema.parse(raw);
        if (cancelled) return;
        return room.connect(access.url, access.token).then(update);
      })
      .catch(() => !cancelled && setMedia({ ...IDLE, status: 'error' }));

    return () => {
      cancelled = true;
      void room.disconnect();
    };
  }, [dealerId]);

  return media;
}
