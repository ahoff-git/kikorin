"use client";

// Peer-to-peer transport (IO layer). PeerJS brokers WebRTC over its free
// public cloud (0.peerjs.com) — no self-hosted signaling server. The Rust
// engine owns the protocol (wire events, mirrors, cadence, timeouts); this
// hook only owns the connections and shuttles bytes:
//   inbound   conn 'data'    → proxy.net_ingest(peer, bytes)
//   outbound  proxy.onNetOut → conn.send(bytes)  (peer null = broadcast)
//   presence  conn 'open'/'close' → proxy.net_peer_(dis)connected
// The transport must live on the main thread: RTCPeerConnection does not
// exist inside Web Workers.

import { log, logLevels } from "@kikorin/util";
import { netChannel } from "@kikorin/adapter";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DataConnection, Peer } from "peerjs";
import type { WorkerEngineProxy } from "../workers/WorkerEngineProxy";

export type ChatMessage = {
  id: number;
  from: string; // "me" for locally sent, peerId for remote
  text: string;
};

export interface UseNetworkingReturn {
  /** This client's PeerJS id — share it so others can join. Null until the broker assigns one. */
  localPeerId: string | null;
  /** Broker/connection failure surfaced to the UI; null when healthy. */
  transportError: string | null;
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
  engine: WorkerEngineProxy | null,
  _playerEid: number | null,
  _ownedEids: readonly number[],
): UseNetworkingReturn {
  const [localPeerId, setLocalPeerId] = useState<string | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [chatMessages] = useState<ChatMessage[]>([]);
  const peerRef = useRef<Peer | null>(null);
  const connsRef = useRef<Map<string, DataConnection>>(new Map());
  // Shared handler wiring for inbound and outgoing connections.
  const wireConnectionRef = useRef<((conn: DataConnection) => void) | null>(null);

  // Bring the transport up once the engine is ready.
  useEffect(() => {
    if (!engine) return;
    let disposed = false;

    function wireConnection(conn: DataConnection) {
      conn.on("open", () => {
        log(logLevels.debug, "[transport] data channel open", ["network"], conn.peer);
        connsRef.current.set(conn.peer, conn);
        engine?.net_peer_connected(conn.peer);
      });
      conn.on("data", (data) => {
        if (data instanceof ArrayBuffer) {
          engine?.net_ingest(conn.peer, new Uint8Array(data));
        } else if (data instanceof Uint8Array) {
          engine?.net_ingest(conn.peer, data);
        }
      });
      const drop = () => {
        if (connsRef.current.delete(conn.peer)) {
          engine?.net_peer_disconnected(conn.peer);
        }
      };
      conn.on("close", drop);
      conn.on("error", (err) => {
        log(logLevels.warning, "[transport] connection error", ["network"], conn.peer, err);
        drop();
      });
    }

    wireConnectionRef.current = wireConnection;

    // Dynamic import keeps peerjs (browser-only) out of the SSR bundle.
    void import("peerjs").then(({ default: PeerCtor }) => {
      if (disposed) return;
      const peer = new PeerCtor(); // no options = the free public PeerJS cloud
      peerRef.current = peer;

      peer.on("open", (id) => {
        log(logLevels.debug, "[transport] broker connected", ["network"], id);
        setLocalPeerId(id);
        setTransportError(null);
      });
      peer.on("connection", wireConnection);
      peer.on("error", (err) => {
        log(logLevels.error, "[transport] peer error", ["network"], err);
        setTransportError(String(err));
      });
      peer.on("disconnected", () => {
        // Broker link dropped (existing data channels survive); try to regain it.
        peer.reconnect();
      });
    });

    // Engine → wire: send whatever the engine queued since the last flush.
    engine.onNetOut((items) => {
      for (const item of items) {
        if (item.peer === null) {
          for (const conn of connsRef.current.values()) conn.send(item.data);
        } else {
          connsRef.current.get(item.peer)?.send(item.data);
        }
      }
    });

    return () => {
      disposed = true;
      wireConnectionRef.current = null;
      engine.onNetOut(null);
      for (const [peerId] of connsRef.current) engine.net_peer_disconnected(peerId);
      connsRef.current.clear();
      peerRef.current?.destroy();
      peerRef.current = null;
      setLocalPeerId(null);
    };
  }, [engine]);

  // Live peer list from engine net events: peer_joined fires when the data
  // channel opens (before any entity data), entity activity also marks a peer
  // present, and peer_left (close or engine timeout) removes it.
  useEffect(() => {
    const unsub = netChannel.subscribe(() => {
      const patches = netChannel.getSnapshot();
      if (patches.length === 0) return;
      setConnectedPeers(prev => {
        let next = prev;
        for (const p of patches) {
          if (p.kind === "peer_left") {
            next = next.filter(id => id !== p.peer_id);
          } else if (!next.includes(p.peer_id)) {
            next = [...next, p.peer_id];
          }
        }
        return next;
      });
    });
    return unsub;
  }, []);

  // Dial another client by its PeerJS id.
  const connect = useCallback((remotePeerId: string) => {
    const peer = peerRef.current;
    const wire = wireConnectionRef.current;
    if (!peer || !wire) {
      log(logLevels.debug, "[transport] connect: broker not ready", ["network"], remotePeerId);
      return;
    }
    wire(peer.connect(remotePeerId, { reliable: true }));
  }, []);

  // TODO: intentional no-op stubs from the TS→Rust netcode migration. Chat and
  // the ownership/hit signalling pipeline are not wired into the wire protocol
  // yet; these keep the setupGame contract stable until a Chat wire event lands
  // (or the pipeline is deleted).
  const sendChatMessage = useCallback((_text: string) => {}, []);
  const addOwnedEntity = useCallback((_eid: number) => {}, []);
  const removeOwnedEntity = useCallback((_eid: number) => {}, []);
  const signalEntityDestroyed = useCallback((_eid: number) => {}, []);
  const signalHitOnRemoteEntity = useCallback((_localMirrorEid: number) => {}, []);
  const setHitHandler = useCallback((_handler: ((eid: number) => void) | null) => {}, []);

  return {
    localPeerId,
    transportError,
    connectedPeers,
    chatMessages,
    connect,
    sendChatMessage,
    addOwnedEntity,
    removeOwnedEntity,
    signalEntityDestroyed,
    signalHitOnRemoteEntity,
    setHitHandler,
  };
}
