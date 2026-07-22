// Entity-ownership state handoff (ADR 0022) — kikorin's half of awari's
// entity-ownership feature (awari ADR 0020). Awari owns *routing authority* for
// an opaque `EntityId` (which peer its `{type:"entity"}` traffic addresses, and
// whose bandwidth budget its presence counts against) and moves it between peers
// to load-balance; it never touches the entity's *state*. This module is the
// state half awari leaves to the app: when routing authority moves X → Y, it
// transfers the entity's authoritative simulation state so Y continues it
// seamlessly.
//
// Pattern: **push-before-release** (awari ADR 0020 §"What the application must
// do", option 3) — the current owner pushes the full state first, and only
// releases ownership once the recipient has it. Lossless on the authoritative
// side, at the cost of a short 3-message negotiation.
//
// The handoff rides the same awari RoomSession as netcode and chat, its control
// messages tagged `kind: "kikorin-handoff"` so they're ignored by the engine's
// binary-payload `net_ingest` and by chat, exactly as chat's own tag is.
//
// This module owns only the orchestration + the local `EntityId ↔ engine eid`
// mapping. It depends on two narrow injected interfaces (the awari session slice
// and the engine slice) so it's testable in isolation, the same discipline
// `createChatController` follows.

import type { EntityId, PeerRef } from "@awari/protocol";

/** The slice of awari's RoomSession the handoff needs — kept narrow so it's trivial to fake. */
export type HandoffSession = {
  publish(route: { type: "peer"; peer: PeerRef } | { type: "room" }, payload: unknown): Promise<void>;
  onMessage(handler: (message: { sender: PeerRef; payload: unknown }) => void): () => void;
  claimEntity(entityId: EntityId, options?: { load?: number }): Promise<void>;
  releaseEntity(entityId: EntityId): Promise<void>;
  onEntityOwned(handler: (entityId: EntityId) => void): () => void;
  onEntityReleased(handler: (entityId: EntityId) => void): () => void;
};

/** The slice of the engine the handoff needs (WorkerEngineProxy satisfies it structurally). */
export type HandoffEngine = {
  entity_snapshot(eid: number): Promise<Uint8Array>;
  adopt_entity(snapshot: Uint8Array): Promise<number>;
  destroy_entity(eid: number): void;
};

/** Sentinel `adopt_entity` returns on malformed input (Rust `u32::MAX`). */
const ADOPT_FAILED = 0xffffffff;

/** Default per-entity bandwidth load, matching awari's `DEFAULT_ENTITY_LOAD`. */
const DEFAULT_LOAD = 1;

// Snapshots ride the awari session as a plain number[] rather than a
// Uint8Array: PeerJS's default serialization rewraps a sent TypedArray as a
// bare ArrayBuffer on arrival (the same quirk useNetworking's net_ingest works
// around), so a byte array survives the round-trip unambiguously.
type HandoffMessage =
  | { kind: "kikorin-handoff"; type: "offer"; entityId: EntityId; snapshot: number[]; load: number }
  | { kind: "kikorin-handoff"; type: "ack"; entityId: EntityId }
  | { kind: "kikorin-handoff"; type: "commit"; entityId: EntityId; load: number };

function isHandoffMessage(payload: unknown): payload is HandoffMessage {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { kind?: unknown }).kind === "kikorin-handoff"
  );
}

export type EntityHandoffOptions = {
  /** Default bandwidth load claimed per entity (awari `EntityRecord.load`). */
  defaultLoad?: number;
  /** How many times the recipient retries its genesis claim while the owner's release-delta is still in flight (relay reorder). */
  claimRetries?: number;
  /** Delay between claim retries, ms. */
  claimRetryMs?: number;
  /** Surface non-fatal handoff errors (a failed snapshot/adopt/claim) — defaults to a no-op. */
  onError?: (context: string, error: unknown) => void;
};

