import type { BootstrapClient } from "@awari/core";
import type { BootstrapRequest, BootstrapResponse, ContactHint, RoomId } from "@awari/protocol";

/**
 * Backs only `connect()`'s manual "paste a peer id" override, not the
 * primary shared-room join (that uses the real, shared bootstrap service —
 * see `httpBootstrapClient.ts`). This one models a direct dial, not
 * discovery: peer discovery here stays exactly what it was before awari —
 * share your id out of band, then paste theirs into "Connect to peer".
 * `seedContact` wires a manually-entered remote id in as that room's
 * leader-hint the instant `connect()` is pressed, so the next `resolve()`
 * for that room finds it without any network round-trip. Any other room
 * (never queried by anything using this client) would resolve with no
 * contacts, so `createAwari` would fall through to becoming that room's
 * genesis leader (see specs/decisions/0009-bootstrap-genesis.md in the
 * awari repo) — moot in practice, since `connect()` always seeds first.
 * `registerHint` is a deliberate no-op — there is no shared directory for a
 * leader-hint (genesis, or a promoted backup after failover) to persist
 * into, and nothing here ever calls `resolve()` for a room whose contact
 * wasn't already seeded directly.
 */
export interface ManualBootstrapClient extends BootstrapClient {
  seedContact(roomId: RoomId, remotePeerId: string): void;
}

export function createManualBootstrapClient(): ManualBootstrapClient {
  const seeded = new Map<RoomId, ContactHint>();

  return {
    seedContact(roomId, remotePeerId) {
      seeded.set(roomId, { role: "leader-hint", connectionData: remotePeerId });
    },
    async resolve(request: BootstrapRequest): Promise<BootstrapResponse> {
      const hint = seeded.get(request.roomId);
      if (hint) return { status: "ready", contacts: [hint] };
      if (request.createIfMissing) return { status: "created", contacts: [] };
      return { status: "not-found", contacts: [] };
    },
    async registerHint() {},
  };
}
