# Kikorin TODO

Punch list — resolved items are removed, not struck through; history lives
in git and the linked ADRs.

## Features:
- 8-way paper-doll (layered sprite) animations — **shipped and Rust-driven**
  across [`packages/paperdoll`](./paperdoll/README.md) + [`crates/animation`](./animation/README.md)
  + the engine (ADRs 0014–0020). Done: the resolver pipeline + bake cache +
  `THREE.Sprite` renderer in all three render modes; the Rust animation state
  machine (timing/fitting, transitions, interruptibility, branch frames, frame
  events, move mask, retrigger, validation/graceful-degradation); frame-synced
  bullet spawn; per-animation movement gating; death (dying state → despawn) +
  hurt; the **TS animation-event adapter** (`animEventsChannel` +
  `onAnimationEvent`); **per-type monster colors**. Remaining paper-doll work:
  1. Ship a *real* sprite set (art) under `apps/web/public/sprites/` + a JSON
     manifest, replacing the procedural placeholder generator.
  2. Per-item sheet fallback (a layer with no sheet for the active family is
     skipped, not chain-resolved) + a formal manifest schema/validation contract.
  3. Monster attack animations (nothing requests a monster attack yet) and a
     player hurt/death path (nothing damages the player in the samples yet).
  4. (Sample-game glue) deliver remote-peer loadouts over the wire for a
     networked sample; wire the 2D player's attack (it fires via `spawn_bullet`,
     bypassing `player_fire`).

- External consumer APIs (the "others import kikorin and wire in game logic" premise):
  - Monster target locations — **exists**: `set_monster_goal(id, gx, gz)` /
    `update_monster_goal` / `clear_monster_goal`. (Could grow: patrol paths,
    named targets, flee — only if a consumer needs it.)
  - Map data (objects/walls/topography) — **exists**: `load_map(blocks)` (+
    `spawn_floor_entity` / `set_terrain_walkable`). (Could grow: more block
    kinds, dynamic obstacles.)
  - Controls — **the real gap**: input bindings are hardcoded per game (each
    game's `onFrame` maps keys → `set_player_input`). Needs a reusable
    binding layer so a consumer declares its own key/button → action map.
- Monsters should have agro radiuses and leashes 
- Players should have health 
- Monsters should deal damage