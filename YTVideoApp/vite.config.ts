import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  server: { port: 5174, proxy: { '/api': 'http://127.0.0.1:8788' } },
  build: { target: 'es2022', modulePreload: { polyfill: false }, cssCodeSplit: false },
});
