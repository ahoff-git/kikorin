"use client";

import { PeerNet, type ComponentSchema, type PeerJSPeer } from "@kikorin/netcode";
import type { CoreWorldBox } from "@kikorin/engine";
import { NET } from "@kikorin/engine";
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
// NetFlags carries the entity type (NET.PROJECTILE) so remote peers can
// choose the right mesh at spawn time. It also doubles as the life/death signal:
// setting it to 0 tells peers to despawn the mirror entity.
const NET_FLAGS_COMPONENT_ID = 2;

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

export type ChatMessage = {
  id: number;
  from: string; // "me" for locally sent, peerId for remote
  text: string;
};

// GameEvent payload type prefix bytes — keeps hit notifications and chat distinct.
const GAME_EVENT_HIT = 0x01;
const GAME_EVENT_CHAT = 0x02;

export interface UseNetworkingReturn {
  localPeerId: string | null;
  connectedPeers: string[];
  chatMessages: ChatMessage[];
  connect: (remotePeerId: string) => void;
  sendChatMessage: (text: string) => void;
  addOwnedEntity: (eid: number) => void;
  removeOwnedEntity: (eid: number) => void;
  signalEntityDestroyed: (eid: number) => void;
  signalHitOnRemoteEntity: (localMirrorEid: number) => void;
  setHitHandler: (handler: ((eid: number) => void) | null) => void;
}

