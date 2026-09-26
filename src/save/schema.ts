import { z } from 'zod';

/**
 * Persisted state. Versioned from the first release because a save format that cannot migrate
 * strands players on an old build — and this one has to survive four biomes of content that do
 * not exist yet.
 */
export const difficultySchema = z.enum(['story', 'standard', 'veteran', 'classic']);

export const axisSettingsSchema = z.object({
  deadZone: z.number().min(0).max(0.9),
  invertX: z.boolean(),
  invertY: z.boolean(),
  /** 1 = linear; higher gives finer control near centre. */
  curve: z.number().min(1).max(4),
});

export const accessibilitySettingsSchema = z.object({
  reducedMotion: z.boolean(),
  /** 0 disables camera shake entirely. */
  cameraShake: z.number().min(0).max(1),
  reducedFlashes: z.boolean(),
  chromaticEffects: z.boolean(),
  colorblindPalette: z.enum(['off', 'deuteranopia', 'protanopia', 'tritanopia']),
  subtitles: z.boolean(),
  visualizedAudio: z.boolean(),
  /** The PRD allows 75%, 90% and 100%; the first two do not affect the grade below Veteran. */
  gameSpeed: z.union([z.literal(0.75), z.literal(0.9), z.literal(1)]),
  /** Prevents direct player bullets from killing civilians; blast knockdown still applies. */
  civilianFriendlyMode: z.boolean(),
  holdToBoost: z.boolean(),
  holdToFire: z.boolean(),
  alwaysShowLandingAid: z.boolean(),
});

export const audioSettingsSchema = z.object({
  master: z.number().min(0).max(1),
  music: z.number().min(0).max(1),
  effects: z.number().min(0).max(1),
  voice: z.number().min(0).max(1),
});

export const bindingOverrideSchema = z.object({
  action: z.string().min(1),
  codes: z.array(z.string().min(1)),
});

export const settingsSchema = z.object({
  language: z.string().min(2),
  difficulty: difficultySchema,
  audio: audioSettingsSchema,
  accessibility: accessibilitySettingsSchema,
  axes: z.object({
    thrust: axisSettingsSchema,
    aim: axisSettingsSchema,
  }),
  /** Off / Low / Standard, per the PRD's gamepad aim-assist slider. */
  aimAssist: z.enum(['off', 'low', 'standard']),
  keyboardOverrides: z.array(bindingOverrideSchema),
  gamepadOverrides: z.array(bindingOverrideSchema),
  /** "Classic controls": stick moves, one button fires, one cycles orientation. */
  classicControls: z.boolean(),
  maxDevicePixelRatio: z.number().min(1).max(4),
});

export const missionResultSchema = z.object({
  missionId: z.string().min(1),
  rank: z.enum(['S', 'A', 'B', 'C', 'D', 'F']),
  score: z.number().min(0).max(100),
  rescued: z.number().int().min(0),
  dead: z.number().int().min(0),
  elapsedSeconds: z.number().min(0),
  difficulty: difficultySchema,
  /** Epoch milliseconds. */
  completedAt: z.number().int().min(0),
});

export const saveGameSchema = z.object({
  schemaVersion: z.literal(1),
  settings: settingsSchema,
  completedMissions: z.record(z.string(), missionResultSchema),
  unlockedAircraft: z.array(z.string().min(1)),
  /** Safe landings completed across the campaign; drives landing-aid mastery. */
  safeLandings: z.number().int().min(0),
});

export type Settings = z.infer<typeof settingsSchema>;
export type AccessibilitySettings = z.infer<typeof accessibilitySettingsSchema>;
export type AudioSettings = z.infer<typeof audioSettingsSchema>;
export type AxisSettings = z.infer<typeof axisSettingsSchema>;
export type MissionResult = z.infer<typeof missionResultSchema>;
export type SaveGame = z.infer<typeof saveGameSchema>;
export type Difficulty = z.infer<typeof difficultySchema>;

export const defaultSettings = (): Settings => ({
  language: 'en',
  difficulty: 'standard',
  audio: { master: 0.8, music: 0.6, effects: 0.9, voice: 1 },
  accessibility: {
    reducedMotion: false,
    cameraShake: 1,
    reducedFlashes: false,
    chromaticEffects: true,
    colorblindPalette: 'off',
    subtitles: true,
    visualizedAudio: false,
    gameSpeed: 1,
    civilianFriendlyMode: false,
    holdToBoost: true,
    holdToFire: true,
    alwaysShowLandingAid: false,
  },
  axes: {
    thrust: { deadZone: 0.12, invertX: false, invertY: false, curve: 1.6 },
    aim: { deadZone: 0.12, invertX: false, invertY: false, curve: 1.4 },
  },
  aimAssist: 'standard',
  keyboardOverrides: [],
  gamepadOverrides: [],
  classicControls: false,
  maxDevicePixelRatio: 2,
});

/** The baseline Rescue helicopter is always available; every campaign mission must be winnable in it. */
export const defaultSave = (): SaveGame => ({
  schemaVersion: 1,
  settings: defaultSettings(),
  completedMissions: {},
  unlockedAircraft: ['rescue'],
  safeLandings: 0,
});
