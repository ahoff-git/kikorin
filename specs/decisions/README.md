# Decisions

## Purpose

Lightweight architecture decision record (ADR) log for kikorin.

## Responsibilities

- Record significant technical decisions and their rationale as they are made, so they don't get silently re-derived (or re-litigated) later.

## Non-Responsibilities

- Does not track day-to-day implementation notes.
- Does not replace inline code documentation or the per-component specs under `specs/`.

## Log

- [0001: Physics dimension is a construction-time Rapier2D/Rapier3D choice, not a shared generic backend](./0001-physics-dimension-construction-parameter.md)
- [0002: 2D pathfinding is a separate build path, not a dimension-branch of the 3D navmesh scan](./0002-2d-pathfinding-separate-build-path.md)
- [0003: 2D monster AI execution reuses 3D's code unmodified, relying on a Z=0 convention](./0003-2d-monster-ai-reuses-3d-code-via-z-zero.md)
- [0004: Chat "nearby"/group channels are broadcast + client-side filtered, not real awari-scoped routing](./0004-chat-channels-are-broadcast-and-client-filtered.md)
- [0005: Top-down "pacman style" game reuses the 3D pipeline with zero gravity, not a fourth Dimension](./0005-topdown-game-reuses-3d-pipeline-with-zero-gravity.md)
- [0006: 3D navmesh walls block lateral movement, not just standing on top](./0006-navmesh-walls-block-lateral-movement.md)
- [0007: Cross-peer bullet hits reuse existing replication, not a new wire message](./0007-cross-peer-bullet-monster-hits.md)
- [0008: Monsters get a real jump budget, executed with apex-timed re-triggering](./0008-monster-multi-jump-budget.md)
- [0009: Room discovery uses the real, shared awari bootstrap service, proxied same-origin](./0009-real-bootstrap-service.md)
- [0010: Monster type templates via a narrow per-monster capability override](./0010-monster-type-templates.md)
- [0011: Layered pathfinding — tiered planners, shared flow fields, baked key routes, and Tier-4 discovery](./0011-layered-pathfinding.md)
- [0012: Frontier-only discovery with a detour-ratio filter; flying reactive avoidance](./0012-discovery-pacing-and-flying-avoidance.md)
- [0013: Incorporeal (can_phase) — collision groups + phase edges](./0013-incorporeal-phase-capability.md)
- [0014: Paper-doll sprites via a renderer-agnostic resolved-pose contract](./0014-paperdoll-resolved-pose-contract.md)
- [0015: Animation is Rust-simulated; TypeScript is a thin renderer](./0015-animation-simulation-in-rust.md)
- [0016: Queue branch frames and collider-cube hit/hurtboxes](./0016-animation-branch-frames-and-collider-boxes.md)
- [0017: Frame-synced animation events (callbacks)](./0017-frame-synced-animation-events.md)

## Open Questions

- What ADR template/format should be adopted? Settled by 0001: `Status` / `Context` / `Decision` / `Consequences`, numbered sequentially — the same convention used by the `awari` project's own ADR log, which kikorin's `specs/` layout mirrors.
