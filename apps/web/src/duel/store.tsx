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
import { DONE_AFTER_MS, REVEAL_AFTER_MS } from './data';
import { initialState, reducer, type Action, type DuelState } from './logic';

interface DuelCtx {
  state: DuelState;
  dispatch: (a: Action) => void;
  /** Подтвердить ставку: запускает таймеры раунда этого крупье (параллельно с другими). */
  confirm: () => void;
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

  const confirm = useCallback(() => {
    const dealer = stateRef.current.dealer;
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
  }, []);

  const value = useMemo(() => ({ state, dispatch, confirm, now }), [state, confirm, now]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDuel(): DuelCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useDuel outside DuelProvider');
  return ctx;
}
