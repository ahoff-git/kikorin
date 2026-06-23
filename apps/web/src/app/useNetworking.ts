"use client";

import { PeerNet, type ComponentSchema, type PeerJSPeer } from "@kikorin/netcode";
import type { CoreWorldBox } from "@kikorin/engine";
import { log, logLevels } from "@kikorin/util";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BoxGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
} from "three";

const GROUP_ID = "world";
const POSITION_COMPONENT_ID = 0;
const ROTATION_COMPONENT_ID = 1;
// Projectile flag lets remote peers distinguish bullets from people at spawn time.
const PROJECTILE_COMPONENT_ID = 2;

// Person-sized collider for remote NPCs/players so they participate in local collision.
const REMOTE_PERSON_COLLIDER = { halfWidth: 0.5, halfHeight: 0.5, halfDepth: 0.5 };

function createRemotePersonMesh() {
  const geo = new BoxGeometry(1, 1, 1);
  const body = new MeshBasicMaterial({ color: 0xff44aa });
  const mesh = new Mesh(geo, body);
  const edges = new EdgesGeometry(geo);
  const lineMat = new LineBasicMaterial({ color: 0x881155 });
  const lines = new LineSegments(edges, lineMat);
  lines.renderOrder = 1;
  lines.scale.setScalar(1.001);
  mesh.add(lines);
  return mesh;
}

function createRemoteProjectileMesh() {
  const geo = new SphereGeometry(0.12, 14, 10);
  const mesh = new Mesh(geo, new MeshBasicMaterial({ color: 0xf97316 }));
  mesh.scale.set(0.82, 0.82, 1.35);
  return mesh;
}

export interface UseNetworkingReturn {
  localPeerId: string | null;
  connectedPeers: string[];
  connect: (remotePeerId: string) => void;
  addOwnedEntity: (eid: number) => void;
  removeOwnedEntity: (eid: number) => void;
  signalEntityDestroyed: (eid: number) => void;
}

