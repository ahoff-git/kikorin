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
// not exist inside Web Workers. On mount, every client tries to join the
// same shared game room (see gameRoom.ts) via a well-known anchor peer id —
// no bootstrap-service, no pasted id required; see the anchor-claim-or-
// fallback dance in start() below. `connect()` remains as a manual override
// for a private ad hoc session outside the shared room.

import { log, logLevels } from "@kikorin/util";
import { netChannel } from "@kikorin/adapter";
import { applyToObjectByEid } from "@kikorin/system-rendering";
import { useCallback, useEffect, useRef, useState } from "react";
import { createAwari, type Transport } from "@awari/core";
import type { PeerRef, RoomSession } from "@awari/protocol";
import { createPeerJsTransport, readPeerJsId } from "@awari/transport-peerjs";
import { createManualBootstrapClient, type ManualBootstrapClient } from "./manualBootstrap";
import { getGameRoom, type GameKey } from "./gameRoom";
import type { WorkerEngineProxy } from "../workers/WorkerEngineProxy";
import {
  createChatController,
  systemNotice,
  shortPeerName,
  MAX_CHAT_HISTORY,
  type ChatController,
  type ChatChannel,
  type ChatMessage,
} from "./chat";

export type { ChatMessage, ChatChannel };

/** The subset of a game setup's networking hooks needed to report entity ownership and hits. */
export type OwnershipCallbacks = Pick<
  UseNetworkingReturn,
  "addOwnedEntity" | "removeOwnedEntity" | "signalEntityDestroyed" | "signalHitOnRemoteEntity"
>;

