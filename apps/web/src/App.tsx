import { useEffect, useState } from 'react';
import './duel/tokens.css';
import { Shell } from './duel/Shell';
import { DuelProvider } from './duel/store';
import { DealerStudio } from './live/DealerStudio';

const route = () => (window.location.hash.startsWith('#/dealer') ? 'dealer' : 'game');

export function App() {
  const [page, setPage] = useState(route);
  useEffect(() => {
    const on = () => setPage(route());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  if (page === 'dealer') return <DealerStudio />;
  return (
    <DuelProvider>
      <Shell />
    </DuelProvider>
  );
}
