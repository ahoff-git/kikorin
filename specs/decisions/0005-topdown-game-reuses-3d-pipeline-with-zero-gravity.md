# ADR 0005: Top-down "pacman style" game reuses the 3D pipeline with zero gravity, not a fourth Dimension

## Status
Accepted

## Context
The user asked for a third sample game: top-down view, no gravity, same shooter gameplay (player + monsters + bullets) minus jumping. The obvious-looking options were either a genuinely new physics dimension (a "2.5D" or "top-down 3D" `Dimension` variant) or reusing an existing one.

Investigation found 3D's ground plane is already X/Z — exactly what a top-down game needs. `tick_monster_ai`, `apply_monster_separation`, and `closest_player_position` (see [0003](./0003-2d-monster-ai-reuses-3d-code-via-z-zero.md)) already operate on those two axes correctly for a full 3D world; nothing about them assumes gravity or jumping. `tick_player_controller`'s existing yaw + forward/strafe model gives free top-down movement: compute the desired world direction from WASD, convert to a yaw via `atan2`, send it as `yaw_override` with `forward: 1` — the player auto-faces its movement direction, using zero Rust changes. Never sending `jump_held: true` means no jumping, with no special-casing needed. A perfectly flat map means `build_navmesh` never generates a jump/step edge (`height_diff` always exactly `0`) — "no jumping" for monsters falls out of map flatness, not a new code path.

Two real gaps were found along the way, both required for correctness:
1. **Gravity was a hardcoded Rust constant** (`GRAVITY`), used directly at physics construction, two bullet-arc-integration sites, and `navmesh2d`'s reachability math. There was no per-instance override — a "zero gravity" game had no way to actually configure that.
2. **A perfectly vertical top-down camera is a degenerate case for `Object3D.lookAt`**: when view direction is parallel to `up` (both point along Y by default), the resulting orientation is undefined. `system-rendering` had no way to set `camera.up`.

A third, more subtle interaction surfaced during monster placement: `MonsterConfig`'s default `respawn_y` assumes gravity will pull a respawned monster down onto the floor. Under zero gravity nothing pulls it anywhere — a respawn at the default height would float in place forever. Spawn/respawn placement had to be explicitly tuned to the flat map's actual resting height, not left at 3D's defaults.

## Decision
No fourth `Dimension`. The top-down game is Rapier3D (`dimension` omitted → default) with two independent, orthogonal setup choices layered on top:
- **`gravity: Some(0.0)`**, a new second, optional `Engine::new` constructor parameter (default: the existing `GRAVITY` constant when omitted). Threaded to every consumer that reads "how strong is gravity" — physics construction, `tick_bullets`' local integration, `extrapolate_predictable_mirrors`' remote-mirror extrapolation, and `build_navmesh_2d`'s reachability math — via a `self.gravity` field, not the bare constant, so a zero-gravity instance is consistent everywhere.
- **A perfectly flat map** (`kikorinTopDownMap.ts`), authored the same way 3D's map is (`TerrainBlockInput[]`, walls marked `walkable: false`), with no new engine surface.
- **Render mode `"2d"`** (orthographic) applied to a `"3d"`-dimension engine instance — the combination `useEngine`'s `dimension`/`renderMode` parameters didn't previously allow, since the hook passed one value to both the Rust constructor and `setupRenderer`. `renderMode` became its own optional parameter, defaulting to `dimension` when omitted (zero behavior change for the existing two games).

The camera degeneracy was fixed by adding `setCameraUp(x, y, z)` to `system-rendering` (mirrors `setCameraPosition`'s shape), called once at setup with `(0, 0, -1)` before the first `lookCameraAt`.

The monster placement gap was fixed by explicit `set_monster_config` overrides (`spawn_y`/`respawn_y` at the flat floor's resting height, ring radii tuned to fit inside the maze's open center room) — no Rust change, since `MonsterConfig`'s fields already supported this; the defaults were just tuned for 3D's original open, gravity-fed arena.

## Consequences
- **Reinforces the ADR 0001–0003 precedent**: a new sample game does not automatically need new Rust subsystems. Two of three sample games now share one `Dimension` (3D) with different gravity/map/camera configuration, and the third (2D) shares the same engine crate with a different physics backend — the axis of variation is setup parameters and game data, not forked simulation code.
- **`dimension` and `gravity` are both construction-time-only, fixed for the engine's lifetime** — there is no runtime `set_gravity`, matching `dimension`'s existing immutability. A game that wants to change gravity mid-session would need a new `Engine` instance.
- **`renderMode` and physics `dimension` are now explicitly decoupled at the `useEngine` hook level**, not just inside `system-rendering` — the top-down game is the first consumer to actually exercise a mismatched pair (3D physics + 2D-style camera).
- Bullet ballistic integration and `navmesh2d` reachability math must be kept in sync with any future gravity-reading code — a new consumer that reads the bare `GRAVITY` constant instead of `self.gravity` would silently disagree with a zero-gravity instance.
