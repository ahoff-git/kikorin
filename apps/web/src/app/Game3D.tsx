"use client";

import type {
  CSSProperties,
  RefObject,
} from "react";
import { useEffect, useRef, useState } from "react";
import { eventBus } from "@kikorin/events";
import { log, logLevels } from "@kikorin/util";
import { getActiveCamera } from "@kikorin/system-rendering";
import { Vector3 } from "three";
import { setupGame } from "./kikorin";
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

const MIDDLE_POINTER_BUTTON_MASK = 4;
const CLICK_MAX_MOVEMENT_PX = 4;

// The single description of the control scheme — rendered in both the header
// and the left nav.
const CONTROL_INSTRUCTIONS =
  "W / S move forward and back, Q / E strafe, A / D or Left / Right turn, I / K pitch up and down, left click to fire a bouncing block, middle drag to orbit the camera, middle click to reset it behind the player, right drag to spin the player, and press Space to jump.";

type CameraDragController = {
  disconnect: () => void;
};

export default function Game3D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { engine, onFrameRef } = useEngine(canvasRef, "3d");
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
    "3d",
    playerEid,
    ownedEids,
  );

  // Wire scene setup to run once the WASM engine is ready.
  useEffect(() => {
    if (!engine) return;

    let gameCleanup: (() => void) | null = null;
    let cameraDragController: ReturnType<typeof createCameraDragController> | null = null;
    let unmounted = false;

    const canvas = canvasRef.current;

    setupGame(engine, { addOwnedEntity, removeOwnedEntity, signalEntityDestroyed, signalHitOnRemoteEntity }, canvas ?? undefined)
      .then(({ playerEid: eid, ownedEids: owned, onRemoteEntityHit, spawnMonsters, onFrame, onCameraDrag, onCameraReset, cleanup }) => {
        if (unmounted) { cleanup(); return; }

        gameCleanup = cleanup;
        onFrameRef.current = onFrame;
        spawnMonstersRef.current = spawnMonsters;
        setHitHandler(onRemoteEntityHit);
        setPlayerEid(eid);
        setOwnedEids(owned);
        markE2EGameReady(eid, owned);
        installE2EControls(engine, eid);

        if (canvas) canvas.style.cursor = "default";

        cameraDragController = canvas
          ? createCameraDragController(canvas, onCameraDrag, undefined, onCameraReset)
          : null;
      })
      .catch((err) => log(logLevels.error, "setupGame failed", ["game"], err));

    return () => {
      unmounted = true;
      onFrameRef.current = null;
      spawnMonstersRef.current = null;
      setHitHandler(null);
      cameraDragController?.disconnect();
      if (canvas) canvas.style.cursor = "default";
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
    spawnMonstersRef.current?.(10);
  }

  return (
    <PageLayout
      header={
        <GameHeader
          title="← Kikorin 3D"
          controlInstructions={CONTROL_INSTRUCTIONS}
          spawnLabel="Spawn 10 Monsters"
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
      <CanvasViewport canvasRef={canvasRef} />
    </PageLayout>
  );
}

function createCameraDragController(
  canvas: HTMLCanvasElement,
  onCameraDrag: (deltaX: number, deltaY: number) => void,
  onCameraDragActiveChange: ((active: boolean) => void) | undefined,
  onMiddleClick: (() => void) | undefined,
): CameraDragController {
  type Session = {
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    hasDragged: boolean;
  };

  let session: Session | null = null;

  function stopSession(pointerId?: number) {
    if (session === null) return;
    if (pointerId !== undefined && session.pointerId !== pointerId) return;
    const ended = session;
    session = null;
    if (!ended.hasDragged) onMiddleClick?.();
    else onCameraDragActiveChange?.(false);
    if (document.pointerLockElement !== canvas) canvas.style.cursor = "default";
  }

  const onPointerLockChange = () => {
    canvas.style.cursor = document.pointerLockElement === canvas ? "none" : "default";
  };

  function onPointerDown(event: PointerEvent) {
    if (event.pointerType !== "mouse") return;

    if (event.button === 2) {
      if (document.pointerLockElement !== canvas) {
        void canvas.requestPointerLock();
      }
      event.preventDefault();
      return;
    }

    if (event.button !== 1 || session !== null) return;

    session = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      hasDragged: false,
    };

    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Some browsers reject capture when the pointer is already gone.
    }

    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent) {
    if (session === null || session.pointerId !== event.pointerId) return;
    if ((event.buttons & MIDDLE_POINTER_BUTTON_MASK) === 0) {
      stopSession(event.pointerId);
      return;
    }

    const deltaX = event.clientX - session.lastX;
    const deltaY = event.clientY - session.lastY;
    session.lastX = event.clientX;
    session.lastY = event.clientY;

    if (!session.hasDragged) {
      const totalDX = event.clientX - session.startX;
      const totalDY = event.clientY - session.startY;
      if (Math.hypot(totalDX, totalDY) > CLICK_MAX_MOVEMENT_PX) {
        session.hasDragged = true;
        canvas.style.cursor = "grabbing";
        onCameraDragActiveChange?.(true);
      }
    }

    if (!session.hasDragged || (deltaX === 0 && deltaY === 0)) return;
    onCameraDrag(deltaX, deltaY);
    event.preventDefault();
  }

  function onPointerUp(event: PointerEvent) {
    if (event.pointerType === "mouse" && event.button === 2) {
      document.exitPointerLock();
    }
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch {
      // Safe to ignore if capture was already released elsewhere.
    }
    stopSession(event.pointerId);
  }

  function onPointerCancel(event: PointerEvent) {
    stopSession(event.pointerId);
  }

  function onLostPointerCapture() {
    stopSession();
  }

  function onContextMenu(event: MouseEvent) {
    event.preventDefault();
  }

  document.addEventListener("pointerlockchange", onPointerLockChange);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("lostpointercapture", onLostPointerCapture);
  canvas.addEventListener("contextmenu", onContextMenu);

  return {
    disconnect() {
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("lostpointercapture", onLostPointerCapture);
      canvas.removeEventListener("contextmenu", onContextMenu);
      stopSession();
    },
  };
}