export type EntityHandoffController = {
  /**
   * Register a just-spawned, locally-owned, handoff-eligible entity: assign it a
   * stable cross-peer `EntityId` and claim routing authority in awari. Idempotent
   * per eid.
   */
  trackLocal(eid: number, load?: number): void;
  /**
   * A tracked local entity was destroyed for a reason other than a handoff
   * (death, leaving) — relinquish its awari ownership. Idempotent.
   */
  untrackLocal(eid: number): void;
  /**
   * Push-before-release transfer of a tracked local entity to `toPeer`: snapshot
   * → offer → (recipient) ack → (owner) release + commit → (recipient) claim →
   * adopt. Resolves once the offer is sent; the rest completes over the wire.
   */
  transfer(eid: number, toPeer: PeerRef): Promise<void>;
  /** The `EntityId` a tracked local `eid` maps to, or undefined. */
  entityIdOf(eid: number): EntityId | undefined;
  /** Engine eids this peer currently owns and tracks. */
  ownedEids(): number[];
  dispose(): void;
};

/**
 * Wire one awari session + engine into an entity-ownership state handoff.
 * `selfPeerId` seeds the stable EntityId namespace (`"<peer>:<eid>"`), unique
 * across peers and stable across a handoff — the awari record moves, but the
 * per-peer engine eid does not.
 */
