import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAssetUrl } from './assets.js';

const withBase = (baseURI: string): void => {
  vi.stubGlobal('document', { baseURI });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveAssetUrl', () => {
  it('resolves a site-absolute path under a sub-path deployment', () => {
    withBase('https://arcade.shoemoney.com/shoplifter/');
    // The bug this exists to prevent: /assets/... would hit the ARCADE's asset directory.
    expect(resolveAssetUrl('/assets/atlas.png')).toBe(
      'https://arcade.shoemoney.com/shoplifter/assets/atlas.png',
    );
  });

  it('still resolves correctly at the site root', () => {
    withBase('https://example.com/');
    expect(resolveAssetUrl('/assets/atlas.png')).toBe('https://example.com/assets/atlas.png');
  });

  it('handles a base URL that includes a document name', () => {
    withBase('https://arcade.shoemoney.com/shoplifter/index.html');
    expect(resolveAssetUrl('/assets/atlas.png')).toBe(
      'https://arcade.shoemoney.com/shoplifter/assets/atlas.png',
    );
  });

  it('treats an already-relative path the same way', () => {
    withBase('https://arcade.shoemoney.com/shoplifter/');
    expect(resolveAssetUrl('assets/atlas.png')).toBe(
      'https://arcade.shoemoney.com/shoplifter/assets/atlas.png',
    );
  });

  it('strips repeated leading slashes rather than reading them as a host', () => {
    withBase('https://arcade.shoemoney.com/shoplifter/');
    expect(resolveAssetUrl('///assets/atlas.png')).toBe(
      'https://arcade.shoemoney.com/shoplifter/assets/atlas.png',
    );
  });

  it('leaves fully-qualified URLs untouched', () => {
    withBase('https://arcade.shoemoney.com/shoplifter/');
    expect(resolveAssetUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(resolveAssetUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });

  it('leaves protocol-relative URLs untouched', () => {
    withBase('https://arcade.shoemoney.com/shoplifter/');
    expect(resolveAssetUrl('//cdn.example.com/a.png')).toBe('//cdn.example.com/a.png');
  });

  it('degrades to a relative path when there is no document', () => {
    vi.stubGlobal('document', undefined);
    expect(resolveAssetUrl('/assets/atlas.png')).toBe('assets/atlas.png');
  });
});
