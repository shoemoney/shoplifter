# PRD — Modern 2D Helicopter Rescue Game Inspired by Choplifter (1982)
**Document status:** Implementation-ready draft 1.0  
**Target implementer:** Claude Code using an Opus-class coding model  
**Reference game:** Dan Gorlin’s 1982 Apple II game *Choplifter!*  
**Default product assumption:** An original commercial spiritual successor, not an unlicensed remake  
**Initial platform:** Desktop web, Chrome/Edge, keyboard/mouse and gamepad  
**Rendering:** WebGPU with WGSL  
**Initial scope:** Polished vertical slice plus architecture and content pipeline for a 12-mission campaign
## Executive Direction
Build a modern 2D side-scrolling helicopter rescue game that preserves the original’s essential tension: flying is expressive, every civilian life is finite, combat exists to enable rescue, and returning vulnerable passengers to safety matters more than accumulating kills. The player should continually choose between fighting, evading, landing, protecting civilians, and extracting before the situation deteriorates.

The original game’s unusually humane scoring philosophy is the strongest design anchor. Dan Gorlin deliberately rejected a conventional seven-digit score because finite people made each death meaningful; the only meaningful result was how many hostages survived. The remake should therefore reward lives saved, safe piloting, speed, restraint, and mission objectives—not raw destruction.[^1][^2]

For commercial use, treat this as an original spiritual successor. Do not ship the *Choplifter* name, Bungeling Empire, original text, audiovisual assets, level layout, code, or other distinctive expression without documented permission. A binary-identical clean-room reverse engineering project exists and is valuable for behavioral research, but its repository explicitly describes the work as Dan Gorlin’s game rather than granting ownership of the underlying game. Obtain counsel before copying code or recognizable content.[^3]
## Product Vision
### One-sentence pitch
Pilot a responsive combat-rescue helicopter through collapsing 2D war zones, protect finite civilians, make repeated hot-zone extractions, and adapt as enemies escalate in response to every successful sortie.
### Design pillars
- **Rescue before destruction:** Fighting creates safe windows for evacuation; it is never the sole purpose.
- **Expressive flight:** The helicopter has momentum, lift, drift, pitch, and landing weight, but remains learnable in minutes.
- **Visible human stakes:** Civilians wave, panic, seek cover, board, become injured, and react to nearby fire.
- **Escalating counterattack:** Each extraction changes enemy composition and aggression, echoing the original’s sortie escalation.
- **Readable 2.5D combat:** Movement stays on a side-view plane, while the helicopter can yaw toward the foreground to attack ground-depth targets.
- **Authored missions, systemic outcomes:** Levels have deliberate geography and encounters, but physics, AI, destruction, and civilian behavior create unscripted rescues.
### Target experience
A new player should understand takeoff, translation, aiming, landing, and boarding within five minutes. Mastery should come from preserving momentum, managing altitude, selecting firing angles, suppressing threats without harming civilians, and choosing when to abort a pickup. Typical missions should last 8–15 minutes; the vertical-slice mission should last 10–12 minutes on a first successful run.
## Original Game Research
## Historical Core
*Choplifter!* was developed by Dan Gorlin and published by Broderbund for the Apple II in 1982. Gorlin began with a joystick-driven helicopter simulation, added targets, and adopted the idea of rescuing people after a young *Defender* fan suggested adding people to pick up. The initial design attempted more realistic helicopter physics and even a first-person presentation, but it became a side-scroller and Broderbund helped reduce simulation complexity to improve playability.[^4][^1][^5]

The resulting game combines arcade action, light flight simulation, and an escort-rescue objective. Contemporary commentary praised its animation and subtle flight control, while Gorlin’s rescue-focused premise made it stand apart from score-driven shooters.[^2][^6]
## Original Objective and Rules
The original scenario contains 64 hostages in four barracks, 16 per barracks. The player must open barracks, land near released hostages, carry no more than 16 at a time, and unload them at the home landing pad; several trips are therefore mandatory. The manual states that all 16 people associated with a barracks must be rescued or killed before progression to the next barracks group.[^4][^7]

The player receives three helicopters. The game ends after the third helicopter is lost or when all 64 hostages have been either rescued or killed; rescuing all 64 is the maximum result. The reverse-engineered source independently identifies 64 as both the victory threshold and the combined rescued/dead termination threshold, stores sortie/life state as 0–2, and implements difficulty levels 0–7.[^7][^8][^3]
### Original loop
1. Take off from the post-office base.
2. Cross the defensive barrier into hostile territory.
3. Open or approach a barracks and expose its hostages.
4. Suppress tanks and other immediate threats.
5. Land level without crushing civilians or blocking their path.
6. Wait while hostages run to and board the helicopter.
7. Leave when full or when remaining on the ground becomes too dangerous.
8. Return to base, land, and unload.
9. Repeat as the enemy escalates.
10. Finish when all 64 people are accounted for or all three helicopters are destroyed.
## Original Helicopter Handling
The helicopter responds to analog horizontal and vertical joystick thrust. Accounts of the Apple II version describe gravity, inertia, partial input required to hover, pitching/yawing animation, hard-landing bounce, and a control model that is demanding enough to reward smooth flight without being a full simulator. The helicopter can fly left or right independently of its facing, and it can face left, right, or toward the player.[^9][^4][^5]

The original two-button scheme is unusually expressive. The manual describes Button 1 as the orientation control: a short press rotates the helicopter into a forward-facing anti-tank posture, while a sustained press reverses its side-facing direction. Button 0 fires. The reverse-engineered source indicates that shooting and turning are prohibited while grounded, death animation blocks both actions, and no more than five player projectiles can be active simultaneously.[^7][^3]

A safe landing is a gameplay action, not an automatic state. Hostages can be crushed by the skids, killed if the helicopter is improperly tilted, or prevented from exiting a building if the helicopter blocks the doorway. Hard or careless landings therefore convert movement skill directly into civilian survival.[^4]
## Original Combat
The player’s gun fires in the helicopter’s facing direction. Left/right facing supports air-to-air and lateral fire; forward-facing is primarily used to shoot tanks and other foreground/ground-plane threats. Friendly fire matters: low-angle player fire can hit civilians, while some forward anti-tank fire does not, making orientation and shot discipline part of rescue.[^9][^4][^7]

The original enemy roster has three major types:

