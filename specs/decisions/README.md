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

## Open Questions

- What ADR template/format should be adopted? Settled by 0001: `Status` / `Context` / `Decision` / `Consequences`, numbered sequentially — the same convention used by the `awari` project's own ADR log, which kikorin's `specs/` layout mirrors.
