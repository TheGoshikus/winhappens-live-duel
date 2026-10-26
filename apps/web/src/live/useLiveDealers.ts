import { liveDealersResponseSchema } from '@winhappens/shared';
import { useEffect } from 'react';
import type { LiveTable } from '../duel/logic';
import { useDuel } from '../duel/store';
import { api } from './api';

const POLL_MS = 5_000;

/** Опрашивает GET /dealers и синхронизирует столы. Без core игра остаётся на демо-столах. */
export function useLiveDealers() {
  const { dispatch, syncBalance } = useDuel();
  useEffect(() => {
    let stop = false;
    let online = false;
    const tick = async () => {
      try {
        const { dealers } = liveDealersResponseSchema.parse(await api<unknown>('/dealers'));
        const live: LiveTable[] = dealers.map((d) => ({
          id: d.id,
          name: d.name,
          scene: d.scene,
          // FUN — сотые доли фишки; на экране ставки в целых фишках.
          min: Math.max(
            1,
            Number(d.currency === 'FUN' ? d.minStake / 100n : d.minStake / 1_000_000n),
          ),
        }));
        if (stop) return;
        dispatch({ type: 'syncLive', live, now: Date.now() });
        // Появились живые столы — дальше играем на реальном кошельке.
        if (live.length && !online) {
          online = true;
          await syncBalance();
        }
      } catch {
        // core недоступен — демо-режим
      }
    };
    void tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [dispatch, syncBalance]);
}