| Enemy | Behavior | Player response |
|---|---|---|
| Tank | Moves along the ground, attacks landed or low helicopters, and can kill exposed hostages | Face forward, rise just enough to fire, or evade and reposition[^7] |
| Jet fighter | Enters at speed, attacks with air-to-air missiles and can bomb a grounded helicopter | Change altitude, reverse, evade, or shoot it down[^4][^7] |
| Drone air mine / alien craft | Homes toward the helicopter and can pursue it across the barrier into the base zone | Destroy quickly or keep moving; unlike other enemies it threatens sanctuary[^7][^10] |

The first outward rescue trip initially emphasizes tanks. Jets appear after the first extraction, drones after later trips, and total enemy pressure increases after each return to base. The reverse-engineered code contains a 0–7 difficulty value and increments difficulty after unloading, supporting sortie-based escalation as an original mechanic.[^5][^8][^9]
## Original Civilians
Released hostages do more than act as pickups. They run, wave, hesitate, scramble around fire, move toward the landed helicopter, and flee a crashing helicopter. If the helicopter reaches its 16-person capacity, remaining hostages wave it off and wait for another trip. Civilians can die from hostile fire, player fire, being landed on, unsafe boarding geometry, or destruction of the helicopter while aboard.[^9][^4]

The original does not award a conventional kill score. Its display tracks hostages killed, currently aboard, and safely returned; the finite population makes every casualty persistent and emotionally legible. This is the principal system to preserve.[^1][^7]
## Original Environment and Presentation
The Apple II game uses a horizontally scrolling battlefield with a protected base/post office and landing pad, a fence or barrier, four hostage structures, desert ground, mountains, stars, and a moon. The fully documented reverse-engineered source names rendering routines for stars, moon, scrolling, mountains, base, fence, and hostage houses. The game runs from 48 KB and uses Apple II high-resolution graphics, showing how much behavior and animation Gorlin fit into limited hardware.[^8][^3]

The player reads most state directly in the world: rotor motion and aircraft pitch communicate thrust, the landing gear compresses on impact, the fuselage collapses and burns after destruction, enemies visibly turn or enter depth planes, and people run or wave. Modern graphics should increase this readability rather than bury it beneath particles.[^9]
## Original Controls
| Input | Original behavior |
|---|---|
| Analog joystick X/Y | Horizontal and vertical thrust[^7] |
| Button 0 | Fire; unavailable on ground[^7][^3] |
| Button 1, short press | Turn forward to attack tanks[^7] |
| Button 1, sustained press | Reverse left/right facing[^7] |
| Esc | Pause[^7] |
| Ctrl-S | Toggle sound[^7] |
| Ctrl-V / Ctrl-A | Reverse vertical / horizontal joystick axes[^7] |
| Any key | Start play[^7] |

The original requires a joystick with two buttons and supports axis reversal, an early accessibility/comfort feature worth retaining as full remapping and inversion options.[^7]
## Research Conclusions
The remake should preserve five things even when every asset and implementation is new:

- Finite named or individually tracked civilians.
- Repeated outbound-and-return extraction trips.
- A helicopter that moves independently from its weapon-facing orientation.
- Meaningful landing and boarding risk.
- Enemy escalation caused by successful rescues.

Modernizations should remove avoidable frustration without removing consequence. The camera must show adequate look-ahead, warnings should identify off-screen threats, input should be remappable, and failures should be attributable to readable decisions rather than unseen jets. Reviews of *Choplifter HD* specifically criticized close camera framing, strict time pressure, forced helicopter choices, repetition, and trial-and-error restarts. Its useful additions—independent aiming, boost, varied objectives, aircraft statistics, repairs/refueling, and mission structure—can be adapted selectively without letting combat overwhelm rescue.[^11][^12][^13][^14][^15]
## Product Scope
## MVP Vertical Slice
The MVP is one complete 10–12 minute mission in the **Salt Flats** biome, plus tutorial overlays, settings, results, retry, and deterministic debug tools.
### Required vertical-slice content
- One 6,000-meter side-scrolling map.
- One home base and one forward refuel/rearm pad.
- Three civilian sites with 8 civilians each, for 24 total.
- One player helicopter with 8-passenger capacity.
- Five enemy types: rifle infantry, RPG infantry, light tank, AA gun, interceptor jet.
- One homing-drone hazard introduced after the first successful unload.
- Two primary weapons: door gun and rockets.
- Countermeasures: flares with cooldown.
- Damage model: hull, engine/rotor, fuel leak, passenger danger.
- Civilian states: captive, released, seeking cover, approaching, boarding, aboard, injured, rescued, dead.
- Day-to-dusk lighting transition during the mission.
- Full keyboard/mouse and XInput-style gamepad support.
- Results grade based primarily on survival and mission completion.
- WebGPU renderer, audio, save settings, pause, restart, and unsupported-browser screen.
## Campaign Target
After vertical-slice approval, expand to 12 authored missions across four three-mission biomes:

| Biome | Visual identity | New systemic pressure |
|---|---|---|
| Salt Flats | High-contrast desert, long sightlines, radar towers | Tanks, jets, heat shimmer, dust |
| Jungle River | Dense canopy, villages, water reflections | Ambushes, boats, narrow landing zones, rain |
| Alpine Border | Snow, cliffs, tunnels, high winds | Downdrafts, radar-guided SAMs, low visibility |
| Flooded Megacity | Night neon, rooftops, fires, collapsing structures | Rooftop extraction, drones, power grids, moving hazards |

