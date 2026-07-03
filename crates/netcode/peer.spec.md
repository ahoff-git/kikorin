## crates/netcode — Peer Delta Tracker & Session

### Purpose
Delta-based entity state sync over WebRTC data channels. Tracks which entities are dirty per remote peer, encodes minimal bincode payloads, and applies inbound patches to the ECS world.

### Inputs and Outputs
- **In:** `DeltaTracker::mark_dirty(id)` (per locally-owned entity), `flush(&world, peer_id)` (build outbound payloads), `apply_inbound(bytes, &mut world)`.
- **Out:** `Vec<u8>` outbound payloads (handed to `PeerSession::broadcast`); `Vec<NetPatch>` from `apply_inbound`. This `NetPatch` is the wire-level type (peer, entity, event kind, field updates) and stays internal to netcode + engine — the engine maps it to the thinner boundary `NetPatch` owned by `crates/patch` before it rides in the PatchBundle.

### Invariants
- Only entities dirtied since the last flush appear in outbound payloads; flush clears the dirty set.
- Inbound patches that fail to decode are dropped whole — the world is never partially mutated.

### Boundaries
Owns `DeltaTracker`, `PeerSession`, `NetPatch`, field-level component constants, and `encode_patches` / `apply_patch_to_world`. Signaling and transport are delegated to `wasm-peers` (WASM) or native stubs.

### Dependencies
`ecs` (World writes), `bincode`, `serde`, `wasm-peers` (WASM target only).

### Verification
`cargo test -p netcode` — delta encode/decode roundtrips.
