import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  roundViewSchema,
  sessionViewSchema,
  walletResponseSchema,
  type SessionView,
} from '@winhappens/shared';
import { api, ApiError } from '../live/api';
import { playRound } from '../live/rounds';
import { connectRealtime, onEvent } from '../live/socket';
import { DONE_AFTER_MS, REVEAL_AFTER_MS } from './data';
import { CENT, initialState, reducer, roundOf, type Action, type DuelState } from './logic';

interface DuelCtx {
  state: DuelState;
  dispatch: (a: Action) => void;
  /** Подтвердить ставку: запускает таймеры раунда этого крупье (параллельно с другими). */
  confirm: () => void;
  /** Подтянуть баланс FUN из кошелька core. */
  syncBalance: () => Promise<void>;
  /** Активные сессии игрока по id крупье (живые столы). */
  sessions: ReadonlyMap<string, SessionView>;
  now: number;
}

const Ctx = createContext<DuelCtx | null>(null);

/** Причина конца сессии → сообщение на сцене. */
const SESSION_END_TEXT: Record<string, string> = {
  time_over: 'СЕССИЯ ЗАВЕРШЕНА · 5:00',
  deposit_exhausted: 'ДЕПОЗИТ СЕССИИ ИСЧЕРПАН',
  dealer_left: 'КРУПЬЕ ВЫШЛА ИЗ-ЗА СТОЛА',
  dealer_disconnected: 'КРУПЬЕ ПОТЕРЯЛА СВЯЗЬ',
  player_disconnected: 'СВЯЗЬ ПОТЕРЯНА · СЕССИЯ ЗАКРЫТА',
};

const ERROR_TEXT: Record<string, string> = {
  insufficient_funds: 'НЕ ХВАТАЕТ НА ДЕПОЗИТ СЕССИИ',
  dealer_busy: 'КРУПЬЕ ЗАНЯТА ДРУГИМ ИГРОКОМ',
  dealer_insufficient_funds: 'У КРУПЬЕ НЕ ХВАТАЕТ НА ДЕПОЗИТ',
  session_deposit_exhausted: 'ДЕПОЗИТ СЕССИИ ИСЧЕРПАН',
  dealer_not_live: 'КРУПЬЕ НЕ В ЭФИРЕ',
};

export function DuelProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(Date.now()));
  const [now, setNow] = useState(() => Date.now());
  const [sessions, setSessions] = useState<ReadonlyMap<string, SessionView>>(new Map());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const timers = useRef<number[]>([]);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => {
      window.clearInterval(id);
      timers.current.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  const putSession = useCallback((s: SessionView) => {
    setSessions((prev) => {
      const next = new Map(prev);
      if (s.status === 'active') next.set(s.dealerId, s);
      else next.delete(s.dealerId);
      return next;
    });
  }, []);

  // Реальное время: присутствие в сети (сессия ждёт переподключения 30 с) и события сервера.
  useEffect(() => {
    connectRealtime();
    api<{ sessions: unknown[] }>('/sessions/active')
      .then(({ sessions: list }) => list.map((x) => sessionViewSchema.parse(x)).forEach(putSession))
      .catch(() => {});
    const offWallet = onEvent('wallet.updated', (e) =>
      // Баланс = основной счёт + депозиты сессий: деньги игрока, пока сессия идёт.
      dispatch({ type: 'setBalance', cents: Number(e.FUN.main + e.FUN.hold) }),
    );
    const offSession = onEvent('session.updated', (e) => {
      const s = e.session;
      if (s.seat !== 0) return;
      putSession(s);
      if (s.status === 'ended' && s.endReason && s.endReason !== 'player_left') {
        const dealer = stateRef.current.dealers.findIndex((d) => d.id === s.dealerId);
        const text = SESSION_END_TEXT[s.endReason];
        if (dealer >= 0 && text) dispatch({ type: 'notice', dealer, text });
      }
    });
    return () => {
      offWallet();
      offSession();
    };
  }, [putSession]);

  /** Баланс FUN с сервера (живая игра идёт на реальном кошельке). */
  const syncBalance = useCallback(async () => {
    try {
      const w = walletResponseSchema.parse(await api('/wallet'));
      dispatch({ type: 'setBalance', cents: Number(w.FUN.main + w.FUN.hold) });
    } catch {
      // core недоступен — остаёмся на локальном балансе
    }
  }, []);

  /**
   * Сессия с крупье под текущую ставку: при первой ставке — открыть (депозит D = S × 5),
   * при смене ставки — закрыть прежнюю и открыть новую.
   */
  const ensureSession = useCallback(
    async (dealerId: string, stake: bigint, item: boolean) => {
      const cur = sessionsRef.current.get(dealerId);
      if (cur && (item || cur.stake === stake)) return cur;
      if (cur)
        putSession(
          sessionViewSchema.parse(await api(`/sessions/${cur.id}/leave`, { method: 'POST' })),
        );
      const s = sessionViewSchema.parse(
        await api('/sessions', { body: { dealerId, stake: stake.toString() } }),
      );
      putSession(s);
      return s;
    },
    [putSession],
  );

  /** Раунд с живой крупье: сервер ведёт сессию, commit–reveal и деньги, клиент показывает. */
  const confirmLive = useCallback(
    async (s: DuelState) => {
      const dealer = s.dealer;
      const table = s.dealers[dealer]!;
      const pick = roundOf(s, dealer).pick!;
      const item = s.mode[dealer] === 'items' ? s.item : null;
      const stake = BigInt(s.stake * CENT);
      dispatch({ type: 'confirm', now: Date.now() });
      try {
        await ensureSession(table.id, stake, item !== null);
        const created = roundViewSchema.parse(
          await api('/rounds', {
            body: { dealerId: table.id, stake: stake.toString(), ...(item ? { item } : {}) },
          }),
        );
        const r = await playRound(created.id, pick, () => {});
        if (r.status === 'cancelled') {
          dispatch({
            type: 'abort',
            dealer,
            text: 'КРУПЬЕ НЕ УСПЕЛА · СТАВКА ВОЗВРАЩЕНА',
            now: Date.now(),
          });
        } else {
          const res = r.result!;
          dispatch({ type: 'reveal', dealer, now: Date.now(), dealerPick: res.dealerNumber });
          await new Promise((ok) => setTimeout(ok, 2_500));
          dispatch({ type: 'finish', dealer, won: res.winnerSeat === 0 });
        }
      } catch (e) {
        const text = (e instanceof ApiError && ERROR_TEXT[e.code]) || 'РАУНД НЕ СОСТОЯЛСЯ';
        dispatch({ type: 'abort', dealer, text, now: Date.now() });
      }
      await syncBalance();
    },
    [ensureSession, syncBalance],
  );

  const confirm = useCallback(() => {
    const s = stateRef.current;
    if (s.dealers[s.dealer]!.live) return void confirmLive(s);
    const dealer = s.dealer;
    dispatch({ type: 'confirm', now: Date.now() });
    // Таймеры на крупье: переключение стола не прерывает чужие раунды.
    timers.current.push(
      window.setTimeout(
        () => dispatch({ type: 'reveal', dealer, now: Date.now() }),
        REVEAL_AFTER_MS,
      ),
      window.setTimeout(
        () => dispatch({ type: 'finish', dealer }),
        REVEAL_AFTER_MS + DONE_AFTER_MS,
      ),
    );
  }, [confirmLive]);

  const value = useMemo(
    () => ({ state, dispatch, confirm, syncBalance, sessions, now }),
    [state, confirm, syncBalance, sessions, now],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDuel(): DuelCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useDuel outside DuelProvider');
  return ctx;
}
