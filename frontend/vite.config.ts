import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const API_PROXY = { '/api': { target: 'http://localhost:8000', changeOrigin: true, ws: true } };

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: API_PROXY },
  preview: { port: 4173, proxy: API_PROXY },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