export function useNetworking(
  engine: CoreWorldBox | null,
  playerEid: number | null,
  ownedEids: readonly number[],
): UseNetworkingReturn {
  const [localPeerId, setLocalPeerId] = useState<string | null>(null);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const netRef = useRef<PeerNet | null>(null);
  // All peer IDs we've successfully connected to or received data from, for chat broadcast.
  const knownPeerIdsRef = useRef<Set<string>>(new Set());
  const chatIdRef = useRef(0);
  // peerId → Map<remoteEid, localEid>
  const remoteEntitiesRef = useRef(new Map<string, Map<number, number>>());
  // localEid → { peerId, remoteEid } — reverse lookup so the shooter can route
  // hit notifications to the entity's owner peer.
  const mirrorOwnerRef = useRef(new Map<number, { peerId: string; remoteEid: number }>());
  // Mutable set of entity IDs this peer owns. Initialized from ownedEids inside
  // the setup effect (where playerEid and ownedEids land in the same React batch),
  // then managed dynamically by addOwnedEntity / removeOwnedEntity for projectiles.
  const ownedEntitySetRef = useRef(new Set<number>());
  // Direct reference to the NetFlags array so ownership callbacks can set flags
  // without closing over stale world refs.
  const netFlagsRef = useRef<Int8Array | null>(null);
  // Called by the owner peer when a remote hit notification arrives.
  const hitHandlerRef = useRef<((eid: number) => void) | null>(null);

  const setHitHandler = useCallback((handler: ((eid: number) => void) | null) => {
    hitHandlerRef.current = handler;
  }, []);

  const signalHitOnRemoteEntity = useCallback((localMirrorEid: number) => {
    const net = netRef.current;
    if (!net) return;
    const owner = mirrorOwnerRef.current.get(localMirrorEid);
    if (!owner) return;
    // Byte 0 = GAME_EVENT_HIT, bytes 1-4 = remote entity ID (little-endian Uint32).
    const payload = new ArrayBuffer(5);
    const view = new DataView(payload);
    view.setUint8(0, GAME_EVENT_HIT);
    view.setUint32(1, owner.remoteEid, true);
    net.sendGameEvent(owner.peerId, payload);
  }, []);

  const sendChatMessage = useCallback((text: string) => {
    const net = netRef.current;
    if (!net) return;
    const encoded = new TextEncoder().encode(text);
    const payload = new ArrayBuffer(1 + encoded.byteLength);
    const view = new DataView(payload);
    view.setUint8(0, GAME_EVENT_CHAT);
    new Uint8Array(payload, 1).set(encoded);
    for (const peerId of knownPeerIdsRef.current) {
      net.sendGameEvent(peerId, payload);
    }
    setChatMessages(prev => [...prev, { id: chatIdRef.current++, from: "me", text }]);
  }, []);

  const addOwnedEntity = useCallback((eid: number) => {
    ownedEntitySetRef.current.add(eid);
    const flags = netFlagsRef.current;
    if (flags) flags[eid] |= NET.OWNED | NET.SHARED;
  }, []);

  const removeOwnedEntity = useCallback((eid: number) => {
    ownedEntitySetRef.current.delete(eid);
    const flags = netFlagsRef.current;
    if (flags) flags[eid] &= ~(NET.OWNED | NET.SHARED);
  }, []);

  // Called by game code before destroying an owned entity. Clears all NetFlags
  // (which also clears PROJECTILE, signaling peers to despawn the mirror), flushes
  // that final delta, then removes the entity from the owned set. Must be called
  // BEFORE destroyEntity so the flush can still read the entity's position.
  const signalEntityDestroyed = useCallback((eid: number) => {
    const flags = netFlagsRef.current;
    if (flags) flags[eid] = 0;
    const net = netRef.current;
    if (net) {
      net.markEntitiesDirty([eid]);
      net.flushGroupDeltas(GROUP_ID, [eid]);
      // Clear the snapshot so if this eid is recycled to a new entity, the next
      // flush sends all fields rather than a diff against the old entity's values.
      net.invalidateEntity(eid);
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
    netFlagsRef.current = world.components.NetFlags;

    // Mark all initially-owned entities as owned+shared so shouldSendState works.
    const netFlagsArr = world.components.NetFlags;
    for (const eid of ownedEids) {
      netFlagsArr[eid] |= NET.OWNED | NET.SHARED;
    }

    let net: PeerNet | null = null;
    let cancelled = false;
    let unsubTick: (() => void) | undefined;
    let unsubGameEvents: (() => void) | undefined;
    let unsubPeerList: (() => void) | undefined;

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

    // Transmit the full NetFlags byte so remote peers can determine entity type
    // (NET.PROJECTILE bit) for spawning and detect destruction (value → 0).
    const netFlagsSchema: ComponentSchema = {
      id: NET_FLAGS_COMPONENT_ID,
      name: "NetFlags",
      fields: [
        { id: 0, name: "flags", array: world.components.NetFlags },
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
        net.registerComponent(netFlagsSchema);
        net.createGroup({ id: GROUP_ID, tickRateMs: 50 });

        // When a connected peer introduces us to new peers, auto-connect to complete the mesh.
        unsubPeerList = net.onPeerList((peers) => {
          if (!net) return;
          for (const peerId of peers) {
            if (knownPeerIdsRef.current.has(peerId)) continue;
            // Claim the slot immediately so concurrent introductions don't double-connect.
            knownPeerIdsRef.current.add(peerId);
            void net.connectPeer(peerId).then(() => {
              if (!net) return;
              net.joinGroup(GROUP_ID, [peerId]);
              net.sendFullSync(GROUP_ID, peerId, [...ownedEntitySetRef.current]);
              // Tell the new peer about our other known peers.
              const others = [...knownPeerIdsRef.current].filter(p => p !== peerId);
              if (others.length > 0) net.sendPeerList(peerId, others);
              // Announce the new peer to everyone we already know.
              for (const existingId of knownPeerIdsRef.current) {
                if (existingId !== peerId) net.sendPeerList(existingId, [peerId]);
              }
              setConnectedPeers((prev) =>
                prev.includes(peerId) ? prev : [...prev, peerId],
              );
            }).catch(() => {
              knownPeerIdsRef.current.delete(peerId);
            });
          }
        });

        net.onPeerDisconnect((peerId: string) => {
          const peerMap = remoteEntitiesRef.current.get(peerId);
          if (peerMap) {
            for (const localEid of peerMap.values()) {
              eng.destroyEntity(localEid);
              mirrorOwnerRef.current.delete(localEid);
            }
            remoteEntitiesRef.current.delete(peerId);
          }
          knownPeerIdsRef.current.delete(peerId);
          setConnectedPeers((prev) => prev.filter((id) => id !== peerId));
        });

        unsubGameEvents = net.onGameEvent((payload, fromPeer) => {
          if (payload.byteLength < 1) return;
          const view = new DataView(payload);
          const kind = view.getUint8(0);
          if (kind === GAME_EVENT_HIT) {
            if (payload.byteLength < 5) return;
            const remoteEid = view.getUint32(1, true);
            hitHandlerRef.current?.(remoteEid);
          } else if (kind === GAME_EVENT_CHAT) {
            const text = new TextDecoder().decode(new Uint8Array(payload, 1));
            setChatMessages(prev => [
              ...prev,
              { id: chatIdRef.current++, from: fromPeer, text },
            ]);
          }
        });

        net.onGroupDelta(GROUP_ID, (deltas, _gid, fromPeer) => {
          const isNewPeer = !remoteEntitiesRef.current.has(fromPeer);
          const peerEntities = getOrCreatePeerMap(fromPeer);

          // When we first hear from a peer, send them our full state so they
          // can spawn mirrors for all our boxes immediately, and exchange peer
          // lists so the full mesh can form automatically.
          if (isNewPeer && net) {
            net.sendFullSync(GROUP_ID, fromPeer, [...ownedEntitySetRef.current]);
            // fromPeer is not in knownPeerIdsRef yet at this point, so this gives
            // exactly the set of peers we should introduce fromPeer to.
            const existingPeers = [...knownPeerIdsRef.current];
            if (existingPeers.length > 0) net.sendPeerList(fromPeer, existingPeers);
            for (const peerId of existingPeers) {
              net.sendPeerList(peerId, [fromPeer]);
            }
          }

          // First pass: identify new projectiles (for spawning) and destroyed
          // entities (NetFlags = 0 on a known entity = despawn signal).
          const projectileRemoteEids = new Set<number>();
          const destroyedRemoteEids = new Set<number>();
          for (const d of deltas) {
            if (d.componentId === NET_FLAGS_COMPONENT_ID) {
              if ((d.value & NET.PROJECTILE) !== 0) {
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
              mirrorOwnerRef.current.delete(localEid);
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
            // Skip all deltas belonging to despawned entities.
            if (destroyedRemoteEids.has(d.entityId)) continue;
            if (d.componentId === NET_FLAGS_COMPONENT_ID && d.value === 0) continue;
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
        //
        // fallCleanupSystem (which destroys entities that fall off the world)
        // runs AFTER controlsSystem in the engine loop, so entities it destroys
        // never get signalEntityDestroyed called. We detect them here — if an
        // owned eid no longer has Position it was silently destroyed — and send
        // NetFlags=0 so peers can despawn their mirrors.
        unsubTick = world.controls.onTick(() => {
          if (!net) return;
          const ownedIds = ownedEntitySetRef.current;
          if (ownedIds.size === 0) return;

          const toFlush: number[] = [];
          const silentlyDestroyed: number[] = [];
          for (const eid of ownedIds) {
            if (eng.hasEntityComponents(eid, ["Position"])) {
              toFlush.push(eid);
            } else {
              silentlyDestroyed.push(eid);
            }
          }

          if (silentlyDestroyed.length > 0) {
            const flags = netFlagsRef.current;
            for (const eid of silentlyDestroyed) {
              if (flags) flags[eid] = 0;
              ownedIds.delete(eid);
            }
            net.markEntitiesDirty(silentlyDestroyed);
            net.flushGroupDeltas(GROUP_ID, silentlyDestroyed);
            for (const eid of silentlyDestroyed) net.invalidateEntity(eid);
          }

          if (toFlush.length === 0) return;
          net.markEntitiesDirty(toFlush);
          net.flushGroupDeltas(GROUP_ID, toFlush);
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
    // Projectile-type entities get the bullet mesh; all others get person mesh with
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
            // NET.PREDICT could be set here to enable local bullet prediction.
            // Left as 0 (network-only) since remote bullet state is authoritative.
            netFlags: NET.PROJECTILE,
          })
        : eng.spawnEntity({
            position: { x: 0, y: 0, z: 0 },
            rotation: { pitch: 0, yaw: 0, roll: 0 },
            collider: REMOTE_PERSON_COLLIDER,
            renderMesh: createRemotePersonMesh,
            // No OWNED — positions come from network. Add NET.PREDICT to also run
            // local movement prediction while accepting network corrections.
            netFlags: 0,
            // Person component so camera/movement filters treat this like a local person.
            player: { level: 0, experience: 0, name: '' },
          });

      peerEntities.set(remoteEid, localEid);
      mirrorOwnerRef.current.set(localEid, { peerId, remoteEid });
      knownPeerIdsRef.current.add(peerId);
      setConnectedPeers((prev) =>
        prev.includes(peerId) ? prev : [...prev, peerId],
      );
      return localEid;
    }

    return () => {
      cancelled = true;
      unsubTick?.();
      unsubGameEvents?.();
      unsubPeerList?.();
      net?.dispose();
      for (const peerMap of remoteEntitiesRef.current.values()) {
        for (const eid of peerMap.values()) eng.destroyEntity(eid);
      }
      remoteEntitiesRef.current.clear();
      mirrorOwnerRef.current.clear();
      netFlagsRef.current = null;
      netRef.current = null;
      setLocalPeerId(null);
      setConnectedPeers([]);
    };
  }, [engine, playerEid]);

  function connect(remotePeerId: string) {
    const net = netRef.current;
    if (!net || knownPeerIdsRef.current.has(remotePeerId)) return;
    // Claim immediately so concurrent introductions don't double-connect.
    knownPeerIdsRef.current.add(remotePeerId);
    void net.connectPeer(remotePeerId).then(() => {
      net.joinGroup(GROUP_ID, [remotePeerId]);
      // Send a full snapshot of all owned entities so the remote peer can
      // immediately spawn mirrors for all boxes, not just the player.
      net.sendFullSync(GROUP_ID, remotePeerId, [...ownedEntitySetRef.current]);
      // Send the new peer our existing peer list so they can connect to the full mesh.
      const others = [...knownPeerIdsRef.current].filter(p => p !== remotePeerId);
      if (others.length > 0) net.sendPeerList(remotePeerId, others);
      // Announce the new peer to everyone we already know.
      for (const existingId of knownPeerIdsRef.current) {
        if (existingId !== remotePeerId) net.sendPeerList(existingId, [remotePeerId]);
      }
      setConnectedPeers((prev) =>
        prev.includes(remotePeerId) ? prev : [...prev, remotePeerId],
      );
    }).catch(() => {
      knownPeerIdsRef.current.delete(remotePeerId);
    });
  }

  return { localPeerId, connectedPeers, chatMessages, connect, sendChatMessage, addOwnedEntity, removeOwnedEntity, signalEntityDestroyed, signalHitOnRemoteEntity, setHitHandler };
}
