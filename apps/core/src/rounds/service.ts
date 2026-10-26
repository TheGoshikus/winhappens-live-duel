import type { GameConfig } from '@winhappens/config';
import {
  CURRENCIES,
  RECIPROCITY_AFTER_ROUNDS,
  RECIPROCITY_ITEMS,
  stakeFee,
  toWire,
  type ReciprocityItemId,
  type RoundViewWire,
  type SessionViewWire,
} from '@winhappens/shared';
import type { Selectable, Updateable } from 'kysely';
import { createHash } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import type { Db } from '../db/index.js';
import type { DuelRoundTable, DuelSessionTable } from '../db/schema.js';
import type { Eligibility, EligibilitySubject } from '../eligibility/index.js';
import { AppError, forbidden } from '../errors.js';
import { InsufficientFundsError } from '../wallet/ledger.js';
import type { WalletService } from '../wallet/service.js';
import { roundMessage, type RoundSigner } from './signer.js';

type Row = Selectable<DuelRoundTable>;
type SessionRow = Selectable<DuelSessionTable>;
type Seat = 0 | 1;

/** Что изменилось за операцию — после коммита транзакции рассылается по WS. */
export interface Changes {
  rounds: Set<string>;
  sessions: Set<string>;
  /** Изменился состав занятых столов (сессия началась/закончилась). */
  tables: boolean;
}
const newChanges = (): Changes => ({ rounds: new Set(), sessions: new Set(), tables: false });

export interface RoundDeps {
  db: Db;
  wallet: WalletService;
  eligibility: Pick<Eligibility, 'canPlay'>;
  /** Снимок допуска; ipCountry — страна запроса (для крупье — сохранённая). */
  subject: (userId: string, ipCountry: string | null) => Promise<EligibilitySubject>;
  signer: RoundSigner;
  game: Pick<
    GameConfig,
    | 'seatHoldSec'
    | 'revealTimeoutSec'
    | 'stakeFeeBps'
    | 'sessionDurationSec'
    | 'roundsBuffer'
    | 'reconnectGraceSec'
  >;
  /** Присутствие (WS): переподключение за reconnectGraceSec, иначе выход из сессии. */
  isOnline?: (userId: string) => Promise<boolean>;
  /** Рассылка изменений (WS). Вызывается после коммита транзакции. */
  emit?: (changes: Changes, svc: RoundService) => Promise<void>;
  clock?: () => Date;
}

/** commit = sha256("{number}:{salt}") — то же считает клиент. */
export const commitOf = (number: number, salt: string) =>
  createHash('sha256').update(`${number}:${salt}`).digest('hex');

const notFound = () => new AppError(404, 'round_not_found');
const sessionNotFound = () => new AppError(404, 'session_not_found');

/**
 * Дуэль игрок (место 0, ЧЁТ) ↔ крупье (место 1, НЕЧЁТ): сессия 300 с с депозитом D = S × buffer
 * у каждого и раунды commit–reveal внутри неё (architecture §4–6, roadmap этапы 4–5).
 */
