"use client";

import type {
  CSSProperties,
  RefObject,
} from "react";
import { useEffect, useRef, useState } from "react";
import { type Time, useKikorinEvent } from "@kikorin/react";
import { eventBus } from "@kikorin/events";
import { log, logLevels } from "@kikorin/util";
import { getActiveCamera } from "@kikorin/system-rendering";
import { Vector3 } from "three";
import { setupGame } from "./kikorin";
import { useNetworking, type ChatMessage } from "./useNetworking";
import { useEngine } from "./useEngine";
import { Box } from "@mui/material";
import { PageLayout, PAGE_COLUMN_TEMPLATE } from "./kikorinLayout";
import {
  installE2EControls,
  markE2EGameReady,
  markE2EGameStopped,
  uninstallE2EControls,
} from "./e2eMetrics";

const MIDDLE_POINTER_BUTTON_MASK = 4;
const CLICK_MAX_MOVEMENT_PX = 4;

const canvasViewportStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  position: "relative",
};

const canvasStyle: CSSProperties = {
  flex: 1,
  width: "100%",
  height: "100%",
  display: "block",
  touchAction: "none",
  cursor: "default",
};

const headerStyle: CSSProperties = {
  display: "flex",
  gap: 12,
  alignItems: "center",
  flexWrap: "wrap",
};

const navStyle: CSSProperties = {
  padding: "16px 20px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const sectionLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

const helperTextStyle: CSSProperties = {
  lineHeight: 1.6,
  color: "#555",
};

const chatBoxStyle: CSSProperties = {
  marginTop: 12,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const chatLogStyle: CSSProperties = {
  height: 140,
  overflowY: "auto",
  background: "#111",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 11,
  fontFamily: "monospace",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const chatInputRowStyle: CSSProperties = {
  display: "flex",
  gap: 4,
};

const chatInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: "monospace",
  fontSize: 11,
};

const networkPanelStyle: CSSProperties = { marginTop: 16 };

const networkRowStyle: CSSProperties = {
  display: "flex",
  gap: 4,
  alignItems: "center",
  marginTop: 4,
};

const networkIdStyle: CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  wordBreak: "break-all",
  flex: 1,
};

const networkInputStyle: CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  flex: 1,
  minWidth: 0,
};

const networkPeerItemStyle: CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  marginTop: 2,
  color: "#ff44aa",
};

// The single description of the control scheme — rendered in both the header
// and the left nav.
const CONTROL_INSTRUCTIONS =
  "W / S move forward and back, Q / E strafe, A / D or Left / Right turn, I / K pitch up and down, left click to fire a bouncing block, middle drag to orbit the camera, middle click to reset it behind the player, right drag to spin the player, and press Space to jump.";

type CameraDragController = {
  disconnect: () => void;
};

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { engine, onFrameRef } = useEngine(canvasRef);
  const [playerEid, setPlayerEid] = useState<number | null>(null);
  const [ownedEids, setOwnedEids] = useState<readonly number[]>([]);
  const timeMetrics = useTimeMetrics();
  const spawnMonstersRef = useRef<((count: number) => void) | null>(null);
  const { localPeerId, transportError, connectedPeers, chatMessages, connect, sendChatMessage, addOwnedEntity, removeOwnedEntity, signalEntityDestroyed, signalHitOnRemoteEntity, setHitHandler } = useNetworking(
    engine,
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
      header={<Header onSpawnMonsters={handleSpawnMonsters} />}
      left={<LeftNav />}
      right={
        <RightPanel
          timeMetrics={timeMetrics}
          localPeerId={localPeerId}
          transportError={transportError}
          connectedPeers={connectedPeers}
          onConnect={connect}
          chatMessages={chatMessages}
          onSendChat={sendChatMessage}
        />
      }
      footer={<Footer />}
    >
      <CanvasViewport canvasRef={canvasRef} />
    </PageLayout>
  );
}

