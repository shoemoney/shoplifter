import type { GpuContext } from './context.js';

export interface AtlasRegion {
  /** Pixel rect in the atlas. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AtlasManifest {
  image: string;
  width: number;
  height: number;
  regions: Record<string, AtlasRegion>;
}

export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** Half-texel inset stops bilinear/nearest sampling from bleeding a neighbouring sprite. */
export const regionToUv = (
  region: AtlasRegion,
  atlasWidth: number,
  atlasHeight: number,
  inset = 0.5,
): UvRect => ({
  u0: (region.x + inset) / atlasWidth,
  v0: (region.y + inset) / atlasHeight,
  u1: (region.x + region.width - inset) / atlasWidth,
  v1: (region.y + region.height - inset) / atlasHeight,
});

export interface LoadedAtlas {
  texture: GPUTexture;
  manifest: AtlasManifest;
  uv: (name: string) => UvRect;
  /** True when the real image failed to load and a generated placeholder is standing in. */
  placeholder: boolean;
}

const PLACEHOLDER_SIZE = 64;

/**
 * Builds a magenta/grey checker in memory. Asset load failure must degrade to something
 * obviously wrong on screen rather than a silent invisible sprite — an invisible placeholder
 * reads as "my draw call is broken" and costs hours.
 */
export const placeholderPixels = (size = PLACEHOLDER_SIZE): Uint8Array<ArrayBuffer> => {
  const data = new Uint8Array(new ArrayBuffer(size * size * 4));
  const cell = Math.max(1, size >> 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const checker = ((x / cell) | 0) + ((y / cell) | 0);
      const magenta = (checker & 1) === 0;
      const offset = (y * size + x) * 4;
      data[offset + 0] = magenta ? 255 : 40;
      data[offset + 1] = magenta ? 0 : 40;
      data[offset + 2] = magenta ? 255 : 48;
      data[offset + 3] = 255;
    }
  }
  return data;
};

const createTextureFromPixels = (
  context: GpuContext,
  pixels: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  label: string,
): GPUTexture => {
  const texture = context.device.createTexture({
    label,
    size: { width, height },
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  context.device.queue.writeTexture(
    { texture },
    pixels,
    { bytesPerRow: width * 4, rowsPerImage: height },
    { width, height },
  );
  return texture;
};

export const createPlaceholderTexture = (context: GpuContext): GPUTexture =>
  createTextureFromPixels(
    context,
    placeholderPixels(),
    PLACEHOLDER_SIZE,
    PLACEHOLDER_SIZE,
    'placeholder-atlas',
  );

/**
 * Decodes an image and uploads it. Failure is not fatal: the caller receives a placeholder
 * texture and a flag, so the mission still runs and the debug overlay can say what is missing.
 */
export const loadAtlas = async (
  context: GpuContext,
  manifest: AtlasManifest,
): Promise<LoadedAtlas> => {
  let texture: GPUTexture;
  let placeholder = false;

  try {
    const response = await fetch(manifest.image);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${manifest.image}`);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' });
    texture = context.device.createTexture({
      label: `atlas:${manifest.image}`,
      size: { width: bitmap.width, height: bitmap.height },
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    context.device.queue.copyExternalImageToTexture(
      { source: bitmap, flipY: false },
      { texture, premultipliedAlpha: true },
      { width: bitmap.width, height: bitmap.height },
    );
    bitmap.close();
  } catch {
    texture = createPlaceholderTexture(context);
    placeholder = true;
  }

  const cache = new Map<string, UvRect>();
  const uv = (name: string): UvRect => {
    const cached = cache.get(name);
    if (cached) return cached;
    const region = manifest.regions[name];
    if (!region) throw new Error(`Atlas region "${name}" is not in the manifest.`);
    const rect = placeholder
      ? { u0: 0, v0: 0, u1: 1, v1: 1 }
      : regionToUv(region, manifest.width, manifest.height);
    cache.set(name, rect);
    return rect;
  };

  return { texture, manifest, uv, placeholder };
};
