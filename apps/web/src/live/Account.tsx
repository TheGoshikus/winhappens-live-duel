import { useState } from 'react';
import { api, ApiError, saveSession } from './api';
import st from './studio.module.css';

export const REASONS: Record<string, string> = {
  self_excluded: 'Действует самоисключение — пополнение недоступно.',
  geo_blocked: 'Игра на реальные деньги недоступна в вашей стране.',
  geo_unknown: 'Не удалось определить страну.',
  insufficient_funds: 'Недостаточно средств.',
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
export const explain = (e: unknown) =>
  e instanceof ApiError
    ? (REASONS[e.code] ?? e.message)
    : e instanceof Error
      ? e.message
      : String(e);

/** Вход по коду из SMS или письма; гостевая сессия становится зарегистрированной. */
export function Login({
  onDone,
  onError,
  hint = 'Войдите, чтобы открыть стол. Код придёт в SMS или на почту.',
}: {
  onDone: () => void;
  onError: (e: string | null) => void;
  hint?: string;
}) {
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
      <p className={st.muted}>{hint}</p>
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

export function Kyc({
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
