import { roomAccessSchema, type DealerScene } from '@winhappens/shared';
import { createLocalTracks, Room, RoomEvent, Track, type LocalTrack } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SCENES } from '../duel/data';
import { api, ApiError, saveSession } from './api';
import st from './studio.module.css';

interface Me {
  kind: 'guest' | 'registered';
  kyc: { status: 'pending' | 'verified' | 'rejected' } | null;
}

const REASONS: Record<string, string> = {
  registration_required: 'Сначала войдите по коду из SMS или письма.',
  kyc_required: 'Нужна проверка личности.',
  underage: 'Стол крупье доступен только с 18 лет.',
  dealer_female_only:
    'Стол крупье может открыть только девушка (пол подтверждается проверкой личности).',
  user_blocked: 'Аккаунт заблокирован.',
  otp_invalid: 'Неверный или просроченный код.',
  otp_attempts_exceeded: 'Слишком много попыток. Запросите новый код.',
  otp_rate_limited: 'Слишком много кодов. Попробуйте через час.',
};
const explain = (e: unknown) =>
  e instanceof ApiError
    ? (REASONS[e.code] ?? e.message)
    : e instanceof Error
      ? e.message
      : String(e);

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

function Login({ onDone, onError }: { onDone: () => void; onError: (e: string | null) => void }) {
  const [channel, setChannel] = useState<'email' | 'phone'>('email');
  const [destination, setDestination] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const start = async () => {
    onError(null);
    try {
      const r = await api<{ challengeId: string }>('/auth/otp/start', {
        body: { channel, destination },
      });
      setChallengeId(r.challengeId);
    } catch (e) {
      onError(explain(e));
    }
  };
  const verify = async () => {
    onError(null);
    try {
      saveSession(await api('/auth/otp/verify', { body: { challengeId, code } }));
      onDone();
    } catch (e) {
      onError(explain(e));
    }
  };
  return (
    <div className={st.card}>
      <p className={st.muted}>Войдите, чтобы открыть стол. Код придёт в SMS или на почту.</p>
      <div className={st.row}>
        {(['email', 'phone'] as const).map((c) => (
          <button
            key={c}
            type="button"
            className={`${st.opt} ${channel === c ? st.optOn : ''}`}
            onClick={() => setChannel(c)}
          >
            {c === 'email' ? 'Email' : 'Телефон'}
          </button>
        ))}
      </div>
      <input
        className={st.input}
        aria-label={channel === 'email' ? 'Email' : 'Телефон'}
        placeholder={channel === 'email' ? 'name@example.com' : '+7 999 123-45-67'}
        inputMode={channel === 'email' ? 'email' : 'tel'}
        value={destination}
        onChange={(e) => setDestination(e.target.value)}
      />
      {challengeId ? (
        <>
          <input
            className={st.input}
            aria-label="Код"
            placeholder="Код из 6 цифр"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <button type="button" className={st.cta} disabled={code.length !== 6} onClick={verify}>
            Войти
          </button>
        </>
      ) : (
        <button type="button" className={st.cta} disabled={!destination} onClick={start}>
          Получить код
        </button>
      )}
    </div>
  );
}

function Kyc({
  status,
  onDone,
  onError,
}: {
  status: 'pending' | 'rejected' | null;
  onDone: () => void;
  onError: (e: string | null) => void;
}) {
  const [form, setForm] = useState({ birthdate: '1998-03-08', gender: 'female', country: 'DE' });
  const run = async (fn: () => Promise<unknown>) => {
    onError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      onError(explain(e));
    }
  };
  return (
    <div className={st.card}>
      <p className={st.muted}>
        {status === 'pending'
          ? 'Проверка личности запущена.'
          : status === 'rejected'
            ? 'Проверка не пройдена — запустите её заново.'
            : 'Стол крупье открывается после проверки личности: возраст и пол подтверждаются документом.'}
      </p>
      {status !== 'pending' && (
        <button
          type="button"
          className={st.cta}
          onClick={() => run(() => api('/kyc/start', { method: 'POST' }))}
        >
          Пройти проверку личности
        </button>
      )}
      {status === 'pending' && import.meta.env.DEV && (
        <>
          <span className={st.label}>Разработка: результат mock-проверки</span>
          <input
            className={st.input}
            aria-label="Дата рождения"
            type="date"
            value={form.birthdate}
            onChange={(e) => setForm({ ...form, birthdate: e.target.value })}
          />
          <div className={st.row}>
            {(['female', 'male'] as const).map((g) => (
              <button
                key={g}
                type="button"
                className={`${st.opt} ${form.gender === g ? st.optOn : ''}`}
                onClick={() => setForm({ ...form, gender: g })}
              >
                {g === 'female' ? 'Женский' : 'Мужской'}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={st.cta}
            onClick={() => run(() => api('/dev/kyc/complete', { body: form }))}
          >
            Завершить проверку
          </button>
        </>
      )}
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
    } catch (e) {
      onError(explain(e));
    }
  };

  const stop = async () => {
    await room?.disconnect(false);
    setRoom(null);
    await api('/dealer/offline', { method: 'POST' }).catch(() => {});
  };

  useEffect(() => () => void room?.disconnect(), [room]);

  return (
    <>
      <div className={st.preview}>
        <video ref={video} autoPlay muted playsInline data-studio-preview />
        {room && (
          <span className={st.badge}>
            <span className={st.dot} /> В ЭФИРЕ · зрителей: {viewers}
          </span>
        )}
      </div>
      {room ? (
        <div className={st.card}>
          <p className={st.muted}>
            Стол «{name}» открыт. Игроки видят вас в ленте. Сцена — {SCENES[scene].label}, ставка от{' '}
            {minStake}.
          </p>
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
