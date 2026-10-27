import { roomAccessSchema, type DealerScene } from '@winhappens/shared';
import { createLocalTracks, Room, RoomEvent, Track, type LocalTrack } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SCENES } from '../duel/data';
import { Kyc, Login, explain } from './Account';
import { api } from './api';
import { DealerRounds } from './DealerRounds';
import st from './studio.module.css';

interface Me {
  kind: 'guest' | 'registered';
  kyc: { status: 'pending' | 'verified' | 'rejected' } | null;
}

const STAKES = [1, 5, 10, 25];

/** Студия крупье: вход, проверка личности, настройка стола и эфир с камеры (LiveKit). */
export function DealerStudio() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadMe = useCallback(
    () =>
      api<Me>('/me')
        .then(setMe)
        .catch((e) => setError(explain(e))),
    [],
  );
  useEffect(() => void loadMe(), [loadMe]);

  const step = !me
    ? 'loading'
    : me.kind !== 'registered'
      ? 'login'
      : me.kyc?.status !== 'verified'
        ? 'kyc'
        : 'live';
  return (
    <div className={st.page}>
      <div className={st.head}>
        <b>Win!</b>
        <a href="#/" style={{ color: '#C8CDDA', fontSize: 14 }}>
          К игре
        </a>
      </div>
      <h1 className={st.title}>Студия крупье</h1>
      {error && <div className={st.error}>{error}</div>}
      {step === 'login' && <Login onDone={loadMe} onError={setError} />}
      {step === 'kyc' && (
        <Kyc
          status={
            me!.kyc?.status === 'pending' || me!.kyc?.status === 'rejected' ? me!.kyc.status : null
          }
          onDone={loadMe}
          onError={setError}
        />
      )}
      {step === 'live' && <Broadcast onError={setError} />}
    </div>
  );
}

function Broadcast({ onError }: { onError: (e: string | null) => void }) {
  const [name, setName] = useState('');
  const [scene, setScene] = useState<DealerScene>('cabaret');
  const [minStake, setMinStake] = useState(5);
  const [tracks, setTracks] = useState<LocalTrack[]>([]);
  const [room, setRoom] = useState<Room | null>(null);
  const [viewers, setViewers] = useState(0);
  const [autoAccept, setAutoAccept] = useState(true);
  const video = useRef<HTMLVideoElement>(null);

  // Превью камеры до выхода в эфир.
  useEffect(() => {
    let local: LocalTrack[] = [];
    createLocalTracks({
      audio: true,
      video: { facingMode: 'user', resolution: { width: 720, height: 960 } },
    })
      .then((t) => {
        local = t;
        setTracks(t);
      })
      .catch(() => onError('Нет доступа к камере или микрофону. Разрешите их в браузере.'));
    return () => local.forEach((t) => t.stop());
  }, [onError]);

  useEffect(() => {
    const cam = tracks.find((t) => t.kind === Track.Kind.Video);
    if (cam && video.current) cam.attach(video.current);
    return () => {
      if (cam && video.current) cam.detach(video.current);
    };
  }, [tracks]);

  const goLive = async () => {
    onError(null);
    try {
      const access = roomAccessSchema.parse(
        await api('/dealer/live', {
          body: {
            displayName: name.trim(),
            scene,
            currency: 'FUN',
            minStake: String(minStake * 100),
          },
        }),
      );
      const r = new Room();
      const count = () => setViewers(r.remoteParticipants.size);
      r.on(RoomEvent.ParticipantConnected, count).on(RoomEvent.ParticipantDisconnected, count);
      await r.connect(access.url, access.token);
      for (const t of tracks) await r.localParticipant.publishTrack(t);
      count();
      setRoom(r);
      await saveAutoAccept(autoAccept);
    } catch (e) {
      onError(explain(e));
    }
  };

  const saveAutoAccept = async (v: boolean) => {
    setAutoAccept(v);
    await api('/dealer/settings', { method: 'PATCH', body: { autoAccept: v } }).catch(() => {});
  };

  const stop = async () => {
    await room?.disconnect(false);
    setRoom(null);
    await api('/dealer/offline', { method: 'POST' }).catch(() => {});
  };

  useEffect(() => () => void room?.disconnect(), [room]);

  return (
    <>
      <div className={`${st.preview} ${room ? st.previewLive : ''}`}>
        <video ref={video} autoPlay muted playsInline data-studio-preview />
        {room && (
          <span className={st.badge}>
            <span className={st.dot} /> В ЭФИРЕ · зрителей: {viewers}
          </span>
        )}
      </div>
      {room && <DealerRounds />}
      {room ? (
        <div className={st.card}>
          <p className={st.muted}>
            Стол «{name}» открыт. Игроки видят вас в ленте. Сцена — {SCENES[scene].label}, ставка от{' '}
            {minStake}.
          </p>
          <label className={st.muted} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              aria-label="Принимать игроков автоматически"
              checked={autoAccept}
              onChange={(e) => void saveAutoAccept(e.target.checked)}
            />
            Принимать игроков автоматически
          </label>
          <button type="button" className={`${st.cta} ${st.danger}`} onClick={stop}>
            Завершить эфир
          </button>
        </div>
      ) : (
        <div className={st.card}>
          <span className={st.label}>Имя за столом</span>
          <input
            className={st.input}
            aria-label="Имя за столом"
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <span className={st.label}>Декорация</span>
          <div className={st.row}>
            {(Object.keys(SCENES) as DealerScene[]).map((k) => (
              <button
                key={k}
                type="button"
                className={`${st.opt} ${scene === k ? st.optOn : ''}`}
                onClick={() => setScene(k)}
              >
                {SCENES[k].label}
              </button>
            ))}
          </div>
          <span className={st.label}>Минимальная ставка</span>
          <div className={st.row}>
            {STAKES.map((v) => (
              <button
                key={v}
                type="button"
                className={`${st.opt} ${minStake === v ? st.optOn : ''}`}
                onClick={() => setMinStake(v)}
              >
                {v}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={st.cta}
            disabled={!name.trim() || tracks.length === 0}
            onClick={goLive}
          >
            Выйти в эфир
          </button>
        </div>
      )}
    </>
  );
}
