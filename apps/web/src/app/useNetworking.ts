"use client";

import { PeerNet, type ComponentSchema, type PeerJSPeer } from "@kikorin/netcode";
import type { CoreWorldBox } from "@kikorin/engine";
import { useEffect, useRef, useState } from "react";
import {
  BoxGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
} from "three";

const GROUP_ID = "world";
const POSITION_COMPONENT_ID = 0;
const ROTATION_COMPONENT_ID = 1;

function createRemotePlayerMesh() {
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

export interface UseNetworkingReturn {
  localPeerId: string | null;
  connectedPeers: string[];
  connect: (remotePeerId: string) => void;
}

export function useNetworking(
  engine: CoreWorldBox | null,
  playerEid: number | null,
): UseNetworkingReturn {
  const [localPeerId, setLocalPeerId] = useState<string | null>(null);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const netRef = useRef<PeerNet | null>(null);
  // peerId → Map<remoteEid, localEid>
  const remoteEntitiesRef = useRef(new Map<string, Map<number, number>>());

  useEffect(() => {
    if (!engine || playerEid === null) return;

    // Capture as non-null locals for use inside closures
    const eng = engine;
    const world = eng.world;
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
        net.createGroup({ id: GROUP_ID, tickRateMs: 50 });

        net.onGroupDelta(GROUP_ID, (deltas, _gid, fromPeer) => {
          const peerEntities = getOrCreatePeerMap(fromPeer);
          const posUpd = new Map<
            number,
            Partial<{ x: number; y: number; z: number }>
          >();
          const rotUpd = new Map<
            number,
            Partial<{ yaw: number; pitch: number }>
          >();

          for (const d of deltas) {
            const localEid = getOrSpawnRemote(
              fromPeer,
              d.entityId,
              peerEntities,
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

        // Flush local player deltas every game tick
        unsubTick = world.controls.onTick(() => {
          if (!net) return;
          net.markEntityDirty(playerEid);
          net.flushGroupDeltas(GROUP_ID, [playerEid]);
        });

        netRef.current = net;
        setLocalPeerId(id);
      });

      peer.on("error", (err: Error) =>
        console.error("[peerjs]", err.message),
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

    function getOrSpawnRemote(
      peerId: string,
      remoteEid: number,
      peerEntities: Map<number, number>,
    ): number {
      const existing = peerEntities.get(remoteEid);
      if (existing !== undefined) return existing;

      const localEid = eng.spawnEntity({
        position: { x: 0, y: 0, z: 0 },
        rotation: { pitch: 0, yaw: 0, roll: 0 },
        renderMesh: createRemotePlayerMesh,
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
      setConnectedPeers((prev) =>
        prev.includes(remotePeerId) ? prev : [...prev, remotePeerId],
      );
    });
  }

  return { localPeerId, connectedPeers, connect };
}