export function createRoundService(deps: RoundDeps) {
  const { db, wallet, eligibility, subject, signer, game } = deps;
  const clock = deps.clock ?? (() => new Date());
  const seatOf = (r: { player_id: string; dealer_id: string }, userId: string): Seat | null =>
    r.player_id === userId ? 0 : r.dealer_id === userId ? 1 : null;
  const userOf = (r: { player_id: string; dealer_id: string }, seat: Seat) =>
    seat === 0 ? r.player_id : r.dealer_id;
  const holdField = (seat: Seat): 'player_hold_left' | 'dealer_hold_left' =>
    seat === 0 ? 'player_hold_left' : 'dealer_hold_left';
  const costOf = (stake: bigint) => stake + stakeFee(stake, game.stakeFeeBps);

  // ---------- блокировки и запись ----------

  async function lock(trx: Db, id: string): Promise<Row> {
    const r = await trx
      .selectFrom('duel_round')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!r) throw notFound();
    return r;
  }
  async function lockSession(trx: Db, id: string): Promise<SessionRow> {
    const s = await trx
      .selectFrom('duel_session')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!s) throw sessionNotFound();
    return s;
  }
  const update = (trx: Db, id: string, patch: Updateable<DuelRoundTable>) =>
    trx
      .updateTable('duel_round')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  const updateSession = (trx: Db, id: string, patch: Updateable<DuelSessionTable>) =>
    trx
      .updateTable('duel_session')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

  /** Транзакция + рассылка изменений после коммита. */
  async function run<T>(fn: (trx: Db, ch: Changes) => Promise<T>): Promise<T> {
    const ch = newChanges();
    const result = await db.transaction().execute((trx) => fn(trx, ch));
    if (deps.emit && (ch.rounds.size || ch.sessions.size || ch.tables))
      await deps.emit(ch, service).catch(() => {});
    return result;
  }

  // ---------- сессия ----------

  /** Закрыть сессию: вернуть остатки депозитов на main. Открытых раундов к этому моменту нет. */
  async function finalize(trx: Db, s: SessionRow, reason: string, ch: Changes) {
    for (const seat of [0, 1] as const) {
      await wallet.releaseAmount(
        {
          userId: userOf(s, seat),
          currency: s.currency,
          sessionId: s.id,
          amount: s[holdField(seat)],
        },
        trx,
      );
    }
    await updateSession(trx, s.id, {
      status: 'ended',
      end_reason: s.end_reason ?? reason,
      ended_at: clock(),
    });
    ch.sessions.add(s.id);
    ch.tables = true;
  }

  const openRound = (trx: Db, sessionId: string) =>
    trx
      .selectFrom('duel_round')
      .selectAll()
      .where('session_id', '=', sessionId)
      .where('status', 'in', ['commit', 'reveal'])
      .forUpdate()
      .executeTakeFirst();

  /** После раунда: время вышло, сессия закрывается или депозита не хватает на следующий — конец. */
  async function afterRound(trx: Db, sessionId: string | null, ch: Changes) {
    if (!sessionId) return;
    const s = await lockSession(trx, sessionId);
    if (s.status !== 'active') return;
    ch.sessions.add(s.id);
    const minCost = costOf(s.stake);
    const reason =
      s.end_reason ??
      (s.ends_at <= clock()
        ? 'time_over'
        : s.player_hold_left < minCost || s.dealer_hold_left < minCost
          ? 'deposit_exhausted'
          : null);
    if (reason) await finalize(trx, s, reason, ch);
  }

  /**
   * Завершение сессии. Выход участника (leaverSeat) при открытом раунде (§6.4, architecture §6.1):
   * до обоих коммитов — отмена с возвратом; после — не раскрывшийся ушедший проигрывает; если
   * ушедший уже раскрылся — раунд дожидается таймаута соперника. Без ушедшего (время) — раунд
   * доигрывается, сессия закрывается после него.
   */
  async function endSession(
    trx: Db,
    s: SessionRow,
    reason: string,
    leaverSeat: Seat | null,
    ch: Changes,
  ) {
    if (s.status !== 'active') return;
    ch.sessions.add(s.id);
    if (!s.end_reason) s = await updateSession(trx, s.id, { end_reason: reason });
    const r = await openRound(trx, s.id);
    if (r && leaverSeat !== null) {
      if (r.status === 'commit') await cancel(trx, r, ch);
      else if ((leaverSeat === 0 ? r.player_number : r.dealer_number) === null)
        await settle(trx, r, leaverSeat === 0 ? 1 : 0, 'forfeit', ch);
    }
    if (!(await openRound(trx, s.id)))
      await finalize(trx, await lockSession(trx, s.id), reason, ch);
  }

  // ---------- раунд ----------

  /** Отмена: ставки со сбором закоммитивших возвращаются в депозит сессии. */
  async function cancel(trx: Db, r: Row, ch: Changes): Promise<Row> {
    const s = r.session_id ? await lockSession(trx, r.session_id) : null;
    for (const seat of [0, 1] as const) {
      if (!(seat === 0 ? r.player_commit : r.dealer_commit)) continue;
      await wallet.refundStake(
        { userId: userOf(r, seat), currency: r.currency, amount: r.stake, roundId: r.id },
        trx,
      );
      if (s) {
        const f = holdField(seat);
        await updateSession(trx, s.id, {
          [f]: (await lockSession(trx, s.id))[f] + costOf(r.stake),
        });
      }
    }
    const next = await update(trx, r.id, { status: 'cancelled', settled_at: clock() });
    ch.rounds.add(r.id);
    await afterRound(trx, r.session_id, ch);
    return next;
  }

  /** Расчёт: банк 2S победителю минус комиссия с выигрыша (на main); результат подписывается. */
  async function settle(
    trx: Db,
    r: Row,
    winnerSeat: Seat,
    outcome: 'normal' | 'forfeit',
    ch: Changes,
  ): Promise<Row> {
    const settled = await wallet.settleRound(
      {
        currency: r.currency,
        roundId: r.id,
        pot: r.stake * 2n,
        winnerStake: r.stake,
        winnerUserId: userOf(r, winnerSeat),
        reciprocity: r.item !== null,
      },
      trx,
    );
    const signature = signer.sign(
      roundMessage({
        id: r.id,
        dealerId: r.dealer_id,
        playerId: r.player_id,
        currency: r.currency,
        stake: r.stake,
        item: r.item,
        playerCommit: r.player_commit,
        dealerCommit: r.dealer_commit,
        playerNumber: r.player_number,
        dealerNumber: r.dealer_number,
        outcome,
        winnerSeat,
        prize: settled.prize,
        winFee: settled.winFee,
      }),
    );
    const next = await update(trx, r.id, {
      status: 'settled',
      outcome,
      winner_seat: winnerSeat,
      prize: settled.prize,
      win_fee: settled.winFee,
      stake_fee: stakeFee(r.stake, game.stakeFeeBps),
      signature,
      settled_at: clock(),
    });
    ch.rounds.add(r.id);
    await afterRound(trx, r.session_id, ch);
    return next;
  }

  /**
   * Просроченные фазы: не закоммитили оба за seatHold — отмена с возвратом; не раскрылся один
   * за revealTimeout — проигрыш ему (как выход после коммита); не раскрылся никто — отмена.
   */
  async function advance(trx: Db, r: Row, ch: Changes): Promise<Row> {
    const now = clock();
    if (r.status === 'commit' && r.commit_deadline <= now) return cancel(trx, r, ch);
    if (r.status === 'reveal' && r.reveal_deadline && r.reveal_deadline <= now) {
      const p = r.player_number !== null;
      const d = r.dealer_number !== null;
      if (p !== d) return settle(trx, r, p ? 0 : 1, 'forfeit', ch);
      if (!p && !d) return cancel(trx, r, ch);
    }
    return r;
  }

  // ---------- представления ----------

  function view(r: Row, viewerId: string): RoundViewWire {
    const seat = seatOf(r, viewerId);
    if (seat === null) throw notFound();
    const final = r.status === 'settled';
    return {
      id: r.id,
      dealerId: r.dealer_id,
      playerId: r.player_id,
      seat,
      currency: r.currency,
      stake: toWire(r.stake),
      item: r.item as ReciprocityItemId | null,
      status: r.status,
      commitDeadline: r.commit_deadline.toISOString(),
      revealDeadline: r.reveal_deadline?.toISOString() ?? null,
      committed: { player: !!r.player_commit, dealer: !!r.dealer_commit },
      revealed: { player: r.player_number !== null, dealer: r.dealer_number !== null },
      // Числа соперника не раскрываются до расчёта.
      result: final
        ? {
            outcome: r.outcome!,
            playerNumber: r.player_number,
            dealerNumber: r.dealer_number,
            winnerSeat: r.winner_seat!,
            prize: toWire(r.prize!),
            winFee: toWire(r.win_fee!),
            stakeFee: toWire(r.stake_fee!),
            signature: r.signature!,
          }
        : null,
    };
  }

  function sessionView(s: SessionRow, viewerId: string): SessionViewWire {
    const seat = seatOf(s, viewerId);
    if (seat === null) throw sessionNotFound();
    const other: Seat = seat === 0 ? 1 : 0;
    const offline = other === 0 ? s.player_offline_at : s.dealer_offline_at;
    return {
      id: s.id,
      dealerId: s.dealer_id,
      playerId: s.player_id,
      seat,
      currency: s.currency,
      stake: toWire(s.stake),
      deposit: toWire(s.deposit),
      holdLeft: toWire(s[holdField(seat)]),
      opponentHoldLeft: toWire(s[holdField(other)]),
      status: s.status,
      endReason: s.end_reason,
      startedAt: s.started_at.toISOString(),
      endsAt: s.ends_at.toISOString(),
      opponentOfflineAt: offline?.toISOString() ?? null,
    };
  }

  const settledCount = async (dealerId: string, playerId: string) =>
    Number(
      (
        await db
          .selectFrom('duel_round')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('dealer_id', '=', dealerId)
          .where('player_id', '=', playerId)
          .where('status', '=', 'settled')
          .executeTakeFirstOrThrow()
      ).n,
    );

  /** Предметы, уже снятые этим игроком у этой крупье. */
  const removedItems = async (dealerId: string, playerId: string) =>
    (
      await db
        .selectFrom('duel_round')
        .select('item')
        .where('dealer_id', '=', dealerId)
        .where('player_id', '=', playerId)
        .where('status', '=', 'settled')
        .where('winner_seat', '=', 0)
        .where('item', 'is not', null)
        .execute()
    ).map((r) => r.item as ReciprocityItemId);

  const service = {
    commitOf,
    publicKey: signer.publicKey,
    view,
    sessionView,

    /**
     * Игрок садится за стол: сессия на sessionDurationSec, у обоих замораживается D = S × roundsBuffer.
     * Крупье одновременно играет с одним игроком — остальные видят её «занятой».
     */
    async startSession(
      playerId: string,
      q: { dealerId: string; stake: bigint },
      ipCountry: string | null,
    ) {
      if (playerId === q.dealerId) throw new AppError(409, 'cannot_play_self');
      const table = await db
        .selectFrom('dealer_profile')
        .innerJoin('users', 'users.id', 'dealer_profile.user_id')
        .select([
          'dealer_profile.status',
          'dealer_profile.currency',
          'dealer_profile.min_stake',
          'users.ip_country',
        ])
        .where('dealer_profile.user_id', '=', q.dealerId)
        .executeTakeFirst();
      if (!table || table.status !== 'live') throw new AppError(404, 'dealer_not_live');
      if (q.stake < table.min_stake) throw new AppError(400, 'stake_below_table_min');
      for (const [userId, ip] of [
        [playerId, ipCountry],
        [q.dealerId, table.ip_country?.trim() ?? null],
      ] as const) {
        const d = eligibility.canPlay(await subject(userId, ip), {
          currency: table.currency,
          stake: q.stake,
        });
        if (!d.ok) throw forbidden(userId === playerId ? d.reason : `dealer_${d.reason}`);
      }
      // Стартовые фантики выдаются один раз — на случай, если кошелёк ещё не открывали.
      if (table.currency === 'FUN')
        for (const u of [playerId, q.dealerId]) await wallet.grantFunStarting(u);

      const deposit = q.stake * BigInt(game.roundsBuffer);
      const now = clock();
      const id = uuidv7();
      return run(async (trx, ch) => {
        try {
          await trx
            .insertInto('duel_session')
            .values({
              id,
              dealer_id: q.dealerId,
              player_id: playerId,
              currency: table.currency,
              stake: q.stake,
              deposit,
              player_hold_left: deposit,
              dealer_hold_left: deposit,
              status: 'active',
              end_reason: null,
              started_at: now,
              ends_at: new Date(now.getTime() + game.sessionDurationSec * 1000),
              ended_at: null,
              player_offline_at: null,
              dealer_offline_at: null,
            })
            .execute();
        } catch (e) {
          if ((e as { code?: string }).code === '23505') throw new AppError(409, 'dealer_busy');
          throw e;
        }
        for (const [userId, who] of [
          [playerId, 'insufficient_funds'],
          [q.dealerId, 'dealer_insufficient_funds'],
        ] as const) {
          try {
            await wallet.hold(
              { userId, currency: table.currency, amount: deposit, sessionId: id },
              trx,
            );
          } catch (e) {
            if (e instanceof InsufficientFundsError) throw new AppError(409, who);
            throw e;
          }
        }
        ch.sessions.add(id);
        ch.tables = true;
        return sessionView(await lockSession(trx, id), playerId);
      });
    },

    /** Выйти из сессии (игрок или крупье). */
    async leaveSession(userId: string, sessionId: string) {
      return run(async (trx, ch) => {
        const s = await lockSession(trx, sessionId);
        const seat = seatOf(s, userId);
        if (seat === null) throw sessionNotFound();
        await endSession(trx, s, seat === 0 ? 'player_left' : 'dealer_left', seat, ch);
        return sessionView(await lockSession(trx, sessionId), userId);
      });
    },

    /** Крупье ушла из эфира — её сессия завершается как выход. */
    async endDealerSessions(dealerId: string) {
      const active = await db
        .selectFrom('duel_session')
        .select('id')
        .where('dealer_id', '=', dealerId)
        .where('status', '=', 'active')
        .execute();
      for (const { id } of active) await service.leaveSession(dealerId, id);
    },

    async getSession(userId: string, id: string) {
      const s = await db
        .selectFrom('duel_session')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!s) throw sessionNotFound();
      return sessionView(s, userId);
    },

    async activeSessions(userId: string) {
      const rows = await db
        .selectFrom('duel_session')
        .selectAll()
        .where('status', '=', 'active')
        .where((eb) => eb.or([eb('player_id', '=', userId), eb('dealer_id', '=', userId)]))
        .orderBy('started_at')
        .execute();
      return rows.map((s) => sessionView(s, userId));
    },

    /** Игрок открывает раунд в своей активной сессии с крупье. */
    async create(
      playerId: string,
      q: { dealerId: string; stake: bigint; item?: ReciprocityItemId | undefined },
    ) {
      const s = await db
        .selectFrom('duel_session')
        .selectAll()
        .where('dealer_id', '=', q.dealerId)
        .where('player_id', '=', playerId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!s || s.end_reason || s.ends_at <= clock()) throw new AppError(409, 'no_active_session');

      if (q.item) {
        if ((await settledCount(q.dealerId, playerId)) < RECIPROCITY_AFTER_ROUNDS)
          throw forbidden('reciprocity_locked');
        if ((await removedItems(q.dealerId, playerId)).includes(q.item))
          throw new AppError(409, 'item_removed');
        const price =
          BigInt(RECIPROCITY_ITEMS.find((i) => i.id === q.item)!.price) *
          10n ** BigInt(CURRENCIES[s.currency].exponent);
        if (q.stake !== price) throw new AppError(400, 'stake_must_match_item');
      } else if (q.stake !== s.stake) {
        throw new AppError(400, 'stake_must_match_session');
      }
      const cost = costOf(q.stake);
      if (s.player_hold_left < cost || s.dealer_hold_left < cost)
        throw new AppError(409, 'session_deposit_exhausted');

      const now = clock();
      return run(async (trx, ch) => {
        try {
          const r = await trx
            .insertInto('duel_round')
            .values({
              id: uuidv7(),
              session_id: s.id,
              dealer_id: q.dealerId,
              player_id: playerId,
              currency: s.currency,
              stake: q.stake,
              item: q.item ?? null,
              status: 'commit',
              player_commit: null,
              dealer_commit: null,
              player_number: null,
              player_salt: null,
              dealer_number: null,
              dealer_salt: null,
              commit_deadline: new Date(now.getTime() + game.seatHoldSec * 1000),
              reveal_deadline: null,
              outcome: null,
              winner_seat: null,
              prize: null,
              win_fee: null,
              stake_fee: null,
              signature: null,
              settled_at: null,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          ch.rounds.add(r.id);
          return view(r, playerId);
        } catch (e) {
          if ((e as { code?: string }).code === '23505')
            throw new AppError(409, 'round_in_progress');
          throw e;
        }
      });
    },

    /** Коммит хэша числа; ставка со сбором уходит из депозита сессии в банк в той же транзакции. */
    async commit(userId: string, id: string, commit: string) {
      return run(async (trx, ch) => {
        const r = await advance(trx, await lock(trx, id), ch);
        const seat = seatOf(r, userId);
        if (seat === null) throw notFound();
        if (r.status !== 'commit') throw new AppError(409, 'not_in_commit_phase');
        if (seat === 0 ? r.player_commit : r.dealer_commit)
          throw new AppError(409, 'already_committed');
        const s = await lockSession(trx, r.session_id!);
        const cost = costOf(r.stake);
        const f = holdField(seat);
        if (s[f] < cost) throw new AppError(409, 'session_deposit_exhausted');
        await wallet.commitStake(
          { userId, currency: r.currency, amount: r.stake, roundId: r.id },
          trx,
        );
        await updateSession(trx, s.id, { [f]: s[f] - cost });
        const both = seat === 0 ? !!r.dealer_commit : !!r.player_commit;
        const next = await update(trx, r.id, {
          ...(seat === 0 ? { player_commit: commit } : { dealer_commit: commit }),
          ...(both
            ? {
                status: 'reveal',
                reveal_deadline: new Date(clock().getTime() + game.revealTimeoutSec * 1000),
              }
            : {}),
        });
        ch.rounds.add(r.id);
        ch.sessions.add(s.id);
        return view(next, userId);
      });
    },

    /** Раскрытие: число и соль должны совпасть с коммитом; второй раскрывшийся запускает расчёт. */
    async reveal(userId: string, id: string, number: number, salt: string) {
      return run(async (trx, ch) => {
        const r = await advance(trx, await lock(trx, id), ch);
        const seat = seatOf(r, userId);
        if (seat === null) throw notFound();
        if (r.status !== 'reveal') throw new AppError(409, 'not_in_reveal_phase');
        if ((seat === 0 ? r.player_number : r.dealer_number) !== null)
          throw new AppError(409, 'already_revealed');
        if (commitOf(number, salt) !== (seat === 0 ? r.player_commit : r.dealer_commit))
          throw new AppError(400, 'reveal_mismatch');
        let next = await update(
          trx,
          r.id,
          seat === 0
            ? { player_number: number, player_salt: salt }
            : { dealer_number: number, dealer_salt: salt },
        );
        ch.rounds.add(r.id);
        if (next.player_number !== null && next.dealer_number !== null) {
          next = await settle(
            trx,
            next,
            (next.player_number + next.dealer_number) % 2 === 0 ? 0 : 1,
            'normal',
            ch,
          );
        }
        return view(next, userId);
      });
    },

    async get(userId: string, id: string) {
      return run(async (trx, ch) => view(await advance(trx, await lock(trx, id), ch), userId));
    },

    /** Последняя запись раунда без продвижения таймаутов — для рассылки. */
    async peek(id: string) {
      return db.selectFrom('duel_round').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    },
    async peekSession(id: string) {
      return db
        .selectFrom('duel_session')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    },

    /** Раунды крупье: открытые и последние завершённые. */
    async forDealer(dealerId: string) {
      const rows = await db
        .selectFrom('duel_round')
        .select('id')
        .where('dealer_id', '=', dealerId)
        .orderBy('created_at', 'desc')
        .limit(10)
        .execute();
      return Promise.all(rows.map((r) => service.get(dealerId, r.id)));
    },

    /** Прогресс игрока с крупье: сыгранные раунды (кольцо) и снятые предметы. */
    async progress(playerId: string, dealerId: string) {
      return {
        rounds: await settledCount(dealerId, playerId),
        removed: await removedItems(dealerId, playerId),
      };
    },

    /** Крупье, у которых идёт сессия (для «занята» в ленте). */
    async busyDealers(): Promise<Set<string>> {
      const rows = await db
        .selectFrom('duel_session')
        .select('dealer_id')
        .where('status', '=', 'active')
        .execute();
      return new Set(rows.map((r) => r.dealer_id));
    },

    /**
     * Фоновый обработчик (раз в секунду): таймауты раундов, конец сессий по времени и
     * переподключение — офлайн дольше reconnectGraceSec считается выходом.
     */
    async sweep() {
      const now = clock();
      const due = await db
        .selectFrom('duel_round')
        .select('id')
        .where((eb) =>
          eb.or([
            eb.and([eb('status', '=', 'commit'), eb('commit_deadline', '<=', now)]),
            eb.and([eb('status', '=', 'reveal'), eb('reveal_deadline', '<=', now)]),
          ]),
        )
        .limit(100)
        .execute();
      for (const { id } of due) await run(async (trx, ch) => advance(trx, await lock(trx, id), ch));

      const sessions = await db
        .selectFrom('duel_session')
        .selectAll()
        .where('status', '=', 'active')
        .limit(500)
        .execute();
      for (const s0 of sessions) {
        await run(async (trx, ch) => {
          let s = await lockSession(trx, s0.id);
          if (s.status !== 'active') return;
          if (deps.isOnline) {
            for (const seat of [0, 1] as const) {
              const field = seat === 0 ? 'player_offline_at' : 'dealer_offline_at';
              const online = await deps.isOnline(userOf(s, seat));
              if (online && s[field]) {
                s = await updateSession(trx, s.id, { [field]: null });
                ch.sessions.add(s.id);
              } else if (!online && !s[field]) {
                s = await updateSession(trx, s.id, { [field]: now });
                ch.sessions.add(s.id);
              } else if (
                !online &&
                s[field] &&
                now.getTime() - s[field].getTime() >= game.reconnectGraceSec * 1000
              ) {
                return endSession(
                  trx,
                  s,
                  seat === 0 ? 'player_disconnected' : 'dealer_disconnected',
                  seat,
                  ch,
                );
              }
            }
          }
          if ((s.end_reason || s.ends_at <= now) && !(await openRound(trx, s.id))) {
            await finalize(trx, s, s.end_reason ?? 'time_over', ch);
          }
        });
      }
      return due.length;
    },
  };
  return service;
}

export type RoundService = ReturnType<typeof createRoundService>;
