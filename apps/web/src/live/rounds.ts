import { roundViewSchema, type RoundView } from '@winhappens/shared';
import { api } from './api';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Полный раунд со стороны одного участника: коммит → ожидание соперника → раскрытие → итог.
 * Соль живёт только в памяти до раскрытия. onUpdate получает каждое новое состояние.
 */
export async function playRound(
  id: string,
  number: number,
  onUpdate: (r: RoundView) => void,
  pollMs = 700,
): Promise<RoundView> {
  const salt = randomSalt();
  let r = await commitRound(id, number, salt);
  onUpdate(r);
  for (;;) {
    if (r.status === 'settled' || r.status === 'cancelled') return r;
    const mine = r.seat === 0 ? r.revealed.player : r.revealed.dealer;
    if (r.status === 'reveal' && !mine) {
      r = await revealRound(id, number, salt);
      onUpdate(r);
      continue;
    }
    await sleep(pollMs);
    r = await getRound(id);
    onUpdate(r);
  }
}
