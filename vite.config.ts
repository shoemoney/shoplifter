import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  /**
   * Document-relative output. The arcade serves this game from
   * https://arcade.shoemoney.com/shoplifter/ while `vite preview` serves it from the root, and
   * `./` is the only setting that is correct at both. Hard-coding the arcade path would break
   * every local run; leaving it at `/` breaks the arcade.
   */
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    assetsInlineLimit: 0,
  },
  server: { port: 5173 },
});
