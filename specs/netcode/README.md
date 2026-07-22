# crates/netcode — Wire Protocol & Delta Tracker

### Purpose
The pure peer-sync protocol: defines the wire events, tracks dirty locally-owned entities against per-entity snapshots for **broadcast to all peers**, and applies inbound field updates. No transport lives here — the crate has no wasm dependencies and is fully native-testable. Transport is the game layer's job (see Transport below); sender identity always comes from the transport's connection identity — payloads carry no self-claimed identity.

### Wire Protocol
`Vec<WireEvent>` per payload, bincode-encoded, sent as raw binary over WebRTC data channels:
- `Spawn { entity, flags, fields }` — first description of a sender-owned entity (new to the tracker, or every entity in a late-join sync). `flags` is the entity's public net profile (`NET_PUBLIC_MASK`) so the receiver can style the mirror and know whether to extrapolate it.
- `Delta { entity, fields }` — changed fields for an already-announced entity.
- `Despawned { entity }` — sender destroyed the entity; receivers drop their mirror.
- `Ping` — keepalive when a sender is otherwise silent, so quiet ≠ dead.

Entity ids are in the **sender's id space**; the receiving engine maps them to local mirror entities. Component ids (`COMP_POSITION`, `COMP_ROTATION`, `COMP_VELOCITY`) are wire contract — never renumber; unknown ids are skipped on apply. Velocity ships only for `NET_PREDICTABLE` entities. Ownership/authority/urgency flags never cross the wire.

