"use client";

// Peer-to-peer transport (IO layer), riding on @awari/core's room/topology
// session instead of ad hoc pairwise PeerJS dialing (see
// specs/netcode/README.md's Transport section). The Rust engine still
// owns the wire protocol and delta tracking unchanged — this hook only
// bridges an awari RoomSession to the engine's net_* bridge:
//   inbound   session.onMessage        → proxy.net_ingest(sender.peerId, bytes)
//   outbound  proxy.onNetOut           → session.publish({type:"room"}, bytes)
//   presence  session.onPeerJoined/Left → proxy.net_peer_(dis)connected
// The transport must still live on the main thread: RTCPeerConnection does
// not exist inside Web Workers. On mount, every client joins the same shared
// game room (see gameRoom.ts) via the real, shared awari bootstrap service
// (httpBootstrapClient.ts) — awari's own join() orchestrates genesis-vs-join
// entirely internally (whoever gets there first becomes genesis, per
// awari's own bootstrap-genesis ADR), so nothing here does that manually —
// see this repo's specs/decisions/0009-real-bootstrap-service.md for why
// that switch happened and what it replaced. `connect()` remains a manual
// override for a private ad hoc session outside the shared room, keyed by
// a pasted peer id — a different mechanism (direct dial, no discovery
// needed) with its own dedicated bootstrap client instance
// (manualBootstrap.ts), since the real service has no "just connect to this
// exact peer" primitive.

