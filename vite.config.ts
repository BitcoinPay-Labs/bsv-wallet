import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ['buffer', 'crypto', 'stream', 'util'],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  // Proxy teratestnet indexer (HTTP-only) through a same-origin path so the
  // dev server mirrors the production vercel.json rewrite and avoids
  // mixed-content blocking. Kept in sync with TERATESTNET_API_BASE in chains.ts.
  server: {
    proxy: {
      '/tera': {
        target: 'http://162.43.7.61:18101',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tera/, ''),
      },
    },
  },
})