export function createEntityHandoff(
  session: HandoffSession,
  engine: HandoffEngine,
  selfPeerId: string,
  options: EntityHandoffOptions = {},
): EntityHandoffController {
  const defaultLoad = options.defaultLoad ?? DEFAULT_LOAD;
  const claimRetries = options.claimRetries ?? 5;
  const claimRetryMs = options.claimRetryMs ?? 120;
  const onError = options.onError ?? (() => {});

  // Local, per-peer maps for entities THIS peer currently owns.
  const entityIdByEid = new Map<number, EntityId>();
  const eidByEntityId = new Map<EntityId, number>();
  // Snapshots pushed to us, awaiting our claim → adopt (recipient side).
  const pendingAdopt = new Map<EntityId, Uint8Array>();

  function entityIdFor(eid: number): EntityId {
    return `${selfPeerId}:${eid}`;
  }

  function forget(entityId: EntityId): void {
    const eid = eidByEntityId.get(entityId);
    if (eid !== undefined) entityIdByEid.delete(eid);
    eidByEntityId.delete(entityId);
  }

  function trackLocal(eid: number, load: number = defaultLoad): void {
    if (entityIdByEid.has(eid)) return;
    const entityId = entityIdFor(eid);
    entityIdByEid.set(eid, entityId);
    eidByEntityId.set(entityId, eid);
    // claimEntity fires onEntityOwned(entityId) synchronously; the handler below
    // finds no pending snapshot (we just spawned it locally) and no-ops.
    void session.claimEntity(entityId, { load }).catch((e) => onError("claimEntity", e));
  }

  function untrackLocal(eid: number): void {
    const entityId = entityIdByEid.get(eid);
    if (entityId === undefined) return;
    forget(entityId);
    void session.releaseEntity(entityId).catch((e) => onError("releaseEntity", e));
  }

  async function transfer(eid: number, toPeer: PeerRef): Promise<void> {
    const entityId = entityIdByEid.get(eid);
    if (entityId === undefined) return; // not a tracked local entity we own
    let snapshot: Uint8Array;
    try {
      snapshot = await engine.entity_snapshot(eid);
    } catch (e) {
      onError("entity_snapshot", e);
      return;
    }
    if (snapshot.length === 0) return; // entity already gone
    const message: HandoffMessage = {
      kind: "kikorin-handoff",
      type: "offer",
      entityId,
      snapshot: Array.from(snapshot),
      load: defaultLoad,
    };
    await session.publish({ type: "peer", peer: toPeer }, message).catch((e) => onError("publish offer", e));
  }

  // Recipient: retry the genesis claim while the owner's release-delta is still
  // in flight. claimEntity no-ops if the entity still exists (owner not yet
  // released), so onEntityOwned wouldn't fire; retry until it lands or we give
  // up. Directly-connected peers (the common case) are ordered and succeed on
  // the first attempt — this only matters for a relayed, reordered handoff.
  function claimWithRetry(entityId: EntityId, load: number, attempt = 0): void {
    if (!pendingAdopt.has(entityId)) return; // already adopted (claim succeeded)
    void session.claimEntity(entityId, { load }).catch((e) => onError("claimEntity(recipient)", e));
    // claimEntity fires onEntityOwned synchronously when it takes (awari applies
    // the delta in-call), which clears pendingAdopt — so a success needs no retry
    // timer at all. Only schedule one when the claim no-op'd (owner's release-
    // delta not yet applied here — a relayed, reordered handoff).
    if (!pendingAdopt.has(entityId)) return;
    if (attempt >= claimRetries) {
      onError("claim timed out", entityId);
      return;
    }
    setTimeout(() => claimWithRetry(entityId, load, attempt + 1), claimRetryMs);
  }

  const unsubMessage = session.onMessage(({ sender, payload }) => {
    if (!isHandoffMessage(payload)) return;
    if (payload.type === "offer") {
      // Recipient: stash the pushed state, then agree.
      pendingAdopt.set(payload.entityId, new Uint8Array(payload.snapshot));
      const ack: HandoffMessage = { kind: "kikorin-handoff", type: "ack", entityId: payload.entityId };
      void session.publish({ type: "peer", peer: sender }, ack).catch((e) => onError("publish ack", e));
      return;
    }
    if (payload.type === "ack") {
      // Owner: the recipient has the state. Stop simulating + broadcasting it,
      // relinquish awari ownership, then tell the recipient to claim. Forget the
      // mapping BEFORE releaseEntity so the resulting onEntityReleased no-ops.
      const eid = eidByEntityId.get(payload.entityId);
      if (eid === undefined) return;
      const load = defaultLoad;
      forget(payload.entityId);
      engine.destroy_entity(eid);
      void session.releaseEntity(payload.entityId).catch((e) => onError("releaseEntity(handoff)", e));
      const commit: HandoffMessage = { kind: "kikorin-handoff", type: "commit", entityId: payload.entityId, load };
      void session.publish({ type: "peer", peer: sender }, commit).catch((e) => onError("publish commit", e));
      return;
    }
    // commit — recipient: owner released; claim to take routing authority. The
    // claim fires onEntityOwned, which adopts the stashed snapshot.
    claimWithRetry(payload.entityId, payload.load);
  });

  const unsubOwned = session.onEntityOwned((entityId) => {
    const snapshot = pendingAdopt.get(entityId);
    if (!snapshot) return; // our own claim for a locally-spawned entity — already mapped
    pendingAdopt.delete(entityId);
    void (async () => {
      let newEid: number;
      try {
        newEid = await engine.adopt_entity(snapshot);
      } catch (e) {
        onError("adopt_entity", e);
        return;
      }
      if (newEid === ADOPT_FAILED) {
        onError("adopt_entity failed", entityId);
        return;
      }
      entityIdByEid.set(newEid, entityId);
      eidByEntityId.set(entityId, newEid);
    })();
  });

  // Robustness for a handoff we didn't drive through our own push path (e.g. an
  // awari-initiated rebalance owner-change): if we still hold a local entity for
  // a released id, stop simulating it. No-op for our push path (already forgotten).
  const unsubReleased = session.onEntityReleased((entityId) => {
    const eid = eidByEntityId.get(entityId);
    if (eid === undefined) return;
    forget(entityId);
    engine.destroy_entity(eid);
  });

  return {
    trackLocal,
    untrackLocal,
    transfer,
    entityIdOf: (eid) => entityIdByEid.get(eid),
    ownedEids: () => [...entityIdByEid.keys()],
    dispose() {
      unsubMessage();
      unsubOwned();
      unsubReleased();
      entityIdByEid.clear();
      eidByEntityId.clear();
      pendingAdopt.clear();
    },
  };
}
