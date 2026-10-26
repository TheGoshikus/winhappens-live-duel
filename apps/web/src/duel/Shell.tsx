import { useCallback, useEffect, useRef, useState } from 'react';
import { DesktopGame } from './DesktopGame';
import { TourKeyContext } from './lift';
import { MobileGame } from './MobileGame';
import {
  Checklist,
  HelpMenu,
  LabelsOverlay,
  RulesOverlay,
  Tour,
  type HelpChoice,
} from './Onboarding';
import { LiveMediaContext } from '../live/media';
import { useDealerMedia } from '../live/room';
import { useLiveDealers } from '../live/useLiveDealers';
import { useDuel } from './store';

type Overlay = 'rules' | 'tour' | 'labels' | 'checklist' | 'menu' | null;

const STORAGE = { onboarded: 'wh.onboarded', tourDone: 'wh.tourDone' };
const read = (k: string) => {
  try {
    return localStorage.getItem(k) === '1';
  } catch {
    return false;
  }
};
const write = (k: string) => {
  try {
    localStorage.setItem(k, '1');
  } catch {
    // приватный режим — онбординг просто покажется снова
  }
};

const DESKTOP_QUERY = '(min-width: 1024px)';

function useDesktop() {
  const [desktop, setDesktop] = useState(() => window.matchMedia(DESKTOP_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const on = () => setDesktop(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return desktop;
}

/** Игровой экран + онбординг: правила при первом запуске, видео-обучение, подписи, чек-лист. */
export function Shell() {
  const { state } = useDuel();
  const desktop = useDesktop();
  const frame = useRef<HTMLDivElement>(null);
  const [overlay, setOverlay] = useState<Overlay>(() => (read(STORAGE.onboarded) ? null : 'rules'));
  const [tourKey, setTourKey] = useState<string | null>(null);
  const [tourDone, setTourDone] = useState(() => read(STORAGE.tourDone));
  useLiveDealers();
  const table = state.dealers[state.dealer]!;
  const liveId = table.live && !table.busy ? table.id : null;
  const media = useDealerMedia(liveId);

  const closeRules = () => {
    write(STORAGE.onboarded);
    setOverlay(null);
  };
  const onTourClose = useCallback((completed: boolean) => {
    write(STORAGE.onboarded);
    if (completed) {
      write(STORAGE.tourDone);
      setTourDone(true);
    }
    setOverlay(null);
  }, []);
  const pick = (c: HelpChoice) => setOverlay(c);

  const layer = (
    <>
      {overlay === 'rules' && (
        <RulesOverlay
          onWatch={() => {
            write(STORAGE.onboarded);
            setOverlay('tour');
          }}
          onSkip={closeRules}
        />
      )}
      {overlay === 'tour' && (
        <Tour
          frame={frame}
          layout={desktop ? 'desktop' : 'mobile'}
          onStep={setTourKey}
          onClose={onTourClose}
        />
      )}
      {overlay === 'labels' && <LabelsOverlay frame={frame} onClose={() => setOverlay(null)} />}
      {overlay === 'menu' && <HelpMenu onPick={pick} onClose={() => setOverlay(null)} />}
      {overlay === 'checklist' && (
        <Checklist
          st={{ tourDone, deposited: state.balance > 0, played: state.history.length > 0 }}
          onTour={() => setOverlay('tour')}
          onClose={() => setOverlay(null)}
        />
      )}
    </>
  );

  // Подписи ЧЁТ/НЕЧЁТ на поле — только во время онбординга.
  const onboarding = overlay === 'rules' || overlay === 'tour' || overlay === 'labels';
  const props = { onHelp: () => setOverlay('menu'), showParity: onboarding, frameRef: frame };
  return (
    <LiveMediaContext.Provider value={{ dealerId: liveId, media }}>
      <TourKeyContext.Provider value={overlay === 'tour' ? tourKey : null}>
        {desktop ? (
          <DesktopGame {...props}>{layer}</DesktopGame>
        ) : (
          <MobileGame {...props}>{layer}</MobileGame>
        )}
      </TourKeyContext.Provider>
    </LiveMediaContext.Provider>
  );
}