function useTimeMetrics(): Time | null {
  const [timeMetrics, setTimeMetrics] = useState<Time | null>(null);
  useKikorinEvent("ui:timeMetricsUpdate", ({ timeMetrics }) => setTimeMetrics(timeMetrics));
  return timeMetrics;
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

function Header({ onSpawnMonsters }: { onSpawnMonsters: () => void }) {
  return (
    <div style={headerStyle}>
      <span>{CONTROL_INSTRUCTIONS}</span>
      <button type="button" onClick={onSpawnMonsters}>
        Spawn 10 Monsters
      </button>
    </div>
  );
}

function LeftNav() {
  return (
    <div style={navStyle}>
      <div style={sectionLabelStyle}>Controls</div>
      <div style={helperTextStyle}>{CONTROL_INSTRUCTIONS}</div>
    </div>
  );
}

function RightPanel({
  timeMetrics,
  localPeerId,
  transportError,
  connectedPeers,
  onConnect,
  chatMessages,
  onSendChat,
}: {
  timeMetrics: Time | null;
  localPeerId: string | null;
  transportError: string | null;
  connectedPeers: string[];
  onConnect: (peerId: string) => void;
  chatMessages: ChatMessage[];
  onSendChat: (text: string) => void;
}) {
  // avgDelta = EMA of the Rust tick's execution cost; ticksPerSecond = actual
  // ticks per wall-clock second measured from the bundle tick counter.
  const tickCostMs = Math.round((timeMetrics?.avgDelta ?? 0) * 10) / 10;
  const ticksPerSecond = Math.round(timeMetrics?.ticksPerSecond ?? 0);

  return (
    <div>
      <div>Tick cost: {tickCostMs} ms</div>
      <div>TPS: {ticksPerSecond}</div>
      <ChatBox messages={chatMessages} onSend={onSendChat} />
      <NetworkPanel
        localPeerId={localPeerId}
        transportError={transportError}
        connectedPeers={connectedPeers}
        onConnect={onConnect}
      />
    </div>
  );
}

function ChatBox({
  messages,
  onSend,
}: {
  messages: ChatMessage[];
  onSend: (text: string) => void;
}) {
  const [input, setInput] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setInput("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleSend();
  }

  return (
    <div style={chatBoxStyle}>
      <div style={sectionLabelStyle}>Chat</div>
      <div ref={logRef} style={chatLogStyle}>
        {messages.length === 0 ? (
          <div style={{ color: "#555" }}>No messages yet</div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} style={{ color: msg.from === "me" ? "#4ade80" : "#ff44aa" }}>
              <span style={{ fontWeight: 700 }}>
                {msg.from === "me" ? "You" : msg.from.slice(0, 8)}
              </span>
              {": "}
              {msg.text}
            </div>
          ))
        )}
      </div>
      {/* Chat send is not wired into the Rust netcode yet (useNetworking's
          sendChatMessage is a no-op) — keep the input visibly disabled rather
          than silently dropping typed messages. */}
      <div style={chatInputRowStyle}>
        <input
          style={chatInputStyle}
          placeholder="Chat not wired up yet"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled
        />
        <button type="button" onClick={handleSend} disabled>
          Send
        </button>
      </div>
    </div>
  );
}

function NetworkPanel({
  localPeerId,
  transportError,
  connectedPeers,
  onConnect,
}: {
  localPeerId: string | null;
  transportError: string | null;
  connectedPeers: string[];
  onConnect: (peerId: string) => void;
}) {
  const [inputValue, setInputValue] = useState("");
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  function handleCopy() {
    if (!localPeerId) return;
    void navigator.clipboard.writeText(localPeerId).then(() => {
      setCopied(true);
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }

  function handleConnect() {
    const trimmed = inputValue.trim();
    if (!trimmed || !localPeerId) return;
    onConnect(trimmed);
    setInputValue("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleConnect();
  }

  return (
    <div style={networkPanelStyle}>
      <div style={sectionLabelStyle}>Multiplayer</div>

      {transportError && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#f97316" }}>
          Transport error: {transportError}
        </div>
      )}

      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: 11, color: "#555" }}>Your ID</div>
        <div style={networkRowStyle}>
          <span style={networkIdStyle}>
            {localPeerId ?? "connecting…"}
          </span>
          <button
            type="button"
            onClick={handleCopy}
            disabled={!localPeerId}
            style={{ whiteSpace: "nowrap" }}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 11, color: "#555" }}>Connect to peer</div>
        <div style={networkRowStyle}>
          <input
            style={networkInputStyle}
            placeholder="Paste peer ID…"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!localPeerId}
          />
          <button
            type="button"
            onClick={handleConnect}
            disabled={!localPeerId || !inputValue.trim()}
          >
            Join
          </button>
        </div>
      </div>

      {connectedPeers.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, color: "#555" }}>
            Connected ({connectedPeers.length})
          </div>
          {connectedPeers.map((id) => (
            <div key={id} style={networkPeerItemStyle}>
              {id}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function useFps(): number {
  const [fps, setFps] = useState(0);

  useEffect(() => {
    let frameCount = 0;
    let lastTime = performance.now();
    let rafId: number;

    function frame() {
      frameCount++;
      const now = performance.now();
      const elapsed = now - lastTime;
      if (elapsed >= 1000) {
        setFps(Math.round((frameCount * 1000) / elapsed));
        frameCount = 0;
        lastTime = now;
      }
      rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return fps;
}

function Footer() {
  const fps = useFps();
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: PAGE_COLUMN_TEMPLATE,
        columnGap: 2,
        px: 0,
        py: "6px",
      }}
    >
      <Box
        sx={{
          display: { xs: "none", md: "flex" },
          alignItems: "center",
          justifyContent: "flex-end",
          fontSize: 11,
          color: "#555",
          pr: 1,
        }}
      >
        {fps} FPS
      </Box>
      <Box />
      <Box sx={{ display: { xs: "none", md: "block" } }} />
    </Box>
  );
}