export function useNetworking(
  engine: CoreWorldBox | null,
  playerEid: number | null,
  ownedEids: readonly number[],
): UseNetworkingReturn {
  const [localPeerId, setLocalPeerId] = useState<string | null>(null);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const netRef = useRef<PeerNet | null>(null);
  // peerId → Map<remoteEid, localEid>
  const remoteEntitiesRef = useRef(new Map<string, Map<number, number>>());
  // Mutable set of entity IDs this peer owns. Initialized from ownedEids inside
  // the setup effect (where playerEid and ownedEids land in the same React batch),
  // then managed dynamically by addOwnedEntity / removeOwnedEntity for projectiles.
  const ownedEntitySetRef = useRef(new Set<number>());
  // Direct reference to the Projectile component array, set in the setup effect.
  // Needed by signalEntityDestroyed, which runs outside the effect closure.
  const projectileComponentRef = useRef<{ [index: number]: number } | null>(null);

  const addOwnedEntity = useCallback((eid: number) => {
    ownedEntitySetRef.current.add(eid);
  }, []);

  const removeOwnedEntity = useCallback((eid: number) => {
    ownedEntitySetRef.current.delete(eid);
  }, []);

  // Called by game code before destroying an owned bullet. Sets Projectile = 0,
  // flushes that final delta so peers know to despawn the mirror entity, then
  // removes the entity from the owned set. Must be called BEFORE destroyEntity.
  const signalEntityDestroyed = useCallback((eid: number) => {
    const arr = projectileComponentRef.current;
    if (arr) arr[eid] = 0;
    const net = netRef.current;
    if (net) {
      net.markEntitiesDirty([eid]);
      net.flushGroupDeltas(GROUP_ID, [eid]);
    }
    ownedEntitySetRef.current.delete(eid);
  }, []);

  useEffect(() => {
    if (!engine || playerEid === null) return;

    // playerEid and ownedEids are set together in the same React state batch
    // (via setupGame in HomePage), so this runs with the correct initial set.
    ownedEntitySetRef.current = new Set(ownedEids);

    // Capture as non-null locals for use inside closures
    const eng = engine;
    const world = eng.world;
    projectileComponentRef.current = world.components.Projectile as { [index: number]: number };
    let net: PeerNet | null = null;
    let cancelled = false;
    let unsubTick: (() => void) | undefined;

    const posSchema: ComponentSchema = {
      id: POSITION_COMPONENT_ID,
      name: "Position",
      fields: [
        { id: 0, name: "x", array: world.components.Position.x },
        { id: 1, name: "y", array: world.components.Position.y },
        { id: 2, name: "z", array: world.components.Position.z },
      ],
    };

    const rotSchema: ComponentSchema = {
      id: ROTATION_COMPONENT_ID,
      name: "Rotation",
      fields: [
        { id: 0, name: "yaw",   array: world.components.Rotation.yaw },
        { id: 1, name: "pitch", array: world.components.Rotation.pitch },
      ],
    };

    // Tracks the Projectile flag so remote peers can distinguish bullets from
    // people when spawning mirror entities. Included in full syncs and the
    // first delta batch for any projectile (its value only changes 0→1 once).
    const projectileSchema: ComponentSchema = {
      id: PROJECTILE_COMPONENT_ID,
      name: "Projectile",
      fields: [
        { id: 0, name: "flag", array: world.components.Projectile },
      ],
    };

    import("peerjs").then(({ Peer }) => {
      if (cancelled) return;

      const peer = new Peer();

      peer.on("open", (id: string) => {
        if (cancelled) {
          peer.destroy();
          return;
        }

        net = new PeerNet({ peerId: id });
        // PeerJS Peer satisfies our duck-typed PeerJSPeer interface at runtime
        net.attachPeer(peer as unknown as PeerJSPeer);
        net.registerComponent(posSchema);
        net.registerComponent(rotSchema);
        net.registerComponent(projectileSchema);
        net.createGroup({ id: GROUP_ID, tickRateMs: 50 });

        net.onGroupDelta(GROUP_ID, (deltas, _gid, fromPeer) => {
          const isNewPeer = !remoteEntitiesRef.current.has(fromPeer);
          const peerEntities = getOrCreatePeerMap(fromPeer);

          // When we first hear from a peer, send them our full state so they
          // can spawn mirrors for all our boxes immediately.
          if (isNewPeer && net) {
            net.sendFullSync(GROUP_ID, fromPeer, [...ownedEntitySetRef.current]);
          }

          // First pass: identify new projectiles (for spawning) and destroyed
          // entities (Projectile = 0 on a known entity = despawn signal).
          const projectileRemoteEids = new Set<number>();
          const destroyedRemoteEids = new Set<number>();
          for (const d of deltas) {
            if (d.componentId === PROJECTILE_COMPONENT_ID) {
              if (d.value === 1) {
                projectileRemoteEids.add(d.entityId);
              } else if (d.value === 0 && peerEntities.has(d.entityId)) {
                destroyedRemoteEids.add(d.entityId);
              }
            }
          }

          // Destroy mirror entities before processing any other updates in this batch.
          for (const remoteEid of destroyedRemoteEids) {
            const localEid = peerEntities.get(remoteEid);
            if (localEid !== undefined) {
              eng.destroyEntity(localEid);
              peerEntities.delete(remoteEid);
            }
          }

          const posUpd = new Map<
            number,
            Partial<{ x: number; y: number; z: number }>
          >();
          const rotUpd = new Map<
            number,
            Partial<{ yaw: number; pitch: number }>
          >();

          for (const d of deltas) {
            // Skip all deltas belonging to despawned or unknown-destroy entities.
            if (destroyedRemoteEids.has(d.entityId)) continue;
            if (d.componentId === PROJECTILE_COMPONENT_ID && d.value === 0) continue;
            const localEid = getOrSpawnRemote(
              fromPeer,
              d.entityId,
              peerEntities,
              projectileRemoteEids.has(d.entityId),
            );
            if (d.componentId === POSITION_COMPONENT_ID) {
              const p = posUpd.get(localEid) ?? {};
              if (d.fieldId === 0) p.x = d.value;
              if (d.fieldId === 1) p.y = d.value;
              if (d.fieldId === 2) p.z = d.value;
              posUpd.set(localEid, p);
            } else if (d.componentId === ROTATION_COMPONENT_ID) {
              const r = rotUpd.get(localEid) ?? {};
              if (d.fieldId === 0) r.yaw = d.value;
              if (d.fieldId === 1) r.pitch = d.value;
              rotUpd.set(localEid, r);
            }
          }

          for (const [eid, p] of posUpd) eng.setEntityPosition(eid, p);
          for (const [eid, r] of rotUpd) eng.setEntityRotation(eid, r);
        });

        // Flush all locally-owned entity deltas every game tick.
        // Owned entities run movement locally; remote peers skip movement for
        // entities they receive (they have no Velocity component) and only use
        // the incoming positions. Collision runs on all peers independently.
        unsubTick = world.controls.onTick(() => {
          if (!net) return;
          const ids = [...ownedEntitySetRef.current];
          if (ids.length === 0) return;
          net.markEntitiesDirty(ids);
          net.flushGroupDeltas(GROUP_ID, ids);
        });

        netRef.current = net;
        setLocalPeerId(id);
      });

      peer.on("error", (err: Error) =>
        log(logLevels.error, "[peerjs]", ["network"], err.message),
      );
    });

    function getOrCreatePeerMap(peerId: string): Map<number, number> {
      let map = remoteEntitiesRef.current.get(peerId);
      if (!map) {
        map = new Map();
        remoteEntitiesRef.current.set(peerId, map);
      }
      return map;
    }

    // Spawns a local mirror entity for an entity owned by a remote peer.
    // Projectiles get the correct bullet mesh; all others get person mesh with
    // a collider so they participate in local collision detection.
    // Neither type gets Velocity or Gravity, so the movement system skips them —
    // positions come entirely from network updates.
    function getOrSpawnRemote(
      peerId: string,
      remoteEid: number,
      peerEntities: Map<number, number>,
      isProjectile: boolean,
    ): number {
      const existing = peerEntities.get(remoteEid);
      if (existing !== undefined) return existing;

      const localEid = isProjectile
        ? eng.spawnEntity({
            position: { x: 0, y: 0, z: 0 },
            rotation: { pitch: 0, yaw: 0, roll: 0 },
            renderMesh: createRemoteProjectileMesh,
          })
        : eng.spawnEntity({
            position: { x: 0, y: 0, z: 0 },
            rotation: { pitch: 0, yaw: 0, roll: 0 },
            collider: REMOTE_PERSON_COLLIDER,
            renderMesh: createRemotePersonMesh,
          });

      peerEntities.set(remoteEid, localEid);
      setConnectedPeers((prev) =>
        prev.includes(peerId) ? prev : [...prev, peerId],
      );
      return localEid;
    }

    return () => {
      cancelled = true;
      unsubTick?.();
      net?.dispose();
      for (const peerMap of remoteEntitiesRef.current.values()) {
        for (const eid of peerMap.values()) eng.destroyEntity(eid);
      }
      remoteEntitiesRef.current.clear();
      projectileComponentRef.current = null;
      netRef.current = null;
      setLocalPeerId(null);
      setConnectedPeers([]);
    };
  }, [engine, playerEid]);

  function connect(remotePeerId: string) {
    const net = netRef.current;
    if (!net) return;
    void net.connectPeer(remotePeerId).then(() => {
      net.joinGroup(GROUP_ID, [remotePeerId]);
      // Send a full snapshot of all owned entities so the remote peer can
      // immediately spawn mirrors for all boxes, not just the player.
      net.sendFullSync(GROUP_ID, remotePeerId, [...ownedEntitySetRef.current]);
      setConnectedPeers((prev) =>
        prev.includes(remotePeerId) ? prev : [...prev, remotePeerId],
      );
    });
  }

  return { localPeerId, connectedPeers, connect, addOwnedEntity, removeOwnedEntity, signalEntityDestroyed };
}
