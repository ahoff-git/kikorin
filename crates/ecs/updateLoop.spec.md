## crates/ecs — ECS World & Scheduler

### Purpose
Column-based (struct-of-arrays) entity/component storage plus a fixed-order system scheduler. Provides entity lifecycle, per-component dirty tracking, and the `SystemScheduler` that runs registered systems in order each tick. Game-agnostic — no physics, net, or render knowledge.

### Storage Model
Each component (position, velocity, rotation, health, net_flags, collider, grounded, is_floor) is its own vector indexed by entity ID. Entity IDs are recycled through a free-list, so a destroyed ID is reused by the next `create_entity`. Capacity grows automatically (`grow_to`) when an ID exceeds it, resizing all component vectors together.

### Inputs and Outputs
- **In:** `World::new(capacity)`, then mutations — `create_entity`, `destroy_entity`, `set_position`, `set_health`, `mark_dirty(id, DirtyFlags::…)`, etc.
- **Out:** `entities()` / `dirty_entities()` iterators, component reads (`position(id)`, `health(id)`, …), `clear_dirty()`.
- `SystemScheduler::run(&mut world, dt_secs)` drives registered `FnMut(&mut World, f32)` closures in registration order.

### Invariants
- `destroy_entity` is idempotent: an ID reaches the free-list exactly once (alive→dead transition). Double-destroy is a safe no-op and never aliases two entities to one slot.
- `dirty_list` holds only entities flagged since the last `clear_dirty`; the caller clears it once per tick after patch generation.

### Dependencies
`bitflags` only. `DirtyFlags` = TRANSFORM | COLLIDER | HEALTH | NET.

### Verification
`cargo test -p ecs` — `create_destroy_roundtrip`, `dirty_flag_lifecycle`, `ten_thousand_entities_under_one_ms` (< 1 ms for 10 000 entities with movement + dirty-scan systems).
