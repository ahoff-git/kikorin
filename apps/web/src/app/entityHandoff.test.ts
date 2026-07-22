// Unit tests for the entity-ownership state handoff (ADR 0022), run with the
// built-in node:test runner over compiled output — the same dependency-free
// convention @awari/core uses. See apps/web's `test` script.
//
// Two controllers share a FakeNet that models just enough of awari: genesis-
// only ownership (claim no-ops if the entity exists), synchronous
// onEntityOwned/Released on the owning peer, and peer-routed delivery. That's
// the exact contract createEntityHandoff is written against, so the full
// push-before-release dance (offer → ack → release+commit → claim → adopt)
// exercises here without a live network or worker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createEntityHandoff, type HandoffEngine, type HandoffSession } from "./entityHandoff.js";
import type { EntityId, PeerRef } from "@awari/protocol";

type Msg = { sender: PeerRef; payload: unknown };

class FakeNet {
  /** entityId → owning peerId, the shared routing-authority record awari holds. */
  readonly owners = new Map<EntityId, string>();
  readonly sessions = new Map<string, FakeSession>();
  deliver(to: PeerRef, from: PeerRef, payload: unknown): void {
    this.sessions.get(to.peerId)?.receive(from, payload);
  }
}

class FakeSession implements HandoffSession {
  private msg: ((m: Msg) => void)[] = [];
  private owned: ((id: EntityId) => void)[] = [];
  private released: ((id: EntityId) => void)[] = [];
  constructor(readonly self: PeerRef, private readonly net: FakeNet) {
    net.sessions.set(self.peerId, this);
  }
  async publish(route: { type: "peer"; peer: PeerRef } | { type: "room" }, payload: unknown): Promise<void> {
    if (route.type === "peer") this.net.deliver(route.peer, this.self, payload);
  }
  receive(sender: PeerRef, payload: unknown): void {
    for (const h of [...this.msg]) h({ sender, payload });
  }
  onMessage(h: (m: Msg) => void): () => void {
    this.msg.push(h);
    return () => { this.msg = this.msg.filter((x) => x !== h); };
  }
  async claimEntity(entityId: EntityId, _options?: { load?: number }): Promise<void> {
    if (this.net.owners.has(entityId)) return; // genesis-only, like awari
    this.net.owners.set(entityId, this.self.peerId);
    for (const h of [...this.owned]) h(entityId);
  }
  async releaseEntity(entityId: EntityId): Promise<void> {
    if (this.net.owners.get(entityId) !== this.self.peerId) return;
    this.net.owners.delete(entityId);
    for (const h of [...this.released]) h(entityId);
  }
  onEntityOwned(h: (id: EntityId) => void): () => void {
    this.owned.push(h);
    return () => { this.owned = this.owned.filter((x) => x !== h); };
  }
  onEntityReleased(h: (id: EntityId) => void): () => void {
    this.released.push(h);
    return () => { this.released = this.released.filter((x) => x !== h); };
  }
}

class FakeEngine implements HandoffEngine {
  private next = 100;
  /** eid → the health byte we stash, to prove state crosses the handoff. */
  readonly entities = new Map<number, number>();
  spawn(health: number): number {
    const eid = this.next++;
    this.entities.set(eid, health);
    return eid;
  }
  async entity_snapshot(eid: number): Promise<Uint8Array> {
    const health = this.entities.get(eid);
    return health === undefined ? new Uint8Array() : new Uint8Array([health]);
  }
  async adopt_entity(snapshot: Uint8Array): Promise<number> {
    if (snapshot.length === 0) return 0xffffffff;
    const eid = this.next++;
    this.entities.set(eid, snapshot[0]!);
    return eid;
  }
  destroy_entity(eid: number): void {
    this.entities.delete(eid);
  }
}

const peerA: PeerRef = { peerId: "A", sessionId: "sa" };
const peerB: PeerRef = { peerId: "B", sessionId: "sb" };

/** Let queued microtasks (the async adopt in onEntityOwned) settle. */
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test("push-before-release moves ownership and state from owner to recipient", async () => {
  const net = new FakeNet();
  const sessionA = new FakeSession(peerA, net);
  const sessionB = new FakeSession(peerB, net);
  const engineA = new FakeEngine();
  const engineB = new FakeEngine();
  const handoffA = createEntityHandoff(sessionA, engineA, "A");
  const handoffB = createEntityHandoff(sessionB, engineB, "B");

  // A spawns and tracks a monster (health 77) → claims routing authority.
  const eidA = engineA.spawn(77);
  handoffA.trackLocal(eidA);
  const entityId = handoffA.entityIdOf(eidA)!;
  assert.equal(entityId, "A:100");
  assert.equal(net.owners.get(entityId), "A", "owner claims on track");
  assert.deepEqual(handoffA.ownedEids(), [eidA]);

  // A transfers it to B.
  await handoffA.transfer(eidA, peerB);
  await flush();

  // Ownership moved to B; A no longer owns or simulates it.
  assert.equal(net.owners.get(entityId), "B", "routing authority moved to B");
  assert.deepEqual(handoffA.ownedEids(), [], "A released the entity");
  assert.equal(engineA.entities.has(eidA), false, "A stopped simulating (destroyed its copy)");

  // B adopted it with the exact state, as a new local entity it now owns.
  const ownedB = handoffB.ownedEids();
  assert.equal(ownedB.length, 1, "B owns exactly the handed-off entity");
  assert.equal(handoffB.entityIdOf(ownedB[0]!), entityId, "same stable EntityId, new local eid");
  assert.equal(engineB.entities.get(ownedB[0]!), 77, "health (state) crossed the handoff losslessly");

  handoffA.dispose();
  handoffB.dispose();
});

test("trackLocal is idempotent and untrackLocal releases", async () => {
  const net = new FakeNet();
  const session = new FakeSession(peerA, net);
  const engine = new FakeEngine();
  const handoff = createEntityHandoff(session, engine, "A");

  const eid = engine.spawn(10);
  handoff.trackLocal(eid);
  handoff.trackLocal(eid); // no double-claim, no new EntityId
  assert.deepEqual(handoff.ownedEids(), [eid]);
  assert.equal(net.owners.size, 1);

  handoff.untrackLocal(eid);
  assert.deepEqual(handoff.ownedEids(), [], "untrack releases ownership");
  assert.equal(net.owners.size, 0);
  handoff.dispose();
});

test("a self-claim of a locally-spawned entity is not adopted as a handoff", async () => {
  const net = new FakeNet();
  const session = new FakeSession(peerA, net);
  const engine = new FakeEngine();
  const handoff = createEntityHandoff(session, engine, "A");

  const eid = engine.spawn(5);
  handoff.trackLocal(eid); // fires onEntityOwned for our own claim
  await flush();
  // No phantom adopted entity: engine still has exactly the one we spawned.
  assert.equal(engine.entities.size, 1);
  assert.deepEqual(handoff.ownedEids(), [eid]);
  handoff.dispose();
});
