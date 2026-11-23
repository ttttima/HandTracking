import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5173, host: 'localhost', strictPort: false },
  preview: { port: 4173, host: 'localhost' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  // tasks-vision ships a prebuilt ESM bundle that loads its own WASM; don't pre-bundle it.
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
