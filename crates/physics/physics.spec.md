## crates/physics — Rapier3D Physics World

### Purpose
Wraps Rapier3D for rigid-body simulation of ECS entities. The ECS world is the source of truth: physics bodies are derived from ECS collider data, never the reverse. Owns no entity IDs and defines no component schemas.

### Per-tick Flow
`sync_from_world(&world)` → `step(dt_secs)` → `sync_to_world(&mut world)`.
- **sync_from_world:** reads `collider`, `position`, `is_floor`, `velocity` for all entities. Entities with no active `ColliderConfig` are removed from the physics world. Floor entities become fixed bodies; everything else dynamic with rotation locked.
- **sync_to_world:** writes `position` and `grounded` back for every non-fixed body and marks it `DirtyFlags::TRANSFORM` unconditionally each tick — even at rest, so resting dynamics emit TRANSFORM net patches at full tick rate (known over-dirtying tradeoff; a fix would compare translations before dirtying).

Out-of-tick queries (`floor_height_at`, `cast_ray`, `cast_collider`) need the query pipeline populated; `step` rebuilds it each tick, but callers using these before the first step (e.g. navmesh construction) must call `prepare_queries()` first.

### Velocity Split — game controls XZ, Rapier owns Y
`sync_from_world` writes ECS `velocity.x` / `velocity.z` to Rapier `linvel` every tick, but `velocity.y` only when non-zero. This is the one-frame jump-impulse pattern: game logic sets a large positive Y for exactly one frame then clears it; between jumps Rapier's gravity-accumulated Y linvel is preserved. Lets game logic drive horizontal movement while Rapier handles vertical physics.

### Grounded Detection
A short downward ray from the entity centre, max distance `half_height + GROUND_TOL (0.10)`; `grounded` is true iff it hits a floor entity. A straight-down ray can only reach top/bottom surfaces — vertical side faces of stairs and walls are parallel to it and never hit — so side contacts cannot produce a false positive.

### Zero Friction on Dynamic Colliders
Dynamic colliders use `friction(0.0)` **and** `friction_combine_rule(Multiply)`. Friction 0 alone is insufficient: Rapier's default `Average` rule leaves `(0.0 + 0.5)/2 = 0.25`. `Multiply` wins by higher discriminant, giving `0.0 × 0.5 = 0.0`, eliminating tangential friction on stair/wall contacts that would otherwise oppose the jump impulse.

### Dependencies
`ecs` (World, ColliderConfig, DirtyFlags), `rapier3d`, `parry3d`. This crate is the sole physics integration — no TS Rapier bindings remain.

### Verification
`cargo test -p physics` — 18 tests exercising real ECS + Rapier at 60 Hz: gravity fall/landing (monotonic descent gated on contact, since depenetration nudges y up post-impact) and mid-air grounded=false; wall side-contact never grounds; velocity split — XZ reapplied every sync (proven by pin-against-wall-then-resume, since with zero friction/damping free motion cannot distinguish one-shot from per-sync application), zero and sub-threshold (|vy| ≤ 0.01) Y preserving gravity accumulation, above-threshold Y overriding it, non-zero Y as a one-frame jump impulse; grounded-cache staleness (stale up to GROUNDED_STRIDE−1 ticks after the floor vanishes); `floor_height_at`, `cast_ray`, `cast_ray_with_normal`, `cast_collider` hit/miss and normals via `prepare_queries`; sensors neither block, contact, nor get dirtied; overlapping dynamics generate no contacts (collision-group filter); removal via inactive collider — queries miss, body freezes, `touching` stays stale until the next step; the dirtying contract (moving and resting dynamics dirty every tick, fixed never); and the `World::destroy_entity` Rapier-body leak, pinned as a known gap.
