import type { HealthResponse } from '@winhappens/shared';
import { useEffect, useState } from 'react';
import { fetchHealth } from './api.js';

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <h1>WinHappens Live Duel</h1>
      {error && <p>core недоступен: {error}</p>}
      {health && (
        <>
          <p>
            core: <b>{health.status}</b>
          </p>
          <ul>
            {Object.entries(health.checks).map(([name, c]) => (
              <li key={name}>
                {name}: {c.status}
                {c.latencyMs !== undefined && ` (${c.latencyMs} мс)`}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
