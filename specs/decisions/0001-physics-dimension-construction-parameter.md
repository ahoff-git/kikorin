# ADR 0001: Physics dimension is a construction-time Rapier2D/Rapier3D choice, not a shared generic backend

## Status
Accepted

## Context
kikorin needed to support both a top-down/third-person 3D game and a side-view 2D platformer from the same engine. The two need fundamentally different physics conventions (3D: X/Z ground plane + Y height; 2D: X horizontal + Y vertical, no meaningful Z) and different underlying crates (Rapier3D vs Rapier2D).

The question: should `crates/physics` expose one generic backend parameterized over dimension (shared code, generic over 2 vs 3 components), or two genuinely separate implementations behind a thin dispatcher?

## Decision
`crates/physics` exposes a `Dimension` enum (`TwoD`/`ThreeD`) chosen once at `PhysicsWorld::new(gravity, dimension)` and fixed for the engine's lifetime. Internally, `lib.rs` holds only the enum, a `Backend` enum wrapping either concrete world, and a `PhysicsWorld` struct whose every method is a one-line match dispatching to whichever backend is active. `two_d.rs` and `three_d.rs` are **fully independent implementations** — each has its own copy of every method, and even small shared-seeming constants (`GROUNDED_STRIDE`, `FLOOR_RAY_START_Y`, etc.) and helper functions (`cuboid_shape`, `is_fixed_collider`) are duplicated per file rather than hoisted into `lib.rs`.

This was a deliberate choice, not an oversight: Rapier2D and Rapier3D have genuinely different types (`point!`/`vector!` arity, 2-vs-3-component collider shapes), and a generic-over-dimension abstraction would need either a trait Rapier itself doesn't provide, or a macro stamping out near-identical code with token substitution — both add real indirection to save comparatively little duplicated code in a crate that's rarely touched once correct.

2D's `sync_to_world` deliberately passes Z through **untouched** (reads whatever the caller last set it to) rather than forcing it to zero — 2D physics simply never writes it. This is what later became the load-bearing convention in [0003](./0003-2d-monster-ai-reuses-3d-code-via-z-zero.md): every 2D entity's Z stays 0 because the 2D game never sets it to anything else, not because physics enforces it.

## Consequences
- Adding a third backend (or changing shared behavior) means touching two files, not one — accepted cost.
- `crates/engine`'s `Engine::new(dimension)` threads the same `Dimension` choice into `PhysicsWorld::new`, and exposes it via `dimension()` for any caller (Rust or JS) that needs to branch on it.
- This precedent was **not** repeated for pathfinding or monster AI — see [0002](./0002-2d-pathfinding-separate-build-path.md) and [0003](./0003-2d-monster-ai-reuses-3d-code-via-z-zero.md), which found different shapes fit those problems better. Physics needed two genuinely different implementations; navmesh construction needed one new implementation instead of a dimension-branch of the old one; monster AI *execution* needed no new implementation at all.
