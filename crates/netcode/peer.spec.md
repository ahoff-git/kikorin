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
Every client joins one shared game room (`GAME_ROOM_ID` in `apps/web/src/app/gameRoom.ts`, overridable via `NEXT_PUBLIC_KIKORIN_ROOM_ID` for anyone forking this app) — not a room keyed by any one peer's own id. Discovery has no separate directory service: `GAME_ROOM_ANCHOR_PEER_ID`, a well-known PeerJS id derived from `GAME_ROOM_ID`, is what every client tries to claim (`new Peer(anchorId)`) on start. Whichever client gets there first keeps that id and becomes the room's genesis leader; every client after that fails to claim it (PeerJS rejects a taken id) — that failure *is* the discovery signal — falls back to its own broker-assigned id, and dials the anchor id directly instead of needing a pasted id. With 3+ players all reaching the same anchor, awari's room-leader backbone relays broadcasts to everyone through it, resolving the old pairwise-only transport's main limitation (2 players worked; 3+ required every client to dial everyone).

`connect(remotePeerId)` remains as a manual override, joining a private ad hoc room keyed by the pasted id instead of the shared game room — useful for testing or a session deliberately kept separate.

### Disconnect Model
Explicit: awari's `onPeerLeft` (the room leader detecting a member's connection closing and broadcasting it, or this client's own leader connection dropping) calls `net_peer_disconnected` — mirrors despawn and `PeerLeft` reaches the UI next tick. Backstop: peers silent past `PEER_TIMEOUT_SECS` are dropped the same way (healthy peers `Ping` when otherwise quiet for `PING_INTERVAL_SECS`) — this covers a leader that's alive but silently partitioned, which awari v0's reactive-only failover (no phi-accrual yet) wouldn't otherwise catch.

### Known Gaps
- No bootstrap-service is deployed: the anchor-id trick (see Room model) covers *initial* discovery for the shared game room without one, and `connect()`'s manual id-sharing covers private ad hoc rooms, but there's still no shared directory (`ManualBootstrapClient.registerHint` is a no-op).
- **A brand-new client can't discover a room whose anchor already left.** If the anchor disconnects mid-session, awari's reactive failover promotes the next backup fine for peers already in the room (they're already connected to each other) — but the promoted leader's own id is a random broker-assigned one, not the anchor id, and nothing re-registers it anywhere. A new client starting up afterward just reclaims the now-free anchor id and becomes the genesis leader of a fresh, empty room instead of rejoining the existing one. Only a real bootstrap-service (or the anchor never leaving) closes this.
- The anchor id is a fixed, guessable string on a genuinely public, shared PeerJS broker (`0.peerjs.com`) — an unrelated app or another kikorin fork picking the exact same `GAME_ROOM_ID` would collide in that broker's id namespace. Pick a distinctive room id to avoid this.
- The public PeerJS broker is best-effort third-party infrastructure; a hosted PeerServer is the drop-in upgrade if it ever degrades.
- `@awari/core`'s failover (leadership handoff on room-leader loss) is reactive and room-scope only in v0 — no hub scope, no phi-accrual suspicion, backups ordered by join order rather than ranked.

### Dependencies
`ecs` (World reads/writes), `bincode`. Nothing else — no wasm, no transport.

### Verification
`cargo test -p netcode` — Spawn-then-Delta sequencing with public-flag masking, suppression of unchanged values, velocity shipped only for predictable entities, wire-event encode/decode roundtrip, `apply_fields` ignoring unknown component/field ids, full-snapshot scoping, and snapshot eviction (`forget`) for recycled IDs. The engine crate's loopback test wires two engines through the same `net_*` bridge the browser uses.
