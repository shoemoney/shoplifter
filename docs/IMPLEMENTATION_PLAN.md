# Implementation Plan

Maps the PRD's Milestones 0–5 onto small, independently testable issues. One milestone is
implemented at a time; the campaign is not scaffolded ahead of a working vertical slice.

Legend: **done** · _in progress_ · (unstarted)

## Milestone 0 — Foundation — **done**

Bootable WebGPU app with CI.

| #    | Issue                                                                      | Lands in                                                       | Tests                                        |
| ---- | -------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| 0.1  | Repository bootstrap, Vite/TS strict, lint, format, Vitest, Playwright, CI | `package.json`, `eslint.config.js`, `.github/workflows/ci.yml` | `npm run verify`                             |
| 0.2  | WebGPU probe, adapter/device, canvas sizing, error scopes                  | `src/render/webgpu/context.ts`                                 | `context.test.ts`, `e2e/unsupported.spec.ts` |
| 0.3  | Device-loss detection and resource rebuild                                 | `src/render/webgpu/deviceRecovery.ts`                          | `e2e/boot.spec.ts` (loss drill)              |
| 0.4  | WGSL sprite pipeline + instanced batcher                                   | `pipelines.ts`, `spriteBatch.ts`, `shaders/sprite.wgsl`        | `spriteBatch.test.ts`, e2e draw-call budget  |
| 0.5  | Fixed-step deterministic clock                                             | `src/core/clock.ts`                                            | `clock.test.ts`                              |
| 0.6  | Seeded RNG + state hash                                                    | `src/core/rng.ts`, `src/core/math.ts`                          | `rng.test.ts`, `math.test.ts`                |
| 0.7  | Input action abstraction, rebinding, gamepad                               | `src/input/*`                                                  | `actions.test.ts`, `rebinding.test.ts`       |
| 0.8  | Balance/atlas schemas and loaders                                          | `src/content/**`                                               | `balance.test.ts`, `atlas.test.ts`           |
| 0.9  | Debug overlay with frame percentiles                                       | `src/debug/overlay.ts`                                         | e2e overlay assertions                       |
| 0.10 | Unsupported-browser screen                                                 | `src/ui/unsupported.ts`                                        | `e2e/unsupported.spec.ts`                    |

**Acceptance:** instanced textured sprites render at a stable 60 FPS in one draw call; an
unsupported browser gets a specific explanation; `npm run verify` and the Playwright suite pass.

## Milestone 1 — Flight Sandbox — **done**

| #   | Issue                                                                     | Notes                                                 |
| --- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1.1 | Flight component + system from the PRD tuning table                       | Replaces `GameApp.stepDemo` entirely                  |
| 1.2 | Landing contacts and crash classification                                 | Safe ≤ 3.2 m/s, hard 3.2–6.0, crash > 6.0, slope ≤ 7° |
| 1.3 | Yaw state machine (left / foreground / right), 180–260 ms, never grounded |                                                       |
| 1.4 | Camera look-ahead wired to real velocity + threat input                   | `camera.ts` already implements the framing rules      |
| 1.5 | Balance hot reload via Vite HMR                                           | `BalanceStore.replace` is the seam                    |
| 1.6 | Rotor/engine audio layers and skid haptics                                |                                                       |
| 1.7 | Debug graphs: velocity, lift, frame time, contacts                        |                                                       |

**Acceptance:** takeoff, hover, reverse, yaw, land and crash behave identically at 60/120/144 Hz.

## Milestone 2 — Combat Sandbox (unstarted)

Projectile pool + door gun · rockets, lock-on, splash, flares · component damage · collider
shapes and a 16 m spatial hash · infantry, tank, AA, jet pass controller, homing drone ·
foreground targeting plane · threat telegraphs.

**Acceptance:** every enemy has at least two viable responses; no unavoidable off-screen hit
(700 ms minimum warning).

## Milestone 3 — Rescue Loop (unstarted)

Civilian state machine and nav lanes · boarding, capacity, injury, unload, rescue accounting ·
rotor and skid safety · director escalation tiers · rescue-weighted scoring.

**Acceptance:** 24 civilians produce every documented outcome deterministically; kills award no
score.

## Milestone 4 — Vertical Slice Level (unstarted)

JSON level schema and loader with editor-friendly errors · _Operation Open Sky_ content ·
director phases · three civilian sites · weather and day-to-dusk · base services · objectives.

**Acceptance:** a blind internal tester finishes in under 20 minutes after the tutorial.

## Milestone 5 — Polish and Hardening (unstarted)

Art/audio pass · settings, accessibility, save and migration · replay capture and deterministic
verifier · particles, lighting, grading · performance optimization · soak harness.

**Acceptance:** every MVP criterion and performance budget passes CI and the manual checklist.
