## crates/physics — Rapier3D Physics World

### Purpose
Wraps Rapier3D to provide rigid-body simulation for ECS entities. Syncs entity positions and collider configs from the ECS World before each step, steps the simulation, then writes results (updated positions, grounded state) back to the ECS World.

### Boundaries
- **Owns:** `PhysicsWorld` struct, rigid-body and collider lifecycle, entity ↔ Rapier handle mappings, contact tracking (`touching`, `floor_contacts`), `floor_height_at`, `cast_collider`, `cast_ray`.
- **Must not:** own entity IDs or define component schemas. Physics bodies are always derived from ECS collider data — the ECS World is the source of truth.

### Inputs and Outputs
- **Inputs (per tick):** `sync_from_world(&world)` — reads `collider`, `position`, `is_floor`, and `velocity` for all entities; `step(dt_secs)` — advances Rapier simulation; `sync_to_world(&mut world)` — writes updated positions and `grounded` back.
- **Out-of-tick queries:** `prepare_queries()` — rebuilds the spatial query pipeline without stepping (required before `floor_height_at` / `cast_ray` / `cast_collider` when `step` has not yet run, e.g. navmesh construction after spawn).
- **Outputs:** Updated `world.position` and `world.grounded` for all dynamic entities; `DirtyFlags::TRANSFORM` marked on changed entities.

### Invariants
- Entities without an active `ColliderConfig` are removed from the physics world.
- Floor entities (`is_floor = true`) become fixed bodies; all others become dynamic with rotation locked.
- Dynamic (character) colliders are created with `friction = 0.0` **and** `friction_combine_rule = Multiply`. Setting friction to 0 alone is insufficient: Rapier's default combine rule is `Average`, so `(0.0 + 0.5) / 2 = 0.25` friction remains. With `Multiply`, Rapier picks the higher-discriminant rule (`Multiply=2 > Average=0`), giving `0.0 × 0.5 = 0.0`. This eliminates tangential friction on stair/wall contacts, which otherwise opposes the jump impulse in the vertical direction.
- `grounded` is true when a short downward ray from the entity's centre hits a floor entity within `half_height + GROUND_TOL` (0.10). The ray points straight down, so it can only intersect horizontally-facing (top/bottom) surfaces. The vertical side faces of stairs and walls are parallel to the ray direction and are never hit — side contacts cannot produce a false `grounded = true`.
- Rapier `query_pipeline` is rebuilt each step (implicit in `step` → `rebuild_touching`).
- `floor_height_at`, `cast_ray`, and `cast_collider` require the query pipeline to be populated. Call `prepare_queries()` before using these outside of the normal tick loop (e.g. navmesh construction).
- **Velocity split**: `sync_from_world` applies ECS `velocity[0]` (X) and `velocity[2]` (Z) to the Rapier `linvel` each tick; `velocity[1]` (Y) is applied only when non-zero (jump impulse — caller sets a large positive value for exactly one frame, then clears it). Between jump frames, Rapier's internal Y linvel (gravity-accumulated) is preserved. This allows game logic to control horizontal movement while Rapier handles vertical physics.

### Dependencies
- `ecs` crate (World, ColliderConfig, DirtyFlags), `rapier3d`, `parry3d` (for `ShapeCastOptions`).

### Verification
- `cargo test -p physics` — `sphere_resolves_floor_collision_within_3_ticks`: a dynamic entity above a floor collider reports `grounded = true` within 3 ticks at 60 Hz.

### Change Notes
- Initial implementation. TS Rapier bindings (`@dimforge/rapier3d`) have been removed from the TypeScript layer; this Rust crate is now the sole physics integration.
- Added `prepare_queries()` to support navmesh construction: callers that need floor height data before the first simulation tick can sync entities and call `prepare_queries()` to prime the query pipeline.
- Added ECS velocity → Rapier linvel sync in `sync_from_world`: horizontal (XZ) applied every tick; vertical (Y) applied only when ECS Y is non-zero (one-frame jump impulse pattern). Rapier owns Y otherwise (gravity).
- Grounded detection now uses contact normal direction (`floor_contacts`) rather than any contact. Only contacts where `|local_n1.y| > 0.5` (significantly vertical normal) count as feet contacts; both entities are recorded symmetrically so the result is correct regardless of Rapier's collider-ordering convention. Side/body contacts (horizontal normals) no longer incorrectly set the grounded flag.
- `remove_entity` promoted to `pub`: callers (e.g. `Engine::destroy_entity`) must call this whenever an ECS entity is destroyed so the Rapier body is removed immediately. Without this, orphaned bodies continue to simulate and generate phantom render patches for recycled entity IDs.
- Dynamic colliders now use `friction(0.0)` and `friction_combine_rule(Multiply)`. `friction(0.0)` alone left 0.25 effective friction (Rapier's default Average rule computes `(0 + 0.5)/2`). With Multiply, the effective rule becomes `0.0 × 0.5 = 0.0`, fully eliminating tangential friction on stair and wall contacts that would otherwise oppose the jump impulse.
- Grounded detection replaced with a downward ray cast from the entity centre (`half_height + 0.10` max distance). Previous contact-manifold normal checks (`|local_n1.y| > 0.5`) were unable to prevent side contacts from triggering `grounded = true` in some Rapier contact configurations. A straight-down ray is geometrically incapable of hitting vertical side faces — only top/bottom surfaces are reachable — removing the entire class of false-grounded bugs near stairs and walls. The `floor_contacts` map has been removed; `touching` remains for bullet/sensor contact queries.
