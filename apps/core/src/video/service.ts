import type { DealerScene } from '@winhappens/shared';
import type { Db } from '../db/index.js';
import type { Eligibility, EligibilitySubject } from '../eligibility/index.js';
import { AppError, forbidden } from '../errors.js';
import { dealerRoom, type LiveKit } from './livekit.js';

export interface VideoDeps {
  db: Db;
  livekit: LiveKit;
  eligibility: Pick<Eligibility, 'canBeDealer'>;
  subject: (userId: string) => Promise<EligibilitySubject>;
  /** Крупье с идущей сессией — «занята» в ленте. */
  busy?: () => Promise<Set<string>>;
  /** Крупье ушла из эфира: завершить её сессии. */
  onOffline?: (userId: string) => Promise<void>;
  /** Состав эфира изменился (WS dealers.updated). */
  onTablesChanged?: () => Promise<void>;
  clock?: () => Date;
}

export function createVideoService({
  db,
  livekit,
  eligibility,
  subject,
  busy = async () => new Set<string>(),
  onOffline,
  onTablesChanged,
  clock = () => new Date(),
}: VideoDeps) {
  return {
    /** Крупье выходит в эфир: профиль стола + токен на публикацию камеры в свою комнату. */
    async goLive(
      userId: string,
      q: { displayName: string; scene: DealerScene; currency: 'USDT' | 'FUN'; minStake: bigint },
    ) {
      const allowed = eligibility.canBeDealer(await subject(userId));
      if (!allowed.ok) throw forbidden(allowed.reason);
      const room = dealerRoom(userId);
      const now = clock();
      await db
        .insertInto('dealer_profile')
        .values({
          user_id: userId,
          display_name: q.displayName,
          scene: q.scene,
          currency: q.currency,
          min_stake: q.minStake,
          status: 'live',
          room,
          went_live_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.column('user_id').doUpdateSet({
            display_name: q.displayName,
            scene: q.scene,
            currency: q.currency,
            min_stake: q.minStake,
            status: 'live',
            went_live_at: now,
            updated_at: now,
          }),
        )
        .execute();
      await onTablesChanged?.();
      return livekit.dealerToken(userId, q.displayName, room);
    },

    async goOffline(userId: string) {
      await db
        .updateTable('dealer_profile')
        .set({ status: 'offline', updated_at: clock() })
        .where('user_id', '=', userId)
        .execute();
      await onOffline?.(userId);
      await onTablesChanged?.();
    },

    /** Крупье в эфире, давно вышедшие — первыми. */
    async liveDealers() {
      const rows = await db
        .selectFrom('dealer_profile')
        .selectAll()
        .where('status', '=', 'live')
        .orderBy('went_live_at')
        .execute();
      const engaged = await busy();
      return rows.map((r) => ({
        id: r.user_id,
        name: r.display_name,
        scene: r.scene,
        currency: r.currency,
        minStake: r.min_stake.toString(),
        room: r.room,
        busy: engaged.has(r.user_id),
      }));
    },

    /** Игрок смотрит стол: токен только на подписку. */
    async watch(viewerId: string, dealerId: string) {
      if (viewerId === dealerId) throw new AppError(409, 'cannot_watch_self');
      const d = await db
        .selectFrom('dealer_profile')
        .select(['room', 'status'])
        .where('user_id', '=', dealerId)
        .executeTakeFirst();
      if (!d || d.status !== 'live') throw new AppError(404, 'dealer_not_live');
      return livekit.viewerToken(viewerId, d.room);
    },

    /** Вебхук LiveKit: крупье покинула комнату или комната закрыта — стол уходит из эфира. */
    async onLiveKitEvent(e: {
      event: string;
      room?: { name: string };
      participant?: { identity: string };
    }) {
      const room = e.room?.name;
      if (!room?.startsWith('dealer-')) return;
      const owner = room.slice('dealer-'.length);
      const leftOwner = e.event === 'participant_left' && e.participant?.identity === owner;
      if (leftOwner || e.event === 'room_finished') await this.goOffline(owner);
    },
  };
}

export type VideoService = ReturnType<typeof createVideoService>;