Each biome introduces one flight hazard, two enemies, one civilian complication, and one mission archetype. Reuse systems, not layouts.
## Non-goals
- No 3D free-flight or first-person cockpit mode.
- No competitive multiplayer in version 1.
- No loot boxes, battle pass, energy timer, or live-service dependency.
- No realistic military faction names or direct recreation of a real current conflict.
- No procedural campaign replacing authored missions.
- No mandatory kill quotas unless destruction directly protects civilians.
- No direct use of original code, art, audio, story text, character names, or exact layouts.
## Core Game Loop
### Mission loop
1. Review objectives, weather, known threats, and aircraft loadout.
2. Launch from base.
3. Navigate using terrain, altitude, and momentum.
4. Reconnoiter extraction zone.
5. Neutralize or suppress only the threats necessary to create a landing window.
6. Release and protect civilians.
7. Land within slope and velocity tolerances.
8. Board civilians while managing exposure and capacity.
9. Return, optionally refuel/rearm/repair, and unload.
10. React to escalation and repeat until primary objectives resolve.
11. Extract or complete the final defensive event.
12. Receive a debrief based on lives, objectives, damage, time, restraint, and optional rescues.
### Moment-to-moment loop
- Read threats.
- Choose altitude and facing.
- Accelerate, drift, brake, or hover.
- Aim and fire in controlled bursts.
- Break missile locks.
- Create a temporary safe zone.
- Commit to landing or abort.
- Protect boarding civilians.
- Depart before threats close in.
## Success Metrics
### Player-facing goals
- At least 80% of first-time players complete the tutorial without external instructions.
- Median first successful vertical-slice run: 10–12 minutes.
- At least 70% of failures are followed by retry rather than exit during playtests.
- Players correctly identify civilian survival as the primary scoring factor.
- Gamepad and keyboard/mouse completion rates remain within 10 percentage points.
### Technical goals
- 60 FPS at 1080p on the baseline integrated GPU.
- 120 FPS supported when display and hardware permit.
- Fixed deterministic simulation at 120 Hz.
- Frame-time target: CPU simulation under 3 ms; CPU render preparation under 2 ms; GPU under 8 ms at 1080p.
- Fewer than 150 WebGPU draw calls in the vertical slice; target below 60 through sprite instancing.
- Fewer than 50 MB initial compressed download; fewer than 150 MB decoded texture/audio memory.
- Mission restart to control in under 2 seconds after assets are cached.
- Zero unhandled promise rejections and graceful WebGPU device-loss recovery.
## Flight Model
Use a custom deterministic 2D rigid-body flight model, not a general-purpose physics engine. The helicopter should feel analog and inertial while remaining predictable.
### State
```ts
interface HelicopterState {
  position: Vec2;          // meters
  velocity: Vec2;          // meters/second
  acceleration: Vec2;
  pitch: number;           // visual/handling angle, radians
  pitchVelocity: number;
  facing: -1 | 0 | 1;      // left, foreground, right
  grounded: boolean;
  landingContactCount: 0 | 1 | 2;
  hull: number;
  engine: number;
  fuel: number;
  passengers: EntityId[];
  weaponHeat: number;
  rockets: number;
  flares: number;
}
```
### Initial tuning values
These are modern design targets, not claims about the 1982 binary.

| Parameter | Initial value | Notes |
|---|---:|---|
| Max horizontal speed | 42 m/s | Boost increases to 58 m/s |
| Max climb speed | 18 m/s | Slower with heavy damage |
| Max descent speed | 24 m/s | Player can exceed safe landing speed |
| Horizontal acceleration | 22 m/s² | Scaled by engine state |
| Vertical acceleration | 26 m/s² | Input adds lift against gravity |
| Gravity | 14 m/s² | Tuned, not real-world gravity |
| Linear drag X/Y | 0.32 / 0.48 | Exponential damping |
| Safe touchdown vertical speed | ≤ 3.2 m/s | No damage |
| Hard landing | 3.2–6.0 m/s | Hull/passenger injury chance |
| Crash landing | > 6.0 m/s | Severe damage or destruction |
| Safe horizontal touchdown speed | ≤ 2.5 m/s | Skid tolerance |
| Safe slope | ≤ 7 degrees | Both skids must contact |
| Base capacity | 8 civilians | Upgrade/content variants may use 4–16 |
| Boost duration | Fuel-governed | 1.38× top speed, 2.5× fuel use |
### Equations
At each fixed step:

```ts
lift = inputY * verticalAcceleration * engineEfficiency
horizontalThrust = inputX * horizontalAcceleration * engineEfficiency
acceleration.x = horizontalThrust - dragX * velocity.x * abs(velocity.x)
acceleration.y = lift - gravity - dragY * velocity.y * abs(velocity.y)
velocity += acceleration * dt
position += velocity * dt
```

Apply soft speed limits using excess-speed drag rather than hard clamps. Pitch should follow horizontal acceleration with spring damping, while rotor and fuselage remain visually independent from weapon facing.
### Handling requirements
- Neutral vertical input must produce a gentle descent, not a hover.
- Hover requires approximately 55% vertical input at full engine health.
- Reversing direction must require braking momentum.
- Passenger load should slightly reduce climb response, never so much that the aircraft becomes frustrating.
- Engine damage reduces maximum lift; rotor damage adds periodic control noise but never random instant failure.
- Ground effect may add 5–8% lift within one rotor diameter of flat ground.
- The helicopter may translate opposite its facing.
- Yaw transitions take 180–260 ms and cannot occur while fully grounded.
## Camera
Use a side-view orthographic camera with velocity look-ahead and threat-aware framing.

- Default visible world width at 1080p: 56–64 meters.
- Look-ahead: up to 28% of viewport in travel direction.
- Vertical bias: helicopter sits at 58–62% screen height when cruising.
- Zoom out up to 12% during high-speed flight, missile pursuit, or multi-threat combat.
- Never spawn an immediately lethal attack inside the untelegraphed off-screen margin.
- Off-screen jets, missiles, and civilian distress generate edge indicators and spatial audio.
- Camera shake is layered by source and capped; accessibility setting can reduce or disable it.

