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

## Milestone 2 — Combat Sandbox — **done**

| #   | Issue                                             | Lands in                         |
| --- | ------------------------------------------------- | -------------------------------- |
| 2.1 | Collider shapes + 16 m spatial hash + raycast     | `src/sim/collision.ts`           |
| 2.2 | SoA projectile pool, swept segments, guided kinds | `src/sim/systems/projectiles.ts` |
| 2.3 | Door gun, rockets with civilian-safe lock, flares | `src/sim/systems/weapons.ts`     |
| 2.4 | Component damage, fuel leak, suppression/morale   | `src/sim/systems/damage.ts`      |
| 2.5 | Six enemy state machines                          | `src/sim/systems/enemies.ts`     |
| 2.6 | Escalation over authored sockets                  | `src/sim/systems/director.ts`    |

**Acceptance:** every firing enemy telegraphs for at least 700 ms (asserted); a tank cannot
reach a high hover; the jet makes one pass and leaves; tier 4 terminates.

## Milestone 3 — Rescue Loop — **done**

| #   | Issue                                                   | Lands in                        |
| --- | ------------------------------------------------------- | ------------------------------- |
| 3.1 | Civilian state machine, lanes, cover, panic             | `src/sim/systems/civilians.ts`  |
| 3.2 | Two boarding doors, capacity, wounded costing two seats | `civilians.ts` (`BoardingBay`)  |
| 3.3 | Rotor / skid / downwash zones per difficulty            | `civilians.ts`                  |
| 3.4 | Objective tracking and mission progress                 | `src/sim/systems/objectives.ts` |
| 3.5 | Rescue-weighted grading where kills score nothing       | `src/sim/systems/scoring.ts`    |

**Acceptance:** civilians produce every documented outcome deterministically; a record time
cannot buy back a death (asserted).

## Milestone 4 — Vertical Slice Level — **done**

| #   | Issue                                          | Lands in                                 |
| --- | ---------------------------------------------- | ---------------------------------------- |
| 4.1 | Mission schema with editor-friendly validation | `src/content/schemas/mission.ts`         |
| 4.2 | Terrain compiler + landing-pad levelling       | `src/content/loaders/missionLoader.ts`   |
| 4.3 | _Operation Open Sky_ content                   | `src/content/missions/m01_open_sky.json` |
| 4.4 | Full system integration                        | `src/sim/mission.ts`                     |
| 4.5 | Headless autopilot                             | `src/debug/autopilot.ts`                 |
| 4.6 | HUD model, renderer, debrief                   | `src/ui/`                                |

**Acceptance:** the mission completes end to end under synthetic input — 22 of 24 rescued, every
primary objective met, inside the 20-minute budget, **without the pilot firing a shot**.

## Milestone 5 — Polish and Hardening — _mostly done_

| #    | Issue                                           | State                                                                       |
| ---- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| 5.1  | Replay capture + deterministic verifier         | **done** — `src/debug/replay.ts`                                            |
| 5.2  | Soak harness                                    | **done** — one simulated hour runs in 0.8 s with zero drift                 |
| 5.3  | Versioned save, settings, accessibility         | **done** — `src/save/`, persisted to IndexedDB                              |
| 5.4  | Audio: mixing rules + Web Audio graph           | **done** — `src/audio/mixer.ts`, `src/audio/engine.ts`                      |
| 5.5  | Settings applied at runtime                     | **done** — `src/app/settingsRuntime.ts`                                     |
| 5.6  | Particles, rotor wash, explosions, camera shake | **done** — `src/render/webgpu/particles.ts`                                 |
| 5.7  | Pause menu, restart, debrief screen             | **done** — `src/ui/screens.ts`                                              |
| 5.8  | Art and audio pass                              | **unstarted** — art direction is still an open PRD decision                 |
| 5.9  | Lighting, distortion, colour grading            | **unstarted** — needs the art direction first                               |
| 5.10 | Full settings menu and rebinding UI             | **unstarted** — the model and persistence exist; only the screen is missing |
| 5.11 | Tutorial overlays                               | **unstarted**                                                               |

### What remains before this is a shippable demo

The systems are all present and tested. What is missing is **content and presentation**, both
of which wait on decisions the PRD itself lists as open:

- **Art.** Everything on screen is a generated placeholder atlas. Pixel-art vs illustrated vs
  hybrid is an open PRD decision, and nothing should be drawn until it is made.
- **Audio assets.** The graph synthesises every cue from oscillators. `CUE_LIBRARY` is the seam
  a real sample pack drops into.
- **Tutorial overlays**, which the MVP scope requires.
- **A settings screen.** Every setting is modelled, validated, persisted and applied; only the
  pause menu's five quick toggles are reachable.
- **The remaining 11 campaign missions**, which need no new systems — only authored JSON.
