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
    /**
     * No source map in the shipped build. The arcade serves zero maps for its other games, and
     * a 1.1 MB map per deploy buys nothing a reader cannot get from the public MIT repo. (The
     * map itself was checked and leaks nothing — 72 relative source paths, no local paths and
     * no username — this is about matching the deploy target, not about secrecy.)
     */
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  server: { port: 5173 },
});