This directly addresses a recurring complaint that later versions framed action too tightly and forced memorization of attacks.[^12]
## Controls
### Gamepad default
| Input | Action |
|---|---|
| Left stick | Horizontal/vertical thrust |
| Right stick | Aim gun within current facing plane |
| Right trigger | Fire door gun |
| Left trigger | Fire selected secondary weapon |
| Left bumper | Yaw left / cycle left-facing plane |
| Right bumper | Yaw right / cycle right-facing plane |
| A / Cross | Interact: open doors, deploy winch, confirm landing action |
| B / Circle | Flares / countermeasure |
| X / Square | Boost |
| Y / Triangle | Cycle secondary weapon |
| D-pad | Context commands / weapon selection |
| Menu | Pause |
### Keyboard and mouse default
| Input | Action |
|---|---|
| W/S | Increase/decrease lift |
| A/D | Horizontal thrust |
| Mouse | Aim weapon reticle |
| Left mouse | Door gun |
| Right mouse | Rocket / selected secondary |
| Q/E | Yaw left/right |
| Space | Boost |
| F | Flares |
| R | Interact / winch |
| 1–3 | Select secondary |
| Esc | Pause |
### Control requirements
- Full remapping for keyboard, mouse, and gamepad.
- Independent X/Y inversion and dead-zone settings, retaining the spirit of the original axis-reversal options.[^7]
- Aim-assist slider for gamepad: Off, Low, Standard.
- Input buffering of 100 ms for yaw and countermeasure actions.
- Haptic feedback for skid contact, incoming lock, firing, damage, boarding, and rescue completion.
- “Classic controls” preset: left stick moves, one button fires, one button cycles left/front/right orientation.
## Combat System
Combat must support rescue. Every threat should create a spatial or timing problem that can be solved by destruction, suppression, evasion, terrain use, or faster extraction.
### Door gun
- Infinite reserve ammunition.
- Heat-limited sustained fire.
- Accurate first 0.6 seconds, then increasing spread.
- Heat per second: 0.28; cooling per second: 0.22 after a 0.25-second delay.
- Overheat at 1.0; lockout until 0.55.
- Damage falloff begins at 70% of screen width.
- Can intercept rockets and damage light vehicles.
- Friendly fire is enabled in Veteran/Classic modes; Standard mode uses a brief trigger warning and reduced civilian damage, not immunity.
### Rockets
- Initial load: 8.
- Semi-active soft lock within a 12-degree cone; no automatic target selection through civilians.
- High splash damage with visible danger radius.
- Strong against tanks, AA, structures, and clustered drones.
- Resupplied only at base or designated pads.
### Flares
- Two charges, 8-second recharge per charge when not locked.
- Break heat-seeking lock if deployed within the correct timing window.
- Poor timing reduces missile accuracy rather than guaranteeing a miss.
- Clear audio and edge indicator communicate lock progression.
### Suppression
Infantry and exposed gunners have morale. Near misses and sustained fire force them into cover for 2–5 seconds, creating a landing window without requiring a kill. Suppression earns a restraint bonus when civilians survive.
### Damage model
| Component | Effect |
|---|---|
| Hull | Reaching zero destroys helicopter |
| Engine/rotor | Reduces lift, acceleration, and boost; severe damage produces forced descent |
| Fuel system | Adds leak rate; fire risk increases after further hits |
| Weapons | Raises heat, spread, or reload time |
| Passenger bay | Direct heavy hits may injure passengers; never silently kills them |

Damage must always have visual, audio, and HUD feedback. No hidden random critical hits.
## Enemy Specifications
### Rifle infantry
- Patrols near objectives and enters cover.
- Fires inaccurate bursts at low helicopter altitude.
- Suppressed by near misses.
- Low lethality alone; dangerous during boarding.
### RPG infantry
- Telegraphs aim for 1.1 seconds with glint and audio cue.
- Rocket accelerates and can be shot down.
- Relocates after firing.
- Prioritizes hovering or grounded helicopter.
### Light tank
- Travels on ground lanes and rotates turret independently.
- Cannot elevate enough to hit a high helicopter.
- Effective against low or grounded helicopter and exposed civilians.
- Vulnerable rear armor; rocket or sustained gunfire kills it.
- Turret traverse and firing line are visible.
### AA gun
- Controls high-altitude routes.
- Burst fire leads target velocity.
- Suppressible but armored; rocket is efficient answer.
- Radar variant emits a scan cone that can be masked by terrain.
### Interceptor jet
- Begins off-screen with radar/audio warning.
- Performs one readable attack pass, exits, then re-enters after cooldown.
- Fires a limited missile volley rather than unavoidable instant damage.
- Can be evaded through altitude change, flares, terrain masking, or gunfire.
### Homing drone
- Slow, persistent, and permitted to cross into the base zone, preserving the original drone’s special role.[^7]
- Acquires player after line-of-sight exposure.
- Can be lured into terrain, shot, or disabled by EMP pickup in later missions.
- At higher escalation it gains a short-range gun, reflecting the original’s later pressure increase.[^9]
### Enemy director
The director does not rubber-band damage or spawn lethal threats without warning. It selects from authored spawn sockets according to mission phase, extraction count, elapsed combat pressure, and player altitude.

```ts
interface DirectorBudget {
  threatPoints: number;
  maxConcurrentAir: number;
  maxConcurrentGround: number;
  reinforcementCooldown: number;
  escalationTier: 0 | 1 | 2 | 3 | 4;
}
```

Initial tier behavior:

- Tier 0: infantry and tanks.
- Tier 1 after first unload: add AA and jet passes.
- Tier 2 after second unload: add homing drones and flanking ground spawns.
- Tier 3 after major objective: shorter reinforcement cooldown and mixed attacks.
- Tier 4 final extraction: authored climax, never endless spawning.
## Civilian System
Civilians are persistent mission entities with visible state, individual health, and simple identities. Names may be generated from a culturally reviewed list, but portraits and biographies are optional and should never slow the readable action.
### State machine
```text
CAPTIVE
  -> RELEASED
  -> SEEK_COVER <-> PANIC
  -> APPROACH_LZ
  -> WAIT_FOR_SPACE
  -> BOARDING
  -> ABOARD
  -> DISEMBARKING
  -> RESCUED
Any exposed state -> INJURED -> DEAD
```
### Behavior requirements
- Released civilians choose cover if threats are active.
- A safe landed helicopter within 24 meters creates an approach request.
- Civilians use local navigation lanes, not full free-form physics.
- They never knowingly run through fire, rotor danger, or an active blast marker unless panicked.
- A panic event may cause poor decisions, but warning animations must make it readable.
- Full helicopter causes civilians to wave off and return to cover, echoing the original behavior.[^4]
- Boarding takes 0.55 seconds per civilian, with two simultaneous boarding slots when both sides are clear.
- Wounded civilians take 1.5 seconds and consume two capacity units unless a medic upgrade is present.
- Taking off during active boarding cancels boarding and knocks nearby civilians down without automatically killing them.
### Rotor and landing safety
Define a rotor danger capsule, skid crush zones, and exhaust/downwash reaction zone. Standard difficulty prevents an instant civilian death from first contact and instead applies knockdown/injury; Veteran and Classic modes allow lethal crushing. Landing directly on civilians always causes major mission penalties.
### Protection logic
Civilians should not be valid direct targets for most enemy AI. They die from indiscriminate fire, crossfire, structure collapse, explosions, and specific hostile capture behavior. This keeps stakes high without making the simulation feel maliciously arbitrary.
## Mission and Level Design
### Mission archetypes
- **Mass extraction:** Repeated capacity-limited rescue trips.
- **Timed medical evacuation:** Stabilize and return wounded people before condition expires.
- **Insertion and extraction:** Deliver a team, support its objective, then recover it.
- **Rolling evacuation:** Multiple sites become unsafe in sequence.
- **Convoy escort:** Protect ground vehicles while retaining optional rescue targets.
- **Disaster response:** Avoid combat where possible; manage fire, flood, and debris.
- **Final holdout:** Defend a landing zone until boarding completes.

