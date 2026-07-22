# ADR 0022: Entity-ownership state handoff over awari

## Status
Accepted — implemented in `crates/engine` (`entity_snapshot`/`adopt_entity`) +
`apps/web` (`entityHandoff.ts`, wired into `useNetworking`). Consumes awari's
entity-ownership API (awari ADR 0020), vendored until it ships in a published
`@awari` release.

## Context
Awari (kikorin's networking layer) gained entity ownership + load-balanced
handoff (awari ADR 0020): it owns an entity's **routing authority** — which peer
its `{type:"entity"}` traffic addresses, and whose bandwidth budget its presence
counts against — and moves that between peers to spread work, via
`claimEntity` / `releaseEntity` / `rebalanceEntities` / `onEntityOwned` /
`onEntityReleased`. Awari deliberately never touches entity *state*; getting the
current state to the new owner is "the application's job" (awari ADR 0020,
§"What the application must do").

Kikorin is that application. Its ownership model lived entirely in the Rust
engine: whoever spawns an entity owns it *permanently* (`NET_LOCAL`, simulated +
broadcast); other peers hold display-only mirrors. Nothing could move an entity
between owners, and the awari session was used only as a transport + presence
byte-pipe. This ADR is the missing half: when awari moves routing authority
X → Y, transfer the entity's simulation state so Y continues it seamlessly.

## Decision

### Transfer pattern: push-before-release
Of awari ADR 0020's three suggested patterns (rely-on-replicated / pull-on-
promotion / push-before-release), we use **push-before-release**: the current
owner sends the full state first and only relinquishes ownership once the
recipient has it. Chosen for a lossless authoritative cutover — kikorin's wire
replication is lossy for a promote (velocity ships only for `NET_PREDICTABLE`,
health/anim aren't guaranteed at Y), so relying on already-replicated mirror
state would make Y reconstruct from a partial picture. A push is deterministic.

### Engine primitives (additive, not a refactor)
- `entity_snapshot(eid) → bytes`: serialize an owned entity's full transferable
  ECS state — position, velocity, rotation, health, collider, animation cell.
  Richer than the existing `EntityBlueprint` (which a fresh spawn uses), so it's
  a distinct `HandoffSnapshot` type rather than an overload of `spawn_entity`.
- `adopt_entity(bytes) → eid`: reconstruct that state as a new, locally-owned,
  fully-simulated entity, reusing `register_spawned` so it re-enters simulation,
  replication, monster AI, and the mesh lifecycle exactly like a spawn.
- Release on the old owner is the existing `destroy_entity` (it already
  broadcasts a `Despawned` and does full local cleanup).
- Monster AI *internal* state (route, frustration) is **not** carried — the new
  owner re-derives it from the navmesh, the same reconcile any owner does after
  a leader failover. Application state (loadout/capability) also isn't in the
  engine snapshot; it would ride the TS handoff message if a game needed it.

### Orchestration (`apps/web/src/app/entityHandoff.ts`)
A self-contained controller over two narrow injected interfaces (an awari
session slice + an engine slice — the `createChatController` discipline), so the
push-before-release state machine is unit-testable without a live network/worker.

- **Eligibility + tracking**: every locally-owned, handoff-eligible entity
  (`NET_REPLICATED`, not a bullet, not the local player) claims a stable
  `EntityId` (`"<peerId>:<eid>"`) on spawn and releases it on despawn, driven off
  the engine's lifecycle patches. The player is always self-owned; bullets are
  too short-lived to hand off.
- **Flow**: `offer` (owner → recipient, carrying the snapshot) → `ack`
  (recipient agrees) → owner `destroy_entity` + `releaseEntity` + `commit` →
  recipient `claimEntity` → `onEntityOwned` adopts the stashed snapshot. Control
  messages ride the same session tagged `kind: "kikorin-handoff"`, ignored by the
  binary `net_ingest` and chat, and use a `{type:"peer"}` route (reaching a
  non-adjacent peer via awari's leader-gateway relay).
- **Recipient claim retry**: awari's `claimEntity` is genesis-only (no-ops if the
  entity still exists), so a `commit` that overtakes the owner's release-delta
  (possible only for relay-connected peers) would make the claim no-op; the
  recipient retries a few times until the release lands. Directly-connected peers
  are ordered and succeed on the first attempt.

### Awari delivery: vendored tarballs
The entity API isn't in any published `@awari` release yet. Kikorin depends on
locally-built tarballs of the three `@awari/*` packages (`vendor/awari/*.tgz`,
rebuilt via `scripts/vendor-awari.mjs`) through `pnpm.overrides`. Tarballs, not a
`link:` to the sibling source dir, because Turbopack won't resolve a symlink that
points outside the app root — an extracted tarball is real files in the store.
Retire this once kikorin can depend on a published `@awari` carrying the API.

## Consequences
- **Lossless on the authoritative side**: the new owner gets the old owner's
  exact ECS state, so simulation continues without a value jump.
- **Third-party mirror blink (limitation)**: the netcode wire protocol keys
  entities by the *sender's* id space with no stable cross-peer id, so to peers
  other than the two involved, a handoff reads as the old owner's mirror
  despawning and the new owner's spawning — a brief visual reset (and any
  client-side interpolation restarts). Seamless third-party continuity would need
  threading the awari `EntityId` through `Spawn`/`Delta`; deferred as a separate,
  larger netcode change rather than folded in here.
- **Live P2P verification is environment-gated**: the two-peer
  `e2e/entity-handoff.spec.ts` needs a reachable PeerJS broker + WebRTC; it skips
  where those aren't available. The engine primitives (cargo) and the
  orchestration (`node --test`) are covered deterministically regardless.
- **No automatic rebalance trigger wired**: kikorin exposes the mechanism
  (`transferEntity(eid, toPeer)`); *deciding* when/whom to rebalance (awari's
  `rebalanceEntities`, or an app policy) is not yet driven. The mechanism is the
  deliverable; a policy can call it later.
- **Failure modes inherited from awari ADR 0020**: an owner that *crashes*
  mid-ownership orphans its entities (no reactive reclamation), and a rejected
  offer just leaves the entity put. Both are awari-side deferrals.
