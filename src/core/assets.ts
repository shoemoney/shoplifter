/**
 * Resolves a runtime asset path against the document's base URL.
 *
 * The arcade serves each game from a sub-path (`https://arcade.shoemoney.com/shoplifter/`)
 * while `vite preview` and local dev serve it from the root. Vite's `base: './'` handles every
 * URL it emits itself — the script tag, the CSS, the hashed bundles — but it cannot rewrite a
 * path that only exists as a string inside the source or inside a JSON manifest.
 *
 * Those are the ones that break: a site-absolute `/assets/atlas.png` resolves to
 * `arcade.shoemoney.com/assets/atlas.png`, which is the ARCADE's asset directory, not this
 * game's. The atlas 404s, the loader falls back to the magenta placeholder, and the game looks
 * broken in a way that never reproduces locally.
 */
export const resolveAssetUrl = (path: string): string => {
  // Absolute URLs and data URIs are already fully qualified; leave them alone.
  // `//host/path` is protocol-relative and already qualified. `///path` is not — it has no
  // host — so it has to fall through to the stripping below rather than be handed back as-is.
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || /^\/\/[^/]/.test(path)) return path;

  const base = typeof document === 'undefined' ? undefined : document.baseURI;
  // A leading slash is what makes a path site-absolute, so it has to go before the path can be
  // resolved relative to wherever this build happens to be mounted.
  const relative = path.replace(/^\/+/, '');

  if (!base) return relative;
  return new URL(relative, base).href;
};
