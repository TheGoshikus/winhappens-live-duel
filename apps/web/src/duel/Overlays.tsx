import { ROUNDS_TO_RECIPROCITY } from './data';
import s from './duel.module.css';
import { caption, fmtSec, roundOf, timerOf } from './logic';
import { useDuel } from './store';
import { DealerVideo, TrackAudio, useLiveMedia } from '../live/media';
import { VideoFill } from './Video';

/** Полноэкранное видео крупье (ui-spec §6). */
export function FullscreenVideo() {
  const { state, dispatch, now } = useDuel();
  const { dealerId, media } = useLiveMedia();
  if (!state.full) return null;
  const d = state.dealers[state.dealer]!;
  const r = roundOf(state, state.dealer);
  const timer = timerOf(state, now);
  const close = () => dispatch({ type: 'full', open: false });
  const status =
    r.phase !== 'pick'
      ? `Твоя ставка ${r.stake} на ${r.pick}`
      : r.pick !== null
        ? `Выбрано ${r.pick} · не подтверждено`
        : 'Ставка не сделана';
  return (
    <div className={s.overlay} role="dialog" aria-label={`Видео: ${d.name}`}>
      <div style={{ position: 'absolute', inset: 0 }}>
        <DealerVideo dealer={d} label="видео крупье" />
      </div>
      {d.live && d.id === dealerId && <TrackAudio track={media.audio} />}
      <div className={s.fullTop}>
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: '50%',
            position: 'relative',
            overflow: 'hidden',
            boxShadow: '0 0 0 2px #fff',
            flex: 'none',
          }}
        >
          <VideoFill tint={d.tint} label={null} />
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          <b>{d.name}</b>
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-secondary)',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <span className={s.liveDot} /> {d.live ? 'LIVE' : 'ДЕМО'} · {d.scene}
          </span>
        </span>
        <span
          className={`${s.pill} ${s.timer}`}
          style={{ position: 'static', color: timer.open ? '#4F8BFF' : '#fff' }}
        >
          {fmtSec(timer.sec)}
        </span>
        <button type="button" className={s.close} onClick={close} aria-label="Закрыть видео">
          ✕
        </button>
      </div>
      <div className={s.fullBottom}>
        <div className={s.caption} style={{ position: 'static' }}>
          {caption(state)}
        </div>
        <div className={s.statusPill}>{status}</div>
        <div className={s.actions}>
          <button type="button" className={s.roundBtn} aria-label="Микрофон">
            🎙
          </button>
          <button type="button" className={s.cta} onClick={close}>
            К игровому полю
          </button>
          <button type="button" className={s.roundBtn} aria-label="Пожаловаться">
            ⚑
          </button>
        </div>
      </div>
    </div>
  );
}

/** Модалка «{Имя} отвечает взаимностью» после 3 раундов (ui-spec §5). */
export function OfferModal() {
  const { state, dispatch } = useDuel();
  if (state.offer === null) return null;
  const d = state.dealers[state.offer]!;
  return (
    <div
      className={`${s.overlay} ${s.dimmed}`}
      role="dialog"
      aria-modal
      aria-labelledby="offer-title"
    >
      <div className={s.offerAvatar}>
        <div className={s.video}>
          <DealerVideo dealer={d} label={null} />
        </div>
      </div>
      <span className={s.caps} style={{ textAlign: 'center' }}>
        {ROUNDS_TO_RECIPROCITY} раунда сыграно · кольцо заполнено
      </span>
      <h2 id="offer-title" className={s.sheetTitle} style={{ textAlign: 'center' }}>
        {d.name} отвечает взаимностью
      </h2>
      <p className={s.sheetText} style={{ textAlign: 'center' }}>
        И даёт тебе возможность снять с неё аксессуар. Выбери предмет — под ним ставка, на которую
        она сыграет.
      </p>
      <button
        type="button"
        className={s.pillCta}
        onClick={() => dispatch({ type: 'acceptOffer', now: Date.now() })}
      >
        Выбрать, что снять
      </button>
      <button
        type="button"
        className={s.textBtn}
        onClick={() => dispatch({ type: 'dismissOffer' })}
      >
        Позже
      </button>
    </div>
  );
}
