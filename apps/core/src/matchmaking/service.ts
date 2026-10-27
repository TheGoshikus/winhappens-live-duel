import type { GameConfig } from '@winhappens/config';
import {
  stakeFee,
  toWire,
  type MatchViewWire,
  type ShiftChoice,
  type ShiftViewWire,
} from '@winhappens/shared';
import type { Selectable } from 'kysely';
import { uuidv7 } from 'uuidv7';
import type { Db } from '../db/index.js';
import type { MatchTicketTable, ShiftTable } from '../db/schema.js';
import type { Eligibility, EligibilitySubject } from '../eligibility/index.js';
import { AppError, forbidden } from '../errors.js';
import type { RoundService } from '../rounds/service.js';
import type { WalletService } from '../wallet/service.js';

type Ticket = Selectable<MatchTicketTable>;
type Shift = Selectable<ShiftTable>;

export interface MatchChanges {
  tickets: Set<string>;
  shifts: Set<string>;
}

export interface MatchmakingDeps {
  db: Db;
  rounds: RoundService;
  wallet: WalletService;
  eligibility: Pick<Eligibility, 'canPlay' | 'canOpposite'>;
  subject: (userId: string, ipCountry: string | null) => Promise<EligibilitySubject>;
  game: Pick<
    GameConfig,
    | 'matchAcceptSec'
    | 'inlineDepositPauseSec'
    | 'maxStayStreak'
    | 'stayStakeMultiplier'
    | 'roundsBuffer'
    | 'stakeFeeBps'
  >;
  emit?: (ch: MatchChanges, svc: Matchmaking) => Promise<void>;
  clock?: () => Date;
}

/** Сколько недавних соперниц не предлагать в случайном подборе (если есть другие). */
const RECENT_OPPONENTS = 3;
/** Случайная заявка без свободных столов истекает. */
const WAITING_TTL_MS = 60_000;

/**
 * Матчмейкинг (architecture §4: IN_FEED → WAITING → MATCH_PENDING → IN_SESSION) и смена
 * (IN_SHIFT → stay / next / opposite / exit). Крупье подтверждает матч за matchAcceptSec.
 */
