# ADR 0003: 2D monster AI execution reuses 3D's code unmodified, relying on a Z=0 convention

## Status
Accepted

## Context
Following up on [0002](./0002-2d-pathfinding-separate-build-path.md), the 2D game initially kept monster AI *execution* (movement, waypoint-following, goal targeting) in TypeScript, on the assumption that `tick_monster_ai`/`apply_monster_separation`/`closest_player_position` were 3D-specific — they read positions' X and Z components as "the ground plane." This was flagged as a deliberate but uncomfortable exception to the project's principle that Rust owns all game logic, and revisited on review.

Investigation found the assumption was wrong: those functions operate on real `[f32; 3]` positions and don't actually know or care that index 2 is conventionally "Z" — they just compute `dx`/`dz`, distance, and normalized direction from whatever's there. Every 2D entity's Z is already always `0` (2D physics passes it through untouched per [0001](./0001-physics-dimension-construction-parameter.md), and the 2D game never sets it to anything else), so `dz` between any two 2D entities is always `0 - 0 = 0` by construction: `dist = sqrt(dx² + 0)` degenerates to `|dx|`, and `(dx/dist, dz/dist)` degenerates to `(±1, 0)` — exactly correct 1-D ground-plane behavior, for free. The same holds for `apply_monster_separation`'s repulsion force and `tick_bullets`' monster hit-detection (both full 3-D Euclidean distance).

Two things don't degenerate safely:
1. `tick_player_controller`'s yaw/strafe movement model has no 2D equivalent at all (2D is left/right + jump only) and unconditionally drives from `p.input` whenever a player is registered.
2. `tick_monster_ai`'s rotation write (`atan2` → yaw → `set_rotation`) is real 3D yaw with no 2D meaning, and render patches apply rotation to any entity unconditionally (`packages/system-rendering`'s `setObjectTransformByEid`) — confirmed that an unguarded write would visibly, incorrectly spin 2D monster meshes.

## Decision
No new 2D-specific monster AI module. `tick_monster_ai`, `apply_monster_separation`, and `closest_player_position` run **exactly the same code** for both dimensions. Two small, explicit `dimension() == Dimension::TwoD` gates were added instead of a port:
- `tick_player_controller` returns immediately for a 2D engine, even with a player registered — so `register_player` can still be called for 2D (purely so `closest_player_position` can see the player) without the controller stomping TS-driven velocity every tick with default input.
- `tick_monster_ai`'s rotation write is skipped for 2D.

2D's setup (`apps/web/src/app/kikorin2d.ts`) now: registers its player, tags monsters `NET_MONSTER`, and calls `set_ai_config`/`set_monster_config({ respawn: false })`. The `respawn: false` requirement is real, not incidental — `respawn_monster()`'s ring placement writes a nonzero Z (`angle.sin() * radius`), which would silently break the Z=0 invariant everything above relies on.

Tagging 2D monsters `NET_MONSTER` also fixed a pre-existing multiplayer ambiguity for free: `closest_player_position` already excludes `NET_MONSTER`-flagged mirrors from being treated as a chaseable player, so a remote peer's monster is no longer confusable with their actual player.

## Consequences
- **The Z=0 invariant is real and load-bearing, not an implementation detail.** A future feature giving 2D entities nonzero Z (render layering, depth effects, anything) would silently corrupt monster AI distance/direction math — no panic, no error, just wrong behavior. Documented in `specs/engine/README.md`'s "Monster AI in 2D" section and in `tick_monster_ai`'s own doc comment.
- All TS-side monster AI code (`pathFollower2d.ts`, the manual per-frame movement loop, the manual bullet-vs-monster hit-detection loop) was deleted as redundant — Rust's existing, already-tested pipeline now runs for 2D unchanged.
- ~~Known gap, deliberately deferred: `MonsterState` has no multi-jump budget the way `PlayerState` does~~ — **done**, see [0008](./0008-monster-multi-jump-budget.md): `AiConfig::max_jumps` + apex-timed re-triggering.
- ~~Also deliberately deferred: per-monster-type capability (agile/slow/flying archetypes)~~ — **done**, see [0010](./0010-monster-type-templates.md): a narrow per-monster `MonsterCapability` override (`walk_speed`/`can_jump`/`can_fly`), applying uniformly to both dimensions as anticipated here.
