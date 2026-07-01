"use client";

// TODO: Networking was removed along with the TypeScript ECS engine packages.
// PeerNet (from @kikorin/netcode) and CoreWorldBox (from @kikorin/engine) no longer exist.
// Multiplayer entity sync needs to be ported to the Rust WASM engine (crates/engine).

import { log, logLevels } from "@kikorin/util";
import { netChannel } from "@kikorin/adapter";
import { useCallback, useEffect, useState } from "react";

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

export function useNetworking(
  _engine: unknown,
  _playerEid: number | null,
  _ownedEids: readonly number[],
): UseNetworkingReturn {
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

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

  const connect = useCallback((remotePeerId: string) => {
    log(logLevels.debug, "[networking] connect stub called", ["network"], { remotePeerId });
  }, []);

  const sendChatMessage = useCallback((_text: string) => {}, []);
  const addOwnedEntity = useCallback((_eid: number) => {}, []);
  const removeOwnedEntity = useCallback((_eid: number) => {}, []);
  const signalEntityDestroyed = useCallback((_eid: number) => {}, []);
  const signalHitOnRemoteEntity = useCallback((_localMirrorEid: number) => {}, []);
  const setHitHandler = useCallback((_handler: ((eid: number) => void) | null) => {}, []);

  return {
    localPeerId: null,
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
