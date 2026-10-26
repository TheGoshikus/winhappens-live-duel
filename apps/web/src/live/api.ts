import { tokenPairSchema, type TokenPair } from '@winhappens/shared';

const KEY = 'wh.session';

type Session = Pick<TokenPair, 'userId' | 'accessToken' | 'refreshToken'>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function load(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        userId: s.userId,
        accessToken: s.accessToken,
        refreshToken: s.refreshToken,
      }),
    );
  } catch {
    // приватный режим: сессия живёт до перезагрузки
  }
  current = s;
}

let current: Session | null = null;
let pending: Promise<Session> | null = null;

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`/api${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Гостевая сессия создаётся при первом обращении (игра на фантиках без регистрации). */
async function session(): Promise<Session> {
  current ??= load();
  if (current) return current;
  pending ??= post('/auth/guest', {})
    .then(async (r) => {
      if (!r.ok) throw new ApiError(r.status, 'guest_failed', 'не удалось создать гостевую сессию');
      const s = tokenPairSchema.parse(await r.json());
      saveSession(s);
      return s;
    })
    .finally(() => (pending = null));
  return pending;
}

async function refresh(s: Session): Promise<Session | null> {
  const r = await post('/auth/refresh', { refreshToken: s.refreshToken });
  if (!r.ok) return null;
  const next = tokenPairSchema.parse(await r.json());
  saveSession(next);
  return next;
}

/** Запрос к core с Bearer-токеном; при 401 — обновление токена, иначе новая гостевая сессия. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const send = (token: string) =>
    fetch(`/api${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? null : JSON.stringify(init.body),
    });
  let s = await session();
  let res = await send(s.accessToken);
  if (res.status === 401) {
    const renewed = await refresh(s);
    if (!renewed) {
      current = null;
      try {
        localStorage.removeItem(KEY);
      } catch {
        // ничего
      }
    }
    s = renewed ?? (await session());
    res = await send(s.accessToken);
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new ApiError(res.status, json.error ?? 'error', json.message ?? res.statusText);
  return json as T;
}

export const currentUserId = () => (current ?? load())?.userId ?? null;
