# ADR 0010: Monster type templates via a narrow per-monster capability override

## Status
Accepted

## Context
[0003](./0003-2d-monster-ai-reuses-3d-code-via-z-zero.md) deferred per-monster-type capability as "a bigger structural change to `tick_monster_ai`/`MonsterState`... now would benefit both 2D and 3D uniformly" — the prerequisite (2D monster AI running in Rust, with a real jump budget per [0008](./0008-monster-multi-jump-budget.md)) is done, so this picks that back up: "agile ones are fast and can jump, slow ones... can't jump... maybe one can fly."

`AiConfig` is one engine-global instance today — every monster in a given game shares the same walk speed, jump speed, can-jump, and jump budget. The obvious approach — let a monster override any `AiConfig` field — runs straight into a constraint [0006](./0006-navmesh-walls-block-lateral-movement.md) and [0008](./0008-monster-multi-jump-budget.md) already established: the navmesh (`build_navmesh` / `build_navmesh_2d`) is built *once*, assuming *one* canonical capability. Varying `jump_speed` or `max_jumps` per monster while sharing one mesh reopens exactly the bug those ADRs fixed — a monster with a weaker jump than the mesh assumed could get routed onto an edge only the *canonical* (stronger) capability could actually clear, stranding it mid-air.

## Decision
`MonsterCapability` (`crates/engine/src/lib.rs`) exposes only the fields that are safe to vary against a mesh built for one canonical capability:
- `walk_speed` — never changes which edges are reachable, only how fast a monster crosses them.
- `can_jump` — safe in the `false` direction only, but that's the only direction this exposes: `find_path`'s existing `can_jump` argument already routes around jump edges entirely, so a monster given `false` is never offered a path it can't walk.
- `can_fly` — sidesteps the question by skipping the navmesh/pathfinding system entirely.

`jump_speed` and `max_jumps` stay purely `AiConfig`-global, not exposed here at all. Every monster that jumps, in a given game, uses the same impulse and the same budget the mesh actually assumed.

`set_monster_capability(id, cfg)` / `clear_monster_capability(id)` mirror `set_monster_goal`/`clear_monster_goal`'s exact shape (per-entity override map, cleaned up in `destroy_entity` so a recycled id never inherits a stale one). `capability_for(mid)` resolves the override if present, else derives from the *current* `AiConfig` — read fresh every tick, so a later `set_ai_config` still reaches monsters with no override.

**Flying** (`can_fly: true`) bypasses `update_stuck_and_replan`/`follow_waypoints` entirely — no waypoints, no A* — and steers straight at the goal's real 3D position instead (grounded monsters only ever resolve X/Z). This needed no physics-layer changes: `crates/physics`'s own tests (`nonzero_ecs_velocity_y_is_a_one_frame_jump_impulse`, `zero_ecs_velocity_y_preserves_gravity_accumulation`) already establish that writing a fresh nonzero Y *every* tick is a sustained "set velocity.y to exactly this" command, not a one-shot jump — exactly continuous hover/climb control, for free.

Named archetypes are not an engine concept. `apps/web/src/app/monsterTemplates.ts` defines `agile`/`slow`/`flying` as plain data (a `walk_speed` multiplier relative to the *caller's own* baseline, not a fixed absolute number — 3D's default `AiConfig.walk_speed` is 2.5, `kikorin2d.ts` configures 6.0, so one hardcoded speed wouldn't read as "agile" in both) plus a weighted random picker. Both `kikorin.ts` and `kikorin2d.ts` assign a template — and a matching mesh color — to every monster as it spawns (in `kikorin.ts`'s case, via the same lifecycle "spawned" event that already drives mesh creation, so respawns get a fresh random pick too, same as `kikorin2d.ts`'s direct spawn loop).

**Scoped out of this pass**: "slow ones... wander" is read as flavor text for "slow + grounded, given how far it can walk," not a request for separate wander AI — goal selection (closest-player chase) is unchanged for every template. Top-down's flat, zero-gravity map gets no template variety — nothing jumps there already, and flying would be indistinguishable from normal movement on a map with no verticality.

## Consequences
- **A monster's actual capability can now differ from the population's for the first time**, without touching the navmesh at all — the narrow field list is what makes that safe.
- **A future monster archetype that genuinely needs a different `jump_speed`/`max_jumps` (a "super-jumper," say) can't be expressed this way.** Doing that safely would mean building a separate navmesh per distinct jump capability and having `find_path` select among them — a much bigger change, not attempted here. `MonsterCapability` would need a real redesign (or a second, capability-keyed navmesh set) if that's ever needed.
- Flying monsters ignore `apply_monster_separation`'s and the stuck-detection system's assumptions the same way they ignore pathfinding — neither was changed to account for flying, so a cluster of flying monsters may overlap visually. Not addressed here; flag if it becomes a real problem.
- `kikorin.ts`'s `makeLocalMesh` no longer handles `NET_MONSTER` at all (monsters are pulled into their own template-driven mesh-creation branch before reaching it) — a future local-entity type added to that function should keep in mind monsters are handled elsewhere now.
