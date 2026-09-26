<div align="center">

# 🚁 Shoplifter

**An original 2D helicopter rescue game for the browser.**
Fly with weight, land without crushing anyone, and get finite human beings home. 🧑‍🤝‍🧑

[![status](https://img.shields.io/badge/status-pre--alpha-orange)](docs/PRD.md)
[![stack](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org/)
[![render](https://img.shields.io/badge/WebGPU-WGSL-005a9c)](https://www.w3.org/TR/webgpu/)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

## 🎯 What this is

A spiritual successor to Dan Gorlin's 1982 _Choplifter!_ — **not a remake, not a port, no original code, art, audio, or level layouts.** 🚫📼

The design anchor is the thing everyone forgets about the original: it refused a seven-digit score. People were finite, so the only number that mattered was **how many of them lived**. 💔

| Preserved from 1982                             | Modernized                                          |
| ----------------------------------------------- | --------------------------------------------------- |
| 🧍 Finite, individually tracked civilians       | 📷 Camera look-ahead + off-screen threat indicators |
| 🔁 Repeated outbound / return extraction trips  | 🎮 Full remapping, inversion, gamepad + KBM parity  |
| ↔️ Movement independent of weapon facing        | ♿ Accessibility pass (shake, contrast, timing)     |
| 🛬 Landing and boarding are genuinely dangerous | 🎯 Deterministic 120 Hz sim + replay verification   |
| 📈 Rescues escalate the opposition              | 🔥 Damage model, flares, rockets, suppression       |

## 🧱 Stack

```mermaid
flowchart LR
    I["🎮 input<br/>KBM · gamepad · rebinding"] --> S
    S["⚙️ sim<br/>fixed 120 Hz · deterministic · DOM-free"] --> E["📨 event queue"]
    E --> R["🖼️ render<br/>WebGPU · WGSL · instanced sprites"]
    E --> A["🔊 audio<br/>Web Audio"]
    C["📄 content<br/>JSON missions + balance"] --> S
    S -. interpolated state .-> R
```

- **TypeScript** `strict: true` · **Vite** · native **WebGPU/WGSL** (no 3D engine)
- **Vitest** unit · **Playwright** browser smoke · ESLint + Prettier
- Simulation never touches the DOM. `Math.random()` is banned in sim. Every tunable lives in typed balance data.

## 🗺️ Roadmap

<details>
<summary><b>Milestones 0 → 5 (click to expand)</b></summary>

| #   | Milestone         | Deliverable                                                            |
| --- | ----------------- | ---------------------------------------------------------------------- |
| 0   | 🧰 Foundation     | Bootable WebGPU app, CI, fixed clock, seeded RNG, debug overlay        |
| 1   | 🕹️ Flight Sandbox | Helicopter with momentum, pitch, landing contacts, hot-reloaded tuning |
| 2   | 💥 Combat Sandbox | Door gun, rockets, flares, damage, 5 enemies + drone                   |
| 3   | 🚑 Rescue Loop    | Civilian state machine, boarding, capacity, injuries, unload, scoring  |
| 4   | 🏜️ Vertical Slice | _Operation Open Sky_ — 6 km Salt Flats map, launch to debrief          |
| 5   | ✨ Polish         | Art/audio, accessibility, save, replay, perf budgets                   |

</details>

**Target:** 60 FPS at 1080p on integrated graphics, <150 draw calls, <50 MB initial download, restart-to-control under 2 s. ⚡

## 🚀 Getting started

Requires Node 20+ and a WebGPU-capable desktop browser (Chrome/Edge 113+) on https or localhost.

```bash
npm install
npm run dev        # http://localhost:5173 — backquote toggles the debug overlay
npm run verify     # format + lint + typecheck + unit tests + production build
npm run test:e2e   # Playwright: boot, device-loss recovery, unsupported-browser screen
```

**Milestone 0 is landed.** Measured on Apple M-series (Metal 3), 1920×1080:

| Metric                  | Measured                              | PRD budget               |
| ----------------------- | ------------------------------------- | ------------------------ |
| 🎞️ Frame rate           | 60.0 FPS (16.67 ms mean, 16.8 ms p99) | stable 60 @ 1080p        |
| 🖼️ Sprites / draw calls | 1,956 / **1**                         | < 150 draws, target < 60 |
| ⚙️ Sim / render prep    | 0.0 ms / 0.2 ms                       | < 3 ms / < 2 ms          |
| 📦 Bundle               | 131 kB (40 kB gzip)                   | < 50 MB initial          |
| ⏱️ Dropped ticks        | 0                                     | —                        |

Controls right now are the placeholder sandbox: **W/S/A/D** thrust, **Space** boost, **Esc** pause,
**`** debug overlay. The real flight model lands in Milestone 1.

Full spec: **[docs/PRD.md](docs/PRD.md)** · plan: **[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)** · decisions: **[docs/DECISIONS.md](docs/DECISIONS.md)**

## ⚖️ Legal

Mechanics are documented for research and inspiration. No _Choplifter_ name, trademark, artwork, audio, text, source, or level geometry is used or redistributed here. Code in this repo is MIT licensed.
