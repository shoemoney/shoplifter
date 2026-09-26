import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAtlas } from './textures.js';
import type { GpuContext } from './context.js';
import type { AtlasManifest } from './textures.js';

/**
 * Guards the OTHER half of the premultiplied-alpha contract.
 *
 * The atlas is committed with straight alpha (asserted by `tools/make_atlas.py --check`) only
 * because the loader premultiplies on upload. The two halves have to agree, and the shipped bug
 * was exactly a disagreement: both sides premultiplied, so every soft edge darkened twice.
 *
 * Pinning the loader here means a future "fix" that removes premultiplication from this side
 * fails a test instead of silently washing out every feathered sprite.
 */
const manifest: AtlasManifest = {
  image: '/assets/atlas.png',
  width: 16,
  height: 16,
  regions: { white: { x: 0, y: 0, width: 8, height: 8 } },
};

interface Recorded {
  bitmapOptions: ImageBitmapOptions | undefined;
  copyDestination: { premultipliedAlpha?: boolean } | undefined;
  writeTextureCalls: number;
}

const fakeContext = (options: {
  fetchOk: boolean;
}): { context: GpuContext; recorded: Recorded } => {
  const recorded: Recorded = {
    bitmapOptions: undefined,
    copyDestination: undefined,
    writeTextureCalls: 0,
  };

  // WebGPU's usage-flag enum is a browser global; node has no idea what it is.
  vi.stubGlobal('GPUTextureUsage', {
    COPY_SRC: 1,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    STORAGE_BINDING: 8,
    RENDER_ATTACHMENT: 16,
  });
  vi.stubGlobal('fetch', () =>
    Promise.resolve({
      ok: options.fetchOk,
      status: options.fetchOk ? 200 : 404,
      blob: () => Promise.resolve(new Blob()),
    }),
  );
  vi.stubGlobal('createImageBitmap', (_blob: Blob, bitmapOptions?: ImageBitmapOptions) => {
    recorded.bitmapOptions = bitmapOptions;
    return Promise.resolve({ width: 16, height: 16, close: () => undefined });
  });

  const device = {
    createTexture: () => ({ createView: () => ({}) }),
    queue: {
      copyExternalImageToTexture: (
        _source: unknown,
        destination: { premultipliedAlpha?: boolean },
      ) => {
        recorded.copyDestination = destination;
      },
      writeTexture: () => {
        recorded.writeTextureCalls++;
      },
    },
  };

  // A minimal stand-in: `loadAtlas` only ever reaches `context.device`.
  return { context: { device } as unknown as GpuContext, recorded };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('atlas upload premultiplies exactly once', () => {
  it('asks the browser to premultiply when decoding', async () => {
    const { context, recorded } = fakeContext({ fetchOk: true });
    await loadAtlas(context, manifest);
    expect(recorded.bitmapOptions?.premultiplyAlpha).toBe('premultiply');
  });

  it('tells WebGPU the uploaded source is already premultiplied', async () => {
    const { context, recorded } = fakeContext({ fetchOk: true });
    await loadAtlas(context, manifest);
    expect(recorded.copyDestination?.premultipliedAlpha).toBe(true);
  });

  it('keeps both halves of the contract in agreement', async () => {
    const { context, recorded } = fakeContext({ fetchOk: true });
    await loadAtlas(context, manifest);
    // Decoding premultiplied and then declaring the source NOT premultiplied (or the reverse)
    // is the same class of bug as premultiplying twice — it just fails in the other direction.
    const decoded = recorded.bitmapOptions?.premultiplyAlpha === 'premultiply';
    expect(recorded.copyDestination?.premultipliedAlpha).toBe(decoded);
  });

  it('falls back to the placeholder when the atlas cannot be fetched', async () => {
    const { context, recorded } = fakeContext({ fetchOk: false });
    const atlas = await loadAtlas(context, manifest);
    expect(atlas.placeholder).toBe(true);
    expect(recorded.writeTextureCalls).toBe(1);
  });

  it('reports a successfully loaded atlas as not a placeholder', async () => {
    const { context } = fakeContext({ fetchOk: true });
    const atlas = await loadAtlas(context, manifest);
    expect(atlas.placeholder).toBe(false);
  });
});