Every mission must include at least one extraction. No mission is purely a shooting gallery.
### Vertical-slice map
**Mission name:** Operation Open Sky  
**World length:** 6,000 m  
**World height:** 500 m usable airspace  
**Target duration:** 10–12 minutes  
**Civilian total:** 24  
**Required rescue:** 18 on Standard; all surviving civilians must be accounted for on Veteran

#### Zones

1. **Home Base, 0–450 m:** Landing pad, repair/refuel/rearm, unload point, tutorial prompts.
2. **Barrier Ridge, 450–900 m:** Fence, low hills, first tank, facing/yaw tutorial.
3. **Village, 900–2,250 m:** Eight civilians, infantry and light tank, broad landing area.
4. **Dry Lake, 2,250–3,500 m:** Open high-speed route, first jet pass after extraction one.
5. **Radar Camp, 3,500–4,750 m:** AA gun, destructible radar, eight civilians, narrow landing zone.
6. **Canyon Prison, 4,750–5,800 m:** Eight civilians, RPG troops, drone activation, wind gusts.
7. **Extraction Edge, 5,800–6,000 m:** Optional intel pickup and authored final escalation trigger.

#### Scripted beats

- Launch teaches thrust and camera look-ahead.
- Barrier tank teaches forward-facing attack.
- Village teaches release, landing, boarding, and capacity.
- First unload raises escalation tier and introduces a clearly telegraphed jet.
- Second site introduces AA and foreground targeting.
- Second unload introduces a homing drone able to follow the player home.
- Final site combines wind, RPG threat, and wounded civilian.
- Mission ends after required rescue count and final return; optional objectives remain available until player lands and confirms completion.
### Level data format
Use human-editable JSON validated by JSON Schema.

```json
{
  "id": "m01_open_sky",
  "version": 1,
  "lengthMeters": 6000,
  "altitudeCeiling": 500,
  "biome": "salt_flats",
  "playerSpawn": { "x": 120, "y": 18 },
  "objectives": [],
  "terrainSegments": [],
  "landingZones": [],
  "civilianGroups": [],
  "enemySockets": [],
  "directorPhases": [],
  "weatherVolumes": [],
  "checkpoints": []
}
```

All content references use stable string IDs. Runtime code must not contain mission-specific entity placements.
## Scoring and Progression
### Mission grade weights
| Category | Weight |
|---|---:|
| Civilian survival and rescue | 55% |
| Primary/secondary objectives | 20% |
| Aircraft/passenger safety | 10% |
| Time | 10% |
| Restraint and collateral damage | 5% |

Kills never directly award points. Threat destruction may improve objective or safety results. Civilian deaths impose large penalties that cannot be fully offset by speed.
### Rank thresholds
- S: 92+
- A: 82–91
- B: 70–81
- C: 55–69
- D: mission completed below 55
- Failure: primary extraction threshold not met or player aircraft lost without recovery
### Unlocks
Campaign progression unlocks sidegrade helicopters and mission modifiers, not strictly superior aircraft. Avoid the later-remake problem where high ratings effectively require a larger helicopter that the player has not yet unlocked.[^16]

Initial aircraft archetypes:

- **Scout:** 4 capacity, fast, agile, light armor.
- **Rescue:** 8 capacity, balanced baseline.
- **Heavy Lift:** 16 capacity, slow, durable, large landing footprint.
- **Gunship-Rescue:** 6 capacity, stronger weapons, poor fuel economy.

Every campaign mission must be completable with the baseline Rescue helicopter on Standard.
## UI and HUD
### In-mission HUD
- Top left: rescued / total, deaths, onboard passengers.
- Bottom left: hull, engine, fuel.
- Bottom right: gun heat, rockets, flares.
- Top center: current objective and extraction progress.
- Screen edges: off-screen threats, missiles, civilians in distress.
- Thin horizontal tactical strip: player, base, objectives, known threats, refuel points.

The three civilian counters intentionally echo the original’s killed / aboard / safely returned display. Avoid a large traditional score during play.[^7]
### Landing UI
When within 12 meters of a valid landing zone, show:

- Vertical speed.
- Horizontal speed.
- Slope/attitude.
- Left/right skid contact.
- Civilian danger warning.

Indicators fade after the player demonstrates three safe landings unless “Always show” is enabled.
### Debrief
Display each civilian outcome, objective completion, collateral incidents, aircraft damage, flight time, and improvement tips. Do not celebrate kill count; if shown, place it under a neutral “Threats neutralized” statistic.
## Art Direction
Create an original high-resolution 2D presentation with physically grounded lighting and restrained stylization. Do not imitate the original sprites one-for-one.
### Rendering layers
1. Sky gradient and weather.
2. Far parallax silhouettes.
3. Midground terrain and structures.
4. Main gameplay plane.
5. Foreground threat plane.
6. Particles, lighting, distortion, and decals.
7. HUD.
### Sprite approach
- Skeletal or layered sprite animation for helicopter parts.
- Frame animation for civilians and small enemies.
- Instanced quads for sprites, bullets, debris, vegetation, and particles.
- Signed-distance-field text and iconography.
- Normal maps optional for major sprites; use only if readability improves.
- Palette grading per biome plus accessibility-safe threat colors.
### Effects
- Rotor wash bends vegetation, kicks dust/snow, and disturbs water.
- Heat haze near fires and exhaust uses a low-resolution distortion buffer.
- Explosions use layered sprite animation, point light, smoke, and debris.
- Destruction silhouettes remain readable; particles may never conceal landing hazards for more than 0.4 seconds.
- Dynamic dusk uses color grading and light maps, not expensive full-scene physically based rendering.
## Audio
- Rotor audio is procedural layers driven by collective input, RPM, load, and damage.
- Spatial cues identify jets, locks, incoming rockets, civilian calls, and boarding.
- Combat mix ducks under missile and civilian-critical warnings.
- Music adds layers based on escalation, then recedes during boarding to foreground civilian audio.
- Accessibility options include visual sound indicators, mono audio, and independent music/effects/dialogue sliders.
## Technical Architecture
## Stack
- TypeScript with `strict: true`.
- Vite for development and production bundling.
- Native WebGPU and WGSL; avoid a general 3D engine unless later prototyping proves the custom renderer uneconomical.
- Vitest for unit tests.
- Playwright for browser integration and input smoke tests.
- ESLint and Prettier.
- Zod or JSON Schema validator for content.
- Howler.js or Web Audio wrappers only if they reduce complexity; direct Web Audio is acceptable.

