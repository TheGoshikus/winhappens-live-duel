import { roundViewSchema, type RoundView } from '@winhappens/shared';
import { api } from './api';
import { onEvent } from './socket';

/** 16 случайных байт в hex — соль коммита. */
export function randomSalt(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** commit = sha256("{number}:{salt}") — сервер проверяет то же при раскрытии. */
export async function commitOf(number: number, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${number}:${salt}`),
  );
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
}

const parse = (raw: unknown) => roundViewSchema.parse(raw);
export const getRound = async (id: string) => parse(await api(`/rounds/${id}`));
export const commitRound = async (id: string, number: number, salt: string) =>
  parse(await api(`/rounds/${id}/commit`, { body: { commit: await commitOf(number, salt) } }));
export const revealRound = async (id: string, number: number, salt: string) =>
  parse(await api(`/rounds/${id}/reveal`, { body: { number, salt } }));

/**
 * Полный раунд со стороны одного участника: коммит → ожидание соперника → раскрытие → итог.
 * Ход раунда приходит событиями round.updated по WS; редкий опрос — страховка на случай обрыва.
 * Соль живёт только в памяти до раскрытия. onUpdate получает каждое новое состояние.
 */
export async function playRound(
  id: string,
  number: number,
  onUpdate: (r: RoundView) => void,
  fallbackMs = 3_000,
): Promise<RoundView> {
  const salt = randomSalt();
  const first = await commitRound(id, number, salt);
  return new Promise<RoundView>((resolve, reject) => {
    let done = false;
    let revealing = false;
    const finish = (r: RoundView) => {
      done = true;
      off();
      window.clearInterval(timer);
      resolve(r);
    };
    const step = async (r: RoundView) => {
      if (done || r.id !== id) return;
      onUpdate(r);
      if (r.status === 'settled' || r.status === 'cancelled') return finish(r);
      const mine = r.seat === 0 ? r.revealed.player : r.revealed.dealer;
      if (r.status === 'reveal' && !mine && !revealing) {
        revealing = true;
        try {
          await step(await revealRound(id, number, salt));
        } catch (e) {
          done = true;
          off();
          window.clearInterval(timer);
          reject(e);
        }
      }
    };
    const off = onEvent('round.updated', (e) => void step(e.round));
    const timer = window.setInterval(
      () =>
        void getRound(id)
          .then(step)
          .catch(() => {}),
      fallbackMs,
    );
    void step(first);
  });
}
