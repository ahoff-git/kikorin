"use client";

// Peer-to-peer transport (IO layer), riding on @awari/core's room/topology
// session instead of ad hoc pairwise PeerJS dialing (see
// crates/netcode/peer.spec.md's Transport section). The Rust engine still
// owns the wire protocol and delta tracking unchanged — this hook only
// bridges an awari RoomSession to the engine's net_* bridge:
//   inbound   session.onMessage        → proxy.net_ingest(sender.peerId, bytes)
//   outbound  proxy.onNetOut           → session.publish({type:"room"}, bytes)
//   presence  session.onPeerJoined/Left → proxy.net_peer_(dis)connected
// The transport must still live on the main thread: RTCPeerConnection does
// not exist inside Web Workers. There is no bootstrap-service deployed yet —
// see manualBootstrap.ts for the manual-sharing stand-in.

import { log, logLevels } from "@kikorin/util";
import { netChannel } from "@kikorin/adapter";
import { useCallback, useEffect, useRef, useState } from "react";
import { createAwari } from "@awari/core";
import type { PeerRef, RoomSession } from "@awari/protocol";
import { createPeerJsTransport, readPeerJsId } from "@awari/transport-peerjs";
import { createManualBootstrapClient, type ManualBootstrapClient } from "./manualBootstrap";
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
  const sessionRef = useRef<RoomSession | null>(null);
  const awariRef = useRef<ReturnType<typeof createAwari> | null>(null);
  const bootstrapRef = useRef<ManualBootstrapClient | null>(null);
  // Wiring shared between the initial self-hosted session and any session
  // `connect()` joins later — set inside the effect so it closes over the
  // current `engine`, called from the stable `connect` callback via the ref.
  const attachSessionRef = useRef<((session: RoomSession) => void) | null>(null);
  // One identity for this running app instance, across however many rooms it
  // joins in turn (self-hosted, then whichever `connect()` targets).
  const sessionIdRef = useRef<string>(crypto.randomUUID());

  // Bring the transport up once the engine is ready.
  useEffect(() => {
    if (!engine) return;
    // Aliased so nested closures below type-narrow to non-null — `engine` the
    // parameter stays `WorkerEngineProxy | null` inside them otherwise.
    const activeEngine = engine;
    let disposed = false;

    const transport = createPeerJsTransport();
    const bootstrap = createManualBootstrapClient();
    bootstrapRef.current = bootstrap;

    function attachSession(session: RoomSession) {
      sessionRef.current = session;

      // Only the bridge call happens here — the UI's peer list comes from
      // the engine's own NetPatch (PeerJoined/PeerLeft) stream via
      // netChannel below, same as every other piece of entity state.
      session.onPeerJoined((peer: PeerRef) => activeEngine.net_peer_connected(peer.peerId));
      session.onPeerLeft((peer: PeerRef) => activeEngine.net_peer_disconnected(peer.peerId));
      session.onMessage((message) => {
        if (message.payload instanceof Uint8Array) {
          activeEngine.net_ingest(message.sender.peerId, message.payload);
        }
      });
      session.onDisconnected((reason: Error) => {
        log(logLevels.warning, "[transport] room disconnected", ["network"], reason);
        setTransportError(reason.message);
      });
    }
    attachSessionRef.current = attachSession;

    async function start() {
      let selfId: string;
      try {
        selfId = await transport.selfId;
      } catch (err) {
        if (disposed) return;
        log(logLevels.error, "[transport] peer error", ["network"], err);
        setTransportError(String(err));
        return;
      }
      if (disposed) return;

      log(logLevels.debug, "[transport] broker connected", ["network"], selfId);
      setLocalPeerId(selfId);
      setTransportError(null);

      const awari = createAwari({ transport, bootstrap, resolveConnectionId: readPeerJsId, peerId: selfId });
      awariRef.current = awari;

      // Self-host a room keyed by our own id — the direct analog of the old
      // "already listening for incoming connections" posture, since nobody
      // else can name this room without us sharing that same id out of band.
      try {
        const session = await awari.join({ roomId: selfId, sessionId: sessionIdRef.current });
        if (disposed) {
          void session.close();
          return;
        }
        attachSession(session);
      } catch (err) {
        if (disposed) return;
        log(logLevels.error, "[transport] failed to host room", ["network"], err);
        setTransportError(String(err));
      }
    }

    void start();

    // Engine → wire: send whatever the engine queued since the last flush.
    // awari v0 floods every room-routed publish to all direct connections
    // regardless of a per-peer target, so a full-sync originally aimed at
    // one newly-joined peer reaches everyone — harmless, since Spawn events
    // are idempotent for peers who already have that state.
    activeEngine.onNetOut((items) => {
      const session = sessionRef.current;
      if (!session) return;
      for (const item of items) {
        void session.publish({ type: "room" }, item.data);
      }
    });

    return () => {
      disposed = true;
      attachSessionRef.current = null;
      awariRef.current = null;
      bootstrapRef.current = null;
      activeEngine.onNetOut(null);
      void sessionRef.current?.close();
      sessionRef.current = null;
      void transport.destroy();
      setLocalPeerId(null);
    };
  }, [engine]);

  // Live peer list from engine net events: peer_joined fires when the room
  // session bridge reports a new peer (before any entity data), entity
  // activity also marks a peer present, and peer_left (bridge report or
  // engine timeout) removes it.
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

  // Join another client's self-hosted room by its PeerJS id, replacing
  // whatever room we were previously in (self-hosted or otherwise).
  const connect = useCallback((remotePeerId: string) => {
    const awari = awariRef.current;
    const bootstrap = bootstrapRef.current;
    const attach = attachSessionRef.current;
    if (!awari || !bootstrap || !attach) {
      log(logLevels.debug, "[transport] connect: not ready", ["network"], remotePeerId);
      return;
    }

    bootstrap.seedContact(remotePeerId, remotePeerId);

    void (async () => {
      try {
        const previous = sessionRef.current;
        const session = await awari.join({ roomId: remotePeerId, sessionId: sessionIdRef.current });
        await previous?.close();
        attach(session);
      } catch (err) {
        log(logLevels.error, "[transport] connect failed", ["network"], remotePeerId, err);
        setTransportError(String(err));
      }
    })();
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