### Cadence vs Content
The **engine owns cadence** — which entities get marked dirty each tick (every tick by default, urgency/predictability strides, forced marks at discontinuities, and *always immediately* for entities the tracker hasn't announced yet — the Spawn is what tells peers they exist; `is_tracked` exposes that state). The **tracker owns content** — a marked entity ships only components that differ from its snapshot; one with no snapshot ships a `Spawn`. With **no peers connected the engine skips flushing entirely** so its outbound queue cannot grow while the transport is idle; the late-join full sync covers state for whoever arrives.

### Transport — game layer, main thread, awari room session
`RTCPeerConnection` does not exist in Web Workers, so the transport lives on the **main thread in TypeScript** (`useNetworking`), riding on `@awari/core`'s room/topology session instead of raw pairwise dialing. PeerJS is now reached only through `@awari/transport-peerjs` (its free public broker, `0.peerjs.com` — no self-hosted signaling server); the engine never sees PeerJS at all, only the four-call bridge below, driven by an awari `RoomSession`:
- `net_peer_connected(peer)` / `net_peer_disconnected(peer)` on the session's `onPeerJoined`/`onPeerLeft` (see "Room model" below),
- `net_ingest(peer, bytes)` on the session's `onMessage`, keyed by `message.sender.peerId`,
- `net_take_outbound()` drained by the worker each flush → `{peer: string | null, data}[]`, published by the main thread via `session.publish({type: "room"}, data)` regardless of the `peer` field — awari v0 floods every room-routed publish to all direct connections rather than addressing a single peer, so a full-sync originally aimed at one newly-joined peer reaches everyone. Harmless: `Spawn` events are idempotent for peers who already hold that state.

#### Room model
Every client joins one shared game room (`gameRoom.ts`'s `roomId`, overridable via `NEXT_PUBLIC_KIKORIN_ROOM_ID` for anyone forking this app) — not a room keyed by any one peer's own id. Every client gets an ordinary, broker-assigned PeerJS id (no well-known id to claim). Discovery goes through the real, shared awari bootstrap service (`httpBootstrapClient.ts`, proxied through this app's own `/api/bootstrap(/hints)` routes — the live service sends no CORS headers, so a browser can't call it cross-origin directly; the proxy forwards server-to-server, where that doesn't apply): `awari.join({roomId, sessionId})` resolves against it internally — whichever client's `resolve` call comes back `"created"` becomes the room's genesis leader and registers its own connectable id as that room's leader-hint; everyone after that gets `"ready"` with the leader-hint and connects directly. See ADR 0009. With 3+ players all reaching the same leader, awari's room-leader backbone relays broadcasts to everyone through it, resolving the old pairwise-only transport's main limitation (2 players worked; 3+ required every client to dial everyone).

`connect(remotePeerId)` remains as a manual override, joining a private ad hoc room keyed by the pasted id instead of the shared game room — useful for testing or a session deliberately kept separate. This is a direct dial, not discovery, so it keeps its own dedicated bootstrap client (`manualBootstrap.ts`) and `awari` instance rather than going through the real service.

### Entity-Ownership State Handoff (ADR 0022)
Awari (ADR 0020) can move an entity's **routing authority** between peers to
load-balance; kikorin owns transferring the entity's **simulation state** so the
new owner continues it seamlessly. The state handoff rides the same awari session
as netcode + chat (control messages tagged `kind: "kikorin-handoff"`, ignored by
`net_ingest`'s binary check like chat's tag), orchestrated in
`apps/web/src/app/entityHandoff.ts`.

- **Engine primitives** (WASM): `entity_snapshot(eid) → bytes` serializes an
  owned entity's full ECS state (position/velocity/rotation/health/collider/anim
  — richer than a `spawn_entity` blueprint, so the cutover is lossless);
  `adopt_entity(bytes) → eid` reconstructs it as a new locally-owned, simulated
  entity (via `register_spawned`, so it re-enters simulation, replication, and
  monster AI). Release is just `destroy_entity` on the old owner. Monster AI
  *internal* state (route/frustration) is not carried — the new owner re-derives
  it, like after a leader failover.
- **Flow — push-before-release**: owner X snapshots the entity and sends it to
  recipient Y (`offer`); Y stashes it and agrees (`ack`); X stops simulating
  (`destroy_entity`) + relinquishes awari ownership (`releaseEntity`) + tells Y
  (`commit`); Y claims (`claimEntity`), and the resulting `onEntityOwned` adopts
  the stashed snapshot. Each handoff-eligible local entity (`NET_REPLICATED`,
  not a bullet, not the local player) claims a stable `EntityId` (`"<peer>:<eid>"`)
  on spawn and releases it on despawn, driven off the lifecycle patches.
- **Recipient claim retry**: awari's `claimEntity` is genesis-only (no-ops if the
  entity still exists), so if X's release-delta is reordered behind the `commit`
  (only possible when the two peers are relay-connected, not direct), Y's claim
  no-ops; it retries a few times until the release lands. Directly-connected
  peers are ordered and never race.
- **Limitation — third-party mirror blink**: the wire `Spawn`/`Delta` carry no
  stable cross-peer id (entity ids are per-sender), so to *other* peers a handoff
  looks like the old owner's mirror despawning and the new owner's spawning — a
  brief visual reset. The handoff is lossless on the authoritative side (Y gets
  X's exact state); seamless third-party continuity would need threading the
  `EntityId` through the wire protocol, deferred.

### Disconnect Model
Explicit: awari's `onPeerLeft` (the room leader detecting a member's connection closing and broadcasting it, or this client's own leader connection dropping) calls `net_peer_disconnected` — mirrors despawn and `PeerLeft` reaches the UI next tick. Backstop: peers silent past `PEER_TIMEOUT_SECS` are dropped the same way (healthy peers `Ping` when otherwise quiet for `PING_INTERVAL_SECS`) — this covers a leader that's alive but silently partitioned, which awari v0's reactive-only failover (no phi-accrual yet) wouldn't otherwise catch.

### Known Gaps
- `connect()`'s manual id-sharing (private ad hoc rooms) still has no shared directory of its own — `ManualBootstrapClient.registerHint` is a deliberate no-op, since that path is a direct dial, not discovery. This is by design, not a gap to close.
- The public PeerJS broker is best-effort third-party infrastructure; a hosted PeerServer is the drop-in upgrade if it ever degrades.
- The real bootstrap service is itself third-party infrastructure this app doesn't control the uptime of; if it's unreachable, the shared game room can't be discovered at all (the proxy route's `fetch` simply fails). No fallback exists today.
- `@awari/core`'s failover (leadership handoff on room-leader loss) is reactive and room-scope only in v0 — no hub scope, no phi-accrual suspicion, backups ordered by join order rather than ranked.

### Dependencies
`ecs` (World reads/writes), `bincode`. Nothing else — no wasm, no transport.

### Verification
`cargo test -p netcode` — Spawn-then-Delta sequencing with public-flag masking, suppression of unchanged values, velocity shipped only for predictable entities, wire-event encode/decode roundtrip, `apply_fields` ignoring unknown component/field ids, full-snapshot scoping, and snapshot eviction (`forget`) for recycled IDs. The engine crate's loopback test wires two engines through the same `net_*` bridge the browser uses. For the entity-ownership state handoff (ADR 0022): `cargo test -p engine` covers `entity_snapshot` → `adopt_entity` round-tripping full state into a simulated, AI-enrolled entity; `apps/web`'s `node --test` suite (`entityHandoff.test.ts`) covers the push-before-release orchestration end-to-end against a fake awari session; and `e2e/entity-handoff.spec.ts` proves a live two-peer handoff where P2P is reachable (skips otherwise).