export function createMatchmaking(deps: MatchmakingDeps) {
  const { db, rounds, wallet, eligibility, subject, game } = deps;
  const clock = deps.clock ?? (() => new Date());

  async function run<T>(fn: (ch: MatchChanges) => Promise<T>): Promise<T> {
    const ch: MatchChanges = { tickets: new Set(), shifts: new Set() };
    try {
      return await fn(ch);
    } finally {
      if (deps.emit && (ch.tickets.size || ch.shifts.size))
        await deps.emit(ch, svc).catch(() => {});
    }
  }

  const ticket = (id: string) =>
    db.selectFrom('match_ticket').selectAll().where('id', '=', id).executeTakeFirst();
  const setTicket = (id: string, patch: Partial<Ticket>) =>
    db
      .updateTable('match_ticket')
      .set({ ...patch, updated_at: clock() } as never)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

  function ticketView(t: Ticket): MatchViewWire {
    return {
      id: t.id,
      playerId: t.player_id,
      dealerId: t.dealer_id,
      mode: t.mode,
      currency: t.currency,
      stake: toWire(t.stake),
      status: t.status,
      reason: t.reason,
      offerDeadline: t.offer_deadline?.toISOString() ?? null,
      sessionId: t.session_id,
    };
  }

  /** Недавние соперницы игрока (последние сессии). */
  async function recentOpponents(playerId: string): Promise<Set<string>> {
    const rows = await db
      .selectFrom('duel_session')
      .select('dealer_id')
      .where('player_id', '=', playerId)
      .orderBy('started_at', 'desc')
      .limit(RECENT_OPPONENTS)
      .execute();
    return new Set(rows.map((r) => r.dealer_id));
  }

  /** Свободные столы: в эфире, без сессии и без висящего предложения. */
  async function freeTables(q: { currency?: 'USDT' | 'FUN'; stake?: bigint }) {
    let query = db
      .selectFrom('dealer_profile as d')
      .leftJoin('kyc_verification as k', 'k.user_id', 'd.user_id')
      .select([
        'd.user_id',
        'd.display_name',
        'd.scene',
        'd.currency',
        'd.min_stake',
        'd.auto_accept',
        'd.went_live_at',
        'k.verified_gender',
      ])
      .where('d.status', '=', 'live')
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('duel_session')
              .select('id')
              .whereRef('dealer_id', '=', 'd.user_id')
              .where('status', '=', 'active'),
          ),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('match_ticket')
              .select('id')
              .whereRef('dealer_id', '=', 'd.user_id')
              .where('status', '=', 'offered'),
          ),
        ),
      )
      .orderBy('d.went_live_at');
    if (q.currency) query = query.where('d.currency', '=', q.currency);
    if (q.stake !== undefined) query = query.where('d.min_stake', '<=', q.stake);
    return query.execute();
  }

  /** Предложить матч крупье; с автопринятием — сразу принять. */
  async function offer(t: Ticket, dealerId: string, ch: MatchChanges): Promise<Ticket | null> {
    try {
      t = await setTicket(t.id, {
        status: 'offered',
        dealer_id: dealerId,
        offer_deadline: new Date(clock().getTime() + game.matchAcceptSec * 1000),
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return null; // крупье уже предложили другому
      throw e;
    }
    ch.tickets.add(t.id);
    const auto = await db
      .selectFrom('dealer_profile')
      .select('auto_accept')
      .where('user_id', '=', dealerId)
      .executeTakeFirst();
    if (auto?.auto_accept) return acceptTicket(t, ch);
    return t;
  }

  /** Случайный подбор: ключ — валюта, ставка, пол; недавних соперниц — в последнюю очередь. */
  async function tryMatch(t: Ticket, ch: MatchChanges): Promise<Ticket> {
    if (t.status !== 'waiting') return t;
    let tables = (await freeTables({ currency: t.currency, stake: t.stake })).filter(
      (d) => d.user_id !== t.player_id && !t.excluded.includes(d.user_id),
    );
    if (t.gender_pref === 'opposite') {
      const me = await subject(t.player_id, null);
      tables = tables.filter(
        (d) => d.verified_gender && d.verified_gender !== me.kyc?.verifiedGender,
      );
    }
    const recent = await recentOpponents(t.player_id);
    tables.sort((a, b) => Number(recent.has(a.user_id)) - Number(recent.has(b.user_id)));
    for (const d of tables) {
      const offered = await offer(t, d.user_id, ch);
      if (offered) return offered;
    }
    return t;
  }

  /** Крупье приняла (или автопринятие): открыть сессию. */
  async function acceptTicket(t: Ticket, ch: MatchChanges): Promise<Ticket> {
    try {
      const s = await rounds.startSession(
        t.player_id,
        { dealerId: t.dealer_id!, stake: t.stake, stayStreak: t.stay_streak },
        t.player_ip_country?.trim() ?? null,
      );
      t = await setTicket(t.id, { status: 'accepted', session_id: s.id, offer_deadline: null });
    } catch (e) {
      const code = e instanceof AppError ? e.code : 'session_failed';
      // Крупье не может играть (нет денег, занята) — случайную заявку отдаём дальше.
      if (t.mode === 'random' && code.startsWith('dealer_')) return rejectOffer(t, code, ch);
      t = await setTicket(t.id, { status: 'cancelled', reason: code, offer_deadline: null });
    }
    ch.tickets.add(t.id);
    return t;
  }

  /** Отказ/таймаут крупье: прямая заявка отменяется, случайная — ищет дальше без неё. */
  async function rejectOffer(t: Ticket, reason: string, ch: MatchChanges): Promise<Ticket> {
    ch.tickets.add(t.id);
    if (t.mode === 'direct')
      return setTicket(t.id, {
        status: 'cancelled',
        reason: `dealer_${reason}`,
        offer_deadline: null,
      });
    const next = await setTicket(t.id, {
      status: 'waiting',
      dealer_id: null,
      offer_deadline: null,
      excluded: [...t.excluded, t.dealer_id!],
    });
    return tryMatch(next, ch);
  }

  async function createTicket(
    playerId: string,
    q: {
      mode: 'direct' | 'random';
      dealerId?: string | undefined;
      currency: 'USDT' | 'FUN';
      stake: bigint;
      genderPref: 'any' | 'opposite';
      excluded?: string[];
      stayStreak?: number;
    },
    ipCountry: string | null,
    ch: MatchChanges,
  ): Promise<Ticket> {
    const me = await subject(playerId, ipCountry);
    if (q.genderPref === 'opposite') {
      const d = eligibility.canOpposite(me);
      if (!d.ok) throw forbidden(d.reason);
    }
    const d = eligibility.canPlay(me, { currency: q.currency, stake: q.stake });
    if (!d.ok) throw forbidden(d.reason);
    try {
      const t = await db
        .insertInto('match_ticket')
        .values({
          id: uuidv7(),
          player_id: playerId,
          mode: q.mode,
          currency: q.currency,
          stake: q.stake,
          gender_pref: q.genderPref,
          player_ip_country: ipCountry,
          dealer_id: null,
          status: 'waiting',
          reason: null,
          offer_deadline: null,
          excluded: q.excluded ?? [],
          stay_streak: q.stayStreak ?? 0,
          session_id: null,
          created_at: clock(),
          updated_at: clock(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      ch.tickets.add(t.id);
      return t;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError(409, 'match_in_progress');
      throw e;
    }
  }

  // ---------- смена ----------

  const stayStakeOf = (sh: Shift) => sh.stake * BigInt(game.stayStakeMultiplier);

  /** «Остаться ×2»: лимит серии и депозит D' = 2S × buffer у обоих (со сбором раунда). */
  async function canStay(sh: Shift): Promise<boolean> {
    if (sh.stay_streak >= game.maxStayStreak) return false;
    // Депозит новой сессии; ставка раунда со сбором должна в него помещаться.
    const deposit = stayStakeOf(sh) * BigInt(game.roundsBuffer);
    if (deposit < stayStakeOf(sh) + stakeFee(stayStakeOf(sh), game.stakeFeeBps)) return false;
    for (const u of [sh.player_id, sh.dealer_id]) {
      if ((await wallet.balances(u))[sh.currency].main < deposit) return false;
    }
    return true;
  }

  async function shiftView(sh: Shift, viewerId: string): Promise<ShiftViewWire> {
    const seat = sh.player_id === viewerId ? 0 : sh.dealer_id === viewerId ? 1 : null;
    if (seat === null) throw new AppError(404, 'shift_not_found');
    return {
      id: sh.id,
      sessionId: sh.session_id,
      dealerId: sh.dealer_id,
      playerId: sh.player_id,
      seat,
      currency: sh.currency,
      stake: toWire(sh.stake),
      stayStake: toWire(stayStakeOf(sh)),
      canStay: sh.status === 'open' ? await canStay(sh) : false,
      stayStreak: sh.stay_streak,
      deadline: sh.deadline.toISOString(),
      paused: sh.paused,
      myChoice: seat === 0 ? sh.player_choice : sh.dealer_choice,
      opponentChose: seat === 0 ? sh.dealer_choice !== null : sh.player_choice !== null,
      status: sh.status,
      outcome: sh.outcome,
      nextSessionId: sh.next_session_id,
    };
  }

  const lockShift = async (trx: Db, id: string) => {
    const sh = await trx
      .selectFrom('shift')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!sh) throw new AppError(404, 'shift_not_found');
    return sh;
  };

  /**
   * Итог смены: оба «остаться» — новая сессия с ×2 и серией +1; игрок «дальше»/«противоположный
   * пол» (или остался один) — случайный подбор без этой крупье; «выйти» или молчание — в ленту.
   */
  async function resolveShift(id: string, ch: MatchChanges, atDeadline: boolean) {
    const sh = await db.transaction().execute(async (trx) => {
      const x = await lockShift(trx, id);
      if (x.status !== 'open') return null;
      const p = x.player_choice;
      const needDealer = p === 'stay' && x.dealer_choice === null && !atDeadline;
      if (needDealer || (p === null && !atDeadline)) return null;
      return trx
        .updateTable('shift')
        .set({ status: 'resolved' })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    if (!sh) return;
    ch.shifts.add(sh.id);

    let outcome: string = 'exit';
    let nextSession: string | null = null;
    const playerIp =
      (
        await db
          .selectFrom('users')
          .select('ip_country')
          .where('id', '=', sh.player_id)
          .executeTakeFirst()
      )?.ip_country?.trim() ?? null;
    if (sh.player_choice === 'stay' && sh.dealer_choice === 'stay' && (await canStay(sh))) {
      try {
        const s = await rounds.startSession(
          sh.player_id,
          { dealerId: sh.dealer_id, stake: stayStakeOf(sh), stayStreak: sh.stay_streak + 1 },
          playerIp,
        );
        outcome = 'stay';
        nextSession = s.id;
      } catch {
        outcome = 'next';
      }
    } else if (
      sh.player_choice === 'stay' ||
      sh.player_choice === 'next' ||
      sh.player_choice === 'opposite'
    ) {
      outcome = sh.player_choice === 'opposite' ? 'opposite' : 'next';
    }
    if (outcome === 'next' || outcome === 'opposite') {
      try {
        const t = await createTicket(
          sh.player_id,
          {
            mode: 'random',
            currency: sh.currency,
            stake: sh.stake,
            genderPref: outcome === 'opposite' ? 'opposite' : 'any',
            excluded: [sh.dealer_id],
          },
          playerIp,
          ch,
        );
        await tryMatch(t, ch);
      } catch {
        outcome = 'exit';
      }
    }
    await db
      .updateTable('shift')
      .set({ outcome, next_session_id: nextSession })
      .where('id', '=', sh.id)
      .execute();
  }

  const svc = {
    ticketView,
    shiftView,

    /** Прямая заявка (тап по карточке) или «Случайный» (без dealerId). */
    async request(
      playerId: string,
      q: {
        dealerId?: string | undefined;
        stake: bigint;
        currency: 'USDT' | 'FUN';
        genderPref: 'any' | 'opposite';
      },
      ipCountry: string | null,
    ) {
      return run(async (ch) => {
        const pending = await db
          .selectFrom('match_ticket')
          .select('id')
          .where('player_id', '=', playerId)
          .where('status', 'in', ['waiting', 'offered'])
          .executeTakeFirst();
        if (pending) throw new AppError(409, 'match_in_progress');
        if (q.dealerId) {
          if (q.dealerId === playerId) throw new AppError(409, 'cannot_play_self');
          const table = (await freeTables({})).find((d) => d.user_id === q.dealerId);
          if (!table) {
            const live = await db
              .selectFrom('dealer_profile')
              .select('status')
              .where('user_id', '=', q.dealerId)
              .executeTakeFirst();
            throw new AppError(
              live?.status === 'live' ? 409 : 404,
              live?.status === 'live' ? 'dealer_busy' : 'dealer_not_live',
            );
          }
          if (q.stake < table.min_stake) throw new AppError(400, 'stake_below_table_min');
          const t = await createTicket(
            playerId,
            { ...q, mode: 'direct', currency: table.currency },
            ipCountry,
            ch,
          );
          const offered = await offer(t, q.dealerId, ch);
          if (!offered) {
            await setTicket(t.id, { status: 'cancelled', reason: 'dealer_busy' });
            throw new AppError(409, 'dealer_busy');
          }
          return ticketView(offered);
        }
        const t = await createTicket(playerId, { ...q, mode: 'random' }, ipCountry, ch);
        return ticketView(await tryMatch(t, ch));
      });
    },

    async accept(dealerId: string, id: string) {
      return run(async (ch) => {
        const t = await ticket(id);
        if (!t || t.dealer_id !== dealerId) throw new AppError(404, 'match_not_found');
        if (t.status !== 'offered') throw new AppError(409, 'match_not_offered');
        if (t.offer_deadline && t.offer_deadline <= clock())
          return ticketView(await rejectOffer(t, 'timeout', ch));
        return ticketView(await acceptTicket(t, ch));
      });
    },

    async decline(dealerId: string, id: string) {
      return run(async (ch) => {
        const t = await ticket(id);
        if (!t || t.dealer_id !== dealerId) throw new AppError(404, 'match_not_found');
        if (t.status !== 'offered') throw new AppError(409, 'match_not_offered');
        return ticketView(await rejectOffer(t, 'declined', ch));
      });
    },

    async cancel(playerId: string, id: string) {
      return run(async (ch) => {
        const t = await ticket(id);
        if (!t || t.player_id !== playerId) throw new AppError(404, 'match_not_found');
        if (t.status !== 'waiting' && t.status !== 'offered') return ticketView(t);
        ch.tickets.add(t.id);
        return ticketView(
          await setTicket(t.id, {
            status: 'cancelled',
            reason: 'player_cancelled',
            offer_deadline: null,
          }),
        );
      });
    },

    async get(userId: string, id: string) {
      const t = await ticket(id);
      if (!t || (t.player_id !== userId && t.dealer_id !== userId))
        throw new AppError(404, 'match_not_found');
      return ticketView(t);
    },

    /** Висящие заявки и смены пользователя (восстановление после перезагрузки). */
    async active(userId: string) {
      const tickets = await db
        .selectFrom('match_ticket')
        .selectAll()
        .where('status', 'in', ['waiting', 'offered'])
        .where((eb) => eb.or([eb('player_id', '=', userId), eb('dealer_id', '=', userId)]))
        .execute();
      const shifts = await db
        .selectFrom('shift')
        .selectAll()
        .where('status', '=', 'open')
        .where((eb) => eb.or([eb('player_id', '=', userId), eb('dealer_id', '=', userId)]))
        .execute();
      return {
        matches: tickets.map(ticketView),
        shifts: await Promise.all(shifts.map((s) => shiftView(s, userId))),
      };
    },

    /** Решение на смене. Игрок: next/stay/opposite/exit; крупье: stay/next. */
    async decide(userId: string, id: string, choice: ShiftChoice) {
      return run(async (ch) => {
        const sh = await db.transaction().execute(async (trx) => {
          const x = await lockShift(trx, id);
          const seat = x.player_id === userId ? 0 : x.dealer_id === userId ? 1 : null;
          if (seat === null) throw new AppError(404, 'shift_not_found');
          if (x.status !== 'open') throw new AppError(409, 'shift_closed');
          if (seat === 1 && choice !== 'stay' && choice !== 'next')
            throw new AppError(400, 'invalid_choice');
          if ((seat === 0 ? x.player_choice : x.dealer_choice) !== null)
            throw new AppError(409, 'already_decided');
          return trx
            .updateTable('shift')
            .set(
              seat === 0 ? { player_choice: choice } : { dealer_choice: choice as 'stay' | 'next' },
            )
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow();
        });
        if (choice === 'stay' && sh.player_id === userId && !(await canStay(sh))) {
          throw new AppError(409, 'stay_unavailable');
        }
        ch.shifts.add(sh.id);
        await resolveShift(sh.id, ch, false);
        const fresh = await db
          .selectFrom('shift')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        return shiftView(fresh, userId);
      });
    },

    /** Инлайн-пополнение на экране смены: таймер на паузу до inlineDepositPauseSec (один раз). */
    async pause(playerId: string, id: string) {
      return run(async (ch) => {
        const sh = await db.transaction().execute(async (trx) => {
          const x = await lockShift(trx, id);
          if (x.player_id !== playerId) throw new AppError(404, 'shift_not_found');
          if (x.status !== 'open') throw new AppError(409, 'shift_closed');
          if (x.paused) return x;
          return trx
            .updateTable('shift')
            .set({
              paused: true,
              deadline: new Date(x.deadline.getTime() + game.inlineDepositPauseSec * 1000),
            })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow();
        });
        ch.shifts.add(sh.id);
        return shiftView(sh, playerId);
      });
    },

    /** Лента без видео: карточки столов в эфире с фильтрами. */
    async feed(
      userId: string,
      q: {
        currency?: 'USDT' | 'FUN' | undefined;
        stake?: bigint | undefined;
        free?: boolean | undefined;
        scene?: string | undefined;
      },
    ) {
      const recent = await recentOpponents(userId);
      const free = new Set((await freeTables({})).map((d) => d.user_id));
      let query = db
        .selectFrom('dealer_profile')
        .selectAll()
        .where('status', '=', 'live')
        .where('user_id', '<>', userId)
        .orderBy('went_live_at');
      if (q.currency) query = query.where('currency', '=', q.currency);
      if (q.stake !== undefined) query = query.where('min_stake', '<=', q.stake);
      if (q.scene) query = query.where('scene', '=', q.scene as never);
      const rows = await query.execute();
      return {
        cards: rows
          .map((d) => ({
            id: d.user_id,
            name: d.display_name,
            scene: d.scene,
            currency: d.currency,
            minStake: toWire(d.min_stake),
            busy: !free.has(d.user_id),
            recent: recent.has(d.user_id),
          }))
          .filter((c) => (q.free ? !c.busy : true)),
      };
    },

    async setAutoAccept(dealerId: string, autoAccept: boolean) {
      await db
        .updateTable('dealer_profile')
        .set({ auto_accept: autoAccept })
        .where('user_id', '=', dealerId)
        .execute();
    },

    /**
     * Фон: истёкшие предложения → дальше по очереди; ждущие заявки — повторный подбор;
     * долго без столов — истекают; смены после дедлайна — итог.
     */
    async sweep() {
      const now = clock();
      await run(async (ch) => {
        const expiredOffers = await db
          .selectFrom('match_ticket')
          .selectAll()
          .where('status', '=', 'offered')
          .where('offer_deadline', '<=', now)
          .execute();
        for (const t of expiredOffers) await rejectOffer(t, 'timeout', ch);
        const waiting = await db
          .selectFrom('match_ticket')
          .selectAll()
          .where('status', '=', 'waiting')
          .execute();
        for (const t of waiting) {
          if (now.getTime() - t.created_at.getTime() >= WAITING_TTL_MS) {
            await setTicket(t.id, { status: 'expired', reason: 'no_tables' });
            ch.tickets.add(t.id);
          } else {
            await tryMatch(t, ch);
          }
        }
        const due = await db
          .selectFrom('shift')
          .select('id')
          .where('status', '=', 'open')
          .where('deadline', '<=', now)
          .execute();
        for (const { id } of due) await resolveShift(id, ch, true);
      });
    },

    async peekTicket(id: string) {
      return db
        .selectFrom('match_ticket')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    },
    async peekShift(id: string) {
      return db.selectFrom('shift').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    },
  };
  return svc;
}

export type Matchmaking = ReturnType<typeof createMatchmaking>;
