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
import { roundViewSchema, walletResponseSchema } from '@winhappens/shared';
import { api, ApiError } from '../live/api';
import { playRound } from '../live/rounds';
import { DONE_AFTER_MS, REVEAL_AFTER_MS } from './data';
import { CENT, initialState, reducer, roundOf, type Action, type DuelState } from './logic';

interface DuelCtx {
  state: DuelState;
  dispatch: (a: Action) => void;
  /** Подтвердить ставку: запускает таймеры раунда этого крупье (параллельно с другими). */
  confirm: () => void;
  /** Подтянуть баланс FUN из кошелька core. */
  syncBalance: () => Promise<void>;
  now: number;
}

const Ctx = createContext<DuelCtx | null>(null);

export function DuelProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(Date.now()));
  const [now, setNow] = useState(() => Date.now());
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

  /** Баланс FUN с сервера (живая игра идёт на реальном кошельке). */
  const syncBalance = useCallback(async () => {
    try {
      const w = walletResponseSchema.parse(await api('/wallet'));
      dispatch({ type: 'setBalance', cents: Number(w.FUN.main) });
    } catch {
      // core недоступен — остаёмся на локальном балансе
    }
  }, []);

  /** Раунд с живой крупье: сервер ведёт commit–reveal и деньги, клиент только показывает. */
  const confirmLive = useCallback(
    async (s: DuelState) => {
      const dealer = s.dealer;
      const table = s.dealers[dealer]!;
      const pick = roundOf(s, dealer).pick!;
      const item = s.mode[dealer] === 'items' ? s.item : null;
      dispatch({ type: 'confirm', now: Date.now() });
      try {
        const created = roundViewSchema.parse(
          await api('/rounds', {
            body: { dealerId: table.id, stake: String(s.stake * CENT), ...(item ? { item } : {}) },
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
        const text =
          e instanceof ApiError && e.code === 'insufficient_funds'
            ? 'НЕ ХВАТАЕТ ФИШЕК'
            : 'РАУНД НЕ СОСТОЯЛСЯ';
        dispatch({ type: 'abort', dealer, text, now: Date.now() });
      }
      await syncBalance();
    },
    [syncBalance],
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
    () => ({ state, dispatch, confirm, syncBalance, now }),
    [state, confirm, syncBalance, now],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDuel(): DuelCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useDuel outside DuelProvider');
  return ctx;
}