WebGPU is a low-level API that renders through an HTML canvas using devices, pipelines, buffers, textures, bind groups, vertex shaders, and fragment shaders. It requires a secure context and is not universally available across all browsers, so the application must feature-detect `navigator.gpu` and show a useful unsupported-browser page. Do not assume all optional GPU features exist even when WebGPU is present.[^17][^18][^19][^20][^21]
## Runtime modules
```text
src/
  app/
    bootstrap.ts
    gameApp.ts
    routes.ts
  core/
    clock.ts
    events.ts
    rng.ts
    math.ts
    pools.ts
  input/
    actions.ts
    keyboardMouse.ts
    gamepad.ts
    rebinding.ts
  sim/
    world.ts
    components.ts
    systems/
      flight.ts
      weapons.ts
      projectiles.ts
      damage.ts
      civilians.ts
      enemies.ts
      director.ts
      objectives.ts
      collision.ts
      landing.ts
  render/
    webgpu/
      context.ts
      deviceRecovery.ts
      pipelines.ts
      spriteBatch.ts
      particles.ts
      lighting.ts
      post.ts
      shaders/*.wgsl
    camera.ts
    renderWorld.ts
  content/
    schemas/
    loaders/
    missions/
    balance/
  audio/
  ui/
  save/
  debug/
  tests/
public/
  assets/
```
## Simulation design
- Fixed timestep: 1/120 second.
- Variable rendering with interpolation between previous/current simulation states.
- Deterministic seeded RNG; never use `Math.random()` in simulation.
- Structure-of-arrays components for high-volume projectiles/particles; object-style components acceptable for low-volume complex actors.
- Broad phase: uniform spatial hash with 16-meter cells.
- Narrow phase: circles, capsules, and oriented boxes.
- Object pools for projectiles, particles, and temporary audio emitters.
- Event queue separates simulation outcomes from rendering/audio effects.
### Determinism
Record mission ID, content version, seed, fixed-step inputs, and settings affecting simulation. A replay must reproduce actor outcomes within the same build. Add a periodic state hash every 120 ticks to identify divergence.
## WebGPU renderer
### Initialization
1. Verify secure context and `navigator.gpu`.
2. Request adapter with power preference `high-performance`, then retry without preference.
3. Request only required core features.
4. Create device and register `device.lost` handler.
5. Configure canvas using preferred format.
6. Build pipelines asynchronously and cache them.
7. Load textures, create atlases/texture arrays, and create samplers.
8. Start simulation only after minimal mission assets are resident.

Google’s WebGPU guidance recommends explicit feature detection, adapter/device acquisition, canvas configuration, render pipelines, bind groups, and instancing for repeated geometry. WebGPU best-practice guidance also emphasizes buffer uploads, bind-group organization, error handling, render bundles, and device-loss handling.[^22][^20]
### Render passes
1. Background/parallax pass.
2. World sprite pass using premultiplied alpha.
3. Lighting/emissive pass at half resolution.
4. Particle/additive pass.
5. Distortion pass at quarter resolution.
6. Composite/color-grade pass.
7. UI pass.
### Sprite batching
Use one static quad vertex/index buffer and an instance buffer containing transform, UV rectangle, color, layer, flags, and texture index. Sort by pipeline, texture page, blend mode, and depth bucket. Triple-buffer dynamic instance data to avoid CPU/GPU contention. Minimize CPU-to-GPU transfers because that communication is comparatively expensive.[^21]

```ts
interface SpriteInstance {
  position: [number, number];
  size: [number, number];
  rotation: number;
  uv: [number, number, number, number];
  color: number;
  textureLayer: number;
  depth: number;
  flags: number;
}
```
### WebGPU resilience
- Wrap shader compilation and pipeline creation in error scopes.
- Validate shader compilation info and show a development overlay.
- Handle resize and device-pixel-ratio changes without reallocating every frame.
- On device loss, pause simulation, recreate resources once, restore CPU-backed assets, and resume.
- On unrecoverable failure, preserve settings and present restart instructions.
- Cap device pixel ratio at 2 by default.
## Save and Settings
Use versioned IndexedDB for campaign progress, settings, mission results, and optional replays. Settings writes must be debounced and mirrored to localStorage only for bootstrap-critical values such as language and volume.

```ts
interface SaveGameV1 {
  schemaVersion: 1;
  completedMissions: Record<string, MissionResult>;
  unlockedAircraft: string[];
  settings: Settings;
}
```

No account is required for MVP.
## Accessibility
- Full input remapping.
- Axis inversion and dead-zone controls.
- Hold/toggle options for boost and firing.
- Reduced motion, camera shake, flashes, and chromatic effects.
- Colorblind-safe palettes and redundant threat shapes.
- Subtitles and visualized directional audio.
- Adjustable game speed at 75%, 90%, and 100% in single-player, without affecting grade on the first two difficulty settings.
- Civilian-friendly mode that prevents direct player bullets from killing civilians but retains blast knockdown and scoring penalties.
- Difficulty presets independently expose flight assist, enemy aim, civilian resilience, and checkpoint behavior.
## Difficulty
| Setting | Flight assist | Friendly fire | Checkpoints | Enemy pressure |
|---|---|---|---|---|
| Story | Strong auto-hover and landing assist | Nonlethal direct fire | Each unload | Low |
| Standard | Mild hover damping | Reduced civilian damage | Mid-mission optional | Baseline |
| Veteran | None beyond input curves | Full | None | High |
| Classic | Original-style orientation preset, 3 aircraft, finite civilians | Full | None | Sortie escalation emphasis |

