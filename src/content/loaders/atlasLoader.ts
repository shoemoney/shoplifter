import coreAtlas from '../atlases/core.json' with { type: 'json' };
import { atlasManifestSchema, type AtlasManifestData } from '../schemas/atlas.js';

export class AtlasValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AtlasValidationError';
  }
}

/** Validated at startup: a bad region silently samples the wrong sprite, which is hard to spot. */
export const loadCoreAtlasManifest = (): AtlasManifestData => {
  const result = atlasManifestSchema.safeParse(coreAtlas);
  if (!result.success) {
    throw new AtlasValidationError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  }
  return result.data;
};
