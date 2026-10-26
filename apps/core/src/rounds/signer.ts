import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

/** PKCS#8-обёртка для 32-байтного seed Ed25519 (RFC 8410). */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Подпись результата раунда Ed25519 (architecture §6.2): проверяется публичным ключом. */
export function createRoundSigner(seedBase64: string) {
  const seed = Buffer.from(seedBase64, 'base64');
  if (seed.length !== 32) throw new Error('Ed25519 seed must be 32 bytes');
  const priv = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const pub: KeyObject = createPublicKey(priv);
  const publicKey = pub.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  return {
    publicKey,
    sign: (message: string) => sign(null, Buffer.from(message), priv).toString('base64'),
    verify: (message: string, signature: string) =>
      verify(null, Buffer.from(message), pub, Buffer.from(signature, 'base64')),
  };
}

export type RoundSigner = ReturnType<typeof createRoundSigner>;

/** Каноническое сообщение для подписи: фиксированный порядок полей, суммы — строки. */
export function roundMessage(r: {
  id: string;
  dealerId: string;
  playerId: string;
  currency: string;
  stake: bigint;
  item: string | null;
  playerCommit: string | null;
  dealerCommit: string | null;
  playerNumber: number | null;
  dealerNumber: number | null;
  outcome: string;
  winnerSeat: number;
  prize: bigint;
  winFee: bigint;
}): string {
  return JSON.stringify([
    'winhappens.round.v1',
    r.id,
    r.dealerId,
    r.playerId,
    r.currency,
    r.stake.toString(),
    r.item,
    r.playerCommit,
    r.dealerCommit,
    r.playerNumber,
    r.dealerNumber,
    r.outcome,
    r.winnerSeat,
    r.prize.toString(),
    r.winFee.toString(),
  ]);
}
