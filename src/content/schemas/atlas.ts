import { z } from 'zod';

export const atlasRegionSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const atlasManifestSchema = z
  .object({
    image: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    regions: z.record(z.string(), atlasRegionSchema),
  })
  .refine(
    (manifest) =>
      Object.values(manifest.regions).every(
        (region) =>
          region.x + region.width <= manifest.width && region.y + region.height <= manifest.height,
      ),
    { message: 'A region extends past the atlas bounds' },
  );

export type AtlasManifestData = z.infer<typeof atlasManifestSchema>;