import { log, logLevels } from "@kikorin/util";
import { lifecycleChannel, netChannel, NET_BULLET, NET_REPLICATED } from "@kikorin/adapter";
import { applyToObjectByEid } from "@kikorin/system-rendering";
import { useCallback, useEffect, useRef, useState } from "react";
import { createAwari, type Transport } from "@awari/core";
import type { PeerRef, RoomSession } from "@awari/protocol";
import { createEntityHandoff, type EntityHandoffController } from "./entityHandoff";
import { createPeerJsTransport, readPeerJsId } from "@awari/transport-peerjs";
import { createHttpBootstrapClient } from "./httpBootstrapClient";
import { createManualBootstrapClient } from "./manualBootstrap";
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
  /** Push-before-release transfer of a locally-owned entity's ownership + state to a connected peer (ADR 0022). */
  transferEntity: (eid: number, toPeerId: string) => void;
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
  // Should match the calling game's own world scale — see chat.ts's
  // createChatController doc comment. Defaults to DEFAULT_NEARBY_RADIUS.
  nearbyRadius?: number,
): UseNetworkingReturn {
  const [localPeerId, setLocalPeerId] = useState<string | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [activeChatChannel, setActiveChatChannel] = useState<ChatChannel>({ kind: "global" });
  const [joinedChatGroups, setJoinedChatGroups] = useState<string[]>([]);
  const sessionRef = useRef<RoomSession | null>(null);
  // Primary: the shared game room, discovered via the real bootstrap
  // service. Manual: connect()'s pasted-peer-id override, a direct dial with
  // no discovery — its own awari instance since createAwari bakes in one
  // bootstrap client for its lifetime and the two need different ones.
  const awariRef = useRef<ReturnType<typeof createAwari> | null>(null);
  const manualAwariRef = useRef<ReturnType<typeof createAwari> | null>(null);
  const manualBootstrapRef = useRef<ReturnType<typeof createManualBootstrapClient> | null>(null);
  const chatControllerRef = useRef<ChatController | null>(null);
  // Entity-ownership state handoff (ADR 0022) + the full PeerRefs it routes to.
  const handoffRef = useRef<EntityHandoffController | null>(null);
  const peersRef = useRef<Map<string, PeerRef>>(new Map());
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
      // netChannel below, same as every other piece of entity state. The full
      // PeerRef (peerId + sessionId) is kept for entity-handoff routing, which
      // resolves peers by the whole ref, not the peerId alone.
      session.onPeerJoined((peer: PeerRef) => {
        peersRef.current.set(peer.peerId, peer);
        activeEngine.net_peer_connected(peer.peerId);
      });
      session.onPeerLeft((peer: PeerRef) => {
        peersRef.current.delete(peer.peerId);
        activeEngine.net_peer_disconnected(peer.peerId);
      });
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
        nearbyRadius,
      );

      // Entity-ownership state handoff (ADR 0022) rides this same session:
      // awari moves routing authority between peers, this transfers the
      // entity's simulation state so the new owner continues it seamlessly.
      // Recreated with the session (a manual connect() swaps both).
      handoffRef.current?.dispose();
      handoffRef.current = createEntityHandoff(session, activeEngine, selfPeerIdRef.current ?? "unknown", {
        onError: (context, error) => log(logLevels.warning, `[handoff] ${context}`, ["network"], error),
      });
    }
    attachSessionRef.current = attachSession;

    async function start() {
      const { roomId } = getGameRoom(gameKey);
      // An ordinary, auto-assigned PeerJS id — no well-known id to claim.
      // The real bootstrap service (below) is what lets peers find each
      // other now, not a shared, guessable id.
      const transportAttempt = createPeerJsTransport();
      let selfId: string;
      try {
        selfId = await transportAttempt.selfId;
      } catch (err) {
        if (disposed) return;
        log(logLevels.error, "[transport] peer error", ["network"], err);
        setTransportError(String(err));
        return;
      }
      if (disposed) {
        void transportAttempt.destroy();
        return;
      }
      transport = transportAttempt;

      log(logLevels.debug, "[transport] broker connected", ["network"], selfId);
      selfPeerIdRef.current = selfId;
      setLocalPeerId(selfId);
      setTransportError(null);

      const bootstrap = createHttpBootstrapClient();
      const awari = createAwari({ transport, bootstrap, resolveConnectionId: readPeerJsId, peerId: selfId });
      awariRef.current = awari;

      // connect()'s own instance, for the unrelated pasted-peer-id override —
      // see this file's module doc comment for why it needs a separate
      // bootstrap client (and therefore a separate awari instance) from the
      // primary one just above.
      const manualBootstrap = createManualBootstrapClient();
      manualBootstrapRef.current = manualBootstrap;
      manualAwariRef.current = createAwari({
        transport,
        bootstrap: manualBootstrap,
        resolveConnectionId: readPeerJsId,
        peerId: selfId,
      });

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
      manualAwariRef.current = null;
      manualBootstrapRef.current = null;
      activeEngine.onNetOut(null);
      chatControllerRef.current?.dispose();
      chatControllerRef.current = null;
      handoffRef.current?.dispose();
      handoffRef.current = null;
      peersRef.current.clear();
      void sessionRef.current?.close();
      sessionRef.current = null;
      void transport?.destroy();
      setLocalPeerId(null);
    };
  }, [engine, gameKey, nearbyRadius]);

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

  // Entity-handoff bookkeeping: a locally-owned, handoff-eligible entity's
  // lifecycle drives its awari ownership. Eligible = NET_REPLICATED, not a
  // bullet (too short-lived to hand off), and not the local player (each peer
  // always owns its own). Spawned → claim routing authority; despawned →
  // release it (a handoff release already forgot the mapping, so untrackLocal
  // no-ops there). The engine emits these only for local entities, never
  // mirrors, so we only ever claim things we actually own.
  useEffect(() => {
    const unsub = lifecycleChannel.subscribe(() => {
      const handoff = handoffRef.current;
      if (!handoff) return;
      for (const l of lifecycleChannel.getSnapshot()) {
        const eligible =
          (l.flags & NET_REPLICATED) !== 0 &&
          (l.flags & NET_BULLET) === 0 &&
          l.entity !== playerEidRef.current;
        if (!eligible) continue;
        if (l.kind === "spawned") handoff.trackLocal(l.entity);
        else handoff.untrackLocal(l.entity);
      }
    });
    return unsub;
  }, []);

  // Push-before-release transfer of a locally-owned entity to a connected peer
  // (ADR 0022). Routing needs the peer's full PeerRef, tracked from onPeerJoined.
  const transferEntity = useCallback((eid: number, toPeerId: string) => {
    const handoff = handoffRef.current;
    const peer = peersRef.current.get(toPeerId);
    if (!handoff || !peer) return;
    void handoff.transfer(eid, peer);
  }, []);

  // E2E hook: lets a two-peer test drive a handoff and read ownership. Gated on
  // the ?e2e flag so it never exists in a normal session.
  useEffect(() => {
    if (typeof window === "undefined" || !new URLSearchParams(window.location.search).has("e2e")) {
      return;
    }
    const w = window as unknown as { __KIKORIN_HANDOFF__?: unknown };
    w.__KIKORIN_HANDOFF__ = {
      transfer: (eid: number, toPeerId: string) => transferEntity(eid, toPeerId),
      ownedEids: () => handoffRef.current?.ownedEids() ?? [],
      peers: () => [...peersRef.current.keys()],
    };
    return () => {
      delete w.__KIKORIN_HANDOFF__;
    };
  }, [transferEntity]);

  // Manual override: join a private ad hoc room keyed by a pasted PeerJS id,
  // replacing whatever room we were previously in (the shared game room, by
  // default, or another private room). Useful for testing or a session
  // deliberately kept off the shared game room.
  const connect = useCallback((remotePeerId: string) => {
    const awari = manualAwariRef.current;
    const bootstrap = manualBootstrapRef.current;
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
    transferEntity,
    addOwnedEntity,
    removeOwnedEntity,
    signalEntityDestroyed,
    signalHitOnRemoteEntity,
    setHitHandler,
  };
}
