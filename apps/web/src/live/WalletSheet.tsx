import { depositSessionSchema, walletResponseSchema } from '@winhappens/shared';
import { useCallback, useEffect, useState } from 'react';
import o from '../duel/onboarding.module.css';
import { Kyc, Login, explain } from './Account';
import { api, ApiError } from './api';
import st from './studio.module.css';

interface Me {
  kind: 'guest' | 'registered';
  kyc: { status: 'pending' | 'verified' | 'rejected' } | null;
}
type Wallet = ReturnType<typeof walletResponseSchema.parse>;

const usdt = (minor: bigint) =>
  (Number(minor) / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const toMinor = (v: string, exp: number) => {
  const [i = '0', f = ''] = v.replace(',', '.').split('.');
  return (
    BigInt(i || '0') * 10n ** BigInt(exp) +
    BigInt((f + '0'.repeat(exp)).slice(0, exp) || '0')
  ).toString();
};
const AMOUNTS = ['10', '25', '50', '100'];

/** Кошелёк: балансы, пополнение USDT через шлюз (hosted checkout), вывод (после KYC). */
export function WalletSheet({
  onClose,
  onBalance,
}: {
  onClose: () => void;
  onBalance: (funCents: number) => void;
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [tab, setTab] = useState<'deposit' | 'withdraw'>('deposit');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [amount, setAmount] = useState('25');
  const [currency, setCurrency] = useState<'USDT' | 'EUR'>('USDT');
  const [rail, setRail] = useState<'card' | 'crypto'>('card');
  const [destination, setDestination] = useState('');
  const [needKyc, setNeedKyc] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [m, w] = await Promise.all([api<Me>('/me'), api<unknown>('/wallet')]);
      const parsed = walletResponseSchema.parse(w);
      setMe(m);
      setWallet(parsed);
      onBalance(Number(parsed.FUN.main + parsed.FUN.hold));
    } catch (e) {
      setError(explain(e));
    }
  }, [onBalance]);

  // Пока окно открыто, баланс обновляется — зачисление после оплаты видно сразу.
  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, 2_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const deposit = async () => {
    setError(null);
    try {
      const s = depositSessionSchema.parse(
        await api('/wallet/deposits', {
          body: { amount: toMinor(amount, currency === 'EUR' ? 2 : 6), currency, rail },
        }),
      );
      setInfo(`Ожидаем оплату · будет зачислено ${usdt(s.ledgerAmount)} USDT`);
      if (s.checkoutUrl) window.open(s.checkoutUrl, '_blank', 'noopener');
    } catch (e) {
      setError(explain(e));
    }
  };

  const withdraw = async () => {
    setError(null);
    try {
      const r = await api<{ status: string }>('/wallet/withdrawals', {
        body: { amount: toMinor(amount, 6), destination, rail: 'crypto' },
      });
      setInfo(
        r.status === 'review'
          ? 'Заявка на проверке'
          : 'Заявка отправлена — средства заморожены до подтверждения',
      );
      void refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'kyc_required') setNeedKyc(true);
      setError(explain(e));
    }
  };

  return (
    <div className={`${o.layer} ${o.sheetLayer}`} onClick={onClose}>
      <div
        className={o.sheet}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        aria-label="Кошелёк"
        style={{ maxHeight: '92%', overflowY: 'auto' }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Кошелёк</h2>
          <button
            type="button"
            className={o.iconBtn}
            onClick={onClose}
            aria-label="Закрыть кошелёк"
          >
            ✕
          </button>
        </div>
        {wallet && (
          <div className={st.card} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className={st.label}>USDT</span>
              <b data-usdt-balance style={{ fontFamily: 'var(--font-mono)' }}>
                {usdt(wallet.USDT.main)}
              </b>
            </div>
            {wallet.USDT.pendingWithdrawal > 0n && (
              <div className={st.muted} style={{ fontSize: 13 }}>
                На выводе: {usdt(wallet.USDT.pendingWithdrawal)} USDT
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className={st.label}>Фишки (FUN)</span>
              <b style={{ fontFamily: 'var(--font-mono)' }}>
                {(Number(wallet.FUN.main) / 100).toLocaleString('ru-RU')}
              </b>
            </div>
          </div>
        )}
        {error && (
          <div className={st.error} style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}
        {info && (
          <div className={st.card} style={{ marginBottom: 12 }} data-wallet-info>
            {info}
          </div>
        )}
        {me?.kind !== 'registered' ? (
          <>
            <Login
              onDone={refresh}
              onError={setError}
              hint="Фишками играют без регистрации. Чтобы пополнить счёт реальными деньгами, войдите — код придёт в SMS или на почту."
            />
          </>
        ) : (
          <div className={st.card}>
            <div className={st.row}>
              {(['deposit', 'withdraw'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`${st.opt} ${tab === t ? st.optOn : ''}`}
                  onClick={() => setTab(t)}
                >
                  {t === 'deposit' ? 'Пополнить' : 'Вывести'}
                </button>
              ))}
            </div>
            <span className={st.label}>
              Сумма{tab === 'deposit' ? ` · ${currency}` : ' · USDT'}
            </span>
            <div className={st.row}>
              {AMOUNTS.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={`${st.opt} ${amount === a ? st.optOn : ''}`}
                  onClick={() => setAmount(a)}
                >
                  {a}
                </button>
              ))}
            </div>
            <input
              className={st.input}
              aria-label="Сумма"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            {tab === 'deposit' ? (
              <>
                <div className={st.row}>
                  {(['USDT', 'EUR'] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`${st.opt} ${currency === c ? st.optOn : ''}`}
                      onClick={() => setCurrency(c)}
                    >
                      {c}
                    </button>
                  ))}
                  {(['card', 'crypto'] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      className={`${st.opt} ${rail === r ? st.optOn : ''}`}
                      onClick={() => setRail(r)}
                    >
                      {r === 'card' ? 'Карта' : 'Крипта'}
                    </button>
                  ))}
                </div>
                <button type="button" className={st.cta} disabled={!amount} onClick={deposit}>
                  Пополнить
                </button>
              </>
            ) : me.kyc?.status !== 'verified' && (needKyc || me.kyc?.status === 'pending') ? (
              <Kyc
                status={
                  me.kyc?.status === 'pending' || me.kyc?.status === 'rejected'
                    ? me.kyc.status
                    : null
                }
                onDone={() => {
                  setError(null);
                  void refresh();
                }}
                onError={setError}
              />
            ) : (
              <>
                <input
                  className={st.input}
                  aria-label="Адрес USDT (TRC-20)"
                  placeholder="Адрес USDT (TRC-20)"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                />
                <button
                  type="button"
                  className={st.cta}
                  disabled={!amount || destination.length < 4}
                  onClick={withdraw}
                >
                  Вывести
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