export interface UseNetworkingReturn {
  /** This client's PeerJS id — share it so others can join. Null until the broker assigns one. */
  localPeerId: string | null;
  /** Broker/connection failure surfaced to the UI; null when healthy. */
  transportError: string | null;
  connectedPeers: string[];
  chatMessages: ChatMessage[];
  /** Where `sendChatMessage` delivers to; switch before sending to change channel. */
  activeChatChannel: ChatChannel;
  setActiveChatChannel: (channel: ChatChannel) => void;
  /** Group channels this client currently receives — "group" messages outside this list are dropped silently, not queued. */
  joinedChatGroups: string[];
  joinChatGroup: (name: string) => void;
  leaveChatGroup: (name: string) => void;
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
  gameKey: GameKey,
  playerEid: number | null,
  _ownedEids: readonly number[],
): UseNetworkingReturn {
  const [localPeerId, setLocalPeerId] = useState<string | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [activeChatChannel, setActiveChatChannel] = useState<ChatChannel>({ kind: "global" });
  const [joinedChatGroups, setJoinedChatGroups] = useState<string[]>([]);
  const sessionRef = useRef<RoomSession | null>(null);
  const awariRef = useRef<ReturnType<typeof createAwari> | null>(null);
  const bootstrapRef = useRef<ManualBootstrapClient | null>(null);
  const chatControllerRef = useRef<ChatController | null>(null);
  const selfPeerIdRef = useRef<string | null>(null);
  // Latest-value refs so the chat controller (created once per session
  // inside the effect) reads current values instead of a stale closure —
  // same pattern as sessionRef/attachSessionRef below.
  const playerEidRef = useRef(playerEid);
  playerEidRef.current = playerEid;
  const activeChatChannelRef = useRef(activeChatChannel);
  activeChatChannelRef.current = activeChatChannel;
  const joinedChatGroupsRef = useRef<Set<string>>(new Set());
  // Wiring shared between the initial shared-game-room session and any
  // session `connect()` joins later — set inside the effect so it closes
  // over the current `engine`, called from the stable `connect` callback via
  // the ref.
  const attachSessionRef = useRef<((session: RoomSession) => void) | null>(null);
  // One identity for this running app instance, across however many rooms it
  // joins in turn (the shared game room, then whichever `connect()` targets).
  const sessionIdRef = useRef<string>(crypto.randomUUID());

  // Bring the transport up once the engine is ready.
  useEffect(() => {
    if (!engine) return;
    // Aliased so nested closures below type-narrow to non-null — `engine` the
    // parameter stays `WorkerEngineProxy | null` inside them otherwise.
    const activeEngine = engine;
    let disposed = false;

    // Which physical connection ends up backing this session is decided
    // inside start() (anchor-claim-or-fallback below); tracked here so
    // cleanup can always destroy whichever one that turned out to be.
    let transport: Transport | null = null;

    function attachSession(session: RoomSession) {
      sessionRef.current = session;

      // Only the bridge call happens here — the UI's peer list comes from
      // the engine's own NetPatch (PeerJoined/PeerLeft) stream via
      // netChannel below, same as every other piece of entity state.
      session.onPeerJoined((peer: PeerRef) => activeEngine.net_peer_connected(peer.peerId));
      session.onPeerLeft((peer: PeerRef) => activeEngine.net_peer_disconnected(peer.peerId));
      session.onMessage((message) => {
        // PeerJS's default serialization normalizes a sent Uint8Array back to
        // a plain ArrayBuffer on arrival, not the original TypedArray class —
        // net_ingest needs a real Uint8Array, so it's rewrapped here rather
        // than checking `instanceof Uint8Array` (which this payload never is).
        const payload = message.payload;
        if (payload instanceof Uint8Array) {
          activeEngine.net_ingest(message.sender.peerId, payload);
        } else if (payload instanceof ArrayBuffer) {
          activeEngine.net_ingest(message.sender.peerId, new Uint8Array(payload));
        }
      });
      session.onDisconnected((reason: Error) => {
        log(logLevels.warning, "[transport] room disconnected", ["network"], reason);
        setTransportError(reason.message);
      });

      // Chat rides this same session/room rather than opening its own —
      // torn down and recreated alongside it (manual connect() replaces both
      // together, so chat always matches whichever room is currently live).
      chatControllerRef.current?.dispose();
      chatControllerRef.current = createChatController(
        session,
        selfPeerIdRef.current ?? "unknown",
        (message) => {
          setChatMessages((prev) => {
            const next = [...prev, message];
            return next.length > MAX_CHAT_HISTORY ? next.slice(next.length - MAX_CHAT_HISTORY) : next;
          });
        },
        () => joinedChatGroupsRef.current,
        () => {
          const eid = playerEidRef.current;
          if (eid === null) return null;
          let pos: [number, number, number] | null = null;
          applyToObjectByEid(eid, (obj) => {
            pos = [obj.position.x, obj.position.y, obj.position.z];
          });
          return pos;
        },
      );
    }
    attachSessionRef.current = attachSession;

    async function start() {
      // Auto-discovery with no separate directory service: try to claim a
      // well-known PeerJS id derived from this game's room (see gameRoom.ts —
      // scoped by gameKey so the 2D and 3D games never share a room). Whoever
      // gets there first becomes the room's anchor (genesis leader); everyone
      // after that fails to claim it — that failure itself is the discovery
      // signal — and dials it directly instead of needing a pasted id.
      const { roomId, anchorPeerId } = getGameRoom(gameKey);
      let isAnchor = true;
      let transportAttempt = createPeerJsTransport({ id: anchorPeerId });
      let selfId: string;
      try {
        selfId = await transportAttempt.selfId;
      } catch {
        isAnchor = false;
        void transportAttempt.destroy();
        transportAttempt = createPeerJsTransport();
        try {
          selfId = await transportAttempt.selfId;
        } catch (err) {
          if (disposed) return;
          log(logLevels.error, "[transport] peer error", ["network"], err);
          setTransportError(String(err));
          return;
        }
      }
      if (disposed) {
        void transportAttempt.destroy();
        return;
      }
      transport = transportAttempt;

      log(logLevels.debug, "[transport] broker connected", ["network"], selfId, { isAnchor });
      selfPeerIdRef.current = selfId;
      setLocalPeerId(selfId);
      setTransportError(null);

      const bootstrap = createManualBootstrapClient();
      bootstrapRef.current = bootstrap;
      if (!isAnchor) {
        // We're not the anchor, so someone else already is — dial them.
        bootstrap.seedContact(roomId, anchorPeerId);
      }

      const awari = createAwari({ transport, bootstrap, resolveConnectionId: readPeerJsId, peerId: selfId });
      awariRef.current = awari;

      try {
        const session = await awari.join({ roomId, sessionId: sessionIdRef.current });
        if (disposed) {
          void session.close();
          return;
        }
        attachSession(session);
      } catch (err) {
        if (disposed) return;
        log(logLevels.error, "[transport] failed to join game room", ["network"], err);
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
      chatControllerRef.current?.dispose();
      chatControllerRef.current = null;
      void sessionRef.current?.close();
      sessionRef.current = null;
      void transport?.destroy();
      setLocalPeerId(null);
    };
  }, [engine, gameKey]);

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

      // System chat notices: every peer_joined/peer_left is symmetric across
      // clients (each engine reports its own bridge events), so no broadcast
      // is needed — everyone derives the same notice locally.
      const notices = patches
        .filter(p => p.kind === "peer_joined" || p.kind === "peer_left")
        .map(p => systemNotice(`${shortPeerName(p.peer_id)} ${p.kind === "peer_joined" ? "joined" : "left"}`));
      if (notices.length > 0) {
        setChatMessages(prev => {
          const next = [...prev, ...notices];
          return next.length > MAX_CHAT_HISTORY ? next.slice(next.length - MAX_CHAT_HISTORY) : next;
        });
      }
    });
    return unsub;
  }, []);

  // Manual override: join a private ad hoc room keyed by a pasted PeerJS id,
  // replacing whatever room we were previously in (the shared game room, by
  // default, or another private room). Useful for testing or a session
  // deliberately kept off the shared game room.
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

  const sendChatMessage = useCallback((text: string) => {
    chatControllerRef.current?.send(activeChatChannelRef.current, text);
  }, []);

  const joinChatGroup = useCallback((name: string) => {
    const clean = name.trim();
    if (!clean || joinedChatGroupsRef.current.has(clean)) return;
    joinedChatGroupsRef.current.add(clean);
    setJoinedChatGroups([...joinedChatGroupsRef.current]);
  }, []);

  const leaveChatGroup = useCallback((name: string) => {
    if (!joinedChatGroupsRef.current.delete(name)) return;
    setJoinedChatGroups([...joinedChatGroupsRef.current]);
  }, []);

  // TODO: intentional no-op stubs from the TS→Rust netcode migration. The
  // ownership/hit signalling pipeline is not wired into the wire protocol
  // yet; these keep the setupGame contract stable until it lands (or the
  // pipeline is deleted).
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
    activeChatChannel,
    setActiveChatChannel,
    joinedChatGroups,
    joinChatGroup,
    leaveChatGroup,
    connect,
    sendChatMessage,
    addOwnedEntity,
    removeOwnedEntity,
    signalEntityDestroyed,
    signalHitOnRemoteEntity,
    setHitHandler,
  };
}
