## crates/ecs — ECS World & Scheduler

### Purpose
Column-based (SoA) entity-component storage and a fixed-order system scheduler for the Rust simulation layer. Provides entity lifecycle management, per-component dirty-flag tracking, and a lightweight scheduler that runs registered systems in order each tick.

### Boundaries
- **Owns:** entity creation/destruction, component read/write (position, velocity, rotation, health, net_flags, collider, grounded, is_floor), dirty-flag bookkeeping, and the `SystemScheduler` runner.
- **Must not:** import any game-specific logic, physics, rendering, or network crates. Compiles and tests independently.

### Inputs and Outputs
- **Inputs:** `World::new(capacity)`, then mutation calls: `create_entity`, `destroy_entity`, `set_position`, `set_health`, `mark_dirty(id, DirtyFlags::TRANSFORM)`, etc.
- **Outputs:** `entities()` iterator, `dirty_entities()` iterator, component reads (`position(id)`, `health(id)`, …), `clear_dirty()`.
- `SystemScheduler::run(&mut world, dt_secs)` drives registered `FnMut(&mut World, f32)` closures in registration order.

### Invariants
- Entity IDs are recycled via a free-list. A destroyed ID will be reused by the next `create_entity` call.
- `dirty_list` tracks only entities that have had at least one flag set since the last `clear_dirty`. `clear_dirty` must be called once per tick after patch generation.
- Growing the world is automatic (`grow_to`) when an ID exceeds current capacity; all component vectors are resized together.

### Dependencies
- `bitflags` crate only. No physics, net, or render dependencies.

### Verification
- `cargo test -p ecs` — three tests: `create_destroy_roundtrip`, `dirty_flag_lifecycle`, `ten_thousand_entities_under_one_ms` (< 1 ms for 10 000 entities with movement + dirty-scan systems).

### Change Notes
- Initial implementation. `DirtyFlags` covers TRANSFORM, COLLIDER, HEALTH, NET. `grounded` and `is_floor` components added for physics handoff.
