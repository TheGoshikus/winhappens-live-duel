import type { GameConfig } from '@winhappens/config';
import {
  CURRENCIES,
  RECIPROCITY_AFTER_ROUNDS,
  RECIPROCITY_ITEMS,
  stakeFee,
  toWire,
  type ReciprocityItemId,
  type RoundViewWire,
} from '@winhappens/shared';
import type { Selectable, Updateable } from 'kysely';
import { createHash } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import type { Db } from '../db/index.js';
import type { DuelRoundTable } from '../db/schema.js';
import type { Eligibility, EligibilitySubject } from '../eligibility/index.js';
import { AppError, forbidden } from '../errors.js';
import type { WalletService } from '../wallet/service.js';
import { roundMessage, type RoundSigner } from './signer.js';

type Row = Selectable<DuelRoundTable>;
type Seat = 0 | 1;

export interface RoundDeps {
  db: Db;
  wallet: WalletService;
  eligibility: Pick<Eligibility, 'canPlay'>;
  /** Снимок допуска; ipCountry — страна запроса (для крупье — сохранённая). */
  subject: (userId: string, ipCountry: string | null) => Promise<EligibilitySubject>;
  signer: RoundSigner;
  game: Pick<GameConfig, 'seatHoldSec' | 'revealTimeoutSec' | 'stakeFeeBps'>;
  clock?: () => Date;
}

/** commit = sha256("{number}:{salt}") — то же считает клиент. */
export const commitOf = (number: number, salt: string) =>
  createHash('sha256').update(`${number}:${salt}`).digest('hex');

const notFound = () => new AppError(404, 'round_not_found');

export function createRoundService({
  db,
  wallet,
  eligibility,
  subject,
  signer,
  game,
  clock = () => new Date(),
}: RoundDeps) {
  const seatOf = (r: Row, userId: string): Seat | null =>
    r.player_id === userId ? 0 : r.dealer_id === userId ? 1 : null;
  const userOf = (r: Row, seat: Seat) => (seat === 0 ? r.player_id : r.dealer_id);

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

  async function update(trx: Db, id: string, patch: Updateable<DuelRoundTable>): Promise<Row> {
    return trx
      .updateTable('duel_round')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Возврат ставок закоммитивших и отмена раунда (ставки со сбором — обратно на main). */
  async function cancel(trx: Db, r: Row): Promise<Row> {
    for (const seat of [0, 1] as const) {
      if (!(seat === 0 ? r.player_commit : r.dealer_commit)) continue;
      const userId = userOf(r, seat);
      await wallet.refundStake(
        { userId, currency: r.currency, amount: r.stake, roundId: r.id },
        trx,
      );
      await wallet.release({ userId, currency: r.currency, sessionId: r.id }, trx);
    }
    return update(trx, r.id, { status: 'cancelled', settled_at: clock() });
  }

  /** Расчёт: банк 2S победителю минус комиссия с выигрыша; результат подписывается. */
  async function settle(
    trx: Db,
    r: Row,
    winnerSeat: Seat,
    outcome: 'normal' | 'forfeit',
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
    return update(trx, r.id, {
      status: 'settled',
      outcome,
      winner_seat: winnerSeat,
      prize: settled.prize,
      win_fee: settled.winFee,
      stake_fee: stakeFee(r.stake, game.stakeFeeBps),
      signature,
      settled_at: clock(),
    });
  }

  /**
   * Просроченные фазы: не закоммитили оба за seatHold — отмена с возвратом; не раскрылся один
   * за revealTimeout — проигрыш ему (как выход после коммита); не раскрылся никто — отмена.
   */
  async function advance(trx: Db, r: Row): Promise<Row> {
    const now = clock();
    if (r.status === 'commit' && r.commit_deadline <= now) return cancel(trx, r);
    if (r.status === 'reveal' && r.reveal_deadline && r.reveal_deadline <= now) {
      const p = r.player_number !== null;
      const d = r.dealer_number !== null;
      if (p !== d) return settle(trx, r, p ? 0 : 1, 'forfeit');
      if (!p && !d) return cancel(trx, r);
    }
    return r;
  }

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

  return {
    commitOf,
    publicKey: signer.publicKey,

    /** Игрок открывает раунд у крупье в эфире. */
    async create(
      playerId: string,
      q: { dealerId: string; stake: bigint; item?: ReciprocityItemId | undefined },
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

      if (q.item) {
        if ((await settledCount(q.dealerId, playerId)) < RECIPROCITY_AFTER_ROUNDS)
          throw forbidden('reciprocity_locked');
        if ((await removedItems(q.dealerId, playerId)).includes(q.item))
          throw new AppError(409, 'item_removed');
        const price =
          BigInt(RECIPROCITY_ITEMS.find((i) => i.id === q.item)!.price) *
          10n ** BigInt(CURRENCIES[table.currency].exponent);
        if (q.stake !== price) throw new AppError(400, 'stake_must_match_item');
      }

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

      const now = clock();
      try {
        const r = await db
          .insertInto('duel_round')
          .values({
            id: uuidv7(),
            dealer_id: q.dealerId,
            player_id: playerId,
            currency: table.currency,
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
        return view(r, playerId);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new AppError(409, 'round_in_progress');
        throw e;
      }
    },

    /** Коммит хэша числа; ставка со сбором списывается в банк в той же транзакции. */
    async commit(userId: string, id: string, commit: string) {
      return db.transaction().execute(async (trx) => {
        const r = await advance(trx, await lock(trx, id));
        const seat = seatOf(r, userId);
        if (seat === null) throw notFound();
        if (r.status !== 'commit') throw new AppError(409, 'not_in_commit_phase');
        if (seat === 0 ? r.player_commit : r.dealer_commit)
          throw new AppError(409, 'already_committed');
        const amount = r.stake + stakeFee(r.stake, game.stakeFeeBps);
        await wallet.hold({ userId, currency: r.currency, amount, sessionId: r.id }, trx);
        await wallet.commitStake(
          { userId, currency: r.currency, amount: r.stake, roundId: r.id },
          trx,
        );
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
        return view(next, userId);
      });
    },

    /** Раскрытие: число и соль должны совпасть с коммитом; второй раскрывшийся запускает расчёт. */
    async reveal(userId: string, id: string, number: number, salt: string) {
      return db.transaction().execute(async (trx) => {
        const r = await advance(trx, await lock(trx, id));
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
        if (next.player_number !== null && next.dealer_number !== null) {
          next = await settle(
            trx,
            next,
            (next.player_number + next.dealer_number) % 2 === 0 ? 0 : 1,
            'normal',
          );
        }
        return view(next, userId);
      });
    },

    async get(userId: string, id: string) {
      return db
        .transaction()
        .execute(async (trx) => view(await advance(trx, await lock(trx, id)), userId));
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
      return Promise.all(rows.map((r) => this.get(dealerId, r.id)));
    },

    /** Прогресс игрока с крупье: сыгранные раунды (кольцо) и снятые предметы. */
    async progress(playerId: string, dealerId: string) {
      return {
        rounds: await settledCount(dealerId, playerId),
        removed: await removedItems(dealerId, playerId),
      };
    },

    /** Фоновая обработка просроченных раундов (никто не опрашивает — таймауты всё равно срабатывают). */
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
      for (const { id } of due)
        await db.transaction().execute(async (trx) => advance(trx, await lock(trx, id)));
      return due.length;
    },
  };
}

export type RoundService = ReturnType<typeof createRoundService>;
