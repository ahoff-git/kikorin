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

### Transport — game layer, main thread, public broker
`RTCPeerConnection` does not exist in Web Workers, so the transport lives on the **main thread in TypeScript** (`useNetworking`): PeerJS over its free public cloud broker (`0.peerjs.com`) — no self-hosted signaling server, no environment configuration. Your PeerJS id is your shareable address; "Connect to peer" dials it directly. The engine exposes a four-call bridge the transport drives:
- `net_peer_connected(peer)` / `net_peer_disconnected(peer)` on data-channel open/close,
- `net_ingest(peer, bytes)` for inbound payloads,
- `net_take_outbound()` drained by the worker each flush → `{peer: string | null, data}[]` (null = broadcast), sent by the main thread.

### Disconnect Model
Explicit: data-channel close/error events call `net_peer_disconnected` — mirrors despawn and `PeerLeft` reaches the UI next tick. Backstop: peers silent past `PEER_TIMEOUT_SECS` are dropped the same way (healthy peers `Ping` when otherwise quiet for `PING_INTERVAL_SECS`).

### Known Gaps
- Connections are pairwise: joining one peer does not mesh you with peers *they* know (fine for 2 players; 3+ requires each client to dial everyone).
- The public PeerJS broker is best-effort third-party infrastructure; a hosted PeerServer is the drop-in upgrade if it ever degrades.

### Dependencies
`ecs` (World reads/writes), `bincode`. Nothing else — no wasm, no transport.

### Verification
`cargo test -p netcode` — Spawn-then-Delta sequencing with public-flag masking, suppression of unchanged values, velocity shipped only for predictable entities, wire-event encode/decode roundtrip, `apply_fields` ignoring unknown component/field ids, full-snapshot scoping, and snapshot eviction (`forget`) for recycled IDs. The engine crate's loopback test wires two engines through the same `net_*` bridge the browser uses.
