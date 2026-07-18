# crates/ecs — ECS World

### Purpose
Column-based (struct-of-arrays) entity/component storage: entity lifecycle, component reads/writes, and per-entity dirty tracking. It stores boundary schemas the other crates share (`net_flags`, `ColliderConfig`, `is_floor`, `grounded`, `AnimCell`) and defines the `NET_*` networking-profile flag constants (as the shared substrate both engine and netcode may depend on) — but contains no logic for them; the profile semantics are documented in the engine spec.

### Storage Model
Each component (position, velocity, rotation, health, net_flags, collider, grounded, anim, is_floor) is its own vector indexed by entity ID. `anim` holds an `AnimCell` (anim_id/frame/dir) — the engine's animation state machine writes it and patch generation reads it; ecs stores the numeric output only, not the state machine. Entity IDs are recycled through a free-list, so a destroyed ID is reused by the next `create_entity`. Capacity grows automatically (`grow_to`) when any setter or `mark_dirty` targets an ID beyond it, resizing all component vectors together; `World::new(capacity)` clamps up to `MIN_CAPACITY` (256).

Adding a component column is a three-site change (`new`, `grow_to`, `destroy_entity`) enforced by the `destroy_clears_every_component_column` and `grow_to_expands_all_columns` tests — a missed clear would leak stale data into recycled IDs.

### Inputs and Outputs
- **In:** `World::new(capacity)`, then mutations — `create_entity`, `destroy_entity`, component setters, `mark_dirty(id, DirtyFlags::…)`.
- **Out:** `entities()` / `dirty_entities()` iterators, component reads (`position(id)`, `health(id)`, …), `clear_dirty()`, `tick_count()` / `advance_tick()` (the tick stamp the engine writes into each PatchBundle).

### Invariants
- `destroy_entity` is idempotent: an ID reaches the free-list exactly once (alive→dead transition). Double-destroy is a safe no-op and never aliases two entities to one slot.
- `destroy_entity` clears every component column **and** the entity's `dirty_list` entry, so a recycled ID re-marked in the same tick cannot appear twice.
- `dirty_list` holds only entities flagged since the last `clear_dirty`; the caller clears it once per tick after patch generation.

### Dependencies
`bitflags` only. `DirtyFlags` = TRANSFORM | HEALTH | NET | ANIM (ANIM = the resolved animation cell changed this tick).

### Verification
`cargo test -p ecs` — create/destroy roundtrip with ID recycling, destroy idempotence, all-columns cleared on destroy, all-columns grown past capacity, dirty-flag lifecycle, and a 10 000-entity movement-pass perf pin (< 5 ms, catches accidental O(n²)).
