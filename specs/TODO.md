# Kikorin TODO

Punch list — resolved items are removed, not struck through; history lives
in git and the linked ADRs.

## Features:
- 8-way paper-doll (layered sprite) animations — **v1 shipped** in
  [`packages/paperdoll`](./paperdoll/README.md), wired into the top-down game
  (see [ADR 0014](./decisions/0014-paperdoll-resolved-pose-contract.md)). Done:
  the resolver pipeline, manifest + sprite-set registry
  (`registerSpriteSet` with in-memory *or* `baseUrl` sheets), baked-strip cache,
  the flat-sprite renderer, and the player/monsters rendering as layered 8-way
  sprites. Remaining, in rough dependency order:
  1. Rust: add `action` / `action_variant` / `action_seq` to the semantic patch
     and emit transitions (ecs, engine, patch); mirror in adapter types. Unlocks
     Rust-authoritative attack/hurt/death animations (v1 derives idle/walk in
     TS). This is the "define the contract" follow-up.
  2. Wire the remaining render modes: billboard into the 3D game (code path
     exists, unused) and flat sprites into the 2D side-scroller.
  3. Ship a *real* sprite set (art) under `apps/web/public/sprites/` + a JSON
     manifest, replacing the procedural placeholder generator.
  4. Per-item sheet fallback (v1 skips a layer with no sheet for the active
     family instead of chain-resolving it) and a formal manifest schema/
     validation contract.
  5. (Sample-game glue, not core engine) deliver remote-peer loadouts over the
     wire if/when a networked sample needs them — see the spec's open question.

- There should be external Apis from this project to allow the user to specify target locations for monsters to move as part of game logic
- Similarly there should be external Apis for the user to be able to specify map data. Object and wall locations topography that sort of thing
- The user should also be able to specify controls like makes a character move or jump or shoot