Classic mode is inspired by documented rules but is not a binary recreation.
## Testing Strategy
### Unit tests
- Flight integration and speed limits.
- Safe/hard/crash landing thresholds.
- Boarding capacity and cancellation.
- Civilian state transitions.
- Damage and splash falloff.
- Heat, cooling, rocket, and flare logic.
- Director tier transitions.
- Scoring and grade calculation.
- Deterministic RNG and replay hash.
- Content schema migration.
### Integration tests
- Launch, rescue, unload, and complete mission with synthetic inputs.
- Device resize and DPR changes.
- Gamepad connect/disconnect during mission.
- Pause/resume without simulation drift.
- WebGPU device-loss recreation using test hooks.
- Save migration and corrupted-save recovery.
- Asset load failure and placeholder substitution.
### Gameplay acceptance tests
- Helicopter can move opposite facing.
- Player can yaw left/front/right without changing velocity.
- Weapons cannot fire while landed unless an aircraft-specific later upgrade allows it.
- Civilians refuse boarding when capacity is full and visibly wave off.
- Unsafe landing can injure civilians and passengers.
- First unload advances director tier and schedules a warned jet pass.
- Drone can follow player across the base barrier.
- Mission can be completed without killing every enemy.
- Baseline aircraft can earn A rank without upgrades.
- No lethal attack reaches player from off-screen without at least 700 ms warning.
### Performance tests
- 2,000 particles, 200 projectiles, 80 actors, 32 civilians, and full parallax at 60 FPS baseline.
- One-hour soak test without growing GPU buffers or JavaScript heap.
- Automated frame capture at 720p, 1080p, 1440p, and DPR 2.
- Pipeline cache warm and cold start measurements.
## Milestones
### Milestone 0 — Foundation
**Duration:** 3–5 working days  
**Deliverable:** Bootable WebGPU app with CI.

- Create Vite/TypeScript project.
- Add lint, format, unit tests, Playwright, and build scripts.
- Implement WebGPU feature detection, adapter/device, canvas resize, clear pass, and device-loss handler.
- Implement fixed-step clock, deterministic RNG, input action map, and debug overlay.
- Acceptance: textured instanced sprites render at stable 60 FPS; unsupported browser receives clear message.
### Milestone 1 — Flight Sandbox
**Duration:** 5–7 days  
**Deliverable:** Playable helicopter in empty test range.

- Implement flight model, camera, landing contacts, rotor visual, basic audio, and keyboard/gamepad input.
- Add parameter hot reload from balance JSON.
- Add debug graphs for velocity, lift, frame time, and contacts.
- Acceptance: takeoff, hover, reverse, yaw, land, and crash all behave consistently at 60/120/144 Hz rendering.
### Milestone 2 — Combat Sandbox
**Duration:** 6–8 days  
**Deliverable:** Gun, rockets, flares, damage, infantry, tank, AA, jet, drone.

- Implement projectile pooling, collisions, threat telegraphs, suppression, and component damage.
- Add foreground targeting plane and target selection.
- Acceptance: each enemy has at least two viable responses; no off-screen unavoidable hit.
### Milestone 3 — Rescue Loop
**Duration:** 6–8 days  
**Deliverable:** Complete release-land-board-return-unload loop.

- Implement civilian state machine, nav lanes, capacity, injuries, rotor safety, unloading, and debrief counters.
- Add rescue-focused scoring.
- Acceptance: 24 civilians can produce all expected outcomes deterministically; kills do not award score.
### Milestone 4 — Vertical Slice Level
**Duration:** 8–12 days  
**Deliverable:** Operation Open Sky from launch to debrief.

- Build JSON level loader and editor-friendly validation errors.
- Implement director phases, three sites, weather, day/dusk, objectives, base services, and optional objective.
- Acceptance: blind internal tester completes mission in under 20 minutes after tutorial.
### Milestone 5 — Polish and Hardening
**Duration:** 7–10 days  
**Deliverable:** Public-demo-quality build.

- Art/audio pass, settings, accessibility, save, replay, telemetry opt-in, device-loss recovery, performance optimization.
- Conduct keyboard/gamepad and low-end hardware passes.
- Acceptance: all MVP criteria and performance budgets pass CI/manual checklist.
## Issue Breakdown for Claude Code
Create issues in this order; every issue must include tests and acceptance criteria.

1. Repository bootstrap and CI.
2. WebGPU context, canvas, clear pass, resize, error scopes, device loss.
3. WGSL sprite pipeline and instanced batcher.
4. Fixed-step deterministic simulation clock.
5. Input action abstraction and rebinding.
6. Flight component and flight system.
7. Landing contacts and crash classification.
8. Camera look-ahead and threat framing.
9. Collider shapes and spatial hash.
10. Projectile pool and door gun.
11. Rockets, lock-on, splash, and flares.
12. Health/component damage and feedback events.
13. Enemy base state machine and authored spawn sockets.
14. Infantry and suppression.
15. Tank and AA.
16. Jet attack-pass controller.
17. Homing drone.
18. Civilian state machine and nav lanes.
19. Boarding, capacity, injury, unload, and rescue accounting.
20. Director escalation tiers.
21. Objective and mission state system.
22. JSON schema and level loader.
23. Operation Open Sky content.
24. HUD, landing aid, tactical strip, threat indicators.
25. Scoring and debrief.
26. Audio mixer and procedural rotor layers.
27. Particles, lighting, distortion, and grading.
28. Settings, accessibility, save, and migration.
29. Replay capture and deterministic verifier.
30. Playwright smoke suite, soak harness, and production build.
## Coding Rules for the Implementer
- Implement one milestone at a time; do not scaffold the entire campaign before the vertical slice works.
- Keep simulation independent from rendering and DOM.
- Do not use `Math.random()` in simulation.
- Do not mutate entity collections while iterating; queue creation/destruction.
- Do not allocate per frame in hot simulation/render loops.
- Every tunable value belongs in typed balance data, not scattered constants.
- Every WGSL shader has a corresponding pipeline descriptor and validation test.
- Prefer small systems with explicit inputs/outputs over inheritance hierarchies.
- Add a debug command to spawn every actor and force every mission phase.
- Preserve CPU copies or reload descriptors for all GPU resources needed after device loss.
- Commit after each issue passes tests; include a short architecture note for non-obvious decisions.
## Definition of Done
The vertical slice is done when a player can open the HTTPS-hosted build in a supported desktop browser, use keyboard/mouse or gamepad, complete a tutorialized rescue mission, experience escalating tanks/jets/drones, protect and transport finite civilians across multiple trips, use modern weapons and countermeasures, receive a survival-weighted grade, change accessibility/control settings, retry quickly, and finish without console errors or frame-rate violations.

The experience must remain recognizably descended from the 1982 design because rescue is the point, flight has weight, facing matters, landing is dangerous, passengers are finite, and each successful trip intensifies opposition. It must nevertheless stand as an original game through new naming, audiovisual work, worldbuilding, mission layouts, code, and expanded systems.
## Claude Code Kickoff Prompt
Copy the following into Claude Code after placing this PRD at `docs/PRD.md`:

