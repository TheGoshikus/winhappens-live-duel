import './duel/tokens.css';
import { Shell } from './duel/Shell';
import { DuelProvider } from './duel/store';

export function App() {
  return (
    <DuelProvider>
      <Shell />
    </DuelProvider>
  );
}
