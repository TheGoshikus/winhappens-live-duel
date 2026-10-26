import {
  dealerRoundsResponseSchema,
  walletResponseSchema,
  type RoundView,
} from '@winhappens/shared';
import { useEffect, useRef, useState } from 'react';
import { ITEMS } from '../duel/data';
import { fmtMoney } from '../duel/logic';
import { api } from './api';
import { commitRound, randomSalt, revealRound } from './rounds';
import st from './studio.module.css';

const POLL_MS = 700;

/**
 * Пульт крупье: входящий раунд → выбрать число (до дедлайна) → раскрытие автоматически.
 * Соль коммита хранится только в памяти вкладки до раскрытия.
 */
export function DealerRounds() {
  const [rounds, setRounds] = useState<RoundView[]>([]);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const secrets = useRef(new Map<string, { number: number; salt: string }>());
  const busy = useRef(new Set<string>());

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const { rounds: list } = dealerRoundsResponseSchema.parse(await api('/dealer/rounds'));
        if (stop) return;
        setRounds(list);
        setNow(Date.now());
        for (const r of list) {
          const secret = secrets.current.get(r.id);
          if (r.status === 'reveal' && secret && !r.revealed.dealer && !busy.current.has(r.id)) {
            busy.current.add(r.id);
            await revealRound(r.id, secret.number, secret.salt).finally(() =>
              busy.current.delete(r.id),
            );
          }
        }
        const w = walletResponseSchema.parse(await api('/wallet'));
        if (!stop) setBalance(w.FUN.main);
      } catch {
        // временная ошибка сети — следующий тик повторит
      }
    };
    void tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, []);

  const choose = async (r: RoundView, number: number) => {
    if (busy.current.has(r.id)) return;
    busy.current.add(r.id);
    const salt = randomSalt();
    secrets.current.set(r.id, { number, salt });
    try {
      await commitRound(r.id, number, salt);
    } finally {
      busy.current.delete(r.id);
    }
  };

  const open = rounds.find((r) => r.status === 'commit' || r.status === 'reveal');
  const recent = rounds
    .filter((r) => r.status === 'settled' || r.status === 'cancelled')
    .slice(0, 5);
  const secLeft = open ? Math.max(0, Math.ceil((Date.parse(open.commitDeadline) - now) / 1000)) : 0;
  const item = open?.item ? ITEMS.find((i) => i.id === open.item) : null;

  return (
    <div className={st.card} data-dealer-rounds>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className={st.label}>Раунды</span>
        {balance !== null && (
          <span style={{ fontFamily: 'var(--font-mono)' }}>◎ {fmtMoney(Number(balance))}</span>
        )}
      </div>
      {!open && <p className={st.muted}>Ждём ставку игрока…</p>}
      {open && open.status === 'commit' && !open.committed.dealer && (
        <>
          <p className={st.muted} style={{ color: '#fff' }}>
            Игрок ставит <b>{fmtMoney(Number(open.stake))}</b>
            {item ? ` · против «${item.name}» ${item.emoji}` : ''}. Вы — НЕЧЁТ. Выберите число ·{' '}
            {secLeft} с
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
            {Array.from({ length: 10 }, (_, n) => (
              <button
                key={n}
                type="button"
                className={st.opt}
                data-dealer-number={n}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 20,
                  color: n % 2 ? 'var(--odd)' : 'var(--even)',
                }}
                onClick={() => choose(open, n)}
              >
                {n}
              </button>
            ))}
          </div>
        </>
      )}
      {open && (open.committed.dealer || open.status === 'reveal') && (
        <p className={st.muted} style={{ color: '#fff' }}>
          Число {secrets.current.get(open.id)?.number ?? '—'} принято.{' '}
          {open.committed.player ? 'Раскрываем…' : 'Ждём игрока…'}
        </p>
      )}
      {recent.map((r) => {
        const res = r.result;
        const text = !res
          ? 'отменён — ставки возвращены'
          : `${res.playerNumber ?? '?'} + ${res.dealerNumber ?? '?'} · ${res.winnerSeat === 1 ? `вы выиграли +${fmtMoney(Number(res.prize - r.stake - res.stakeFee))}` : `игрок выиграл · −${fmtMoney(Number(r.stake + res.stakeFee))}`}${res.outcome === 'forfeit' ? ' (таймаут)' : ''}`;
        return (
          <div key={r.id} className={st.muted} style={{ fontSize: 13 }} data-dealer-result>
            Ставка {fmtMoney(Number(r.stake))}: {text}
          </div>
        );
      })}
    </div>
  );
}