```text
You are the lead gameplay and graphics engineer for an original browser game described in docs/PRD.md.

Read the entire PRD before changing files. Then:
1. Create docs/IMPLEMENTATION_PLAN.md mapping Milestones 0–5 to small testable issues.
2. Create docs/DECISIONS.md and record architecture decisions, assumptions, and deviations.
3. Implement only Milestone 0 first.
4. Use TypeScript strict mode, Vite, native WebGPU/WGSL, Vitest, and Playwright.
5. Keep deterministic fixed-step simulation separate from rendering.
6. Do not use copyrighted Choplifter names, assets, source code, story text, or exact level layouts. The PRD describes mechanics for research and inspiration only.
7. Feature-detect WebGPU, require HTTPS outside localhost, handle device loss, and show a useful unsupported-browser UI.
8. Add tests with every feature. Run format, lint, typecheck, unit tests, browser smoke tests, and production build before marking any issue complete.
9. Do not invent silent behavior. If the PRD is ambiguous, record the decision in docs/DECISIONS.md and choose the smallest reversible implementation.
10. Stop after Milestone 0 passes and provide a concise status report: files changed, commands run, test results, risks, and proposed Milestone 1 tasks.

Prioritize a working, inspectable vertical slice over abstractions for hypothetical future features.
```
## Open Decisions
These defaults should be confirmed before production art and public branding:

- Final original title and fiction.
- Commercial versus noncommercial distribution.
- Whether a rights license will be sought for the *Choplifter* name.
- Baseline integrated GPU and lowest supported browser versions.
- Pixel-art, illustrated, or hybrid sprite style.
- Whether mobile/touch support belongs in version 1.
- Checkpoint policy for Standard difficulty.
- Campaign aircraft upgrade depth.

None of these blocks Milestones 0–3 because the architecture and vertical-slice mechanics remain the same.

---

## References

1. [Dan Gorlin](https://dadgum.com/halcyon/BOOK/GORLIN.HTM) - A great concept, more strategy than most action games, and a slick implementation made "Choplifter" ...

2. [Choplifter: From 1982 to 2012 - Game Developer](https://www.gamedeveloper.com/business/-i-choplifter-i-from-1982-to-2012) - In this extensive new interview, Dan Gorlin, the creator of the 1982 Apple II classic tells the stor...

3. [A full reverse engineer of Choplifter, the Apple II game ...](https://github.com/blondie7575/ChoplifterReverse) - This is a full reverse engineer of the Apple II game Choplifter, written by Dan Gorlin in 1982. It w...

4. [Choplifter](https://en.wikipedia.org/wiki/Choplifter) - Choplifter (stylized as Choplifter!) is a 1982 horizontally scrolling shooter video game developed b...

5. [Choplifter](https://www.filfre.net/2012/08/choplifter/) - Convinced that he “could make some money” with the game, Gorlin sent his prototype to Brøderbund, wh...

6. [Choplifter : r/c64](https://www.reddit.com/r/c64/comments/1sz8v1z/choplifter/) - The video showcases the gameplay of the classic arcade game, Choplifter, where the player controls a...

7. [choplifter! - Games Database](https://www.gamesdatabase.org/Media/SYSTEM/Apple_II//Manual/formated/Choplifter!_-_Br%C3%B8derbund_Software.pdf) - The game ends when you lose your third helicopter or all the hostages are dead or rescued. Controlli...

8. [Reversing Choplifter](https://blondihacks.com/reversing-choplifter/) - Choplifter doesn't have a lot of keyboard use (it requires a joystick for gameplay) but it allows yo...

9. [Game 168: Choplifter!](https://datadrivengamer.blogspot.com/2020/03/game-168-choplifter.html) - Choplifter controls beautifully too. What took me most by surprise is that this game makes full use ...

10. [Choplifter - C64-Wiki](https://www.c64-wiki.com/wiki/Choplifter)

11. [Choplifter HD Review - Gaming Pastime](https://gamingpastime.com/choplifter-hd-review/) - Choplifter HD is a fun arcade-style game with a ton of action. It's easy to pick up and play but can...

12. [Choplifter HD Review](https://gamecritics.com/daniel-weissenberger/choplifter-hd-review/) - Offering a total of 30 missions, Choplifter asks players to use three different upgradeable helicopt...

13. [Choplifter HD Review for PC](https://www.cheatcc.com/articles/choplifter-hd-review-for-pc-pc/) - How Do You Remake An Apple II Game? Choplifter HD is a remake of an old Apple II game by […]

14. [Choplifter HD Review](https://www.ign.com/articles/2012/01/11/choplifter-hd-review-2) - Verdict. Choplifter HD is an ace experience for bite-sized sessions and marathons alike. The goofy s...

15. [Choplifter HD Analysis on Niklas Notes](https://niklasnotes.com/dashboard/game/91973/choplifter_hd) - Overall, Choplifter HD is well-received for its nostalgic value, fun gameplay ... Some players find ...

16. [Thoughts: Choplifter HD.](https://scientificgamer.com/thoughts-choplifter-hd/) - The way the levels make use of the different enemy varieties is quite clever; if you fly low you mak...

17. [WebGPU API - MDN Web Docs - Mozilla](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API) - WebGPU is the successor to WebGL, providing better compatibility with modern GPUs, support for gener...

18. [GPU - Web APIs - MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/API/GPU) - The GPU interface of the WebGPU API is the starting point for using WebGPU. It can be used to return...

19. [GPUSupportedFeatures - Web APIs | MDN](https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedFeatures) - in some or all supporting browsers. not all features will be available to WebGPU in all browsers tha...

20. [Your first WebGPU app - Google Codelabs](https://codelabs.developers.google.com/your-first-webgpu-app) - This codelab introduces the fundamentals of the new WebGPU API. It guides you through building a ver...

21. [Introduction to Computer Graphics, Section 9.1 -- WebGPU ...](https://math.hws.edu/graphicsbook/c9/s1.html) - Like WebGL and OpenGL, WebGPU draws primitives (points, lines, and triangles) that are defined by ve...

22. [WebGPU Best Practices](https://toji.dev/webgpu-best-practices/) - WebGPU Render Bundle best practices - Covers usage of Render Bundles to reduce CPU overhead and how ...

