import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { target: 'es2022', modulePreload: { polyfill: false }, cssCodeSplit: false },
});
