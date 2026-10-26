import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const core = process.env.CORE_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: core, ws: true, rewrite: (p) => p.replace(/^\/api/, '') } },
  },
});
