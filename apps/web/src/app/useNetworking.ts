"use client";

// Networking wired to the Rust WASM engine via WorkerEngineProxy.init_networking().
// The local peer ID is a UUID generated on mount — it's the wasm-peers session ID this
// client joins on startup. "Connect" reinitialises networking with a remote peer's session
// ID, joining their room so the two clients can exchange delta patches.
//
// Requires NEXT_PUBLIC_SIGNALING_URL to be set; without it the ID still displays but
// networking won't connect (buttons remain enabled to surface the missing config clearly).

import { log, logLevels } from "@kikorin/util";
import { netChannel } from "@kikorin/adapter";
import { useCallback, useEffect, useState } from "react";
import type { WorkerEngineProxy } from "../workers/WorkerEngineProxy";

export type ChatMessage = {
  id: number;
  from: string; // "me" for locally sent, peerId for remote
  text: string;
};

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

const SIGNALING_URL = process.env.NEXT_PUBLIC_SIGNALING_URL ?? '';

export function useNetworking(
  engine: WorkerEngineProxy | null,
  _playerEid: number | null,
  _ownedEids: readonly number[],
): UseNetworkingReturn {
  const [localId] = useState<string>(() => crypto.randomUUID());
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  // Auto-initialise networking once the engine is ready.
  useEffect(() => {
    if (!engine || !SIGNALING_URL) return;
    engine.init_networking(localId, SIGNALING_URL);
  }, [engine, localId]);

  // Track peers reported by the Rust engine via net patches.
  useEffect(() => {
    const unsub = netChannel.subscribe(() => {
      const patches = netChannel.getSnapshot();
      const rustPeerIds = [...new Set(patches.map(p => p.peer_id))];
      if (rustPeerIds.length > 0) {
        setConnectedPeers(prev => {
          const next = [...prev];
          for (const id of rustPeerIds) {
            if (!next.includes(id)) next.push(id);
          }
          return next.length === prev.length ? prev : next;
        });
      }
    });
    return unsub;
  }, []);

  // Join another peer's wasm-peers session by reinitialising networking with their ID.
  const connect = useCallback((remotePeerId: string) => {
    if (!engine) {
      log(logLevels.debug, "[networking] connect: engine not ready", ["network"], { remotePeerId });
      return;
    }
    if (!SIGNALING_URL) {
      log(logLevels.debug, "[networking] connect: NEXT_PUBLIC_SIGNALING_URL not configured", ["network"], { remotePeerId });
      return;
    }
    engine.init_networking(remotePeerId, SIGNALING_URL);
  }, [engine]);

  const sendChatMessage = useCallback((_text: string) => {}, []);
  const addOwnedEntity = useCallback((_eid: number) => {}, []);
  const removeOwnedEntity = useCallback((_eid: number) => {}, []);
  const signalEntityDestroyed = useCallback((_eid: number) => {}, []);
  const signalHitOnRemoteEntity = useCallback((_localMirrorEid: number) => {}, []);
  const setHitHandler = useCallback((_handler: ((eid: number) => void) | null) => {}, []);

  return {
    localPeerId: localId,
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
