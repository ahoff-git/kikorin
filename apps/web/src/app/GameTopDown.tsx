"use client";

import { useEffect, useRef, useState } from "react";
import { log, logLevels } from "@kikorin/util";
import { setupGameTopDown } from "./kikorinTopDown";
import { useNetworking } from "./useNetworking";
import { useEngine } from "./useEngine";
import { PageLayout } from "./kikorinLayout";
import {
  installE2EControls,
  markE2EGameReady,
  markE2EGameStopped,
  uninstallE2EControls,
} from "./e2eMetrics";
import {
  canvasViewportStyle,
  canvasStyle,
  GameHeader,
  GameLeftNav,
  RightPanel,
  Footer,
  useTimeMetrics,
} from "./gameChrome";

const CONTROL_INSTRUCTIONS =
  "WASD or arrow keys to move (auto-faces your movement direction), left click to shoot in the direction you're facing.";

export default function GameTopDown() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 3D physics (X/Z ground plane — what monster AI/pathfinding already
  // expect) rendered through the 2D mode's orthographic camera (a true
  // overhead look, not perspective) with gravity 0 — see kikorinTopDown.ts's
  // module doc for why this combination needs no new Rust code.
  const { engine, onFrameRef } = useEngine(canvasRef, "3d", 0, "2d");
  const [playerEid, setPlayerEid] = useState<number | null>(null);
  const [ownedEids, setOwnedEids] = useState<readonly number[]>([]);
  const timeMetrics = useTimeMetrics();
  const spawnMonstersRef = useRef<((count: number) => void) | null>(null);
  const {
    localPeerId, transportError, connectedPeers, chatMessages,
    activeChatChannel, setActiveChatChannel, joinedChatGroups, joinChatGroup, leaveChatGroup,
    connect, sendChatMessage,
    addOwnedEntity, removeOwnedEntity, signalEntityDestroyed, signalHitOnRemoteEntity, setHitHandler,
  } = useNetworking(
    engine,
    "topdown",
    playerEid,
    ownedEids,
    // KIKORIN_TOPDOWN_MAP's maze spans x/z in roughly [-20, 20] — about one
    // room-to-room hop, smaller than the 3D game's default (15) radius.
    10,
  );

  // Wire scene setup to run once the WASM engine is ready.
  useEffect(() => {
    if (!engine) return;

    let gameCleanup: (() => void) | null = null;
    let unmounted = false;

    const canvas = canvasRef.current;

    setupGameTopDown(engine, { addOwnedEntity, removeOwnedEntity, signalEntityDestroyed, signalHitOnRemoteEntity }, canvas ?? undefined)
      .then(({ playerEid: eid, ownedEids: owned, onRemoteEntityHit, spawnMonsters, onFrame, cleanup }) => {
        if (unmounted) { cleanup(); return; }

        gameCleanup = cleanup;
        onFrameRef.current = onFrame;
        spawnMonstersRef.current = spawnMonsters;
        setHitHandler(onRemoteEntityHit);
        setPlayerEid(eid);
        setOwnedEids(owned);
        markE2EGameReady(eid, owned);
        installE2EControls(engine, eid);
      })
      .catch((err) => log(logLevels.error, "setupGameTopDown failed", ["game"], err));

    return () => {
      unmounted = true;
      onFrameRef.current = null;
      spawnMonstersRef.current = null;
      setHitHandler(null);
      gameCleanup?.();
      markE2EGameStopped();
      uninstallE2EControls();
      setPlayerEid(null);
      setOwnedEids([]);
    };
  // The useNetworking callbacks are stable no-op refs — intentionally omitted
  // so scene setup re-runs only when the engine instance changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  function handleSpawnMonsters() {
    spawnMonstersRef.current?.(6);
  }

  return (
    <PageLayout
      header={
        <GameHeader
          title="← Kikorin Top-Down"
          controlInstructions={CONTROL_INSTRUCTIONS}
          spawnLabel="Spawn 6 Monsters"
          onSpawnMonsters={handleSpawnMonsters}
        />
      }
      left={<GameLeftNav controlInstructions={CONTROL_INSTRUCTIONS} />}
      right={
        <RightPanel
          timeMetrics={timeMetrics}
          localPeerId={localPeerId}
          transportError={transportError}
          connectedPeers={connectedPeers}
          onConnect={connect}
          chatMessages={chatMessages}
          onSendChat={sendChatMessage}
          activeChatChannel={activeChatChannel}
          onSelectChatChannel={setActiveChatChannel}
          joinedChatGroups={joinedChatGroups}
          onJoinChatGroup={joinChatGroup}
          onLeaveChatGroup={leaveChatGroup}
        />
      }
      footer={<Footer />}
    >
      <div style={canvasViewportStyle}>
        <canvas ref={canvasRef} style={canvasStyle} />
      </div>
    </PageLayout>
  );
}
