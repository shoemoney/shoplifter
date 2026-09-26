import { z } from 'zod';

export const atlasRegionSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /**
   * World size in metres the sprite was drawn for, as [width, height]. Carried in the manifest
   * so the renderer scales art instead of guessing — guessing is how a 2.4:1 helicopter ends up
   * drawn into a 2:1 box and looks subtly wrong everywhere.
   */
  meters: z.tuple([z.number().positive(), z.number().positive()]).optional(),
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
