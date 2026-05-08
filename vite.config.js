import { defineConfig } from 'vite';

// In dev, Vite runs on 5174 and Express API on 3001 — proxy /api requests
// from the frontend to the backend so the same fetch('/api/...') calls work
// both in dev and in production (where Express serves both).
export default defineConfig({
  server: {
    port: 5174,
    strictPort: true,
    open: false,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
