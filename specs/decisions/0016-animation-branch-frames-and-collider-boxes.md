# ADR 0016: Queue branch frames and collider-cube hit/hurtboxes

## Status
Accepted. Refines the animation model from [ADR 0015](./0015-animation-simulation-in-rust.md);
implemented in `crates/animation` alongside Phase 2 engine integration.

## Context
Two refinements surfaced while starting Phase 2:
1. A `Queue`-policy animation that defers a queued action until its very last
   frame feels laggy — the queued move should be able to take over partway
   through, at an animator-chosen point.
2. The per-frame hit/hurtboxes were modelled as a bespoke 2D rect. The engine
   already has a "cube" collider primitive (`ecs::ColliderConfig` — offset +
   half-extents, as used by `spawn_box_entity`); animation boxes should reuse it
   rather than invent a parallel shape.

## Decision
**Queue branch frames.** A `Family` gains `branch_frame: Option<usize>`. When an
action is queued during that family (only possible under `Interrupt::Queue`), the
transition to the queued action fires as soon as playback reaches the branch
frame, instead of waiting for the family to end. With `branch_frame: None` the
queued action still starts at the family's end (the prior behavior). This gives
animators a designated "split point" where an animation forks into whatever is
queued — responsive input without cutting the committed part of the move.

**Hit/hurtboxes are collider cubes.** `HitBox` becomes a 3D box matching the
existing collider convention: `offset: [f32; 3]` (center relative to the entity
origin) + `half_extents: [f32; 3]`, the same shape `ecs::ColliderConfig` and
`spawn_box_entity` use. This keeps one box primitive across physics and combat
and lets the Phase 3 melee system reuse the engine's existing box machinery
(overlap tests, queries) rather than a separate path. The box is carried as pure
geometry in `crates/animation`; the "cooler things" — damage, knockback, tags,
multi-box, effects — hang off the engine's consumption of it in Phase 3, not the
data model here.

## Consequences
- `Family.branch_frame` is honored in `AnimationInstance::advance`: a pending
  queued action starts on reaching the branch frame, else at end (queued action
  still wins over the family's own `next`).
- Hit/hurtbox geometry is directly comparable to entity colliders, so Phase 3
  combat can feed both into the same overlap logic.
- The box data is inert until Phase 3; storing it now only fixes the shape so it
  isn't reworked when combat lands.
