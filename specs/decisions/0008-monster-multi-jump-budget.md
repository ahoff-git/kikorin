# ADR 0008: Monsters get a real jump budget, executed with apex-timed re-triggering

## Status
Accepted

## Context
[0003](./0003-2d-monster-ai-reuses-3d-code-via-z-zero.md) deliberately deferred giving monsters a real jump budget: `MonsterState` could only fire one jump per waypoint trigger, so the 2D game's navmesh was built with `max_jumps: 1` even though the player can double-jump, and monsters would route around anything needing a second jump rather than get stuck attempting it. Reported later as a bug ("pathfinding for 2D w/ gravity doesn't actually make jumps up to the next level") — from a player's perspective, a monster that can never follow them onto a platform they reached by double-jumping reads as broken pathfinding, even though it was a deliberate, documented limitation.

Investigation found the *reachability* math (`navmesh2d::jump_reachable`) already correctly solves multi-jump gaps — it recurses assuming each subsequent jump is "re-triggered exactly at the previous jump's apex," the height-maximizing strategy, and was already tested for exactly this (`step_above_single_jump_apex_needs_a_second_jump`). The gap was entirely on the *execution* side: `follow_waypoints`' jump trigger required `grounded`, which by definition is false for the entire second jump of a real double-jump — there was no path by which a second jump could ever fire before landing.

Separately, the underlying physics mechanism needed no changes at all: `tick_monster_ai` already writes the monster's velocity directly every tick (`world.set_velocity`, not the latching `set_entity_velocity` wrapper players use), and `zero_ecs_velocity_y_preserves_gravity_accumulation`/`nonzero_ecs_velocity_y_is_a_one_frame_jump_impulse` (in `crates/physics`) already establish that a zero Y write leaves gravity's ongoing pull alone while a nonzero Y write is a fresh one-frame impulse — regardless of the monster's current (possibly falling) vertical velocity. A second `wants_jump` firing mid-arc was therefore already physically well-defined; nothing needed to change there.

## Decision
`AiConfig` gained `max_jumps: u32` (default `1`, preserving existing behavior for anyone not setting it) — the monster-side counterpart of `PlayerConfig::max_jumps`. `MonsterState` gained `jumps_used: u32`, reset to `0` whenever `follow_waypoints` observes `grounded`.

The jump trigger now distinguishes the first jump of a sequence from every jump after it:
- **First jump** (`jumps_used == 0`): unchanged — requires `grounded`, throttled by `jump_cooldown` as before.
- **Subsequent jumps**: require `!grounded && vy <= 0.0` — airborne, and past the previous jump's apex (vertical velocity has turned non-positive) — with no `jump_cooldown` gating (that cooldown's ~0.9s default would still be active well past a typical jump's apex time and must not block the deliberately-immediate re-trigger). Bounded by `jumps_used < ai.max_jumps` either way.

`kikorin2d.ts` raised `MONSTER_MAX_JUMPS` from `1` to `2` (matching the player's own budget) and now passes `max_jumps` to both `build_navmesh_2d` (reachability) and `set_ai_config` (execution) — the two must move together, same as `walk_speed`/`jump_speed` already had to.

## Consequences
- A monster can now actually traverse any gap the navmesh's `jump_reachable` proved solvable within its budget, not just single-jump gaps — closing the gap [0003](./0003-2d-monster-ai-reuses-3d-code-via-z-zero.md) left open.
- **Execution now matches the reachability model's exact assumption** (apex-timed re-triggering) rather than approximating it — a monster that jumps "too early" or "too late" relative to what the mesh assumed would risk undershooting a gap the mesh already proved reachable only under that specific strategy.
- `AiConfig::max_jumps` and whatever capability the navmesh was built for (`build_navmesh_2d`'s explicit argument, or `build_navmesh`'s implicit single-jump assumption for 3D) must be kept in sync by the caller — the engine doesn't cross-check them. A future feature that lets a *specific* monster archetype have a different jump budget than the mesh was built for would need to either build a separate mesh per archetype or accept that mismatch as a known limitation.
- This pattern generalizes: any future "player-only" mechanic that gets extended to monsters should look for the same shape — is the *reachability* math already dimension/capability-generic, with the real gap only in *execution*'s gating conditions?
