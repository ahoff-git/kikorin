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
  `onAnimationEvent`); **per-type monster colors**; **monster melee + player
  hurt/death/respawn** (ADR 0021). Remaining paper-doll work:
  1. Ship a *real* sprite set (art) under `apps/web/public/sprites/` + a JSON
     manifest, replacing the procedural placeholder generator.
  2. Per-item sheet fallback (a layer with no sheet for the active family is
     skipped, not chain-resolved) + a formal manifest schema/validation contract.
  3. Monsters melee with the *player's* attack family (shared strike frame); a
     dedicated monster-attack animation (variant) would read better than miming
     the gun-raise. Consume the authored hurtbox geometry for melee reach instead
     of the `melee_range` config radius.
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

- Combat (ADR 0021) — **shipped**: monster aggro radius + leash (return-home),
  monster melee (contact + attack-anim strike-frame damage), player health with
  a quick hurt flinch, and player death → in-place respawn at full health. All
  opt-in via `AiConfig` (`aggro_radius`/`leash_radius`/`melee_range`/
  `melee_damage`) + `PlayerConfig.max_health`; the 3D sample enables it and shows
  a health bar. Follow-ups worth considering (only if wanted):
  - Only the 3D sample wires combat + the health HUD; 2D's TS-driven player has
    no damage/death path.
  - Aggro is a plain radius (no line-of-sight, no de-aggro timer/regen).
  - Player death has no game-over/score hook — it just respawns.


Bugs: 
- Monsters owned by other players in the network do now show animations
