## crates/netcode — Rust Peer Delta Tracker & Session

### Purpose
Delta-based entity state sync over WebRTC data channels. Tracks which entities are dirty per remote peer, encodes minimal bincode payloads, and applies inbound patches from remote peers to the ECS World.

### Boundaries
- **Owns:** `DeltaTracker` (dirty tracking, flush, inbound apply), `PeerSession` (broadcast abstraction), `NetPatch` type, field-level component constants (`COMP_POSITION`, `COMP_ROTATION`, `COMP_NET_FLAGS`), `encode_patches` / `apply_patch_to_world`.
- **Must not:** own WebRTC signaling or transport; those are delegated to `wasm-peers` or native stubs.

### Inputs and Outputs
- **Inputs:** `DeltaTracker::mark_dirty(id)` (called per locally-owned entity), `flush(&world, peer_id)` (builds outbound payloads), `apply_inbound(bytes, &mut world)` (applies remote patches).
- **Outputs:** `Vec<u8>` outbound payloads (passed to `PeerSession::broadcast`), `Vec<NetPatch>` from `apply_inbound` (surfaced in PatchBundle for adapter consumers).

### Invariants
- Only entities marked dirty since the last flush are included in outbound payloads. Flush clears the dirty set.
- Inbound patches that fail decoding are silently dropped; the world is not partially mutated.

### Dependencies
- `ecs` crate (World writes), `bincode`, `wasm-peers` (WASM target only), `serde`.

### Verification
- `cargo test -p netcode` — change-tracker, message-codec, mock-peer integration tests under `packages/netcode` test the TypeScript counterpart; Rust tests cover delta encoding/decoding.

### Change Notes
- Initial implementation. Exposes `DeltaTracker`, `PeerSession`, and `encode_patches` as the public surface consumed by `crates/engine`.
