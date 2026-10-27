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
  matchViewSchema,
  roundViewSchema,
  sessionViewSchema,
  shiftViewSchema,
  walletResponseSchema,
  type MatchView,
  type SessionView,
  type ShiftChoice,
  type ShiftView,
} from '@winhappens/shared';
import { api, ApiError, currentUserId } from '../live/api';
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
  /** Поиск случайного стола (в т.ч. после «Дальше» на смене). */
  match: MatchView | null;
  findRandom: (genderPref?: 'any' | 'opposite') => Promise<void>;
  cancelMatch: () => Promise<void>;
  /** Экран смены после конца сессии: решение за 15 с. */
  shift: ShiftView | null;
  decideShift: (choice: ShiftChoice) => Promise<void>;
  /** Пополнение со смены: таймер на паузу (один раз). */
  pauseShift: () => Promise<void>;
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
  dealer_declined: 'КРУПЬЕ ОТКЛОНИЛА ИГРУ',
  dealer_timeout: 'КРУПЬЕ НЕ ОТВЕТИЛА',
  match_in_progress: 'ИДЁТ ПОИСК СТОЛА',
  no_tables: 'СВОБОДНЫХ СТОЛОВ НЕТ',
  stake_below_table_min: 'СТАВКА НИЖЕ МИНИМУМА СТОЛА',
};

/** Ожидание ответа крупье на прямую заявку: окно 5 с + запас на сеть. */
const MATCH_WAIT_MS = 8_000;

const pending = (m: MatchView) => m.status === 'waiting' || m.status === 'offered';

