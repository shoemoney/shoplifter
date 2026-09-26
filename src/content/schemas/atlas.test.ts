import { describe, expect, it } from 'vitest';
import coreAtlas from '../atlases/core.json' with { type: 'json' };
import { atlasManifestSchema } from './atlas.js';
import { loadCoreAtlasManifest } from '../loaders/atlasLoader.js';

describe('atlas manifest', () => {
  it('validates the shipped manifest', () => {
    expect(atlasManifestSchema.safeParse(coreAtlas).success).toBe(true);
  });

  it('exposes the regions the Milestone 0 scene draws', () => {
    const manifest = loadCoreAtlasManifest();
    for (const name of ['helicopter', 'rotor', 'ground', 'star', 'glow', 'white']) {
      expect(manifest.regions[name]).toBeDefined();
    }
  });

  it('rejects a region that runs off the atlas', () => {
    const broken = structuredClone(coreAtlas);
    broken.regions.helicopter = { x: 120, y: 0, width: 48, height: 24 };
    expect(atlasManifestSchema.safeParse(broken).success).toBe(false);
  });

  it('rejects a zero-sized region', () => {
    const broken = structuredClone(coreAtlas);
    broken.regions.star = { x: 0, y: 0, width: 0, height: 8 };
    expect(atlasManifestSchema.safeParse(broken).success).toBe(false);
  });
});
