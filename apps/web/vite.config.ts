import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Use the shared package source directly (types + small helpers).
      '@widebed/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/hooks': 'http://localhost:4000',
      '/events': 'http://localhost:4000',
      '/oauth': 'http://localhost:4000',
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
  },
});
