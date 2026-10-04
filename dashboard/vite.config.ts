import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const watcher = process.env.WATCHER_URL ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.DASHBOARD_PORT ?? 5173),
    // The dashboard talks to /api/*; in dev Vite proxies it to the watcher.
    proxy: { '/api': { target: watcher, changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
