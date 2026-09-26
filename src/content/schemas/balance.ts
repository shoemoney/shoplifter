import { z } from 'zod';

/**
 * Every tunable value lives in validated data, never as a scattered constant. Hot reload in the
 * flight sandbox depends on this, and so does the ability to diff a balance change in review.
 */
export const simBalanceSchema = z.object({
  tickHz: z.number().int().positive(),
  /** Ticks a single frame may consume before the rest are dropped. */
  maxTicksPerFrame: z.number().int().min(1),
});

export const cameraBalanceSchema = z.object({
  baseWorldWidth: z.number().positive(),
  lookAheadFraction: z.number().min(0).max(1),
  verticalBias: z.number().min(0).max(1),
  maxZoomOut: z.number().min(0).max(1),
  referenceSpeed: z.number().positive(),
  positionSmoothing: z.number().gt(0).lt(1),
  zoomSmoothing: z.number().gt(0).lt(1),
});

export const renderBalanceSchema = z.object({
  spriteCapacity: z.number().int().positive(),
  maxDevicePixelRatio: z.number().min(1).max(4),
  clearColor: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});

export const inputBalanceSchema = z.object({
  deadZone: z.number().min(0).max(0.9),
  axisCurve: z.number().min(1).max(4),
  bufferMs: z.number().min(0).max(500),
});

export const balanceSchema = z.object({
  schemaVersion: z.literal(1),
  sim: simBalanceSchema,
  camera: cameraBalanceSchema,
  render: renderBalanceSchema,
  input: inputBalanceSchema,
});

export type Balance = z.infer<typeof balanceSchema>;
export type SimBalance = z.infer<typeof simBalanceSchema>;
export type CameraBalance = z.infer<typeof cameraBalanceSchema>;
export type RenderBalance = z.infer<typeof renderBalanceSchema>;
export type InputBalance = z.infer<typeof inputBalanceSchema>;

export interface BalanceIssue {
  path: string;
  message: string;
}

export type BalanceParseResult =
  { ok: true; value: Balance } | { ok: false; issues: BalanceIssue[] };

/**
 * Returns editor-friendly issues rather than throwing. A designer editing JSON should get a
 * pointed list of what is wrong, not a stack trace.
 */
export const parseBalance = (raw: unknown): BalanceParseResult => {
  const result = balanceSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
      message: issue.message,
    })),
  };
};
