import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  target: 'node22',
  clean: true,
  // Внутренние пакеты экспортируют исходники .ts — вшиваем их в бандл.
  noExternal: [/^@winhappens\//],
});