export function DuelProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(Date.now()));
  const [now, setNow] = useState(() => Date.now());
  const [sessions, setSessions] = useState<ReadonlyMap<string, SessionView>>(new Map());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [match, setMatch] = useState<MatchView | null>(null);
  const [shift, setShift] = useState<ShiftView | null>(null);
  const shiftRef = useRef(shift);
  shiftRef.current = shift;
  /** Прямые заявки, ждущие ответа крупье: id → resolve. */
  const waiters = useRef(new Map<string, (m: MatchView) => void>());
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
    // Найденный стол: перейти к крупье и взять ставку заявки.
    const onMatch = (m: MatchView) => {
      if (m.playerId !== currentUserId()) return;
      const wait = waiters.current.get(m.id);
      if (wait) {
        if (!pending(m)) wait(m);
        return;
      }
      if (m.mode !== 'random') return;
      if (pending(m)) return setMatch(m);
      setMatch((cur) => (cur && cur.id !== m.id ? cur : null));
      const s = stateRef.current;
      const dealer = s.dealers.findIndex((d) => d.id === m.dealerId);
      if (m.status === 'accepted' && dealer >= 0) {
        dispatch({ type: 'select', dealer, now: Date.now() });
        dispatch({ type: 'setStake', value: Number(m.stake) / CENT, now: Date.now() });
        dispatch({ type: 'notice', dealer, text: `СТОЛ НАЙДЕН · ${s.dealers[dealer]!.name}` });
      } else if (m.status !== 'accepted' && m.reason !== 'player_cancelled') {
        const text = (m.reason && ERROR_TEXT[m.reason]) || 'СТОЛ НЕ НАЙДЕН';
        dispatch({ type: 'notice', dealer: s.dealer, text });
      }
    };
    const onShift = (sh: ShiftView) => {
      if (sh.seat !== 0) return;
      if (sh.status === 'open') return setShift(sh);
      setShift((cur) => (cur && cur.id !== sh.id ? cur : null));
      // «Противоположный пол» требует пол из KYC: без него сервер завершает смену выходом.
      if (sh.outcome === 'exit' && sh.myChoice === 'opposite') {
        const s = stateRef.current;
        dispatch({ type: 'notice', dealer: s.dealer, text: 'ПОЛ НЕ ПОДТВЕРЖДЁН · НУЖЕН KYC' });
      }
      if (sh.outcome === 'stay') {
        const dealer = stateRef.current.dealers.findIndex((d) => d.id === sh.dealerId);
        dispatch({ type: 'setStake', value: Number(sh.stayStake) / CENT, now: Date.now() });
        if (dealer >= 0) dispatch({ type: 'notice', dealer, text: 'ОСТАЁМСЯ · СТАВКА ×2' });
      }
    };
    api<{ matches: unknown[]; shifts: unknown[] }>('/matches/active')
      .then((a) => {
        a.matches.map((x) => matchViewSchema.parse(x)).forEach(onMatch);
        a.shifts.map((x) => shiftViewSchema.parse(x)).forEach(onShift);
      })
      .catch(() => {});
    const offMatch = onEvent('match.updated', (e) => onMatch(e.match));
    const offShift = onEvent('shift.updated', (e) => onShift(e.shift));
    return () => {
      offWallet();
      offSession();
      offMatch();
      offShift();
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
      // Прямая заявка: крупье принимает за 5 с (по умолчанию — автоматически).
      let m = matchViewSchema.parse(
        await api('/matches', { body: { dealerId, stake: stake.toString() } }),
      );
      if (pending(m)) {
        const id = m.id;
        m = await new Promise<MatchView>((resolve) => {
          const done = (v: MatchView) => {
            waiters.current.delete(id);
            window.clearInterval(poll);
            window.clearTimeout(limit);
            resolve(v);
          };
          waiters.current.set(id, done);
          // Страховка на случай потерянного события.
          const poll = window.setInterval(() => {
            api(`/matches/${id}`)
              .then((x) => {
                const v = matchViewSchema.parse(x);
                if (!pending(v)) done(v);
              })
              .catch(() => {});
          }, 1_500);
          const limit = window.setTimeout(() => {
            void api(`/matches/${id}/cancel`, { method: 'POST' }).catch(() => {});
            done({ ...m, status: 'expired', reason: 'dealer_timeout' });
          }, MATCH_WAIT_MS);
        });
      }
      if (m.status !== 'accepted' || !m.sessionId)
        throw new ApiError(409, m.reason ?? 'dealer_busy', 'match not accepted');
      const { sessions: list } = await api<{ sessions: unknown[] }>('/sessions/active');
      const s = list.map((x) => sessionViewSchema.parse(x)).find((x) => x.id === m.sessionId);
      if (!s) throw new ApiError(409, 'session_not_found', 'session not found');
      putSession(s);
      return s;
    },
    [putSession],
  );

  const findRandom = useCallback(async (genderPref: 'any' | 'opposite' = 'any') => {
    const s = stateRef.current;
    try {
      const m = matchViewSchema.parse(
        await api('/matches', {
          body: { stake: String(s.stake * CENT), currency: 'FUN', genderPref },
        }),
      );
      // Событие match.updated могло прийти раньше ответа — обработчик тот же.
      if (pending(m)) setMatch(m);
      else if (m.status === 'accepted') {
        const dealer = stateRef.current.dealers.findIndex((d) => d.id === m.dealerId);
        if (dealer >= 0) {
          dispatch({ type: 'select', dealer, now: Date.now() });
          dispatch({ type: 'setStake', value: Number(m.stake) / CENT, now: Date.now() });
        }
      }
    } catch (e) {
      const text = (e instanceof ApiError && ERROR_TEXT[e.code]) || 'ПОИСК НЕ УДАЛСЯ';
      dispatch({ type: 'notice', dealer: s.dealer, text });
    }
  }, []);

  const cancelMatch = useCallback(async () => {
    const m = match;
    setMatch(null);
    if (m) await api(`/matches/${m.id}/cancel`, { method: 'POST' }).catch(() => {});
  }, [match]);

  const decideShift = useCallback(async (choice: ShiftChoice) => {
    const sh = shiftRef.current;
    if (!sh || sh.myChoice) return;
    setShift({ ...sh, myChoice: choice });
    try {
      const v = shiftViewSchema.parse(await api(`/shifts/${sh.id}/decide`, { body: { choice } }));
      setShift((cur) => (cur?.id !== v.id ? cur : v.status === 'open' ? v : null));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'stay_unavailable')
        setShift({ ...sh, canStay: false });
      else setShift(null);
    }
  }, []);

  const pauseShift = useCallback(async () => {
    const sh = shiftRef.current;
    if (!sh || sh.paused) return;
    try {
      setShift(shiftViewSchema.parse(await api(`/shifts/${sh.id}/pause`, { method: 'POST' })));
    } catch {
      // смена уже закрыта — событие уберёт экран
    }
  }, []);

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
    () => ({
      state,
      dispatch,
      confirm,
      syncBalance,
      sessions,
      match,
      findRandom,
      cancelMatch,
      shift,
      decideShift,
      pauseShift,
      now,
    }),
    [
      state,
      confirm,
      syncBalance,
      sessions,
      match,
      findRandom,
      cancelMatch,
      shift,
      decideShift,
      pauseShift,
      now,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDuel(): DuelCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useDuel outside DuelProvider');
  return ctx;
}