const crosshairStyle: CSSProperties = {
  position: "absolute",
  pointerEvents: "none",
  transform: "translate(-50%, -50%)",
};

const scratchVec = new Vector3();

// Projects a world point to CSS screen coords; returns null if behind camera.
function projectToScreen(wx: number, wy: number, wz: number, camera: ReturnType<typeof getActiveCamera>) {
  if (!camera) return null;
  scratchVec.set(wx, wy, wz).project(camera);
  if (scratchVec.z > 1) return null;
  return {
    left: `${((scratchVec.x + 1) / 2) * 100}%`,
    top: `${((1 - (scratchVec.y + 1) / 2)) * 100}%`,
  };
}

function CanvasViewport({
  canvasRef,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
}) {
  const crosshairRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const crosshair = crosshairRef.current;
    if (!crosshair) return;

    let latestWx = 0, latestWy = 0, latestWz = 0, ready = false;

    const onAimPoint = ({ wx, wy, wz }: { wx: number; wy: number; wz: number }) => {
      latestWx = wx; latestWy = wy; latestWz = wz;
      ready = true;
    };
    eventBus.on("ui:crosshairAimPoint", onAimPoint);

    let rafId = 0;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      if (!ready) return;
      const pos = projectToScreen(latestWx, latestWy, latestWz, getActiveCamera());
      if (pos) {
        crosshair.style.left = pos.left;
        crosshair.style.top = pos.top;
        crosshair.style.visibility = "visible";
      } else {
        crosshair.style.visibility = "hidden";
      }
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      eventBus.off("ui:crosshairAimPoint", onAimPoint);
    };
  }, []);

  return (
    <div style={canvasViewportStyle}>
      <canvas ref={canvasRef} style={canvasStyle} />
      <svg
        ref={crosshairRef}
        width="24"
        height="24"
        viewBox="-12 -12 24 24"
        style={{ ...crosshairStyle, visibility: "hidden" }}
      >
        <circle cx="0" cy="0" r="5" fill="none" stroke="black" strokeWidth="2.5" />
        <line x1="-11" y1="0" x2="-7" y2="0" stroke="black" strokeWidth="2.5" />
        <line x1="7" y1="0" x2="11" y2="0" stroke="black" strokeWidth="2.5" />
        <line x1="0" y1="-11" x2="0" y2="-7" stroke="black" strokeWidth="2.5" />
        <line x1="0" y1="7" x2="0" y2="11" stroke="black" strokeWidth="2.5" />
        <circle cx="0" cy="0" r="5" fill="none" stroke="white" strokeWidth="1.5" />
        <line x1="-11" y1="0" x2="-7" y2="0" stroke="white" strokeWidth="1.5" />
        <line x1="7" y1="0" x2="11" y2="0" stroke="white" strokeWidth="1.5" />
        <line x1="0" y1="-11" x2="0" y2="-7" stroke="white" strokeWidth="1.5" />
        <line x1="0" y1="7" x2="0" y2="11" stroke="white" strokeWidth="1.5" />
      </svg>
    </div>
  );
}
